// Evaluation of one answer. The model reports facts about the answer; code
// computes the verdict, writes the evidence and schedules the next practice.
import type { DatabaseSync } from "node:sqlite";
import { hashText, normalizeText } from "@/lib/text";
import type { Evaluation, SubmitAttemptRequest, Verdict } from "@/shared/contracts";
import type { Learner } from "../auth/sessions";
import { reserve } from "../budget";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, learnerScope, type Row } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, NotFoundError } from "../errors";
import { newId } from "../ids";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
} from "../models/errors";
import { estimateMaxCostMicros } from "../models/meta";
import { runReservedChat } from "../models/reserved-chat";
import { EVALUATE_ATTEMPT_ROLE } from "../models/roles";
import {
  buildEvaluationMessages,
  computeVerdict,
  EVALUATION_JSON_SCHEMA,
  parseEvaluation,
  RUBRIC_VERSION,
  tidyMessage,
  type RawEvaluation,
} from "./evaluation";
import { nextPracticeLabel } from "./labels";
import { isTranscriptEdited } from "./text";

const DAY_MS = 24 * 60 * 60 * 1000;
// First evaluated attempt of a task: a clean recall (expression hidden, no
// hint) earns a longer gap than anything else.
const CLEAN_RECALL_DELAY_MS = 3 * DAY_MS;
const DEFAULT_DELAY_MS = DAY_MS;

const UNAVAILABLE_MESSAGE =
  "We could not check this answer just now. It is saved, so you can try again.";

export interface AttemptDeps extends ServerDeps {
  config?: AppConfig;
}

