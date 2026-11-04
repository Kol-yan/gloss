// Model prices used for the cost upper bound (reserve) and the actual cost
// (settle). A model without an entry here is never called: with no price
// there is no bound, and without a bound the budget cannot be protected.
//
// Sources (checked November 2026); re-check before changing a model:
// - Meta: https://dev.meta.ai/docs/pricing-rate-limits
// - OpenRouter: https://openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints
// Reasoning is included in output tokens.
import { UnknownModelError, type TokenUsage } from "./errors";

export interface TextPrice {
  kind: "text";
  // USD per one million tokens.
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface AsrPrice {
  kind: "asr";
  usdPerMinute: number;
}

// The fast tier's default model and its price bound. OpenRouter lists about
// thirty providers for gpt-oss-120b at $0.03 to $0.35 per million input tokens
// and $0.107 to $0.95 per million output tokens. Routing may pick any of them,
// so the bound is twice the highest listed price of each kind. Presets hide
// their provider, so they use the same bound unless the operator sets prices.
export const FAST_MODEL_DEFAULT = "openai/gpt-oss-120b";
export const FAST_PRICE_DEFAULT: TextPrice = Object.freeze({
  kind: "text",
  inputUsdPerMTok: 0.7,
  outputUsdPerMTok: 1.9,
});

const mutableModelPrices: Record<string, TextPrice | AsrPrice> = {
  "muse-spark-1.3": { kind: "text", inputUsdPerMTok: 1.25, outputUsdPerMTok: 4.25 },
  // The operator's fast-tier preset routes to gpt-oss-120b; the conservative
  // gpt-oss-120b bound applies until an explicit price is configured.
  "@preset/gpt-oss-120b-balanced": FAST_PRICE_DEFAULT,
  [FAST_MODEL_DEFAULT]: FAST_PRICE_DEFAULT,
  "muse-voice-transcribe-1.0": { kind: "asr", usdPerMinute: 0.003 },
  "meta/muse-spark-1.3": { kind: "text", inputUsdPerMTok: 1.25, outputUsdPerMTok: 4.25 },
  "meta/muse-voice-transcribe-1.0": { kind: "asr", usdPerMinute: 0.003 },
};

export const MODEL_PRICES: Record<string, TextPrice | AsrPrice> = Object.freeze(
  Object.fromEntries(Object.entries(mutableModelPrices).map(([model, price]) => [model, Object.freeze(price)])),
) as Record<string, TextPrice | AsrPrice>;

export function textPrice(model: string): TextPrice {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price || price.kind !== "text") throw new UnknownModelError(model);
  return price;
}

export function asrPrice(model: string): AsrPrice {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined;
  if (!price || price.kind !== "asr") throw new UnknownModelError(model);
  return price;
}

// USD per million tokens equals micro-dollars per token, so no unit
// conversion is needed. Results round up to a whole micro-dollar.
function costAtPrice(price: TextPrice, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok);
}

// `price` overrides the table for routes whose price comes from configuration.
export function textCostMicros(
  model: string,
  inputTokens: number,
  outputTokens: number,
  price: TextPrice = textPrice(model),
): number {
  return costAtPrice(price, inputTokens, outputTokens);
}

export function estimateMaxCostMicros(
  model: string,
  inputChars: number,
  maxTokens: number,
  price?: TextPrice,
): number {
  if (!Number.isSafeInteger(inputChars) || inputChars < 0 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError("inputChars and maxTokens must be non-negative safe integers");
  }
  const inputTokens = Math.ceil(inputChars * 3 + 600);
  return Math.ceil(textCostMicros(model, inputTokens, maxTokens, price) * 1.25);
}

// What to record when a call is closed: the cost the provider reported, else
// reported tokens times the price, else (no usage at all) the full upper bound.
export function settledTextCostMicros(
  _price: TextPrice,
  usage: TokenUsage | null,
  maxCostMicros: number,
): number {
  const reported = usage?.costMicros;
  return typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0
    ? reported
    : maxCostMicros;
}

export function asrCostMicros(model: string, seconds: number): number {
  return Math.ceil((seconds / 60) * asrPrice(model).usdPerMinute * 1_000_000 * 1.25);
}
