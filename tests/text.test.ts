import { describe, expect, it } from "vitest";
import {
  applyRange,
  canApply,
  hashText,
  locateFragment,
  normalizeText,
  splitSentences,
  touchesMeaning,
} from "@/lib/text";

describe("normalizeText", () => {
  it("unifies line endings and composes characters", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeText("café")).toBe("café");
  });
});

describe("hashText", () => {
  it("is stable for the same text", async () => {
    expect(await hashText("abc")).toBe(await hashText("abc"));
    expect(await hashText("abc")).not.toBe(await hashText("abd"));
  });
});

describe("sentence ranges", () => {
  const text = normalizeText("We discussed about the deadline. 🚀 The timeline is not realistic.\r\nOK?");

  it("addresses the same characters as the original text", () => {
    for (const s of splitSentences(text)) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it("locates a unique fragment after an emoji", () => {
    const second = splitSentences(text).find((s) => s.text.includes("timeline"))!;
    const range = locateFragment(second, "not realistic")!;
    expect(text.slice(range.start, range.end)).toBe("not realistic");
  });

  it("rejects ambiguous and missing fragments", () => {
    const [sentence] = splitSentences("the cat and the dog.");
    expect(locateFragment(sentence, "the")).toBeNull();
    expect(locateFragment(sentence, "bird")).toBeNull();
  });
});

describe("applying a range", () => {
  const text = "We discussed about the deadline.";
  const range = { start: 13, end: 19, original: "about ", replacement: "" };

  it("applies to the exact text", () => {
    expect(canApply(text, range)).toBe(true);
    expect(applyRange(text, range)).toBe("We discussed the deadline.");
  });

  it("refuses a stale range", () => {
    expect(applyRange("We talked about the deadline.", range)).toBeNull();
  });
});

describe("touchesMeaning", () => {
  it("flags changed numbers, negation and names", () => {
    expect(touchesMeaning("by 5 May", "by 6 May")).toBe(true);
    expect(touchesMeaning("is not realistic", "is realistic")).toBe(true);
    expect(touchesMeaning("ask Maria", "ask Mary")).toBe(true);
  });

  it("allows grammar and style edits", () => {
    expect(touchesMeaning("discussed about the plan", "discussed the plan")).toBe(false);
    expect(touchesMeaning("is not realistic", "isn't realistic")).toBe(false);
  });
});
