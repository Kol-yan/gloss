// Practice task creation: pick the cue level, have the model write a short
// situation, and issue the first attempt for the learner's answer.
import type { DatabaseSync } from "node:sqlite";
import type { CreateTaskRequest, CueLevel, PracticeTask } from "@/shared/contracts";
import type { Learner } from "../auth/sessions";
import { reserve } from "../budget";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, learnerScope, type Row } from "../db";
import type { ServerDeps } from "../deps";
import {
  AiDisabledError,
  BudgetExhaustedError,
  ConflictError,
  NotFoundError,
  QuotaExceededError,
} from "../errors";
import { newId } from "../ids";
import { staleBefore } from "../stale";
import {
  ModelHttpError,
  ModelOutputError,
  ModelTimeoutError,
} from "../models/errors";
import { estimateMaxCostMicros } from "../models/meta";
import { resolveProviderAccess, textModel, type ProviderAccess } from "../models/access";
import { BUILD_PRACTICE_ROLE } from "../models/roles";
import { runReservedChat } from "../models/reserved-chat";
import {
  buildHint,
  buildSituationMessages,
  leaksExpression,
  parseSituation,
  SITUATION_JSON_SCHEMA,
  templateSituation,
} from "./situation";

// An expression is practised with the expression hidden once the learner has
// had an evaluated attempt at least this long ago (a later session, so it has
// to be recalled rather than copied).
export const HIDDEN_CUE_AFTER_MS = 12 * 60 * 60 * 1000;
const TEMPLATE_MODEL = "template";

export interface TaskDeps extends ServerDeps {
  config?: AppConfig;
}

