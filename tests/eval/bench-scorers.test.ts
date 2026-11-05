import { describe, expect, it } from "vitest";
import { diffHunks } from "@/server/proofread/diff";
import {
  containsWords,
  editDistance,
  f1,
  nearForm,
  normalizedEditDistance,
  percentile,
  scoreDictation,
  scoreEvaluation,
  scoreProofread,
  totalProofread,
  uniqueRange,
  type ExpectedError,
} from "../../eval/bench/lib/scorers";

// Predicted edits exactly as the app derives them: a word-level diff between
// the text and the model's corrected text.
function edits(text: string, corrected: string) {
  return diffHunks(text, corrected).map(({ start, end, replacement }) => ({ start, end, replacement }));
}

describe("scoreProofread", () => {
  const text = "She is engineer at a startup and she don't like meetings.";
  const errors: ExpectedError[] = [
    { span: "is engineer", fixes: ["is an engineer"], topic: "article" },
    { span: "she don't", fixes: ["she doesn't", "she does not"] },
  ];

  it("counts exact fixes and a fully right item", () => {
    const score = scoreProofread(text, errors, edits(text, "She is an engineer at a startup and she doesn't like meetings."));
    expect(score).toMatchObject({ expected: 2, fixedExact: 2, fixedNear: 2, located: 2, falsePositives: 0, itemCorrect: true });
    expect(score.predictedNear).toBe(score.predicted);
  });

  it("accepts any listed fix", () => {
    const score = scoreProofread(text, errors, edits(text, "She is an engineer at a startup and she does not like meetings."));
    expect(score.fixedExact).toBe(2);
  });

  it("treats case, comma and spacing differences as near but not exact", () => {
    const t = "Call me when you arrive to the airport.";
    const e: ExpectedError[] = [{ span: "arrive to the airport", fixes: ["arrive at the airport"] }];
    const score = scoreProofread(t, e, edits(t, "Call me when you arrive At the airport."));
    expect(score.fixedExact).toBe(0);
    expect(score.fixedNear).toBe(1);
    expect(score.itemCorrect).toBe(true);
  });

  it("locates a wrong fix without counting it as fixed", () => {
    const score = scoreProofread(text, errors, edits(text, "She is the engineer at a startup and she doesn't like meetings."));
    expect(score.located).toBe(2);
    expect(score.fixedNear).toBe(1);
    expect(score.itemCorrect).toBe(false);
    expect(score.predictedNear).toBe(1);
  });

  it("reports edits far from any expected error as false positives", () => {
    const score = scoreProofread(text, errors, edits(text, "She is an engineer at a start-up and she doesn't like meetings."));
    expect(score.falsePositives).toBe(1);
    expect(score.fixedNear).toBe(2);
    expect(score.itemCorrect).toBe(false);
  });

  it("scores a clean text with no edits as right and with edits as flagged", () => {
    const clean = "Thanks for the update, see you on Monday.";
    expect(scoreProofread(clean, [], []).itemCorrect).toBe(true);
    const flagged = scoreProofread(clean, [], edits(clean, "Thanks for the update. See you on Monday."));
    expect(flagged.falsePositives).toBeGreaterThan(0);
    expect(flagged.itemCorrect).toBe(false);
  });

  it("judges one edit that spans two neighbouring errors by the resulting words", () => {
    const t = "I has went home.";
    const e: ExpectedError[] = [
      { span: "has", fixes: ["have"] },
      { span: "went", fixes: ["gone"] },
    ];
    const merged = [{ start: t.indexOf("has"), end: t.indexOf("went") + 4, replacement: "have gone" }];
    const score = scoreProofread(t, e, merged);
    expect(score).toMatchObject({ fixedExact: 2, predicted: 1, predictedExact: 1, itemCorrect: true });
  });

  it("judges two edits inside one expected span together", () => {
    const t = "We discussed about the plan in the last week.";
    const e: ExpectedError[] = [{ span: "discussed about the plan in the last week", fixes: ["discussed the plan last week"] }];
    const split = [
      { start: t.indexOf("discussed") + 9, end: t.indexOf(" the plan"), replacement: "" },
      { start: t.indexOf(" in the last"), end: t.indexOf(" last week"), replacement: "" },
    ];
    const score = scoreProofread(t, e, split);
    expect(score.predicted).toBe(2);
    expect(score).toMatchObject({ fixedExact: 1, predictedExact: 2, itemCorrect: true });
  });

  it("groups expected errors that only a space separates", () => {
    const t = "She explained us the whole process in details.";
    const e: ExpectedError[] = [
      { span: "explained us the whole process", fixes: ["explained the whole process to us"] },
      { span: "in details", fixes: ["in detail"] },
    ];
    // The diff moves "to us" into the second span's edit.
    const score = scoreProofread(t, e, edits(t, "She explained the whole process to us in detail."));
    expect(score).toMatchObject({ fixedExact: 2, falsePositives: 0, itemCorrect: true });
  });

  it("refuses an answer key whose span is not unique", () => {
    expect(() => scoreProofread("the cat and the dog", [{ span: "the", fixes: ["a"] }], [])).toThrow(/not unique/);
  });
});

