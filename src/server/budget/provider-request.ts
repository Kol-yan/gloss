import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  BudgetExhaustedError,
  AiDisabledError,
} from "../errors";
import { ModelHttpError, ModelTimeoutError } from "../models/errors";
import type { BudgetDeps, Reservation } from "./index";
import { getBudgetStatus, readFundedUntilMs, recordProviderReportedCost } from "./index";
import { immediate } from "../db";
import type { AppConfig } from "../config";
import { mockProviderFetch } from "../models/mock-provider";
import {
  asrCostMicros,
  asrPrice,
  estimateMaxCostMicros,
  textPrice,
  type AsrPrice,
  type TextPrice,
} from "../models/prices";
import {
  OPENROUTER_ASR_MODEL,
  OPENROUTER_FAST_MODEL,
  OPENROUTER_TEXT_MODEL,
  hostedFastRoute,
  providerKey,
} from "../models/access";
import { InvalidWavError, parseWav } from "../practice/wav";

export type ModelProvider = "meta" | "openrouter";
export type ModelOperation = "chat" | "asr";

export interface ProviderCallPolicy {
  provider: ModelProvider;
  operation: ModelOperation;
  model: string;
  apiKey: string;
  price: TextPrice | AsrPrice;
}

export interface BudgetedCallDeps extends BudgetDeps {
  db: DatabaseSync;
  now: Date;
  config: AppConfig;
  reservation: Reservation;
  providerCall: ProviderCallPolicy;
}

interface BudgetedCallContext {
  reservationId: string;
  configRef: AppConfig;
  deps: BudgetedCallDeps;
}

const calls = new AsyncLocalStorage<BudgetedCallContext>();
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CHAT_MAX_TOKENS = 4096;
const CHAT_MIN_TOKENS = 2048;
const MAX_AUDIO_SECONDS = 60;

const ROLE_CONTRACTS: Record<string, { kind: string; operation: ModelOperation; maxTokens?: number }> = {
  proofread: { kind: "proofread", operation: "chat", maxTokens: 4096 },
  detect: { kind: "detect", operation: "chat", maxTokens: 2048 },
  learning: { kind: "detect", operation: "chat", maxTokens: 2048 },
  build_practice: { kind: "evaluate", operation: "chat", maxTokens: 4096 },
  practice_pool: { kind: "detect", operation: "chat", maxTokens: 4096 },
  evaluate_attempt: { kind: "evaluate", operation: "chat", maxTokens: 4096 },
  dictation_cleanup: { kind: "proofread", operation: "chat", maxTokens: 2048 },
  practice_speech: { kind: "asrSeconds", operation: "asr" },
  dictation_asr: { kind: "asrSeconds", operation: "asr" },
};

class ProviderRequestBlockedError extends Error {
  constructor() {
    super("Provider request is not authorized by an active budget reservation");
    this.name = "ProviderRequestBlockedError";
  }
}

// The async scope is installed only by the budget-owned model dispatcher. A
// test mock still passes through every authorization and ledger check below.
export function withBudgetedCall<T>(
  reservationId: string,
  deps: BudgetedCallDeps,
  callback: () => T,
): T {
  if (!reservationId || reservationId !== deps.reservation.id) throw new ProviderRequestBlockedError();
  if (!deps.db || !deps.now || !deps.config || !deps.providerCall) throw new ProviderRequestBlockedError();
  const policy = Object.freeze({ ...deps.providerCall, price: Object.freeze({ ...deps.providerCall.price }) });
  const reservation = Object.freeze({ ...deps.reservation });
  const config = freezeConfig(structuredClone(deps.config));
  const callDeps = { ...deps, reservation, now: new Date(deps.now.getTime()), config, providerCall: policy };
  return calls.run({ reservationId, configRef: deps.config, deps: callDeps }, callback);
}

export async function sendProviderRequest(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; config: AppConfig },
): Promise<{ bodyText: string; latencyMs: number }> {
  const context = calls.getStore();
  if (!context) throw new ProviderRequestBlockedError();
  if (options.config !== context.configRef) throw new ProviderRequestBlockedError();

  const request = snapshotRequest(init);
  const outbound = await inspectRequest(url, request, context.deps.providerCall, context.deps.config);
  claimReservation(context, outbound);

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const send = context.deps.config.modelMock ? mockProviderFetch : fetch;

  let status: number;
  let bodyText = "";
  try {
    const response = await send(url, { ...request, redirect: "error", signal });
    status = response.status;
    if (response.ok) {
      bodyText = await response.text();
      recordTransportCost(context, bodyText);
    }
    else await response.body?.cancel().catch(() => undefined);
  } catch {
    const reason = timeout.aborted ? "timeout" : options.signal?.aborted ? "aborted" : "network";
    throw new ModelTimeoutError(reason, elapsed());
  }

  const latencyMs = elapsed();
  if (status < 200 || status >= 300) throw new ModelHttpError(status, latencyMs);
  return { bodyText, latencyMs };
}