export async function createTask(
  learner: Learner,
  input: CreateTaskRequest,
  deps: TaskDeps = {},
): Promise<PracticeTask> {
  const config = deps.config ?? getConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const access = resolveProviderAccess(learner.id, deps.providerAccess, db);
  const claimed = claimGeneration(db, learner.id, input, now, config, access);
  if ("task" in claimed) return claimed.task;
  const { expression, generationId } = claimed;

  const cue = chooseCue(db, learner.id, input.expressionId, now);
  const text = String(expression.text);
  const meaning = String(expression.meaning);

  try {
    const generated = await writeSituation({
      db,
      now,
      config,
      providerAccess: access,
      learnerId: learner.id,
      requestId: input.requestId,
      generationId,
      expression: text,
      meaning,
      kind: input.kind,
      cue,
    });

    const taskId = newId();
    const attemptId = newId();
    const hint = buildHint(text, meaning);
    immediate((tx) => {
      assertGenerationOwner(tx, learner.id, input.requestId, generationId);
      tx.prepare(
        `INSERT INTO practice_tasks
         (id, learner_id, expression_id, kind, cue, situation, hint, request_id, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        learner.id,
        input.expressionId,
        input.kind,
        cue,
        generated.situation,
        hint,
        input.requestId,
        generated.model,
        now.toISOString(),
      );
      tx.prepare(
        `INSERT INTO attempts (id, learner_id, task_id, status, created_at)
       VALUES (?, ?, ?, 'issued', ?)`,
      ).run(attemptId, learner.id, taskId, now.toISOString());
      tx.prepare(
        `UPDATE practice_task_requests SET status = 'completed'
         WHERE learner_id = ? AND request_id = ? AND generation_id = ?`,
      ).run(learner.id, input.requestId, generationId);
    }, db);

    return {
      id: taskId,
      expressionId: input.expressionId,
      kind: input.kind,
      cue,
      expression: cue === "hidden" ? null : text,
      meaning,
      situation: generated.situation,
      hint,
      attemptId,
    };
  } catch (error) {
    // Keep every reservation intact. A caller may explicitly retry a failed
    // generation, but a stale worker must never release its replacement's claim.
    db.prepare(
      `UPDATE practice_task_requests SET status = 'failed'
       WHERE learner_id = ? AND request_id = ? AND generation_id = ? AND status = 'pending'`,
    ).run(learner.id, input.requestId, generationId);
    throw error;
  }
}

function claimGeneration(
  db: DatabaseSync,
  learnerId: string,
  input: CreateTaskRequest,
  now: Date,
  config: AppConfig,
  access: ProviderAccess,
): { task: PracticeTask } | { expression: Row; generationId: string } {
  return immediate((tx) => {
    const scope = learnerScope(learnerId, tx);
    const stored = scope.selectOne("practice_tasks", {
      where: "request_id = :requestId",
      params: { requestId: input.requestId },
    });
    if (stored) {
      assertSameRequest(stored, input);
      return { task: storedTask(tx, learnerId, stored) };
    }

    const prior = tx
      .prepare("SELECT * FROM practice_task_requests WHERE learner_id = ? AND request_id = ?")
      .get(learnerId, input.requestId);
    if (prior) {
      assertSameRequest(prior, input);
      if (prior.status === "pending" && String(prior.started_at) >= staleBefore(now)) {
        throw new ConflictError();
      }
    } else {
      // A request started before durable claims were added may still be in
      // flight. Keep its reservation counted and wait for its lease to expire.
      const inFlight = tx
        .prepare(
          `SELECT 1 FROM usage_reservations
           WHERE learner_id = ? AND kind = 'evaluate' AND request_id IN (?, ?)
             AND status != 'settled' AND created_at >= ? LIMIT 1`,
        )
        .get(learnerId, input.requestId, `${input.requestId}:regenerate`, staleBefore(now));
      if (inFlight) throw new ConflictError();
    }

    const expression = scope.selectOne("expressions", {
      where: "id = :id",
      params: { id: input.expressionId },
    });
    if (!expression) throw new NotFoundError();
    textModel(access, config);

    const generationId = newId();
    tx.prepare(
      `INSERT INTO practice_task_requests
         (learner_id, request_id, expression_id, kind, generation_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (learner_id, request_id) DO UPDATE
       SET generation_id = excluded.generation_id, status = 'pending', started_at = excluded.started_at`,
    ).run(learnerId, input.requestId, input.expressionId, input.kind, generationId, now.toISOString());
    return { expression, generationId };
  }, db);
}

function assertSameRequest(row: Row, input: CreateTaskRequest): void {
  if (row.expression_id !== input.expressionId || row.kind !== input.kind) throw new ConflictError();
}

function assertGenerationOwner(
  db: DatabaseSync,
  learnerId: string,
  requestId: string,
  generationId: string,
): void {
  const owned = db
    .prepare(
      `SELECT 1 FROM practice_task_requests
       WHERE learner_id = ? AND request_id = ? AND generation_id = ? AND status = 'pending'`,
    )
    .get(learnerId, requestId, generationId);
  if (!owned) throw new ConflictError();
}

// "hidden" once the expression has an evaluated attempt created more than 12
// hours ago, otherwise "shown".
function chooseCue(db: DatabaseSync, learnerId: string, expressionId: string, now: Date): CueLevel {
  const cutoff = new Date(now.getTime() - HIDDEN_CUE_AFTER_MS).toISOString();
  const row = db
    .prepare(
      `SELECT 1 FROM attempts a JOIN practice_tasks t ON t.id = a.task_id
       WHERE a.learner_id = ? AND t.expression_id = ? AND a.status = 'evaluated'
         AND a.created_at < ? LIMIT 1`,
    )
    .get(learnerId, expressionId, cutoff);
  return row ? "hidden" : "shown";
}

interface SituationArgs {
  db: DatabaseSync;
  now: Date;
  config: AppConfig;
  providerAccess: ProviderAccess;
  learnerId: string;
  requestId: string;
  generationId: string;
  expression: string;
  meaning: string;
  kind: CreateTaskRequest["kind"];
  cue: CueLevel;
}

// Asks the model for a situation. If a hidden-cue situation leaks the
// expression it asks once more, then falls back to a generic template.
async function writeSituation(a: SituationArgs): Promise<{ situation: string; model: string }> {
  const model = textModel(a.providerAccess, a.config);
  const messages = buildSituationMessages({
    expression: a.expression,
    meaning: a.meaning,
    kind: a.kind,
  });
  const inputChars =
    messages.reduce((total, m) => total + m.content.length, 0) +
    JSON.stringify(SITUATION_JSON_SCHEMA).length;
  // Throws for a model without a price: no cost bound, no call.
  const maxCostMicros = estimateMaxCostMicros(model, inputChars, BUILD_PRACTICE_ROLE.maxTokens);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Each claimed generation pays for its own calls, without changing the
    // caller's logical request id or releasing earlier uncertain charges.
    const prefix = `${a.requestId}:${a.generationId}`;
    const requestId = attempt === 0 ? prefix : `${prefix}:regenerate`;
    let reservation;
    try {
      reservation = immediate((tx) => {
        assertGenerationOwner(tx, a.learnerId, a.requestId, a.generationId);
        const reserved = reserve(
          { learnerId: a.learnerId, kind: "evaluate", requestId, units: 1, maxCostMicros },
          { db: tx, now: a.now, config: a.config },
        );
        // Another attempt with this request id is in flight (or died halfway).
        if (reserved.replay) throw new ConflictError();
        return reserved;
      }, a.db);
    } catch (error) {
      // Out of allowance for the second try: the template still works.
      const spent =
        error instanceof QuotaExceededError ||
        error instanceof BudgetExhaustedError ||
        error instanceof AiDisabledError;
      if (attempt > 0 && spent) break;
      throw error;
    }

    let value: string;
    try {
      ({ value } = await runReservedChat({
        db: a.db,
        now: a.now,
        config: a.config,
        reservation,
        providerAccess: a.providerAccess,
        chat: {
          model,
          messages,
          jsonSchema: SITUATION_JSON_SCHEMA,
          maxTokens: BUILD_PRACTICE_ROLE.maxTokens,
          temperature: BUILD_PRACTICE_ROLE.temperature,
          reasoningEffort: BUILD_PRACTICE_ROLE.reasoningEffort,
        },
        parse: parseSituation,
      }));
    } catch (error) {
      // The first call failing is the learner's problem to retry; a failing
      // second call after a leak falls back to the template.
      if (attempt > 0 && isModelFailure(error)) break;
      throw error;
    }
    if (a.cue === "shown" || !leaksExpression(value, a.expression)) {
      return { situation: value, model };
    }
  }
  return { situation: templateSituation(a.expression), model: TEMPLATE_MODEL };
}

function isModelFailure(error: unknown): boolean {
  return (
    error instanceof ModelTimeoutError ||
    error instanceof ModelHttpError ||
    error instanceof ModelOutputError
  );
}

function storedTask(db: DatabaseSync, learnerId: string, task: Row): PracticeTask {
  const scope = learnerScope(learnerId, db);
  const expression = scope.selectOne("expressions", {
    where: "id = :id",
    params: { id: String(task.expression_id) },
  });
  const first = scope.selectOne("attempts", {
    where: "task_id = :taskId AND previous_attempt_id IS NULL",
    params: { taskId: String(task.id) },
  });
  if (!expression || !first) throw new NotFoundError();
  const cue = task.cue as CueLevel;
  return {
    id: String(task.id),
    expressionId: String(task.expression_id),
    kind: task.kind as PracticeTask["kind"],
    cue,
    expression: cue === "hidden" ? null : String(expression.text),
    meaning: String(expression.meaning),
    situation: String(task.situation),
    hint: String(task.hint),
    attemptId: String(first.id),
  };
}