export async function submitAttempt(
  learner: Learner,
  attemptId: string,
  input: SubmitAttemptRequest,
  deps: AttemptDeps = {},
): Promise<Evaluation> {
  const config = deps.config ?? getConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const scope = learnerScope(learner.id, db);

  const attempt = scope.selectOne("attempts", { where: "id = :id", params: { id: attemptId } });
  if (!attempt) throw new NotFoundError();
  const task = scope.selectOne("practice_tasks", {
    where: "id = :id",
    params: { id: String(attempt.task_id) },
  });
  const expression = task
    ? scope.selectOne("expressions", {
        where: "id = :id",
        params: { id: String(task.expression_id) },
      })
    : undefined;
  if (!task || !expression) throw new NotFoundError();

  const answer = normalizeText(input.answer).trim();
  const answerHash = await hashText(answer);

  // The same answer on an evaluated attempt returns the stored result; a
  // different answer cannot rewrite history.
  if (attempt.status === "evaluated") {
    if (attempt.answer_hash !== answerHash) throw new ConflictError();
    return storedEvaluation(db, learner.id, attempt, expression, now);
  }
  assertSubmittable(attempt, task);

  if (!config.meta.apiKey) throw new ModelNotConfiguredError();
  const model = config.meta.textModel;
  const targetText = String(expression.text);
  const transcriptEdited =
    task.kind === "voice" &&
    isTranscriptEdited(String(attempt.raw_transcript ?? ""), answer, targetText);

  const messages = buildEvaluationMessages({
    situation: String(task.situation),
    expression: targetText,
    meaning: String(expression.meaning),
    answer,
  });
  const inputChars =
    messages.reduce((total, m) => total + m.content.length, 0) +
    JSON.stringify(EVALUATION_JSON_SCHEMA).length;
  // Throws for a model without a price: no cost bound, no call.
  const maxCostMicros = estimateMaxCostMicros(model, inputChars, EVALUATE_ATTEMPT_ROLE.maxTokens);

  // Reservation and the "evaluating" lock appear together or not at all; a
  // second submit while this one runs gets a conflict. A failed attempt may be
  // re-run, each time with a new reservation.
  const reservation = immediate((tx) => {
    const current = tx
      .prepare("SELECT status, raw_transcript FROM attempts WHERE id = ? AND learner_id = ?")
      .get(attemptId, learner.id);
    if (!current) throw new NotFoundError();
    assertSubmittable(current, task);
    const reserved = reserve(
      {
        learnerId: learner.id,
        kind: "evaluate",
        requestId: `${attemptId}:${newId()}`,
        units: 1,
        maxCostMicros,
      },
      { db: tx, now, config },
    );
    tx.prepare(
      `UPDATE attempts
       SET status = 'evaluating', answer = ?, answer_hash = ?, hint_used = ?, transcript_edited = ?
       WHERE id = ? AND learner_id = ?`,
    ).run(answer, answerHash, input.hintUsed ? 1 : 0, transcriptEdited ? 1 : 0, attemptId, learner.id);
    return reserved;
  }, db);

  let raw: RawEvaluation;
  try {
    ({ value: raw } = await runReservedChat({
      db,
      now,
      config,
      reservation,
      chat: {
        model,
        messages,
        jsonSchema: EVALUATION_JSON_SCHEMA,
        maxTokens: EVALUATE_ATTEMPT_ROLE.maxTokens,
        temperature: EVALUATE_ATTEMPT_ROLE.temperature,
      },
      parse: parseEvaluation,
    }));
  } catch (error) {
    // Whatever went wrong, the attempt must not stay locked.
    db.prepare(
      "UPDATE attempts SET status = 'failed' WHERE id = ? AND learner_id = ? AND status = 'evaluating'",
    ).run(attemptId, learner.id);
    if (
      error instanceof ModelTimeoutError ||
      error instanceof ModelHttpError ||
      error instanceof ModelOutputError
    ) {
      // The learner's answer is kept; nothing is counted for or against them.
      return {
        attemptId,
        verdict: "unavailable",
        message: UNAVAILABLE_MESSAGE,
        correction: null,
        targetUsed: false,
        transcriptEdited,
        nextPracticeLabel: null,
        retryAttemptId: null,
      };
    }
    throw error;
  }

  const verdict = computeVerdict(raw);
  const message = tidyMessage(raw.message, verdict);
  const correction = raw.correction.replace(/\s+/g, " ").trim() || null;
  const hintUsed = input.hintUsed;

  return immediate((tx) => {
    const nowIso = now.toISOString();
    tx.prepare(
      `INSERT INTO evaluations
         (attempt_id, learner_id, verdict, task_completed, target_used, meaning_correct,
          form_correct, message, correction, model, rubric_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attemptId,
      learner.id,
      verdict,
      flag(raw.task_completed),
      flag(raw.target_used),
      flag(raw.meaning_correct),
      flag(raw.form_correct),
      message,
      correction,
      model,
      RUBRIC_VERSION,
      nowIso,
    );
    tx.prepare(
      "UPDATE attempts SET status = 'evaluated', evaluated_at = ? WHERE id = ? AND learner_id = ?",
    ).run(nowIso, attemptId, learner.id);
    tx.prepare(
      `INSERT INTO evidence_events
         (id, learner_id, expression_id, attempt_id, kind, verdict, cue, hint_used,
          transcript_edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      learner.id,
      String(expression.id),
      attemptId,
      task.kind === "voice" ? "spoken_attempt" : "written_attempt",
      verdict,
      String(task.cue),
      flag(hintUsed),
      flag(transcriptEdited),
      nowIso,
    );

    // Only a task's first attempt schedules; its retries add evidence only.
    let nextPracticeAt = expression.next_practice_at === null ? null : String(expression.next_practice_at);
    if (attempt.previous_attempt_id === null) {
      const delay =
        verdict === "used_well" && task.cue === "hidden" && !hintUsed
          ? CLEAN_RECALL_DELAY_MS
          : DEFAULT_DELAY_MS;
      nextPracticeAt = new Date(now.getTime() + delay).toISOString();
      tx.prepare("UPDATE expressions SET next_practice_at = ? WHERE id = ? AND learner_id = ?").run(
        nextPracticeAt,
        String(expression.id),
        learner.id,
      );
    }

    let retryAttemptId: string | null = null;
    if (verdict !== "used_well") {
      retryAttemptId = newId();
      tx.prepare(
        `INSERT INTO attempts (id, learner_id, task_id, previous_attempt_id, status, created_at)
         VALUES (?, ?, ?, ?, 'issued', ?)`,
      ).run(retryAttemptId, learner.id, String(task.id), attemptId, nowIso);
    }

    return {
      attemptId,
      verdict,
      message,
      correction,
      targetUsed: raw.target_used,
      transcriptEdited,
      nextPracticeLabel: nextPracticeAt ? nextPracticeLabel(new Date(nextPracticeAt), now) : null,
      retryAttemptId,
    };
  }, db);
}

// An attempt can be submitted while it is open or after a failed evaluation.
// A voice attempt also needs something transcribed to confirm.
function assertSubmittable(
  attempt: Pick<Row, string>,
  task: Pick<Row, string>,
): void {
  const open =
    attempt.status === "issued" || attempt.status === "transcribed" || attempt.status === "failed";
  if (!open) throw new ConflictError();
  if (task.kind === "voice" && attempt.raw_transcript === null) throw new ConflictError();
}

function storedEvaluation(
  db: DatabaseSync,
  learnerId: string,
  attempt: Row,
  expression: Row,
  now: Date,
): Evaluation {
  const scope = learnerScope(learnerId, db);
  const stored = scope.selectOne("evaluations", {
    where: "attempt_id = :id",
    params: { id: String(attempt.id) },
  });
  if (!stored) throw new NotFoundError();
  const retry = scope.selectOne("attempts", {
    where: "previous_attempt_id = :id",
    params: { id: String(attempt.id) },
  });
  const next = expression.next_practice_at === null ? null : new Date(String(expression.next_practice_at));
  return {
    attemptId: String(attempt.id),
    verdict: stored.verdict as Verdict,
    message: String(stored.message),
    correction: stored.correction === null ? null : String(stored.correction),
    targetUsed: stored.target_used === 1,
    transcriptEdited: attempt.transcript_edited === 1,
    nextPracticeLabel: next ? nextPracticeLabel(next, now) : null,
    retryAttemptId: retry ? String(retry.id) : null,
  };
}

function flag(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
