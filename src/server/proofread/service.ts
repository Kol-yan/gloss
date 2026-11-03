// Cloud proofreading of one text: idempotency, budget reservation, the model
// call and bookkeeping. The model call happens outside any database
// transaction; the reservation and the final write are each atomic.
import type { DatabaseSync } from "node:sqlite";
import { hashText, normalizeText, splitSentences } from "@/lib/text";
import { sanitizeIpa } from "@/lib/pronunciation";
import {
  MAX_TEXT_LENGTH,
  type ProofreadRequest,
  type ProofreadResponse,
  type Suggestion,
} from "@/shared/contracts";
import type { Learner } from "../auth/sessions";
import { getQuotaUsage, markUnknown, reserve, settle, type Reservation } from "../budget";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, learnerScope, type Row } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, InvalidRequestError } from "../errors";
import { newId } from "../ids";
import { staleBefore } from "../stale";
import {
  ModelHttpError,
  ModelOutputError,
  ModelTimeoutError,
  type TokenUsage,
} from "../models/errors";
import { estimateMaxCostMicros, type MetaChatResult } from "../models/meta";
import { resolveProviderAccess, textModel } from "../models/access";
import { chatWithAccess } from "../models/dispatch";
import { textCostMicros } from "../models/prices";
import { buildProofreadMessages } from "./prompt";
import { resolveEdits } from "./edits";
import { PROOFREAD_JSON_SCHEMA, PROOFREAD_MAX_TOKENS, parseProofreadOutput } from "./schema";

export interface ProofreadDeps extends ServerDeps {
  config?: AppConfig;
}

