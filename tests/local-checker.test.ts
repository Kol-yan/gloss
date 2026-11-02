import { describe, expect, it } from "vitest";
import { collectLints, createLinter } from "@/features/editor/harper-lint";
import { categoryFor, mapLints, resolveSpan, type RawLint } from "@/features/editor/local-lint";
import { canApply, normalizeText } from "@/lib/text";

function raw(overrides: Partial<RawLint>): RawLint {
  return {
    rule: "SpellCheck",
    kind: "Spelling",
    start: 0,
    end: 0,
    problem: "",
    message: "Did you mean to spell `recieved` this way?",
    fix: { type: "replace", text: "received" },
    ...overrides,
  };
}

describe("resolveSpan", () => {
  it("accepts UTF-16 spans that point at the problem text", () => {
    const text = "I recieved it";
    expect(resolveSpan(text, { start: 2, end: 10, problem: "recieved" })).toEqual({ start: 2, end: 10 });
  });

  it("converts code point spans when they differ from UTF-16 indices", () => {
    // Two emoji are 2 code points but 4 UTF-16 units each pair.
    const text = "😀😀 I recieved it";
    expect(resolveSpan(text, { start: 5, end: 13, problem: "recieved" })).toEqual({ start: 7, end: 15 });
  });

  it("rejects spans that do not match the problem text", () => {
    expect(resolveSpan("I recieved it", { start: 0, end: 3, problem: "recieved" })).toBeNull();
  });
});

describe("mapLints", () => {
  const text = "😀😀 I recieved it. An apple and a orange.";

  it("produces suggestions that apply to the exact text", () => {
    const suggestions = mapLints(text, [
      raw({ start: 7, end: 15, problem: "recieved" }),
      raw({ rule: "AnA", kind: "Miscellaneous", start: 33, end: 34, problem: "a", message: "Incorrect indefinite article.", fix: { type: "replace", text: "an" } }),
    ]);
    expect(suggestions).toHaveLength(2);
    for (const s of suggestions) {
      expect(s.source).toBe("local");
      expect(s.meaning).toBeNull();
      expect(canApply(text, s)).toBe(true);
    }
    expect(suggestions[0]).toMatchObject({ original: "recieved", replacement: "received", category: "error", reason: "Did you mean to spell “recieved” this way?" });
    expect(suggestions[1]).toMatchObject({ original: "a", replacement: "an", category: "error" });
  });

  it("skips lints without a fix and spans that do not fit", () => {
    expect(mapLints(text, [raw({ start: 7, end: 15, problem: "recieved", fix: null })])).toHaveLength(0);
    expect(mapLints(text, [raw({ start: 1, end: 4, problem: "recieved" })])).toHaveLength(0);
  });

  it("handles remove and insert-after fixes", () => {
    const t = "This is is fine.";
    const removed = mapLints(t, [raw({ rule: "RepeatedWords", kind: "Repetition", start: 5, end: 8, problem: "is ", message: "Repeated word", fix: { type: "remove" } })]);
    expect(removed[0].replacement).toBe("");
    const inserted = mapLints(t, [raw({ kind: "Punctuation", rule: "Punct", start: 11, end: 15, problem: "fine", message: "Add a comma", fix: { type: "insert_after", text: "," } })]);
    expect(inserted[0]).toMatchObject({ original: "fine", replacement: "fine,", category: "style" });
  });

  it("flags edits that change numbers or negation", () => {
    const t = "We can not go on 14 March.";
    const [s] = mapLints(t, [raw({ kind: "Style", rule: "X", start: 3, end: 10, problem: "can not", message: "One word", fix: { type: "replace", text: "cannot" } })]);
    expect(s.meaningChange).toBe(true);
  });

  it("files spelling and grammar as errors and the rest as style", () => {
    expect(categoryFor({ kind: "Spelling", rule: "SpellCheck" })).toBe("error");
    expect(categoryFor({ kind: "Grammar", rule: "x" })).toBe("error");
    expect(categoryFor({ kind: "Readability", rule: "x" })).toBe("style");
    expect(categoryFor({ kind: "Miscellaneous", rule: "x" })).toBe("style");
  });
});

// Runs the real rule engine. The inlined binary is large, so this is the slow test.
describe("Harper integration", () => {
  it("reports ranges that match the editor's UTF-16 indices, also after emoji", async () => {
    const { binaryInlined } = await import("harper.js/binaryInlined");
    const linter = await createLinter(binaryInlined);
    const text = normalizeText("😀😀 I recieved it yesterday. An apple and a orange.");
    const suggestions = mapLints(text, await collectLints(linter, text));
    const spelling = suggestions.find((s) => s.original === "recieved");
    expect(spelling).toBeDefined();
    expect(spelling?.start).toBe(text.indexOf("recieved"));
    expect(spelling?.category).toBe("error");
    expect(suggestions.every((s) => canApply(text, s))).toBe(true);
    await linter.dispose();
  }, 60_000);
});
