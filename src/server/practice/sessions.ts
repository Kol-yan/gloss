import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PracticeSessionAnswerView,
  PracticeSessionExercise,
  PracticeSessionFinishResponse,
  PracticeSessionReadiness,
  type PracticeReaction,
  type PracticeSessionAnswerRequest,
  type PracticeSessionFinishResponse as FinishResponse,
  type PracticeSessionPrepareRequest,
  type PracticeSessionReadiness as Readiness,
  type PracticeSessionReactionRequest,
} from "@/shared/contracts";
import { sanitizeIpa } from "@/lib/pronunciation";
import type { Learner } from "../auth/sessions";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, type Row } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, NotFoundError, QuotaExceededError, UnauthorizedError } from "../errors";
import { utcDayBounds } from "../budget";
import { newId } from "../ids";
import { starterEntry } from "../learning/starter";
import type { ProviderAccess } from "../models/access";
import { checkPracticeAnswer, normalizePracticeAnswer } from "./checking";
import { takePoolExercise, type PoolExercise } from "./exercise-pool";
import { HIDDEN_CUE_AFTER_MS } from "./recall";
import {
  pickSessionWords,
  recordPracticeReaction as recordEnginePracticeReaction,
  recordPracticeResult,
} from "./word-source";

const START_READY_COUNT = 3;
const STALE_ITEM_LEASE_MS = 2 * 60 * 1000;
const ALLOWED_REACTIONS: PracticeReaction[] = ["already_know", "too_easy", "not_relevant", "too_hard"];

export interface PracticeSessionDeps extends ServerDeps {
  config?: AppConfig;
}

type SessionRow = Row & {
  id: string;
  learner_id: string;
  request_id: string;
  status: string;
  requested_size: number;
  total: number;
};

type ItemRow = Row & {
  id: string;
  learner_id: string;
  session_id: string;
  ordinal: number;
  expression_id: string;
  status: string;
  generation_id: string | null;
  exercise_json: string | null;
};

interface StoredExercise extends PoolExercise {
  expressionId: string;
}

export function preparePracticeSession(
  learner: Learner,
  input: PracticeSessionPrepareRequest,
  deps: PracticeSessionDeps = {},
): Readiness {
  const db = deps.db ?? getDb();
  const size = input.size ?? 8;
  const sessionId = newId();
  const nowDate = deps.now ?? new Date();
  const now = nowDate.toISOString();

  const result = immediate((tx) => {
    const existing = tx.prepare(
      "SELECT * FROM practice_sessions WHERE learner_id = ? AND request_id = ?",
    ).get(learner.id, input.requestId) as SessionRow | undefined;
    if (existing) {
      if (Number(existing.requested_size) !== size) throw new ConflictError();
      return String(existing.id);
    }

    const current = tx.prepare("SELECT quota_profile, funding_source FROM learners WHERE id = ? AND deleted_at IS NULL").get(learner.id);
    if (!current) throw new UnauthorizedError();
    if (current.quota_profile === "guest" && current.funding_source === "hosted") {
      const config = deps.config ?? getConfig();
      const { start, end } = utcDayBounds(nowDate);
      const used = Number(tx.prepare(
        "SELECT COUNT(*) AS n FROM practice_sessions WHERE learner_id = ? AND created_at >= ? AND created_at < ?",
      ).get(learner.id, start, end)?.n ?? 0);
      if (used >= config.guestDailyPracticeSessions) throw new QuotaExceededError("evaluate", used, config.guestDailyPracticeSessions);
    }

    // Selection reserves new-word places, so replay lookup must happen first
    // and both operations must share this write transaction.
    const selected = pickSessionWords(learner.id, size, { db: tx, now: nowDate }).slice(0, size);
    const snapshots = selected.flatMap((word) => {
      const expression = tx.prepare(
        "SELECT id, meaning, ipa FROM expressions WHERE id = ? AND learner_id = ?",
      ).get(word.expressionId, learner.id) as Row | undefined;
      if (expression) {
        return [{ word, meaning: String(expression.meaning), ipa: sanitizeIpa(expression.ipa, word.text) }];
      }
      const curated = starterEntry(word.text);
      if (!curated) return [];
      // Starter entries carry definitions but no IPA data, so keep that
      // distinction visible instead of inventing pronunciation metadata.
      return [{ word, meaning: curated.definition, ipa: null }];
    });
    const status = snapshots.length === 0 ? "empty" : "preparing";
    tx.prepare(
      `INSERT INTO practice_sessions (id, learner_id, request_id, status, requested_size,
         total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, learner.id, input.requestId, status, size, snapshots.length, now);
    snapshots.forEach(({ word, meaning, ipa }, ordinal) => {
      tx.prepare(
        `INSERT INTO practice_session_items
           (id, learner_id, session_id, ordinal, expression_id, word_text, meaning, ipa,
            slot, word_status, start_rung, frequency, why, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        newId(), learner.id, sessionId, ordinal, word.expressionId, word.text, meaning, ipa,
        word.slot, word.status, word.startRung, word.frequency, word.why,
      );
    });
    return sessionId;
  }, db);

  return practiceSessionReadiness(learner.id, result, { ...deps, db });
}

