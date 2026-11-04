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
import { ModelHttpError, ModelNotConfiguredError, ModelOutputError, ModelTimeoutError } from "../models/errors";
import { estimateMaxCostMicros, type MetaChatResult } from "../models/meta";
import { resolveProviderAccess, resolveTextRoute } from "../models/access";
import { chatWithRoute } from "../models/dispatch";
import { settledTextCostMicros, type TextPrice } from "../models/prices";
import { PROOFREAD_ROLE } from "../models/roles";
import { buildProofreadMessages } from "./prompt";
import { resolveProofread, type ProofreadMode } from "./edits";
import { PROOFREAD_JSON_SCHEMA, parseProofreadOutput } from "./schema";

export interface ProofreadDeps extends ServerDeps {
  config?: AppConfig;
  // "verify" is for re-checking text that was already corrected: only
  // definite mistakes are reported, and an unchanged sentence has none.
  // The default checks fully and also offers optional improvements.
  mode?: ProofreadMode;
}

export async function proofread(
  learner: Learner,
  input: ProofreadRequest,
  deps: ProofreadDeps = {},
): Promise<ProofreadResponse> {
  const mode = deps.mode ?? "check";
  return runCheckJob(learner, input, {
    purpose: "proofread",
    quotaKind: "proofread",
    role: PROOFREAD_ROLE,
    messages: buildProofreadMessages(splitSentences(normalizeText(input.text)), mode),
    jsonSchema: PROOFREAD_JSON_SCHEMA,
    parse: (content) => {
      const output = parseProofreadOutput(content);
      return output ? resolveProofread(splitSentences(normalizeText(input.text)), output, mode) : null;
    },
  }, deps);
}

// Both jobs share atomic reservation, persistence and decision handling. Only
// the Learning entry point can supply a personal expression list in messages.
export interface CheckJob {
  purpose: "proofread" | "learning";
  quotaKind: "proofread" | "detect";
  role: { tier: "fast"; maxTokens: number; temperature: number };
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  parse: (content: string) => Suggestion[] | null;
}

export async function runCheckJob(
  learner: Learner,
  input: ProofreadRequest,
  job: CheckJob,
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
    if (existing.purpose !== job.purpose) throw new ConflictError();
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
      suggestions: storedSuggestions(db, learner.id, checkRunId).map((suggestion) =>
        job.purpose === "learning" ? { ...suggestion, origin: "learning" as const } : suggestion),
      quota: getQuotaUsage(learner, { db, now })[job.quotaKind],
    };
  }

  // Routine job: the fast tier. Throws before any reservation when it cannot
  // be served (no key, or a model without a cost bound).
  const route = resolveTextRoute(access, config, job.role.tier);
  // An opaque preset cannot guarantee that this operation never uses Spark.
  if (job.purpose === "learning" && (/spark/i.test(route.model) || route.model.startsWith("@preset/"))) {
    throw new ModelNotConfiguredError();
  }
  const messages = job.messages;
  const inputChars =
    messages.reduce((total, message) => total + message.content.length, 0) +
    JSON.stringify(job.jsonSchema).length;
  // Throws for a model without a price: no cost bound, no call.
  const maxCostMicros = estimateMaxCostMicros(route.model, inputChars, job.role.maxTokens, route.price);

  // Reservation and check run appear together or not at all. A reservation
  // that already exists means another attempt with this request id is in
  // flight (or died halfway), so this one must not call the model.
  const runId = newId();
  const reservation = immediate((tx) => {
    const reserved = reserve(
      {
        learnerId: learner.id,
        kind: job.quotaKind,
        requestId: input.requestId,
        units: 1,
        maxCostMicros,
      },
      { db: tx, now, config },
    );
    if (reserved.replay) throw new ConflictError();
    tx.prepare(
      `INSERT INTO check_runs
         (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      runId,
      learner.id,
      input.requestId,
      textHash,
      text.length,
      route.provider,
      route.model,
      now.toISOString(),
      job.purpose,
    );
    return reserved;
  }, db);

  const bookkeeping = { db, now, reservation, runId, learnerId: learner.id, price: route.price, maxCostMicros };
  const started = performance.now();

  let result: MetaChatResult;
  try {
    // Deliberately not tied to the request's abort signal: if the browser
    // disconnects, the call still finishes and its result is stored, so a
    // retry with the same request id gets it without a second charge.
    result = await chatWithRoute(
      {
        model: route.model,
        messages,
        jsonSchema: job.jsonSchema,
        maxTokens: job.role.maxTokens,
        temperature: job.role.temperature,
      },
      route,
      config,
    );
  } catch (error) {
    closeFailedRun(bookkeeping, error, Math.round(performance.now() - started));
    throw error;
  }

  const parsedSuggestions = job.parse(result.content);
  if (!parsedSuggestions) {
    const error = new ModelOutputError("invalid_output", result.usage, result.latencyMs, result.servingProvider);
    closeFailedRun(bookkeeping, error, result.latencyMs);
    throw error;
  }
  const suggestions = parsedSuggestions.map((suggestion) =>
    job.purpose === "learning" ? { ...suggestion, origin: "learning" as const } : suggestion);
  const settledCostMicros = settledTextCostMicros(route.price, result.usage, maxCostMicros);

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
    updateRun(tx, runId, learner.id, "ok", result.latencyMs, result.servingProvider, settledCostMicros);
    settle(reservation.id, settledCostMicros, { db: tx, now });
  }, db);

  console.info("[gloss] check served", JSON.stringify({
    purpose: job.purpose,
    provider: result.servingProvider ?? "unknown",
    model: route.model,
    latencyMs: result.latencyMs,
    settledCostMicros,
  }));

  return {
    checkRunId: runId,
    textHash,
    suggestions,
    quota: getQuotaUsage(learner, { db, now })[job.quotaKind],
  };
}

interface Bookkeeping {
  db: DatabaseSync;
  now: Date;
  reservation: Reservation;
  runId: string;
  learnerId: string;
  price: TextPrice;
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
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs, undefined, 0);
    } else if (error instanceof ModelOutputError) {
      const settledCostMicros = settledTextCostMicros(b.price, error.usage, b.maxCostMicros);
      settle(b.reservation.id, settledCostMicros, deps);
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs, error.servingProvider, settledCostMicros);
    } else {
      // ModelTimeoutError or anything unexpected: assume the provider may have
      // done the work.
      markUnknown(b.reservation.id, deps);
      const status = error instanceof ModelTimeoutError ? "unknown" : "failed";
      updateRun(tx, b.runId, b.learnerId, status, latencyMs);
    }
  }, b.db);
}

function updateRun(
  db: DatabaseSync,
  runId: string,
  learnerId: string,
  status: "ok" | "failed" | "unknown",
  latencyMs: number,
  servingProvider?: string,
  settledCostMicros?: number,
): void {
  db.prepare(
    `UPDATE check_runs SET status = ?, latency_ms = ?, serving_provider = ?, settled_cost_micros = ?
     WHERE id = ? AND learner_id = ?`,
  ).run(status, latencyMs, servingProvider ?? null, settledCostMicros ?? null, runId, learnerId);
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