function snapshotRequest(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (body instanceof FormData) {
    const copy = new FormData();
    for (const [name, value] of body.entries()) copy.append(name, value);
    body = copy;
  }
  return { method: init.method, headers, body, redirect: "error" };
}

function recordTransportCost(context: BudgetedCallContext, bodyText: string): void {
  let envelope: unknown;
  try {
    envelope = JSON.parse(bodyText);
  } catch {
    return;
  }
  if (!isRecord(envelope) || !isRecord(envelope.usage)) return;
  const usage = envelope.usage;
  const costUsd = typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
    ? usage.cost
    : undefined;
  if (costUsd === undefined) return;
  let totalUsd = costUsd;
  if (context.deps.providerCall.provider === "openrouter" && usage.is_byok === true) {
    const costDetails = usage.cost_details;
    const upstream = isRecord(costDetails) && typeof costDetails.upstream_inference_cost === "number" &&
      Number.isFinite(costDetails.upstream_inference_cost) && costDetails.upstream_inference_cost >= 0
      ? costDetails.upstream_inference_cost
      : undefined;
    if (upstream === undefined) return;
    totalUsd += upstream;
  }
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return;
  const costMicros = Math.ceil(Math.round(totalUsd * 1_000_000_000) / 1_000);
  if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return;
  recordProviderReportedCost(context.reservationId, costMicros, {
    db: context.deps.db,
    now: new Date(),
    config: context.deps.config,
  });
}

interface InspectedRequest {
  maxCostMicros: number;
  units: number;
}

async function inspectRequest(
  urlValue: string,
  init: RequestInit,
  policy: ProviderCallPolicy,
  config: AppConfig,
): Promise<InspectedRequest> {
  if (init.method !== "POST" || init.redirect !== "error") {
    throw new ProviderRequestBlockedError();
  }
  const url = new URL(urlValue);
  const expectedUrl = expectedProviderUrl(policy, config);
  if (url.href !== expectedUrl || url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestBlockedError();
  }
  const headers = new Headers(init.headers);
  if (headers.get("authorization") !== `Bearer ${policy.apiKey}`) throw new ProviderRequestBlockedError();
  const allowedHeaders = new Set(policy.provider === "meta"
    ? policy.operation === "chat" ? ["authorization", "content-type"] : ["authorization", "accept"]
    : ["authorization", "accept", "content-type", "http-referer", "x-openrouter-title"]);
  for (const [name, value] of headers) {
    if (!allowedHeaders.has(name)) throw new ProviderRequestBlockedError();
    if (name === "accept" && value !== "application/json") throw new ProviderRequestBlockedError();
    if (name === "content-type" && value !== "application/json") throw new ProviderRequestBlockedError();
    if (name === "http-referer" && value !== config.publicUrl) throw new ProviderRequestBlockedError();
    if (name === "x-openrouter-title" && value !== "gloss") throw new ProviderRequestBlockedError();
  }
  if (policy.provider === "openrouter" && policy.operation === "asr" &&
    headers.get("content-type") !== "application/json") throw new ProviderRequestBlockedError();

  if (policy.operation === "chat") {
    if (typeof init.body !== "string" || headers.get("content-type") !== "application/json") {
      throw new ProviderRequestBlockedError();
    }
    const payload = parseJsonRecord(init.body);
    validateChatPayload(payload, policy);
    const messages = payload.messages as { role: string; content: string }[];
    const schemaObject = (payload.response_format as Record<string, unknown>).json_schema as Record<string, unknown>;
    const schema = schemaObject.schema;
    const name = schemaObject.name;
    if (typeof name !== "string" || !isRecord(schema)) throw new ProviderRequestBlockedError();
    const inputChars = messages.reduce((n, message) => n + message.content.length, 0) +
      JSON.stringify({ name, schema }).length;
    if (!Number.isSafeInteger(inputChars) || inputChars < 1 || inputChars > config.modelMaxInputChars) {
      throw new ProviderRequestBlockedError();
    }
    const maxTokens = Number(payload.max_tokens);
    const maxCostMicros = estimateMaxCostMicros(policy.model, inputChars, maxTokens, policy.price as TextPrice);
    return { maxCostMicros, units: maxTokens };
  }

  const audio = policy.provider === "openrouter"
    ? await inspectOpenRouterAudio(init.body, policy)
    : init.body instanceof FormData ? await inspectMetaAudio(init.body, policy) : (() => { throw new ProviderRequestBlockedError(); })();
  const units = Math.ceil(audio.seconds);
  if (audio.seconds <= 0 || audio.seconds > MAX_AUDIO_SECONDS || units > MAX_AUDIO_SECONDS) {
    throw new ProviderRequestBlockedError();
  }
  const maxCostMicros = asrCostMicros(policy.model, units);
  return { maxCostMicros, units };
}

