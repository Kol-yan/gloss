import { describe, expect, it } from "vitest";
import { UnknownModelError } from "@/server/models/errors";
import { estimateMaxCostMicros } from "@/server/models/meta";
import {
  asrCostMicros,
  FAST_MODEL_DEFAULT,
  FAST_PRICE_DEFAULT,
  settledTextCostMicros,
  textCostMicros,
  textPrice,
} from "@/server/models/prices";

describe("prices", () => {
  it("prices text models per million tokens, rounded up to a micro-dollar", () => {
    // 1000 * 1.25 + 200 * 4.25 = 2100 micro-dollars
    expect(textCostMicros("muse-spark-1.3", 1000, 200)).toBe(2100);
    expect(textCostMicros("muse-spark-1.3", 1, 1)).toBe(6); // 5.5 rounds up
    expect(textCostMicros("muse-spark-1.3", 0, 0)).toBe(0);
  });

  it("prices gpt-oss-120b at twice the highest provider price listed in November 2026", () => {
    // Highest listed: $0.35 per million input tokens, $0.95 per million output tokens.
    expect(FAST_MODEL_DEFAULT).toBe("openai/gpt-oss-120b");
    expect(textPrice(FAST_MODEL_DEFAULT)).toEqual({ kind: "text", inputUsdPerMTok: 0.7, outputUsdPerMTok: 1.9 });
    expect(FAST_PRICE_DEFAULT).toBe(textPrice(FAST_MODEL_DEFAULT));
    expect(textCostMicros(FAST_MODEL_DEFAULT, 1000, 200)).toBe(1080);
  });

  it("prices with an explicit price when one is given", () => {
    const price = { kind: "text", inputUsdPerMTok: 2, outputUsdPerMTok: 10 } as const;
    expect(textCostMicros("any-model", 1000, 200, price)).toBe(4000);
    expect(estimateMaxCostMicros("any-model", 100, 2048, price)).toBe(Math.ceil(((300 + 600) * 2 + 2048 * 10) * 1.25));
  });

  it("settles at the reported cost, else retains the full bound (tokens without cost are unproven)", () => {
    const price = textPrice(FAST_MODEL_DEFAULT);
    expect(settledTextCostMicros(price, { inputTokens: 1000, outputTokens: 200, costMicros: 77 }, 9999)).toBe(77);
    expect(settledTextCostMicros(price, { inputTokens: 1000, outputTokens: 200, costMicros: 0 }, 9999)).toBe(9999);
    expect(settledTextCostMicros(price, { inputTokens: 1000, outputTokens: 200 }, 9999)).toBe(9999);
    expect(settledTextCostMicros(price, null, 9999)).toBe(9999);
  });

  it("prices speech-to-text per minute with the 1.25 safety margin", () => {
    expect(asrCostMicros("muse-voice-transcribe-1.0", 60)).toBe(3750);
    expect(asrCostMicros("muse-voice-transcribe-1.0", 1)).toBe(63);
    expect(asrCostMicros("muse-voice-transcribe-1.0", 0)).toBe(0);
  });

  it("refuses models without a price or of the wrong kind", () => {
    expect(() => textPrice("some-other-model")).toThrow(UnknownModelError);
    expect(() => textPrice("muse-voice-transcribe-1.0")).toThrow(UnknownModelError);
    expect(() => asrCostMicros("muse-spark-1.3", 10)).toThrow(UnknownModelError);
    // Inherited object keys are not models.
    expect(() => textPrice("toString")).toThrow(UnknownModelError);
    expect(() => textPrice("__proto__")).toThrow(UnknownModelError);
  });
});

describe("estimateMaxCostMicros", () => {
  it("reserves a Unicode-safe input bound and the full reasoning/output budget with the 1.25 safety margin", () => {
    expect(estimateMaxCostMicros("muse-spark-1.3", 3000, 4096)).toBe(36_760);
  });

  it("covers input bytes for ASCII, dense Unicode and surrogate pairs", () => {
    for (const text of ["a".repeat(1000), "\u4e2d".repeat(1000), "\ud83d\ude00".repeat(500)]) {
      expect(estimateMaxCostMicros("muse-spark-1.3", text.length, 4096)).toBeGreaterThanOrEqual(
        textCostMicros("muse-spark-1.3", Buffer.byteLength(text) + 600, 4096),
      );
    }
  });

  it("refuses an unknown model", () => {
    expect(() => estimateMaxCostMicros("mystery", 10, 2048)).toThrow(UnknownModelError);
  });
});