export function practiceSessionReadiness(
  learnerId: string,
  sessionId: string,
  deps: ServerDeps = {},
): Readiness {
  const db = deps.db ?? getDb();
  const session = getSession(db, learnerId, sessionId);
  const ready = countItems(db, learnerId, sessionId, "status IN ('ready', 'issued', 'answered')");
  const canStart = session.status !== "finished" && session.total > 0 && ready >= Math.min(START_READY_COUNT, session.total);
  return PracticeSessionReadiness.parse({
    sessionId,
    ready,
    total: Number(session.total),
    status: session.status,
    canStart,
  });
}

export function hasPreparationWork(learnerId: string, sessionId: string, db = getDb()): boolean {
  const row = db.prepare(
    `SELECT 1 FROM practice_sessions s JOIN practice_session_items i
       ON i.session_id = s.id AND i.learner_id = s.learner_id
     WHERE s.id = ? AND s.learner_id = ? AND s.status IN ('preparing', 'ready')
       AND i.status IN ('pending', 'generating') LIMIT 1`,
  ).get(sessionId, learnerId);
  return Boolean(row);
}

// Next's after() callback and readiness polling both enter here. Per-item leases
// make overlapping continuations harmless, while the token fences stale workers.
export async function continuePracticePreparation(
  learnerId: string,
  sessionId: string,
  providerAccess: ProviderAccess,
  deps: PracticeSessionDeps = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  try {
    while (true) {
      const now = deps.now ?? new Date();
      const claim = claimNextItem(db, learnerId, sessionId, now);
      if (!claim) return;
      try {
        // Current exercise generation supports 1-4. Rungs 5-6 are served as
        // the supported rung-4 recall exercise, whose actual answer is scored.
        const rung = Math.max(1, Math.min(4, Number(claim.start_rung))) as 1 | 2 | 3 | 4;
        const generated = await takePoolExercise(learnerId, String(claim.expression_id), rung, {
          db,
          now,
          providerAccess,
          config,
        });
        const stored = validateAndStoreExercise(generated, generated.rung, String(claim.word_text));
        immediate((tx) => {
          const current = tx.prepare(
            `SELECT status FROM practice_sessions WHERE id = ? AND learner_id = ?`,
          ).get(sessionId, learnerId) as Row | undefined;
          if (!current || current.status === "finished") return;
          const updated = tx.prepare(
            `UPDATE practice_session_items SET status = 'ready', exercise_json = ?,
               generation_started_at = NULL
             WHERE id = ? AND learner_id = ? AND session_id = ?
               AND status = 'generating' AND generation_id = ?`,
          ).run(JSON.stringify(stored), String(claim.id), learnerId, sessionId, String(claim.generation_id));
          if (Number(updated.changes) > 0) refreshSessionStatus(tx, learnerId, sessionId);
        }, db);
      } catch (error) {
        if (error instanceof ConflictError) {
          immediate((tx) => {
            tx.prepare(
              `UPDATE practice_session_items SET status = 'pending', generation_started_at = NULL
               WHERE id = ? AND learner_id = ? AND session_id = ? AND generation_id = ? AND status = 'generating'`,
            ).run(String(claim.id), learnerId, sessionId, String(claim.generation_id));
          }, db);
          return;
        }
        failPreparation(db, learnerId, sessionId, String(claim.id), String(claim.generation_id));
        return;
      }
    }
  } catch {
    // Background failures are represented by terminal item/session state only.
    failPreparation(db, learnerId, sessionId);
  }
}

