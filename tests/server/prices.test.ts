import { describe, expect, it } from "vitest";
import { UnknownModelError } from "@/server/models/errors";
import { estimateMaxCostMicros } from "@/server/models/meta";
import { asrCostMicros, textCostMicros, textPrice } from "@/server/models/prices";

describe("prices", () => {
  it("prices text models per million tokens, rounded up to a micro-dollar", () => {
    // 1000 * 1.25 + 200 * 4.25 = 2100 micro-dollars
    expect(textCostMicros("muse-spark-1.3", 1000, 200)).toBe(2100);
    expect(textCostMicros("muse-spark-1.3", 1, 1)).toBe(6); // 5.5 rounds up
    expect(textCostMicros("muse-spark-1.3", 0, 0)).toBe(0);
  });

  it("prices speech-to-text per minute", () => {
    expect(asrCostMicros("muse-voice-transcribe-1.0", 60)).toBe(3000);
    expect(asrCostMicros("muse-voice-transcribe-1.0", 1)).toBe(50);
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
  it("reserves a Unicode-safe input bound and the full reasoning/output budget", () => {
    expect(estimateMaxCostMicros("muse-spark-1.3", 3000, 4096)).toBe(29_408);
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
