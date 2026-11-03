// Classifies a bounded set of sentences with a fast model. Inputs are hashed
// and validated before reservation; only hashes and model decisions persist.
import type { DatabaseSync } from "node:sqlite";
import {
  DetectResponse,
  MAX_DETECT_LOCAL_RANGES,
  MAX_DETECT_SENTENCES,
  MAX_DETECT_TOTAL_TEXT_LENGTH,
  type DetectLocalRange,
  type DetectRequest,
  type DetectResponse as DetectResponseType,
} from "@/shared/contracts";
import { hashText, normalizeText, splitSentences } from "@/lib/text";
import type { Learner } from "../auth/sessions";
import { getQuotaUsage, markUnknown, reserve, settle, type Reservation } from "../budget";
import { getConfig, type AppConfig } from "../config";
import { getDb, immediate, learnerScope, type Row } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, InvalidRequestError } from "../errors";
import { ModelHttpError, ModelOutputError, ModelTimeoutError } from "../models/errors";
import { estimateMaxCostMicros, type MetaChatResult } from "../models/meta";
import { resolveProviderAccess, resolveTextRoute, type ProviderAccess, type TextRoute } from "../models/access";
import { chatWithRoute } from "../models/dispatch";
import { settledTextCostMicros } from "../models/prices";
import { DETECT_ROLE } from "../models/roles";
import { staleBefore } from "../stale";
import { buildDetectMessages } from "./prompt";
import { DETECT_JSON_SCHEMA, parseDetectOutput } from "./schema";

export interface DetectDeps extends ServerDeps {
  config?: AppConfig;
  providerAccess?: ProviderAccess;
}

interface NormalizedSentence {
  hash: string;
  text: string;
  localRanges: DetectLocalRange[];
}

