// Model prices used for the cost upper bound (reserve) and the actual cost
// (settle). A model without an entry here is never called: with no price
// there is no bound, and without a bound the budget cannot be protected.
//
// Source: public price listings for the Meta models, October 2026, as given by
// the operator. Re-check them before changing a model in the environment.
import { UnknownModelError } from "./errors";

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

export const MODEL_PRICES: Record<string, TextPrice | AsrPrice> = {
  "muse-spark-1.3": { kind: "text", inputUsdPerMTok: 1.25, outputUsdPerMTok: 4.25 },
  "muse-voice-transcribe-1.0": { kind: "asr", usdPerMinute: 0.003 },
};

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
export function textCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const price = textPrice(model);
  return Math.ceil(inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok);
}

export function asrCostMicros(model: string, seconds: number): number {
  return Math.ceil((seconds / 60) * asrPrice(model).usdPerMinute * 1_000_000);
}