export async function proofread(
  learner: Learner,
  input: ProofreadRequest,
  deps: ProofreadDeps = {},
): Promise<ProofreadResponse> {
  const config = deps.config ?? getConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const access = resolveProviderAccess(learner.id, deps.providerAccess, db);

  const text = normalizeText(input.text);
  const sentences = splitSentences(text);
  // Normalization can lengthen text in rare cases; whitespace-only text has
  // nothing to check.
  if (text.length > MAX_TEXT_LENGTH || sentences.length === 0) throw new InvalidRequestError();
  const textHash = await hashText(text);

  // A retry with the same request id gets the stored result, never a second call.
  const scope = learnerScope(learner.id, db);
  const existing = scope.selectOne("check_runs", {
    where: "request_id = :requestId",
    params: { requestId: input.requestId },
  });
  if (existing) {
    // A run still 'pending' after two minutes was abandoned by a dead process:
    // record it as failed. Its reservation is swept to 'unknown' by the next
    // reservation, so the cost stays counted.
    if (existing.status === "pending" && String(existing.created_at) < staleBefore(now)) {
      db.prepare(
        "UPDATE check_runs SET status = 'failed' WHERE id = ? AND learner_id = ? AND status = 'pending'",
      ).run(String(existing.id), learner.id);
    }
    if (existing.text_hash !== textHash || existing.status !== "ok") throw new ConflictError();
    const checkRunId = String(existing.id);
    return {
      checkRunId,
      textHash,
      suggestions: storedSuggestions(db, learner.id, checkRunId),
      quota: getQuotaUsage(learner, { db, now }).proofread,
    };
  }

  const model = textModel(access, config);
  const messages = buildProofreadMessages(sentences);
  const inputChars =
    messages.reduce((total, message) => total + message.content.length, 0) +
    JSON.stringify(PROOFREAD_JSON_SCHEMA).length;
  // Throws for a model without a price: no cost bound, no call.
  const maxCostMicros = estimateMaxCostMicros(model, inputChars, PROOFREAD_MAX_TOKENS);

  // Reservation and check run appear together or not at all. A reservation
  // that already exists means another attempt with this request id is in
  // flight (or died halfway), so this one must not call the model.
  const runId = newId();
  const reservation = immediate((tx) => {
    const reserved = reserve(
      {
        learnerId: learner.id,
        kind: "proofread",
        requestId: input.requestId,
        units: 1,
        maxCostMicros,
      },
      { db: tx, now, config },
    );
    if (reserved.replay) throw new ConflictError();
    tx.prepare(
      `INSERT INTO check_runs
         (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      runId,
      learner.id,
      input.requestId,
      textHash,
      text.length,
      access.provider,
      model,
      now.toISOString(),
    );
    return reserved;
  }, db);

  const bookkeeping = { db, now, reservation, runId, learnerId: learner.id, model, maxCostMicros };
  const started = performance.now();

  let result: MetaChatResult;
  try {
    // Deliberately not tied to the request's abort signal: if the browser
    // disconnects, the call still finishes and its result is stored, so a
    // retry with the same request id gets it without a second charge.
    result = await chatWithAccess(
      {
        model,
        messages,
        jsonSchema: PROOFREAD_JSON_SCHEMA,
        maxTokens: PROOFREAD_MAX_TOKENS,
        reasoningEffort: "minimal",
        temperature: 0,
      },
      access,
      config,
    );
  } catch (error) {
    closeFailedRun(bookkeeping, error, Math.round(performance.now() - started));
    throw error;
  }

  const edits = parseProofreadOutput(result.content);
  if (!edits) {
    const error = new ModelOutputError("invalid_output", result.usage, result.latencyMs);
    closeFailedRun(bookkeeping, error, result.latencyMs);
    throw error;
  }
  const suggestions = resolveEdits(sentences, edits);

  immediate((tx) => {
    const insert = tx.prepare(
      `INSERT INTO suggestions
         (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason,
          meaning_change, meaning, ipa, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const s of suggestions) {
      insert.run(
        s.id,
        runId,
        learner.id,
        s.start,
        s.end,
        s.original,
        s.replacement,
        s.category,
        s.reason,
        s.meaningChange ? 1 : 0,
        s.meaning,
        s.ipa ?? null,
      );
    }
    updateRun(tx, runId, learner.id, "ok", result.latencyMs);
    settle(reservation.id, actualCost(model, result.usage, maxCostMicros), { db: tx, now });
  }, db);

  return {
    checkRunId: runId,
    textHash,
    suggestions,
    quota: getQuotaUsage(learner, { db, now }).proofread,
  };
}

interface Bookkeeping {
  db: DatabaseSync;
  now: Date;
  reservation: Reservation;
  runId: string;
  learnerId: string;
  model: string;
  maxCostMicros: number;
}

// Settles the reservation and closes the check run after a failed call:
// - outcome unknown (timeout, dropped connection): keep counting max cost;
// - provider refused (HTTP error): nothing was billed, cost 0;
// - unusable output: the work was billed, so use reported usage or max cost.
function closeFailedRun(b: Bookkeeping, error: unknown, latencyMs: number): void {
  immediate((tx) => {
    const deps = { db: tx, now: b.now };
    if (error instanceof ModelHttpError) {
      settle(b.reservation.id, 0, deps);
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs);
    } else if (error instanceof ModelOutputError) {
      settle(b.reservation.id, actualCost(b.model, error.usage, b.maxCostMicros), deps);
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs);
    } else {
      // ModelTimeoutError or anything unexpected: assume the provider may have
      // done the work.
      markUnknown(b.reservation.id, deps);
      const status = error instanceof ModelTimeoutError ? "unknown" : "failed";
      updateRun(tx, b.runId, b.learnerId, status, latencyMs);
    }
  }, b.db);
}

function actualCost(model: string, usage: TokenUsage | null, maxCostMicros: number): number {
  return usage ? textCostMicros(model, usage.inputTokens, usage.outputTokens) : maxCostMicros;
}

function updateRun(
  db: DatabaseSync,
  runId: string,
  learnerId: string,
  status: "ok" | "failed" | "unknown",
  latencyMs: number,
): void {
  db.prepare(
    "UPDATE check_runs SET status = ?, latency_ms = ? WHERE id = ? AND learner_id = ?",
  ).run(status, latencyMs, runId, learnerId);
}

function storedSuggestions(db: DatabaseSync, learnerId: string, runId: string): Suggestion[] {
  const rows: Row[] = learnerScope(learnerId, db).select("suggestions", {
    where: "check_run_id = :runId",
    params: { runId },
    orderBy: "start",
  });
  return rows.map((row) => ({
    id: String(row.id),
    source: "ai",
    category: row.category as Suggestion["category"],
    start: Number(row.start),
    end: Number(row.end),
    original: String(row.original),
    replacement: String(row.replacement),
    reason: String(row.reason),
    meaningChange: row.meaning_change === 1,
    meaning: row.meaning === null ? null : String(row.meaning),
    ipa: row.category === "expression" ? sanitizeIpa(row.ipa, String(row.replacement)) : null,
  }));
}
