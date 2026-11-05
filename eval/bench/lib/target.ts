// The model under test, called through the app's own code path: the price
// table, the hosted route, a real budget reservation in a throwaway in-memory
// database, the budget-owned dispatcher (chatWithRoute) and the provider
// adapters with their transport checks. Nothing here talks to a provider
// directly, so a request the app would refuse is refused here too.
import type { DatabaseSync } from "node:sqlite";
import { markUnknown, reserve, settle } from "@/server/budget";
import { loadConfig, type AppConfig } from "@/server/config";
import { immediate, openDatabase } from "@/server/db";
import { newId } from "@/server/ids";
import { hostedFastRoute, providerKey, type ModelTier, type TextRoute } from "@/server/models/access";
import { chatWithRoute } from "@/server/models/dispatch";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
  type TokenUsage,
} from "@/server/models/errors";
import type { ChatMessage, MetaChatInput } from "@/server/models/meta";
import { estimateMaxCostMicros, textCostMicros, textPrice } from "@/server/models/prices";
import type { QuotaKind } from "@/shared/contracts";

export const PROVIDERS = ["openrouter", "meta", "openai"] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Record<ProviderKind, string | null> = {
  openrouter: "@preset/gpt-oss-120b-balanced",
  meta: "muse-spark-1.3",
  // An OpenAI-compatible endpoint has no sensible default model.
  openai: null,
};

// Matches the shape the dummy key must have to pass the app's key check.
const DRY_RUN_OPENROUTER_KEY = ["sk", "or", "v1", "benchdryrun".padEnd(24, "0")].join("-");
const DRY_RUN_KEY = "bench-dry-run-key";