export async function detect(
  learner: Learner,
  input: DetectRequest,
  deps: DetectDeps = {},
): Promise<DetectResponseType> {
  const config = deps.config ?? getConfig();
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const sentences = await normalizeAndValidate(input);
  const fingerprint = await hashText(JSON.stringify(sentences.map(({ hash, text, localRanges }) => ({
    hash,
    text,
    localRanges,
  }))));

  const scope = learnerScope(learner.id, db);
  const prior = scope.selectOne("detect_runs", {
    where: "request_id = :requestId",
    params: { requestId: input.requestId },
  });
  if (prior) return replayOrConflict(prior, learner, input.requestId, fingerprint, db, now);

  const access = resolveProviderAccess(learner.id, deps.providerAccess, db);
  const route = resolveTextRoute(access, config, DETECT_ROLE.tier);
  const messages = buildDetectMessages(sentences);
  const inputChars =
    messages.reduce((total, message) => total + message.content.length, 0) +
    JSON.stringify(DETECT_JSON_SCHEMA).length;
  const maxCostMicros = estimateMaxCostMicros(
    route.model,
    inputChars,
    DETECT_ROLE.maxTokens,
    route.price,
  );

  const runId = crypto.randomUUID();
  const reservation = immediate((tx) => {
    // Serialize the run claim with reservation creation. A racing duplicate
    // never gets a second model call, even before the first result is stored.
    if (learnerScope(learner.id, tx).selectOne("detect_runs", {
      where: "request_id = :requestId",
      params: { requestId: input.requestId },
    })) throw new ConflictError();

    const reserved = reserve(
      {
        learnerId: learner.id,
        kind: "detect",
        requestId: input.requestId,
        units: 1,
        maxCostMicros,
      },
      { db: tx, now, config },
    );
    if (reserved.replay) throw new ConflictError();

    tx.prepare(
      `INSERT INTO detect_runs
         (id, learner_id, request_id, fingerprint, provider, model, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(runId, learner.id, input.requestId, fingerprint, route.provider, route.model, now.toISOString());
    return reserved;
  }, db);

  const started = performance.now();
  let result: MetaChatResult;
  try {
    result = await chatWithRoute(
      {
        model: route.model,
        messages,
        jsonSchema: DETECT_JSON_SCHEMA,
        maxTokens: DETECT_ROLE.maxTokens,
        temperature: DETECT_ROLE.temperature,
      },
      route,
      config,
    );
  } catch (error) {
    const latencyMs = error instanceof ModelHttpError || error instanceof ModelTimeoutError || error instanceof ModelOutputError
      ? error.latencyMs
      : Math.round(performance.now() - started);
    closeFailedRun({ db, now, reservation, runId, learnerId: learner.id, route, maxCostMicros }, error, latencyMs);
    console.info("[gloss] detect failed", JSON.stringify({
      provider: error instanceof ModelOutputError ? error.servingProvider ?? route.provider : route.provider,
      model: route.model,
      latencyMs,
      settledCostMicros: error instanceof ModelHttpError
        ? 0
        : error instanceof ModelOutputError
          ? settledTextCostMicros(route.price, error.usage, maxCostMicros)
          : null,
      maxCostMicros,
      status: error instanceof ModelTimeoutError ? "unknown" : "failed",
    }));
    throw error;
  }

  const output = parseDetectOutput(result.content, sentences.length);
  if (!output) {
    const error = new ModelOutputError(
      "invalid_output",
      result.usage,
      result.latencyMs,
      result.servingProvider,
    );
    closeFailedRun({ db, now, reservation, runId, learnerId: learner.id, route, maxCostMicros }, error, result.latencyMs);
    console.info("[gloss] detect failed", JSON.stringify({
      provider: result.servingProvider ?? route.provider,
      model: route.model,
      latencyMs: result.latencyMs,
      settledCostMicros: settledTextCostMicros(route.price, result.usage, maxCostMicros),
      maxCostMicros,
      status: "failed",
    }));
    throw error;
  }

  const detected = output.map((decision) => ({
    hash: sentences[decision.sentence_index].hash,
    needs_correction: decision.needs_correction,
    needs_clarity: decision.needs_clarity,
    needs_word_choice: decision.needs_word_choice,
  }));
  const settledCostMicros = settledTextCostMicros(route.price, result.usage, maxCostMicros);
  let response!: DetectResponseType;

  immediate((tx) => {
    settle(reservation.id, settledCostMicros, { db: tx, now });
    response = DetectResponse.parse({
      requestId: input.requestId,
      sentences: detected,
      quota: getQuotaUsage(learner, { db: tx, now }).detect,
    });
    tx.prepare(
      `UPDATE detect_runs
       SET status = 'ok', latency_ms = ?, serving_provider = ?, settled_cost_micros = ?, response_json = ?
       WHERE id = ? AND learner_id = ?`,
    ).run(
      result.latencyMs,
      result.servingProvider ?? null,
      settledCostMicros,
      JSON.stringify(response),
      runId,
      learner.id,
    );
  }, db);

  console.info("[gloss] detect served", JSON.stringify({
    provider: result.servingProvider ?? "unknown",
    model: route.model,
    latencyMs: result.latencyMs,
    settledCostMicros,
  }));
  return response;
}

async function normalizeAndValidate(input: DetectRequest): Promise<NormalizedSentence[]> {
  if (!input || !Array.isArray(input.sentences) || input.sentences.length < 1 || input.sentences.length > MAX_DETECT_SENTENCES) {
    throw new InvalidRequestError();
  }

  const sentences: NormalizedSentence[] = [];
  const hashes = new Set<string>();
  let totalLength = 0;
  for (const sentence of input.sentences) {
    if (!sentence || typeof sentence.text !== "string" || typeof sentence.hash !== "string") {
      throw new InvalidRequestError();
    }
    const text = normalizeText(sentence.text);
    totalLength += text.length;
    if (
      !text.trim() ||
      totalLength > MAX_DETECT_TOTAL_TEXT_LENGTH ||
      splitSentences(text).length !== 1
    ) throw new InvalidRequestError();

    const localRanges = sentence.localRanges ?? [];
    if (!Array.isArray(localRanges) || localRanges.length > MAX_DETECT_LOCAL_RANGES) {
      throw new InvalidRequestError();
    }
    const checkedRanges: DetectLocalRange[] = [];
    for (const range of localRanges) {
      if (
        !range ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 0 ||
        range.end <= range.start ||
        range.end > text.length ||
        !isUtf16Boundary(text, range.start) ||
        !isUtf16Boundary(text, range.end)
      ) throw new InvalidRequestError();
      checkedRanges.push({ start: range.start, end: range.end });
    }

    const actualHash = await hashText(text);
    if (!/^[a-f0-9]{64}$/.test(sentence.hash) || sentence.hash !== actualHash || hashes.has(actualHash)) {
      throw new InvalidRequestError();
    }
    hashes.add(actualHash);
    sentences.push({ hash: actualHash, text, localRanges: canonicalizeRanges(checkedRanges) });
  }
  return sentences;
}

function canonicalizeRanges(ranges: DetectLocalRange[]): DetectLocalRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DetectLocalRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function isUtf16Boundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function replayOrConflict(
  prior: Row,
  learner: Learner,
  requestId: string,
  fingerprint: string,
  db: DatabaseSync,
  now: Date,
): DetectResponseType {
  if (prior.fingerprint !== fingerprint) throw new ConflictError();

  if (prior.status === "pending" && String(prior.created_at) < staleBefore(now)) {
    immediate((tx) => {
      const scope = learnerScope(learner.id, tx);
      const current = scope.selectOne("detect_runs", {
        where: "request_id = :requestId",
        params: { requestId },
      });
      if (!current || current.status !== "pending" || String(current.created_at) >= staleBefore(now)) return;
      tx.prepare("UPDATE detect_runs SET status = 'unknown' WHERE id = ? AND learner_id = ? AND status = 'pending'")
        .run(String(current.id), learner.id);
      const reservation = scope.selectOne("usage_reservations", {
        where: "kind = 'detect' AND request_id = :requestId",
        params: { requestId },
      });
      if (reservation?.status === "reserved") markUnknown(String(reservation.id), { db: tx, now });
    }, db);
  }

  const current = learnerScope(learner.id, db).selectOne("detect_runs", {
    where: "request_id = :requestId",
    params: { requestId },
  });
  if (!current || current.fingerprint !== fingerprint || current.status !== "ok" || typeof current.response_json !== "string") {
    throw new ConflictError();
  }

  try {
    const cached = DetectResponse.parse(JSON.parse(current.response_json));
    if (cached.requestId !== requestId) throw new Error("invalid cached response");
    return { ...cached, quota: getQuotaUsage(learner, { db, now }).detect };
  } catch {
    throw new ConflictError();
  }
}

interface Bookkeeping {
  db: DatabaseSync;
  now: Date;
  reservation: Reservation;
  runId: string;
  learnerId: string;
  route: TextRoute;
  maxCostMicros: number;
}

function closeFailedRun(b: Bookkeeping, error: unknown, latencyMs: number): void {
  immediate((tx) => {
    const deps = { db: tx, now: b.now };
    if (error instanceof ModelHttpError) {
      settle(b.reservation.id, 0, deps);
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs, undefined, 0);
    } else if (error instanceof ModelOutputError) {
      const settledCostMicros = settledTextCostMicros(b.route.price, error.usage, b.maxCostMicros);
      settle(b.reservation.id, settledCostMicros, deps);
      updateRun(tx, b.runId, b.learnerId, "failed", latencyMs, error.servingProvider, settledCostMicros);
    } else {
      markUnknown(b.reservation.id, deps);
      updateRun(
        tx,
        b.runId,
        b.learnerId,
        error instanceof ModelTimeoutError ? "unknown" : "failed",
        latencyMs,
      );
    }
  }, b.db);
}

function updateRun(
  db: DatabaseSync,
  runId: string,
  learnerId: string,
  status: "failed" | "unknown",
  latencyMs: number,
  servingProvider?: string,
  settledCostMicros?: number,
): void {
  db.prepare(
    `UPDATE detect_runs SET status = ?, latency_ms = ?, serving_provider = ?, settled_cost_micros = ?
     WHERE id = ? AND learner_id = ?`,
  ).run(status, latencyMs, servingProvider ?? null, settledCostMicros ?? null, runId, learnerId);
}