describe("totalProofread", () => {
  it("computes precision, recall and F1 over all items", () => {
    const text = "He go to work. She go home.";
    const errors: ExpectedError[] = [
      { span: "He go", fixes: ["He goes"] },
      { span: "She go", fixes: ["She goes"] },
    ];
    const one = scoreProofread(text, errors, edits(text, "He goes to work. She go home."));
    const clean = scoreProofread("All good.", [], edits("All good.", "All fine."));
    const totals = totalProofread([one, clean]);
    expect(totals.expected).toBe(2);
    expect(totals.predicted).toBe(2);
    expect(totals.recallNear).toBe(0.5);
    expect(totals.precisionNear).toBe(0.5);
    expect(totals.f1Near).toBe(0.5);
    expect(totals.cleanItems).toBe(1);
    expect(totals.cleanFlagged).toBe(1);
  });

  it("returns null ratios when nothing was predicted", () => {
    const totals = totalProofread([scoreProofread("Fine.", [], [])]);
    expect(totals.precisionNear).toBeNull();
    expect(totals.recallNear).toBeNull();
    expect(totals.f1Near).toBeNull();
  });

  it("handles F1 edge cases", () => {
    expect(f1(0, 0)).toBe(0);
    expect(f1(null, 1)).toBeNull();
    expect(f1(1, 1)).toBe(1);
  });
});

describe("text helpers", () => {
  it("finds unique ranges only", () => {
    expect(uniqueRange("a cat sat", "cat")).toEqual({ start: 2, end: 5 });
    expect(uniqueRange("a cat sat on a cat", "cat")).toBeNull();
    expect(uniqueRange("abc", "")).toBeNull();
  });

  it("normalizes near forms", () => {
    expect(nearForm("It’s  Fine, “really”")).toBe(nearForm("it's fine \"really\""));
  });
});

describe("dictation scoring", () => {
  it("computes edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("mañana", "manana")).toBe(1);
    expect(normalizedEditDistance("Same text.", "Same  text.")).toBe(0);
    expect(normalizedEditDistance("", "")).toBe(0);
  });

  it("rewards a faithful clean-up", () => {
    const score = scoreDictation({
      transcript: "um so i will uh send the the report",
      expected: "So I will send the report.",
      output: "So I will send the report.",
    });
    expect(score).toMatchObject({ distance: 0, exact: true, addedWords: [], keptShare: 1, wordsPreserved: true });
  });

  it("catches added and lost words", () => {
    const score = scoreDictation({
      transcript: "i has finished the first part",
      expected: "I has finished the first part.",
      output: "I have finished the first part.",
      keep: ["has"],
    });
    expect(score.addedWords).toEqual(["have"]);
    expect(score.missingKeep).toEqual(["has"]);
    expect(score.keptShare).toBeLessThan(1);
    expect(score.wordsPreserved).toBe(false);
  });

  it("uses the closest accepted variant", () => {
    const score = scoreDictation({
      transcript: "okay so we start at nine",
      expected: "Okay, so we start at nine.",
      accept: ["Okay so we start at nine."],
      output: "Okay so we start at nine.",
    });
    expect(score.distance).toBe(0);
    expect(score.exact).toBe(true);
  });

  it("matches must-keep terms as whole words", () => {
    expect(containsWords("My mother says mañana, mañana!", "mañana mañana")).toBe(true);
    expect(containsWords("We cannot come.", "no")).toBe(false);
    expect(containsWords("No, actually we stay.", "no")).toBe(true);
  });
});

describe("evaluation scoring", () => {
  it("separates acceptable, strict and false passes", () => {
    const item = { expected: "almost" as const, acceptable: ["almost" as const, "not_yet" as const] };
    expect(scoreEvaluation(item, "almost")).toEqual({ verdict: "almost", acceptable: true, strict: true, falsePass: false });
    expect(scoreEvaluation(item, "not_yet")).toMatchObject({ acceptable: true, strict: false, falsePass: false });
    expect(scoreEvaluation(item, "used_well")).toMatchObject({ acceptable: false, falsePass: true });
    expect(scoreEvaluation(item, null)).toMatchObject({ acceptable: false, falsePass: false });
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([10, 1, 7, 3, 5, 9, 2, 8, 4, 6], 0.95)).toBe(10);
  });
});
