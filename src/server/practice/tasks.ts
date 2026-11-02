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
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
} from "../models/errors";
import { estimateMaxCostMicros } from "../models/meta";
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
  const scope = learnerScope(learner.id, db);

  // A retry with the same request id gets the stored task, never a second call.
  const stored = scope.selectOne("practice_tasks", {
    where: "request_id = :requestId",
    params: { requestId: input.requestId },
  });
  if (stored) {
    if (stored.expression_id !== input.expressionId || stored.kind !== input.kind) {
      throw new ConflictError();
    }
    return storedTask(db, learner.id, stored);
  }

  const expression = scope.selectOne("expressions", {
    where: "id = :id",
    params: { id: input.expressionId },
  });
  if (!expression) throw new NotFoundError();
  if (!config.meta.apiKey) throw new ModelNotConfiguredError();

  const cue = chooseCue(db, learner.id, input.expressionId, now);
  const text = String(expression.text);
  const meaning = String(expression.meaning);

  const generated = await writeSituation({
    db,
    now,
    config,
    learnerId: learner.id,
    requestId: input.requestId,
    expression: text,
    meaning,
    kind: input.kind,
    cue,
  });

  const taskId = newId();
  const attemptId = newId();
  const hint = buildHint(text, meaning);
  immediate((tx) => {
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
  learnerId: string;
  requestId: string;
  expression: string;
  meaning: string;
  kind: CreateTaskRequest["kind"];
  cue: CueLevel;
}

// Asks the model for a situation. If a hidden-cue situation leaks the
// expression it asks once more, then falls back to a generic template.
async function writeSituation(a: SituationArgs): Promise<{ situation: string; model: string }> {
  const model = a.config.meta.textModel;
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
    // The second request id keeps the first reservation intact.
    const requestId = attempt === 0 ? a.requestId : `${a.requestId}:regenerate`;
    let reservation;
    try {
      reservation = immediate((tx) => {
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
        chat: {
          model,
          messages,
          jsonSchema: SITUATION_JSON_SCHEMA,
          maxTokens: BUILD_PRACTICE_ROLE.maxTokens,
          temperature: BUILD_PRACTICE_ROLE.temperature,
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
