// Speech-to-text for a voice attempt. The audio is validated, paid for in
// advance (asrSeconds), sent to the provider from memory and dropped; only
// the transcript and the duration are stored.
import type { DatabaseSync } from "node:sqlite";
import type { TranscribeResponse } from "@/shared/contracts";
import type { Learner } from "../auth/sessions";
import { markUnknown, reserve, settle } from "../budget";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, learnerScope } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors";
import { newId } from "../ids";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  UnknownModelError,
} from "../models/errors";
import { metaTranscribe } from "../models/meta-asr";
import { asrCostMicros } from "../models/prices";
import { InvalidWavError, parseWav } from "./wav";

export interface SpeechDeps extends ServerDeps {
  config?: AppConfig;
}

export async function transcribeAttempt(
  learner: Learner,
  attemptId: string,
  audio: Uint8Array,
  deps: SpeechDeps = {},
): Promise<TranscribeResponse> {
  const config = deps.config ?? getConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const scope = learnerScope(learner.id, db);

  // Ownership and state come first; nothing is paid for or sent before they pass.
  const attempt = scope.selectOne("attempts", { where: "id = :id", params: { id: attemptId } });
  if (!attempt) throw new NotFoundError();
  const task = scope.selectOne("practice_tasks", {
    where: "id = :id",
    params: { id: String(attempt.task_id) },
  });
  if (!task) throw new NotFoundError();
  if (task.kind !== "voice") throw new InvalidRequestError("Not a voice task");
  if (attempt.status !== "issued" && attempt.status !== "transcribed") throw new ConflictError();

  let info;
  try {
    info = parseWav(audio);
  } catch (error) {
    if (error instanceof InvalidWavError) throw new InvalidRequestError(error.message);
    throw error;
  }

  if (!config.meta.apiKey) throw new ModelNotConfiguredError();
  const model = config.meta.asrModel;
  const units = Math.ceil(info.seconds);
  // Throws for a model without a price: no cost bound, no call.
  const maxCostMicros = asrCostMicros(model, units);

  // Every recording is its own reservation: recording again is a new charge.
  const reservation = immediate(
    (tx) =>
      reserve(
        {
          learnerId: learner.id,
          kind: "asrSeconds",
          requestId: `${attemptId}:${newId()}`,
          units,
          maxCostMicros,
        },
        { db: tx, now, config },
      ),
    db,
  );

  let result;
  try {
    result = await metaTranscribe({ model, audio }, { config });
  } catch (error) {
    // Same rules as the text role: provider refusal costs nothing, unusable
    // output was billed, anything else leaves the outcome unknown.
    immediate((tx) => {
      const d = { db: tx, now };
      if (error instanceof ModelHttpError || error instanceof UnknownModelError) {
        settle(reservation.id, 0, d);
      } else if (error instanceof ModelOutputError) {
        settle(reservation.id, maxCostMicros, d);
      } else {
        markUnknown(reservation.id, d);
      }
    }, db);
    throw error;
  }

  // The provider bills whole seconds; round the reported duration up so the
  // recorded cost never undercounts.
  const billedSeconds =
    result.durationMs === null ? units : Math.min(units, Math.ceil(result.durationMs / 1000));
  immediate((tx) => {
    store(tx, learner.id, attemptId, result.text, info.seconds);
    settle(reservation.id, asrCostMicros(model, billedSeconds), { db: tx, now });
  }, db);

  return { attemptId, text: result.text, durationSeconds: info.seconds };
}

function store(
  db: DatabaseSync,
  learnerId: string,
  attemptId: string,
  text: string,
  seconds: number,
): void {
  db.prepare(
    `UPDATE attempts SET raw_transcript = ?, audio_seconds = ?, status = 'transcribed'
     WHERE id = ? AND learner_id = ? AND status IN ('issued', 'transcribed')`,
  ).run(text, seconds, attemptId, learnerId);
}