export function nextPracticeExercise(learnerId: string, sessionId: string, deps: ServerDeps = {}) {
  const db = deps.db ?? getDb();
  return immediate((tx) => {
    const session = getSession(tx, learnerId, sessionId);
    if (session.status === "finished" || session.status === "empty" || session.status === "failed") {
      return { status: "complete" as const, exercise: null };
    }
    const readyCount = countItems(tx, learnerId, sessionId, "status IN ('ready', 'issued', 'answered')");
    if (Number(session.total) === 0 || readyCount < Math.min(START_READY_COUNT, Number(session.total))) {
      return { status: "waiting" as const, exercise: null };
    }

    const issued = tx.prepare(
      `SELECT * FROM practice_session_items
       WHERE learner_id = ? AND session_id = ? AND status = 'issued'
       ORDER BY ordinal LIMIT 1`,
    ).get(learnerId, sessionId) as ItemRow | undefined;
    if (issued) return { status: "ready" as const, exercise: publicExercise(issued) };

    const next = tx.prepare(
      `SELECT * FROM practice_session_items
       WHERE learner_id = ? AND session_id = ? AND status = 'ready'
       ORDER BY ordinal LIMIT 1`,
    ).get(learnerId, sessionId) as ItemRow | undefined;
    if (!next) {
      const remaining = tx.prepare(
        `SELECT 1 FROM practice_session_items WHERE learner_id = ? AND session_id = ?
           AND status IN ('pending', 'generating') LIMIT 1`,
      ).get(learnerId, sessionId);
      return remaining
        ? { status: "waiting" as const, exercise: null }
        : { status: "complete" as const, exercise: null };
    }
    tx.prepare(
      `UPDATE practice_session_items SET status = 'issued', issued_at = COALESCE(issued_at, ?)
       WHERE id = ? AND learner_id = ? AND session_id = ? AND status = 'ready'`,
    ).run((deps.now ?? new Date()).toISOString(), String(next.id), learnerId, sessionId);
    tx.prepare(
      `UPDATE practice_sessions SET started_at = COALESCE(started_at, ?)
       WHERE id = ? AND learner_id = ?`,
    ).run((deps.now ?? new Date()).toISOString(), sessionId, learnerId);
    const row = tx.prepare(
      "SELECT * FROM practice_session_items WHERE id = ? AND learner_id = ? AND session_id = ?",
    ).get(String(next.id), learnerId, sessionId) as ItemRow;
    return { status: "ready" as const, exercise: publicExercise(row) };
  }, db);
}

export function getPracticeHint(
  learnerId: string,
  sessionId: string,
  exerciseId: string,
  deps: ServerDeps = {},
) {
  const db = deps.db ?? getDb();
  return immediate((tx) => {
    const item = getItem(tx, learnerId, sessionId, exerciseId);
    if (item.status !== "issued") throw new ConflictError();
    parseStoredExercise(item);
    const word = String(item.word_text).trim();
    const first = word.length > 1 ? word.slice(0, 1) : "";
    const hint = first ? `It starts with “${first}”.` : "Think of the meaning.";
    tx.prepare(
      `UPDATE practice_session_items SET hint_used = 1
       WHERE id = ? AND learner_id = ? AND session_id = ? AND status = 'issued'`,
    ).run(exerciseId, learnerId, sessionId);
    return { exerciseId, hint };
  }, db);
}

