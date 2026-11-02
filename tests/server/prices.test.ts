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
  it("assumes 3 chars per token plus 600 tokens of overhead, and counts the full output budget", () => {
    // input: 3000 / 3 + 600 = 1600 tokens * 1.25 = 2000; output: 2048 * 4.25 = 8704
    expect(estimateMaxCostMicros("muse-spark-1.3", 3000, 2048)).toBe(10_704);
  });

  it("rounds a fractional input estimate up", () => {
    // 1000 chars -> ceil(333.33 + 600) = 934 tokens
    expect(estimateMaxCostMicros("muse-spark-1.3", 1000, 2048)).toBe(
      textCostMicros("muse-spark-1.3", 934, 2048),
    );
  });

  it("refuses an unknown model", () => {
    expect(() => estimateMaxCostMicros("mystery", 10, 2048)).toThrow(UnknownModelError);
  });
});