export interface TargetOptions {
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  priceIn?: number;
  priceOut?: number;
  dryRun: boolean;
  env: Record<string, string | undefined>;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export interface RoleCall {
  kind: QuotaKind;
  // The reservation role; the app's transport checks it against the role contract.
  reservationRole: string;
  tier: ModelTier;
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: MetaChatInput["reasoningEffort"];
}

export type CallStatus = "ok" | "http_error" | "timeout" | "bad_output" | "refused";

export interface CallOutcome {
  status: CallStatus;
  errorCode: string | null;
  content: string | null;
  // Network time measured by the app's transport; wall time includes local work.
  latencyMs: number | null;
  wallMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  // What the provider said the call cost (OpenRouter does, Meta does not).
  reportedMicros: number | null;
  // Tokens times the price the route uses.
  tableMicros: number | null;
  // The app's upper bound for this call, reserved before sending.
  boundMicros: number;
  // What the cost guard counts: reported, else table, else the full bound
  // when the outcome is unknown, zero when the provider refused the request.
  accountedMicros: number;
  servingProvider: string | null;
}

export interface Target {
  provider: ProviderKind;
  model: string;
  baseUrl: string | null;
  config: AppConfig;
  db: DatabaseSync;
  route(tier: ModelTier): TextRoute;
  boundMicros(call: RoleCall): number;
  call(call: RoleCall, timeoutMs: number): Promise<CallOutcome>;
  close(): void;
}

function keyFor(options: TargetOptions): string {
  if (options.dryRun) return options.provider === "openrouter" ? DRY_RUN_OPENROUTER_KEY : DRY_RUN_KEY;
  const name = options.provider === "openrouter" ? "OPENROUTER_API_KEY" : options.provider === "meta" ? "META_API_KEY" : "BENCH_API_KEY";
  const value = options.env[name]?.trim();
  if (!value) throw new TargetError(`${name} is not set; it is read from the environment only`);
  return value;
}

export function createTarget(options: TargetOptions): Target {
  const apiKey = keyFor(options);
  if (options.provider === "openai" && !options.baseUrl) {
    throw new TargetError("--provider openai needs --base-url (for example https://api.deepseek.com/v1)");
  }
  if (options.provider !== "openrouter" && (options.priceIn !== undefined || options.priceOut !== undefined)) {
    throw new TargetError("--price-in/--price-out apply to OpenRouter only; other models take their price from the table");
  }
  const baseUrl = options.provider === "openrouter"
    ? null
    : (options.baseUrl ?? "https://api.meta.ai/v1").replace(/\/+$/, "");

  // The app's own config parser, fed only what the bench needs. The budget
  // ceilings are lifted because the bench enforces its own --max-usd stop
  // (the app ledger charges a Meta call at its full bound, which would stop a
  // run long before real spend reaches the cap).
  const config = loadConfig({
    META_API_KEY: options.provider === "openrouter" ? undefined : apiKey,
    META_API_BASE_URL: baseUrl ?? undefined,
    META_TEXT_MODEL: options.provider === "openrouter" ? undefined : options.model,
    OPENROUTER_API_KEY: options.provider === "openrouter" ? apiKey : undefined,
    OPENROUTER_FAST_MODEL: options.provider === "openrouter" ? options.model : undefined,
    OPENROUTER_FAST_PRICE_IN_PER_M: options.priceIn?.toString(),
    OPENROUTER_FAST_PRICE_OUT_PER_M: options.priceOut?.toString(),
    DAILY_BUDGET_USD: "100000",
    PERIOD_BUDGET_USD: "100000",
    AI_ENABLED: "true",
    GLOSSY_DATABASE_PATH: ":memory:",
    GLOSSY_MODEL_MOCK: options.dryRun ? "true" : "false",
  });

  // Fail before any call when the app could not price or route this model.
  const priced = (() => {
    try {
      if (options.provider === "openrouter") {
        providerKey(config.openRouter.apiKey);
        return hostedFastRoute(config);
      }
      return { model: config.meta.textModel, price: textPrice(config.meta.textModel) };
    } catch (error) {
      if (error instanceof UnknownModelError) {
        throw new TargetError(
          `no price for ${error.model} in src/server/models/prices.ts (or --price-in/--price-out below the table price). ` +
          "The app never calls an unpriced model; add a checked price to the table first (see eval/bench/README.md).",
        );
      }
      throw new TargetError("the OpenRouter key does not look like an OpenRouter key (sk-or-v1-...)");
    }
  })();

  const db = openDatabase(":memory:");

  const route = (tier: ModelTier): TextRoute => options.provider === "openrouter"
    ? { tier, provider: "openrouter", model: priced.model, price: priced.price, apiKey: config.openRouter.apiKey ?? "" }
    : { tier, provider: "meta", model: priced.model, price: priced.price };

  // Same input size measure as the app services use for their reservations.
  const boundMicros = (call: RoleCall) => {
    const inputChars = call.messages.reduce((total, message) => total + message.content.length, 0) +
      JSON.stringify(call.jsonSchema).length;
    return estimateMaxCostMicros(priced.model, inputChars, call.maxTokens, priced.price);
  };

  async function call(roleCall: RoleCall, timeoutMs: number): Promise<CallOutcome> {
    const textRoute = route(roleCall.tier);
    const bound = boundMicros(roleCall);
    const now = new Date();
    // A fresh learner per call keeps the daily per-learner quotas out of the way.
    const learnerId = newId();
    db.prepare(
      "INSERT INTO learners (id, display_name, quota_profile, funding_source, created_at) VALUES (?, 'bench', 'owner', 'hosted', ?)",
    ).run(learnerId, now.toISOString());

    const started = performance.now();
    const wall = () => Math.round(performance.now() - started);
    const base = { boundMicros: bound, servingProvider: null, reportedMicros: null, tableMicros: null,
      inputTokens: null, outputTokens: null, content: null };

    let reservation;
    try {
      reservation = immediate((tx) => reserve({
        learnerId, kind: roleCall.kind, role: roleCall.reservationRole,
        requestId: `bench:${newId()}`, units: 1, maxCostMicros: bound,
      }, { db: tx, now, config }), db);
    } catch (error) {
      return { ...base, status: "refused", errorCode: `reserve_${errorName(error)}`, latencyMs: null,
        wallMs: wall(), accountedMicros: 0 };
    }

    const costs = (usage: TokenUsage | null) => ({
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      reportedMicros: usage?.costMicros ?? null,
      tableMicros: usage ? textCostMicros(priced.model, usage.inputTokens, usage.outputTokens, priced.price) : null,
    });
    const close = (cost: number | "unknown") => immediate((tx) => {
      if (cost === "unknown") markUnknown(reservation.id, { db: tx, now });
      else settle(reservation.id, cost, { db: tx, now });
    }, db);

    try {
      const result = await chatWithRoute({
        model: textRoute.model,
        messages: roleCall.messages,
        jsonSchema: roleCall.jsonSchema,
        maxTokens: roleCall.maxTokens,
        temperature: roleCall.temperature,
        reasoningEffort: roleCall.reasoningEffort,
        timeoutMs,
      }, textRoute, config, { reservation, db, now });
      const cost = costs(result.usage);
      const accounted = cost.reportedMicros ?? cost.tableMicros ?? bound;
      close(accounted);
      return { ...base, ...cost, status: "ok", errorCode: null, content: result.content,
        latencyMs: result.latencyMs, wallMs: wall(), accountedMicros: accounted,
        servingProvider: result.servingProvider ?? null };
    } catch (error) {
      if (error instanceof ModelOutputError) {
        const cost = costs(error.usage);
        const accounted = cost.reportedMicros ?? cost.tableMicros ?? bound;
        close(accounted);
        return { ...base, ...cost, status: "bad_output", errorCode: error.reason, latencyMs: error.latencyMs,
          wallMs: wall(), accountedMicros: accounted, servingProvider: error.servingProvider ?? null };
      }
      if (error instanceof ModelHttpError) {
        close(0);
        return { ...base, status: "http_error", errorCode: `http_${error.status}`, latencyMs: error.latencyMs,
          wallMs: wall(), accountedMicros: 0 };
      }
      if (error instanceof ModelTimeoutError) {
        // The provider may have done (and billed) the work.
        close("unknown");
        return { ...base, status: "timeout", errorCode: `timeout_${error.reason}`, latencyMs: error.latencyMs,
          wallMs: wall(), accountedMicros: bound };
      }
      if (error instanceof ModelNotConfiguredError || error instanceof UnknownModelError || error instanceof RangeError) {
        close(0);
        return { ...base, status: "refused", errorCode: errorName(error), latencyMs: null, wallMs: wall(), accountedMicros: 0 };
      }
      // Anything else, including the transport refusing the request before
      // sending, is treated as possibly billed.
      close("unknown");
      return { ...base, status: "refused", errorCode: errorName(error), latencyMs: null, wallMs: wall(),
        accountedMicros: bound };
    }
  }

  return {
    provider: options.provider,
    model: priced.model,
    baseUrl,
    config,
    db,
    route,
    boundMicros,
    call,
    close: () => db.close(),
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown_error";
}