export function submitPracticeAnswer(
  learnerId: string,
  sessionId: string,
  input: PracticeSessionAnswerRequest,
  deps: ServerDeps = {},
) {
  const db = deps.db ?? getDb();
  return immediate((tx) => {
    const item = getItem(tx, learnerId, sessionId, input.exerciseId);
    const exercise = parseStoredExercise(item);
    const usedHint = Boolean(item.hint_used) || input.usedHint;
    const dontKnow = input.dontKnow ?? false;
    const answer = normalizePracticeAnswer(input.answer);
    const digest = createHash("sha256").update(JSON.stringify([answer, usedHint, dontKnow])).digest("hex");
    if (item.status === "answered") {
      if (item.answer_hash !== digest) throw new ConflictError();
      return { answer: PracticeSessionAnswerView.parse(JSON.parse(String(item.answer_json))) };
    }
    if (item.status !== "issued") throw new ConflictError();
    if (!dontKnow && exercise.rung < 4 && (!exercise.options || !exercise.options.some((option) =>
      normalizePracticeAnswer(option) === answer))) {
      throw new ConflictError();
    }
    const result = checkPracticeAnswer({
      rung: exercise.rung,
      answer,
      expected: exercise.answer,
      options: exercise.options ?? undefined,
      dontKnow,
    });
    const correct = result.correct && !dontKnow;
    const now = deps.now ?? new Date();
    const recent = hasRecentReveal(tx, learnerId, String(item.expression_id), now);
    const productive = exercise.rung === 4 && correct && !usedHint && !recent;
    const schedule = recordPracticeResult({
      learnerId,
      expressionId: String(item.expression_id),
      rung: exercise.rung,
      productive,
      correct,
      usedHint,
      eventId: String(item.id),
    }, { db: tx, now });
    const answerView = PracticeSessionAnswerView.parse({
      exerciseId: input.exerciseId,
      correct,
      word: String(item.word_text),
      frequency: String(item.frequency),
      ipa: sanitizeIpa(item.ipa, String(item.word_text)),
      meaning: String(item.meaning),
      example: exercise.example,
      comesBackText: relativeReturnText(schedule.comesBackAt, now),
      allowedReactions: ALLOWED_REACTIONS,
      reaction: null,
    });
    tx.prepare(
      `UPDATE practice_session_items SET status = 'answered', hint_used = ?, submitted_answer = ?,
         answer_hash = ?, answer_correct = ?, dont_know = ?, answer_json = ?, answered_at = ?
       WHERE id = ? AND learner_id = ? AND session_id = ? AND status = 'issued'`,
    ).run(Number(usedHint), input.answer, digest, Number(correct), Number(dontKnow), JSON.stringify(answerView), now.toISOString(),
      input.exerciseId, learnerId, sessionId);
    return { answer: answerView };
  }, db);
}

export function recordPracticeReaction(
  learnerId: string,
  sessionId: string,
  input: PracticeSessionReactionRequest,
  deps: ServerDeps = {},
) {
  const db = deps.db ?? getDb();
  return immediate((tx) => {
    const session = getSession(tx, learnerId, sessionId);
    const item = getItem(tx, learnerId, sessionId, input.exerciseId);
    if (item.status !== "answered") throw new ConflictError();
    parseStoredExercise(item);
    const stored = PracticeSessionAnswerView.parse(JSON.parse(String(item.answer_json)));
    if (item.reaction !== null && item.reaction !== input.reaction) throw new ConflictError();
    if (session.status === "finished" && item.reaction === null) throw new ConflictError();
    if (item.reaction === null) {
      const now = deps.now ?? new Date();
      const schedule = recordEnginePracticeReaction({
        learnerId,
        expressionId: String(item.expression_id),
        eventId: String(item.id),
        reaction: input.reaction,
        correct: stored.correct,
      }, { db: tx, now });
      stored.reaction = input.reaction;
      stored.comesBackText = schedule.status === "hidden"
        ? "hidden from practice"
        : relativeReturnText(schedule.comesBackAt, now);
      tx.prepare(
        `UPDATE practice_session_items SET reaction = ?, answer_json = ?
         WHERE id = ? AND learner_id = ? AND session_id = ? AND status = 'answered'
           AND reaction IS NULL`,
      ).run(input.reaction, JSON.stringify(stored), input.exerciseId, learnerId, sessionId);
    }
    return { answer: stored };
  }, db);
}

