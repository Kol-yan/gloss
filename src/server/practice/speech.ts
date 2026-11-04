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
  ModelOutputError,
  UnknownModelError,
} from "../models/errors";
import { resolveProviderAccess, speechModel } from "../models/access";
import { transcribeWithAccess } from "../models/dispatch";
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

  const access = resolveProviderAccess(learner.id, deps.providerAccess, db);
  const model = speechModel(access, config);
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
          role: "practice_speech",
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
    // Only the canonical file leaves the server, never the raw upload.
    result = await transcribeWithAccess({ model, audio: info.canonical }, access, config, { reservation, db, now });
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

  // Settle at the full reservation. The provider's reported duration may never
  // lower the charge below the seconds that were reserved, and it cannot raise
  // it above them; a longer report than reserved means the sent audio did not
  // match what was measured, which should not happen with a canonical file.
  if (result.durationMs !== null && Math.ceil(result.durationMs / 1000) > units) {
    console.warn(
      `[gloss] speech-to-text reported ${result.durationMs} ms for ${units} reserved seconds`,
    );
  }
  immediate((tx) => {
    store(tx, learner.id, attemptId, result.text, info.seconds);
    settle(reservation.id, maxCostMicros, { db: tx, now });
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