function validateChatPayload(payload: Record<string, unknown>, policy: ProviderCallPolicy): void {
  const metaKeys = new Set(["model", "messages", "max_tokens", "reasoning_effort", "temperature", "response_format"]);
  const openRouterKeys = new Set([...metaKeys, "reasoning", "usage", "provider"]);
  const allowed = policy.provider === "meta" ? metaKeys : openRouterKeys;
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw new ProviderRequestBlockedError();
  if (payload.model !== policy.model || !Number.isInteger(payload.max_tokens) ||
    Number(payload.max_tokens) < CHAT_MIN_TOKENS || Number(payload.max_tokens) > CHAT_MAX_TOKENS) {
    throw new ProviderRequestBlockedError();
  }
  if (payload.temperature !== undefined && (typeof payload.temperature !== "number" ||
    !Number.isFinite(payload.temperature) || payload.temperature < 0 || payload.temperature > 2)) {
    throw new ProviderRequestBlockedError();
  }
  if (payload.reasoning_effort !== undefined &&
    !["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(payload.reasoning_effort))) {
    throw new ProviderRequestBlockedError();
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 8 ||
    !payload.messages.every((message) => isRecord(message) &&
      Object.keys(message).length === 2 && Object.hasOwn(message, "role") && Object.hasOwn(message, "content") &&
      ["system", "user", "assistant"].includes(String(message.role)) && typeof message.content === "string")) {
    throw new ProviderRequestBlockedError();
  }
  const format = payload.response_format;
  if (!isRecord(format) || format.type !== "json_schema" || !isRecord(format.json_schema) ||
    Object.keys(format).length !== 2 || !Object.hasOwn(format, "type") || !Object.hasOwn(format, "json_schema") ||
    Object.keys(format.json_schema).length !== 3 || !Object.hasOwn(format.json_schema, "name") ||
    !Object.hasOwn(format.json_schema, "strict") || !Object.hasOwn(format.json_schema, "schema") ||
    format.json_schema.strict !== true || typeof format.json_schema.name !== "string" ||
    !isRecord(format.json_schema.schema)) throw new ProviderRequestBlockedError();
  if (policy.provider === "openrouter") {
    const provider = payload.provider;
    if (!isRecord(provider) || provider.require_parameters !== true || provider.data_collection !== "deny" ||
      !isRecord(provider.max_price)) throw new ProviderRequestBlockedError();
    const providerKeys = new Set(["require_parameters", "data_collection", "max_price", "allow_fallbacks", "sort"]);
    if (Object.keys(provider).some((key) => !providerKeys.has(key)) || Object.keys(provider.max_price).length !== 2 ||
      !Object.hasOwn(provider.max_price, "prompt") || !Object.hasOwn(provider.max_price, "completion")) {
      throw new ProviderRequestBlockedError();
    }
    if (payload.reasoning !== undefined && (!isRecord(payload.reasoning) ||
      Object.keys(payload.reasoning).length !== 1 || payload.reasoning.effort !== "low")) {
      throw new ProviderRequestBlockedError();
    }
    if (provider.allow_fallbacks !== undefined && provider.allow_fallbacks !== true) throw new ProviderRequestBlockedError();
    if (provider.sort !== undefined && provider.sort !== "throughput") throw new ProviderRequestBlockedError();
    if (payload.usage !== undefined && (!isRecord(payload.usage) ||
      Object.keys(payload.usage).length !== 1 || payload.usage.include !== true)) {
      throw new ProviderRequestBlockedError();
    }
    const maxPrice = provider.max_price;
    const price = policy.price as TextPrice;
    if (typeof maxPrice.prompt !== "number" || maxPrice.prompt <= 0 || maxPrice.prompt > price.inputUsdPerMTok ||
      typeof maxPrice.completion !== "number" || maxPrice.completion <= 0 || maxPrice.completion > price.outputUsdPerMTok) {
      throw new ProviderRequestBlockedError();
    }
  }
}

interface AudioForm {
  seconds: number;
}

async function inspectMetaAudio(form: FormData, policy: ProviderCallPolicy): Promise<AudioForm> {
  const fields = [...form.entries()];
  const values = new Map(fields.map(([key, value]) => [key, value]));
  const allowed = ["request", "audio"];
  if (fields.length !== allowed.length || new Set(fields.map(([key]) => key)).size !== allowed.length ||
    fields.some(([key]) => !allowed.includes(key)) || allowed.some((key) => !values.has(key))) {
    throw new ProviderRequestBlockedError();
  }
  const request = values.get("request");
  if (!(request instanceof Blob) || request.type !== "application/json") throw new ProviderRequestBlockedError();
  const settings = parseJsonRecord(await request.text());
  if (settings.mode !== "PUSH_TO_TALK" || settings.model !== policy.model ||
    settings.audioEncoding !== "WAV" || !Array.isArray(settings.languageBias) ||
    !settings.languageBias.includes("English")) throw new ProviderRequestBlockedError();
  return readAudio(values.get("audio"));
}

async function inspectOpenRouterAudio(body: BodyInit | null | undefined, policy: ProviderCallPolicy): Promise<AudioForm> {
  if (typeof body !== "string") throw new ProviderRequestBlockedError();
  const payload = parseJsonRecord(body);
  if (Object.keys(payload).length !== 4 ||
    Object.keys(payload).some((key) => !["model", "language", "input_audio", "provider"].includes(key)) ||
    payload.model !== policy.model || payload.language !== "en" || !isRecord(payload.input_audio) ||
    Object.keys(payload.input_audio).length !== 2 ||
    payload.input_audio.format !== "wav" || typeof payload.input_audio.data !== "string" ||
    !isRecord(payload.provider) || Object.keys(payload.provider).length !== 1 || payload.provider.data_collection !== "deny") {
    throw new ProviderRequestBlockedError();
  }
  const encoded = payload.input_audio.data;
  const bytes = Buffer.from(encoded, "base64");
  if (!encoded || bytes.toString("base64") !== encoded) throw new ProviderRequestBlockedError();
  return readAudioBytes(new Uint8Array(bytes));
}

async function readAudio(value: FormDataEntryValue | null | undefined): Promise<AudioForm> {
  if (!(value instanceof Blob) || value.type !== "audio/wav") throw new ProviderRequestBlockedError();
  const bytes = new Uint8Array(await value.arrayBuffer());
  return readAudioBytes(bytes);
}

function readAudioBytes(bytes: Uint8Array): AudioForm {
  try {
    const parsed = parseWav(bytes);
    if (Buffer.compare(Buffer.from(bytes), Buffer.from(parsed.canonical)) !== 0) throw new ProviderRequestBlockedError();
    return { seconds: parsed.seconds };
  } catch (error) {
    if (error instanceof InvalidWavError) throw new ProviderRequestBlockedError();
    throw error;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // A malformed provider request must be refused before the transport runs.
  }
  throw new ProviderRequestBlockedError();
}

function expectedProviderUrl(policy: ProviderCallPolicy, config: AppConfig): string {
  if (policy.provider === "meta") {
    return `${config.meta.baseUrl}${policy.operation === "chat" ? "/chat/completions" : "/asr/transcribe"}`;
  }
  return `${OPENROUTER_BASE_URL}${policy.operation === "chat" ? "/chat/completions" : "/audio/transcriptions"}`;
}

function claimReservation(context: BudgetedCallContext, outbound: InspectedRequest): void {
  const { db, config, reservation, providerCall } = context.deps;
  if (db.isTransaction) throw new ProviderRequestBlockedError();
  const sendTime = new Date();
  immediate((tx) => {
    const row = tx.prepare("SELECT * FROM usage_reservations WHERE id = ?").get(context.reservationId);
    if (!row) throw new ProviderRequestBlockedError();
    validateReservation(row, reservation, providerCall, outbound, config);
    const learner = tx.prepare("SELECT funding_source FROM learners WHERE id = ? AND deleted_at IS NULL").get(row.learner_id);
    if (!learner || learner.funding_source !== row.funding_source || row.funding_source !== reservation.fundingSource) {
      throw new ProviderRequestBlockedError();
    }
    if (row.funding_source !== "hosted" && row.funding_source !== "byok") throw new ProviderRequestBlockedError();
    if (row.status !== "reserved") throw new ProviderRequestBlockedError();
    const createdAt = new Date(String(row.created_at));
    if (!Number.isFinite(createdAt.getTime())) throw new ProviderRequestBlockedError();
    const sendDay = new Date(Date.UTC(sendTime.getUTCFullYear(), sendTime.getUTCMonth(), sendTime.getUTCDate())).toISOString();
    if (createdAt.toISOString().slice(0, 10) !== sendDay.slice(0, 10)) throw new BudgetExhaustedError();

    const status = getBudgetStatus({ db: tx, now: sendTime, config });
    if (!status.switchOn) throw new AiDisabledError();
    if (row.funding_source === "hosted") {
      if (sendTime.getTime() >= readFundedUntilMs(config) || status.spentMicros > status.ceilingMicros ||
        status.periodSpentMicros > status.periodCeilingMicros) throw new BudgetExhaustedError();
    }

    const previous = tx.prepare("SELECT 1 AS dispatched FROM budget_dispatches WHERE reservation_id = ?")
      .get(context.reservationId);
    if (previous) throw new ProviderRequestBlockedError();
    tx.prepare("INSERT INTO budget_dispatches (reservation_id, dispatched_at) VALUES (?, ?)")
      .run(context.reservationId, sendTime.toISOString());
  }, db);
}

function validateReservation(
  row: Record<string, SQLOutputValue>,
  reservation: Reservation,
  policy: ProviderCallPolicy,
  outbound: InspectedRequest,
  config: AppConfig,
): void {
  const learnerId = String(row.learner_id);
  const role = String(row.role);
  const contract = ROLE_CONTRACTS[role];
  if (String(row.id) !== reservation.id || learnerId !== reservation.learnerId ||
    Number(row.max_cost_micros) !== reservation.maxCostMicros || String(row.role) !== reservation.role ||
    !contract || String(row.kind) !== contract.kind || policy.operation !== contract.operation ||
    Number(row.max_cost_micros) < outbound.maxCostMicros) throw new ProviderRequestBlockedError();
  if (policy.operation === "chat" && contract.maxTokens !== outbound.units) throw new ProviderRequestBlockedError();
  if (policy.operation === "asr" && (Number(row.units) < outbound.units || Number(row.units) > MAX_AUDIO_SECONDS)) {
    throw new ProviderRequestBlockedError();
  }

  const source = String(row.funding_source);
  const canonicalPrice = resolveCanonicalPolicy(source, policy, config);
  if (!samePrice(policy.price, canonicalPrice)) throw new ProviderRequestBlockedError();
}

function resolveCanonicalPolicy(
  fundingSource: string,
  policy: ProviderCallPolicy,
  config: AppConfig,
): TextPrice | AsrPrice {
  if (policy.provider === "meta") {
    if (fundingSource !== "hosted" || policy.apiKey !== config.meta.apiKey) throw new ProviderRequestBlockedError();
    if (policy.operation === "chat" && policy.model === config.meta.textModel) return textPrice(policy.model);
    if (policy.operation === "asr" && policy.model === config.meta.asrModel) return asrPrice(policy.model);
    throw new ProviderRequestBlockedError();
  }

  if (fundingSource === "hosted") {
    if (policy.operation !== "chat") throw new ProviderRequestBlockedError();
    const route = hostedFastRoute(config);
    if (policy.model !== route.model || policy.apiKey !== config.openRouter.apiKey) throw new ProviderRequestBlockedError();
    return route.price;
  }

  if (fundingSource !== "byok" || policy.apiKey === config.meta.apiKey || policy.apiKey === config.openRouter.apiKey) {
    throw new ProviderRequestBlockedError();
  }
  providerKey(policy.apiKey);
  if (policy.operation === "chat" && [OPENROUTER_FAST_MODEL, OPENROUTER_TEXT_MODEL].includes(policy.model)) {
    return textPrice(policy.model);
  }
  if (policy.operation === "asr" && policy.model === OPENROUTER_ASR_MODEL) return asrPrice(policy.model);
  throw new ProviderRequestBlockedError();
}

function samePrice(left: TextPrice | AsrPrice, right: TextPrice | AsrPrice): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "text" && right.kind === "text") {
    return left.inputUsdPerMTok === right.inputUsdPerMTok && left.outputUsdPerMTok === right.outputUsdPerMTok;
  }
  return left.kind === "asr" && right.kind === "asr" && left.usdPerMinute === right.usdPerMinute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeConfig(config: AppConfig): AppConfig {
  Object.freeze(config.meta);
  Object.freeze(config.openRouter);
  return Object.freeze(config);
}