export function finishPracticeSession(
  learnerId: string,
  sessionId: string,
  deps: ServerDeps = {},
): FinishResponse {
  const db = deps.db ?? getDb();
  return immediate((tx) => {
    const session = getSession(tx, learnerId, sessionId);
    if (session.status === "finished" && session.summary_json) {
      return PracticeSessionFinishResponse.parse(JSON.parse(String(session.summary_json)));
    }
    const now = deps.now ?? new Date();
    const answered = tx.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(answer_correct), 0) AS correct
       FROM practice_session_items WHERE learner_id = ? AND session_id = ? AND status = 'answered'`,
    ).get(learnerId, sessionId) as Row;
    const startedAt = session.started_at === null ? null : new Date(String(session.started_at));
    const durationSeconds = startedAt ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)) : 0;
    const durationMinutes = startedAt ? Math.ceil(durationSeconds / 60) : 0;
    const count = Number(answered.count);
    const summary: FinishResponse = {
      sessionId,
      summary: `${count} ${count === 1 ? "word" : "words"} in ${durationMinutes} ${durationMinutes === 1 ? "minute" : "minutes"}.`,
      correct: Number(answered.correct),
      answered: count,
      total: Number(session.total),
      durationSeconds,
      durationMinutes,
    };
    tx.prepare(
      `UPDATE practice_sessions SET status = 'finished', finished_at = ?, summary_json = ?
       WHERE id = ? AND learner_id = ?`,
    ).run(now.toISOString(), JSON.stringify(summary), sessionId, learnerId);
    tx.prepare(
      `UPDATE practice_session_items SET status = 'failed'
       WHERE session_id = ? AND learner_id = ? AND status IN ('pending', 'generating', 'ready', 'issued')`,
    ).run(sessionId, learnerId);
    return PracticeSessionFinishResponse.parse(summary);
  }, db);
}

function claimNextItem(db: DatabaseSync, learnerId: string, sessionId: string, now: Date): ItemRow | undefined {
  return immediate((tx) => {
    const session = getSession(tx, learnerId, sessionId);
    if (session.status === "finished" || session.status === "empty" || session.status === "failed") return undefined;
    const staleBefore = new Date(now.getTime() - STALE_ITEM_LEASE_MS).toISOString();
    tx.prepare(
      `UPDATE practice_session_items SET status = 'pending', generation_id = NULL,
         generation_started_at = NULL
       WHERE learner_id = ? AND session_id = ? AND status = 'generating'
         AND generation_started_at < ?`,
    ).run(learnerId, sessionId, staleBefore);
    const active = tx.prepare(
      `SELECT 1 FROM practice_session_items WHERE learner_id = ? AND session_id = ?
         AND status = 'generating' LIMIT 1`,
    ).get(learnerId, sessionId);
    if (active) return undefined;
    const item = tx.prepare(
      `SELECT * FROM practice_session_items WHERE learner_id = ? AND session_id = ?
         AND status = 'pending' ORDER BY ordinal LIMIT 1`,
    ).get(learnerId, sessionId) as ItemRow | undefined;
    if (!item) return undefined;
    const generationId = newId();
    tx.prepare(
      `UPDATE practice_session_items SET status = 'generating', generation_id = ?,
         generation_started_at = ? WHERE id = ? AND learner_id = ? AND session_id = ? AND status = 'pending'`,
    ).run(generationId, now.toISOString(), String(item.id), learnerId, sessionId);
    return { ...item, status: "generating", generation_id: generationId } as ItemRow;
  }, db);
}

function failPreparation(db: DatabaseSync, learnerId: string, sessionId: string, itemId?: string, generationId?: string): void {
  try {
    immediate((tx) => {
      const session = tx.prepare(
        "SELECT status FROM practice_sessions WHERE id = ? AND learner_id = ?",
      ).get(sessionId, learnerId) as Row | undefined;
      if (!session || session.status === "finished") return;
      if (itemId && generationId) {
        const failed = tx.prepare(
          `UPDATE practice_session_items SET status = 'failed', generation_started_at = NULL
           WHERE id = ? AND learner_id = ? AND session_id = ? AND generation_id = ? AND status = 'generating'`,
        ).run(itemId, learnerId, sessionId, generationId);
        if (Number(failed.changes) === 0) return;
      }
      tx.prepare(
        `UPDATE practice_session_items SET status = 'failed', generation_started_at = NULL
         WHERE learner_id = ? AND session_id = ? AND status IN ('pending', 'generating')`,
      ).run(learnerId, sessionId);
      refreshSessionStatus(tx, learnerId, sessionId);
    }, db);
  } catch {
    // A later poll may retry recovery if the database itself was temporarily unavailable.
  }
}

function refreshSessionStatus(db: DatabaseSync, learnerId: string, sessionId: string): void {
  const session = getSession(db, learnerId, sessionId);
  if (session.status === "finished") return;
  const ready = countItems(db, learnerId, sessionId, "status IN ('ready', 'issued', 'answered')");
  const pending = countItems(db, learnerId, sessionId, "status IN ('pending', 'generating')");
  const total = Number(session.total);
  const threshold = Math.min(START_READY_COUNT, total);
  const status = total === 0 ? "empty" : ready >= threshold ? "ready" : pending === 0 ? "failed" : "preparing";
  db.prepare("UPDATE practice_sessions SET status = ? WHERE id = ? AND learner_id = ? AND status != 'finished'")
    .run(status, sessionId, learnerId);
}

function validateAndStoreExercise(exercise: PoolExercise, rung: 1 | 2 | 3 | 4, word: string): StoredExercise {
  if (exercise.rung !== rung) throw new Error("invalid exercise rung");
  const options = rung === 4 ? null : exercise.options;
  const publicExercise = PracticeSessionExercise.parse({
    exerciseId: newId(),
    rung,
    sentence: exercise.sentence,
    prompt: exercise.prompt,
    options,
  });
  if (rung === 4 && containsWord(`${publicExercise.sentence} ${publicExercise.prompt}`, word)) {
    throw new Error("hidden exercise leaked target");
  }
  return { ...exercise, expressionId: exercise.expressionId, rung, options: publicExercise.options };
}

function publicExercise(item: ItemRow) {
  const exercise = parseStoredExercise(item);
  return PracticeSessionExercise.parse({
    exerciseId: String(item.id),
    rung: exercise.rung,
    sentence: exercise.sentence,
    prompt: exercise.prompt,
    options: exercise.options,
  });
}

function parseStoredExercise(item: ItemRow): StoredExercise {
  if (!item.exercise_json) throw new ConflictError();
  const exercise = JSON.parse(item.exercise_json) as StoredExercise;
  return {
    ...exercise,
    rung: Math.min(4, Number(exercise.rung)) as 1 | 2 | 3 | 4,
    options: Number(exercise.rung) === 4 ? null : exercise.options,
  };
}

function getSession(db: DatabaseSync, learnerId: string, sessionId: string): SessionRow {
  const row = db.prepare("SELECT * FROM practice_sessions WHERE id = ? AND learner_id = ?").get(sessionId, learnerId) as SessionRow | undefined;
  if (!row) throw new NotFoundError();
  return row;
}

function getItem(db: DatabaseSync, learnerId: string, sessionId: string, exerciseId: string): ItemRow {
  const row = db.prepare(
    `SELECT * FROM practice_session_items WHERE id = ? AND learner_id = ? AND session_id = ?`,
  ).get(exerciseId, learnerId, sessionId) as ItemRow | undefined;
  if (!row) throw new NotFoundError();
  return row;
}

function countItems(db: DatabaseSync, learnerId: string, sessionId: string, condition: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM practice_session_items WHERE learner_id = ? AND session_id = ? AND ${condition}`,
  ).get(learnerId, sessionId) as Row;
  return Number(row.count);
}

