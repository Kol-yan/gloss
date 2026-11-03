import { describe, expect, it } from "vitest";
import { collectLints, createLinter } from "@/features/editor/harper-lint";
import { categoryFor, editDistance, gluedToPunctuation, looksLikeFix, mapLints, resolveSpan, type RawLint } from "@/features/editor/local-lint";
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
    const [s] = mapLints(t, [raw({ kind: "Style", rule: "X", start: 3, end: 10, problem: "can not", message: "One word", fix: { type: "replace", text: "can" } })]);
    expect(s.meaningChange).toBe(true);
    // Joining "can not" keeps the negation, so it is not a change of meaning.
    const [joined] = mapLints(t, [raw({ kind: "Style", rule: "X", start: 3, end: 10, problem: "can not", message: "One word", fix: { type: "replace", text: "cannot" } })]);
    expect(joined.meaningChange).toBe(false);
  });

  it("files spelling and grammar as errors and the rest as style", () => {
    expect(categoryFor({ kind: "Spelling", rule: "SpellCheck" })).toBe("error");
    expect(categoryFor({ kind: "Grammar", rule: "x" })).toBe("error");
    expect(categoryFor({ kind: "Readability", rule: "x" })).toBe("style");
    expect(categoryFor({ kind: "Miscellaneous", rule: "x" })).toBe("style");
  });
});

describe("precision of spelling suggestions", () => {
  const comma = (start: number) =>
    raw({
      rule: "CommaFixes",
      kind: "Punctuation",
      start,
      end: start + 1,
      problem: ",",
      message: "Use a space after a comma.",
      fix: { type: "insert_after", text: " " },
    });
  const word = (text: string, problem: string, fix: string, extra: Partial<RawLint> = {}) => {
    const start = text.indexOf(problem);
    return raw({ start, end: start + problem.length, problem, fix: { type: "replace", text: fix }, ...extra });
  };

  it("shows one suggestion for a word glued to a comma instead of two guesses", () => {
    const text = "Enor,ous";
    const suggestions = mapLints(text, [comma(4), word(text, "Enor", "Enos"), word(text, "ous", "opus")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      start: 0,
      end: 8,
      original: "Enor,ous",
      replacement: "Enor, ous",
      category: "style",
      reason: "Use a space after a comma.",
    });
    expect(canApply(text, suggestions[0])).toBe(true);
  });

  it("does the same inside a sentence and also widens a lone missing space", () => {
    const text = "This is Enor,ous and good, yesterday,and it was late.";
    const suggestions = mapLints(text, [
      comma(text.indexOf("r,o") + 1),
      word(text, "Enor", "Enos"),
      word(text, "ous", "opus"),
      comma(text.indexOf("y,a") + 1),
    ]);
    expect(suggestions.map((s) => [s.original, s.replacement])).toEqual([
      ["Enor,ous", "Enor, ous"],
      ["yesterday,and", "yesterday, and"],
    ]);
    for (const s of suggestions) expect(canApply(text, s)).toBe(true);
  });

  it("drops spelling guesses for words glued to punctuation even without a spacing fix", () => {
    const text = "Wrld!hello";
    expect(mapLints(text, [word(text, "Wrld", "World")])).toHaveLength(0);
    expect(gluedToPunctuation(text, 0, 4)).toBe(true);
    expect(gluedToPunctuation("A wrld, here", 2, 6)).toBe(false);
    expect(gluedToPunctuation("e.g. wrld", 5, 9)).toBe(false);
  });

  it("keeps a spelling fix for a word followed by a comma and a space", () => {
    const text = "I recieve, then leave.";
    const [s] = mapLints(text, [word(text, "recieve", "receive")]);
    expect(s).toMatchObject({ original: "recieve", replacement: "receive" });
  });

  it("leaves a lone comma fix alone when the comma is not between two words", () => {
    const text = "Hello,";
    const [s] = mapLints(text, [comma(5)]);
    expect(s).toMatchObject({ original: ",", replacement: ", " });
  });

  it("measures edits so a transposition counts once", () => {
    expect(editDistance("recieve", "receive")).toBe(1);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "ab")).toBe(2);
  });

  it("drops spelling suggestions whose candidates all look unrelated", () => {
    const text = "A wrold apart.";
    expect(looksLikeFix("wrold", "blood")).toBe(false);
    expect(mapLints(text, [word(text, "wrold", "blood", { candidates: ["blood", "flood"] })])).toHaveLength(0);
  });

  it("uses the first candidate that looks like the word, not just the first one", () => {
    const text = "A wrold apart.";
    const [s] = mapLints(text, [word(text, "wrold", "blood", { candidates: ["blood", "world"] })]);
    expect(s.replacement).toBe("world");
  });

  it("allows more edits in longer words", () => {
    expect(looksLikeFix("unfortunatly", "unfortunately")).toBe(true);
    expect(looksLikeFix("cat", "dog")).toBe(false);
    expect(looksLikeFix("garbage", "package")).toBe(true);
  });

  it("does not apply the similarity check to grammar fixes", () => {
    const text = "We goed home.";
    const [s] = mapLints(text, [
      raw({ rule: "RegularIrregulars", kind: "Grammar", start: 3, end: 7, problem: "goed", fix: { type: "replace", text: "went" }, candidates: ["went"] }),
    ]);
    expect(s.replacement).toBe("went");
  });
});

