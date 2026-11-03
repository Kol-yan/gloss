import type { DatabaseSync } from "node:sqlite";
import type { Learner } from "../auth/sessions";
import type { AppConfig } from "../config";
import { getDb } from "../db";
import { AiDisabledError, UnauthorizedError } from "../errors";
import { ModelNotConfiguredError, UnknownModelError } from "./errors";
import { FAST_MODEL_DEFAULT, FAST_PRICE_DEFAULT, textPrice, type TextPrice } from "./prices";

export type FundingSource = "hosted" | "byok";
export type ProviderAccess = { provider: "meta" } | { provider: "openrouter"; apiKey: string };

export const PROVIDER_KEY_HEADER = "X-Gloss-Provider-Key";
// BYOK models. A visitor's fast tier is the default fast model; the operator's
// configured fast model and its price apply to operator-funded calls only.
export const OPENROUTER_FAST_MODEL = FAST_MODEL_DEFAULT;
export const OPENROUTER_TEXT_MODEL = "meta/muse-spark-1.3";
export const OPENROUTER_ASR_MODEL = "meta/muse-voice-transcribe-1.0";

export function fundingSource(learnerId: string, db: DatabaseSync = getDb()): FundingSource {
  const row = db.prepare("SELECT funding_source FROM learners WHERE id = ? AND deleted_at IS NULL").get(learnerId);
  if (!row) throw new UnauthorizedError();
  if (row.funding_source !== "hosted" && row.funding_source !== "byok") throw new AiDisabledError();
  return row.funding_source;
}

export function providerKey(value: string | null | undefined): string {
  const key = value?.trim() ?? "";
  if (!/^sk-or-v1-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new AiDisabledError();
  return key;
}

// Database funding wins over caller objects and request headers. In particular,
// a BYOK learner can never fall through to the operator's configured Meta key.
export function resolveProviderAccess(
  learnerId: string,
  supplied: ProviderAccess | undefined,
  db: DatabaseSync = getDb(),
): ProviderAccess {
  if (fundingSource(learnerId, db) === "hosted") return { provider: "meta" };
  if (supplied?.provider !== "openrouter") throw new AiDisabledError();
  return { provider: "openrouter", apiKey: providerKey(supplied.apiKey) };
}

export function providerAccessFromRequest(request: Request, learner: Learner): ProviderAccess {
  if (fundingSource(learner.id) === "hosted") return { provider: "meta" };
  return { provider: "openrouter", apiKey: providerKey(request.headers.get(PROVIDER_KEY_HEADER)) };
}

// Text jobs run on one of two tiers. "fast" is a cheap open-weight model for
// routine work; "smart" is Meta Muse Spark for judging learner answers.
export type ModelTier = "fast" | "smart";

// Where one text call goes, resolved before any money is reserved so that a
// misconfiguration fails without a reservation. `price` is the cost bound used
// for the reservation and for settling when the provider reports no cost.
export type TextRoute =
  | { tier: ModelTier; provider: "meta"; model: string; price: TextPrice }
  | { tier: ModelTier; provider: "openrouter"; model: string; price: TextPrice; apiKey: string };

// Funding decides who pays; the tier decides which model answers.
// - Visitors (BYOK): their own OpenRouter key, gpt-oss-120b or Muse Spark.
// - Operator, smart: Meta directly.
// - Operator, fast: the operator's OpenRouter account. It never falls back to
//   Meta, and a missing key refuses the job.
export function resolveTextRoute(access: ProviderAccess, config: AppConfig, tier: ModelTier): TextRoute {
  if (access.provider === "openrouter") {
    const model = tier === "fast" ? OPENROUTER_FAST_MODEL : OPENROUTER_TEXT_MODEL;
    return { tier, provider: "openrouter", model, price: textPrice(model), apiKey: access.apiKey };
  }
  if (tier === "smart") {
    if (!config.meta.apiKey) throw new ModelNotConfiguredError();
    return { tier, provider: "meta", model: config.meta.textModel, price: textPrice(config.meta.textModel) };
  }

  let apiKey: string;
  try {
    apiKey = providerKey(config.openRouter.apiKey);
  } catch {
    throw new ModelNotConfiguredError();
  }
  const { fastModel, fastPriceInUsdPerM: priceIn, fastPriceOutUsdPerM: priceOut } = config.openRouter;
  // The default bound fits gpt-oss-120b (also with a :floor or :nitro routing
  // suffix) and presets. Any other model needs both prices spelled out, or it
  // has no cost bound and no call.
  const priced = priceIn !== undefined && priceOut !== undefined;
  if (!priced && !isBoundedByDefaultPrice(fastModel)) throw new UnknownModelError(fastModel);
  return {
    tier,
    provider: "openrouter",
    model: fastModel,
    apiKey,
    price: {
      kind: "text",
      inputUsdPerMTok: priceIn ?? FAST_PRICE_DEFAULT.inputUsdPerMTok,
      outputUsdPerMTok: priceOut ?? FAST_PRICE_DEFAULT.outputUsdPerMTok,
    },
  };
}

function isBoundedByDefaultPrice(model: string): boolean {
  return (
    model.startsWith("@preset/") ||
    [FAST_MODEL_DEFAULT, `${FAST_MODEL_DEFAULT}:floor`, `${FAST_MODEL_DEFAULT}:nitro`].includes(model)
  );
}

export function speechModel(access: ProviderAccess, config: AppConfig): string {
  if (access.provider === "openrouter") return OPENROUTER_ASR_MODEL;
  if (!config.meta.apiKey) throw new ModelNotConfiguredError();
  return config.meta.asrModel;
}