function hasRecentReveal(db: DatabaseSync, learnerId: string, expressionId: string, now: Date): boolean {
  const cutoff = new Date(now.getTime() - HIDDEN_CUE_AFTER_MS).toISOString();
  const sessionReveal = db.prepare(
    `SELECT 1 FROM practice_session_items WHERE learner_id = ? AND expression_id = ?
       AND ((status = 'answered' AND answered_at >= ?)
         OR (CAST(json_extract(exercise_json, '$.rung') AS INTEGER) BETWEEN 1 AND 3 AND issued_at >= ?)) LIMIT 1`,
  ).get(learnerId, expressionId, cutoff, cutoff);
  if (sessionReveal) return true;
  const shownTask = db.prepare(
    `SELECT 1 FROM practice_tasks WHERE learner_id = ? AND expression_id = ?
       AND cue = 'shown' AND created_at >= ? LIMIT 1`,
  ).get(learnerId, expressionId, cutoff);
  if (shownTask) return true;
  return Boolean(db.prepare(
    `SELECT 1 FROM attempts a JOIN practice_tasks t
       ON t.id = a.task_id AND t.learner_id = a.learner_id
     WHERE a.learner_id = ? AND t.expression_id = ? AND a.status = 'evaluated'
       AND COALESCE(a.evaluated_at, a.created_at) >= ? LIMIT 1`,
  ).get(learnerId, expressionId, cutoff));
}

function relativeReturnText(value: string, now: Date): string {
  const days = Math.max(1, Math.ceil((new Date(value).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}
