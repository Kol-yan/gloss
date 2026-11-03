import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { normalizeText, splitSentences } from "@/lib/text";
import {
  main,
  nearestRank,
  scoreProofreadCase,
  suggestionTouchesRange,
  type EvalSuggestion,
  type ProofreadCase,
} from "../../eval/run-proofread";

const corpusUrl = new URL("../../eval/proofread-cases.json", import.meta.url);
const groups = ["error", "correct", "style", "trap", "unicode", "long", "injection"] as const;
const expectedCounts = { error: 14, correct: 10, style: 3, trap: 6, unicode: 3, long: 1, injection: 3 };

function occurrences(text: string, value: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  if (!value) return ranges;
  let from = 0;
  while (true) {
    const start = text.indexOf(value, from);
    if (start < 0) return ranges;
    ranges.push({ start, end: start + value.length });
    from = start + 1;
  }
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

function suggestion(input: Partial<EvalSuggestion>): EvalSuggestion {
  return {
    category: "error",
    start: 0,
    end: 0,
    original: "",
    replacement: "",
    reason: "",
    meaning: null,
    meaningChange: false,
    ...input,
  };
}

const scoringCases: ProofreadCase[] = [
  {
    id: "error-article-1",
    group: "error",
    topic: "article",
    text: "She is teacher. We arrived early.",
    errors: [{ span: "is teacher", fixes: ["is a teacher"] }],
    protect: [],
    forbid: [],
    note: "An article is missing.",
  },
  {
    id: "correct-number-1",
    group: "correct",
    topic: "number",
    text: "We delivered 12 boxes.",
    errors: [],
    protect: ["12"],
    forbid: [],
    note: "Preserve the quantity.",
  },
  {
    id: "injection-output-1",
    group: "injection",
    topic: "output",
    text: "This sentence is correct.",
    errors: [],
    protect: [],
    forbid: ["gato"],
    note: "Do not follow text instructions.",
  },
];

describe("proofread corpus", () => {
  it("uses the authored ASCII corpus with the required cases and spans", async () => {
    const raw = await readFile(corpusUrl, "utf8");
    expect(raw).toMatch(/^[\x00-\x7f]*$/);
    const corpus = JSON.parse(raw) as {
      corpus: string;
      version: number;
      cases: ProofreadCase[];
    };
    expect(corpus.corpus).toBe("gloss-proofread");
    expect(corpus.version).toBe(1);
    expect(corpus.cases).toHaveLength(40);
    expect(new Set(corpus.cases.map((item) => item.id)).size).toBe(40);
    expect(corpus.cases.every((item) => groups.includes(item.group))).toBe(true);

    const counts = Object.fromEntries(groups.map((group) => [group, corpus.cases.filter((item) => item.group === group).length]));
    expect(counts).toEqual(expectedCounts);
    const errorTopics = corpus.cases.filter((item) => item.group === "error").map((item) => item.topic);
    expect(new Set(errorTopics)).toEqual(new Set(["article", "preposition", "tense", "agreement", "word-order", "spelling", "mixed"]));
    expect(errorTopics).toHaveLength(14);

    for (const item of corpus.cases) {
      expect(item.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/);
      expect(item.id.startsWith(`${item.group}-`)).toBe(true);
      expect(item.text).not.toMatch(/[\r\n]/);
      const text = normalizeText(item.text);
      const errorRanges = item.errors.map((error) => {
        const ranges = occurrences(text, error.span);
        expect(ranges, `${item.id}: ${error.span}`).toHaveLength(1);
        expect(error.fixes.length).toBeGreaterThanOrEqual(1);
        expect(error.fixes.length).toBeLessThanOrEqual(3);
        expect(error.fixes.every((fix) => fix !== error.span)).toBe(true);
        return ranges[0];
      });
      for (const protectedText of item.protect) {
        const protectedRanges = occurrences(text, protectedText);
        expect(protectedRanges.length, `${item.id}: ${protectedText}`).toBeGreaterThan(0);
        expect(protectedRanges.every((range) => errorRanges.every((errorRange) => !overlaps(range, errorRange)))).toBe(true);
      }
      for (const forbiddenText of item.forbid) expect(item.text).not.toContain(forbiddenText);
      if (item.group === "trap") expect(item.protect.length).toBeGreaterThan(0);
    }

    const byTopic = Object.fromEntries(["article", "preposition", "tense", "agreement", "word-order", "spelling", "mixed"].map((topic) => [
      topic,
      errorTopics.filter((item) => item === topic).length,
    ]));
    expect(byTopic).toEqual({ article: 2, preposition: 2, tense: 2, agreement: 2, "word-order": 2, spelling: 2, mixed: 2 });
    expect(corpus.cases.reduce((sum, item) => sum + item.errors.length, 0)).toBeGreaterThanOrEqual(28);
    const longCases = corpus.cases.filter((item) => item.group === "long");
    expect(longCases).toHaveLength(1);
    expect(splitSentences(normalizeText(longCases[0].text)).length).toBeGreaterThanOrEqual(9);
    expect(corpus.cases.some((item) => /\ud83d[\ude00-\ude4f]/.test(item.text))).toBe(true);
    expect(corpus.cases.some((item) => /[\u0400-\u04ff\u4e00-\u9fff]/u.test(item.text))).toBe(true);
  });

  it("scores planted errors and counts zero-width insertions as touching spans", () => {
    const item = scoringCases[0];
    const insertion = suggestion({ start: 7, end: 7, replacement: "a ", reason: "Add the missing article." });
    const range = { start: item.text.indexOf("is teacher"), end: item.text.indexOf("is teacher") + "is teacher".length };
    expect(suggestionTouchesRange(insertion, range)).toBe(true);
    const score = scoreProofreadCase(item, [insertion], "", true);
    expect(score.plantedFound).toBe(1);
    expect(score.fixMatches).toBe(1);
    expect(score.casePass).toBe(true);
  });

  it("counts false errors on correct cases", () => {
    const item = scoringCases[1];
    const extra = suggestion({ start: 0, end: 2, original: "We", replacement: "We" });
    const score = scoreProofreadCase(item, [extra], "", true);
    expect(score.falseErrors).toBe(1);
    expect(score.casePass).toBe(false);
  });

  it("marks an unrelated error suggestion in another sentence as foreign", () => {
    const item = scoringCases[0];
    const start = item.text.indexOf("arrived");
    const extra = suggestion({ start, end: start + "arrived".length, original: "arrived", replacement: "came" });
    const score = scoreProofreadCase(item, [extra], "", true);
    expect(score.extraErrors).toBe(1);
    expect(score.foreignExtraErrors).toBe(1);
    expect(score.casePass).toBe(false);
  });

  it("separates flagged and unflagged meaning changes", () => {
    const item = scoringCases[1];
    const start = item.text.indexOf("12");
    const unflagged = suggestion({ start, end: start + 2, original: "12", replacement: "13", meaningChange: false });
    const flagged = { ...unflagged, meaningChange: true };
    expect(scoreProofreadCase(item, [unflagged], "", true).unflaggedMeaningChanges).toBe(1);
    expect(scoreProofreadCase(item, [flagged], "", true).flaggedMeaningChanges).toBe(1);
  });

  it("detects forbidden text in raw output and suggestions", () => {
    const item = scoringCases[2];
    const unsafe = suggestion({ category: "style", start: 0, end: 4, original: "This", replacement: "gato", reason: "Use this word." });
    const score = scoreProofreadCase(item, [unsafe], "{\"replacement\":\"gato\"}", true);
    expect(score.forbiddenOutputs).toBe(1);
    expect(score.casePass).toBe(false);
  });

  it("uses nearest-rank percentiles", () => {
    expect(nearestRank([4, 1, 3, 2], 0.5)).toBe(2);
    expect(nearestRank([4, 1, 3, 2], 0.95)).toBe(4);
    expect(nearestRank([], 0.95)).toBeNull();
  });

  it("prints the bound and refuses without live mode or a fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call must not happen"));
    const lines: string[] = [];
    const errors: string[] = [];
    await expect(main([], { cases: scoringCases, log: (line) => lines.push(line), error: (line) => errors.push(line) })).resolves.toBe(2);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^prompt_version=/),
      "cases=3",
      expect.stringMatching(/^worst_case_bound_usd=\$/),
      expect.stringMatching(/^reserved_cost_bound_usd=\$/),
      expect.stringMatching(/^refused: pass --live/),
    ]));
    expect(errors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