// Runs the real rule engine. The inlined binary is large, so this is the slow test.
describe("Harper integration", () => {
  it("reports ranges that match the editor's UTF-16 indices, also after emoji", async () => {
    const { binaryInlined } = await import("harper.js/binaryInlined");
    const linter = await createLinter(binaryInlined);
    const text = normalizeText("😀😀 I recieved it yesterday. An apple and a orange.");
    const suggestions = mapLints(text, await collectLints(linter, text));
    const article = suggestions.find((s) => s.original === "a");
    expect(article).toBeDefined();
    expect(article?.start).toBe(text.indexOf(" a orange") + 1);
    expect(article?.replacement).toBe("an");
    expect(article?.category).toBe("error");
    expect(suggestions.every((s) => canApply(text, s))).toBe(true);
    await linter.dispose();
  }, 60_000);

  it("leaves spelling to the later stages", async () => {
    const { binaryInlined } = await import("harper.js/binaryInlined");
    const linter = await createLinter(binaryInlined);
    const text = normalizeText("I recieved the mail, but unfortunatelly it was late.");
    expect(await collectLints(linter, text)).toEqual([]);
    expect(await linter.getLintConfig()).toMatchObject({ SpellCheck: false });
    await linter.dispose();
  }, 60_000);

  it("keeps grammar and punctuation rules on, with one clear suggestion for words glued by a comma", async () => {
    const { binaryInlined } = await import("harper.js/binaryInlined");
    const linter = await createLinter(binaryInlined);

    const glued = normalizeText("Enor,ous");
    const gluedSuggestions = mapLints(glued, await collectLints(linter, glued));
    expect(gluedSuggestions).toHaveLength(1);
    expect(gluedSuggestions[0]).toMatchObject({ original: "Enor,ous", replacement: "Enor, ous", start: 0, end: 8 });

    const paragraph = normalizeText("I recieve the mail yesterday,and it was unfortunatelly late. We goed home. Enor,ous help.");
    const found = mapLints(paragraph, await collectLints(linter, paragraph));
    const pairs = found.map((s) => `${s.original}>${s.replacement}`);
    expect(pairs.some((p) => p.startsWith("goed>"))).toBe(true);
    expect(pairs).toContain("yesterday,and>yesterday, and");
    expect(pairs).toContain("Enor,ous>Enor, ous");
    expect(pairs.some((p) => p.startsWith("recieve>") || p.startsWith("unfortunatelly>"))).toBe(false);
    expect(pairs.some((p) => p.includes("Enos") || p.includes("opus"))).toBe(false);
    expect(found.every((s) => canApply(paragraph, s))).toBe(true);
    await linter.dispose();
  }, 60_000);
});
