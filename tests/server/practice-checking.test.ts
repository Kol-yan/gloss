import { describe, expect, it } from "vitest";
import { checkPracticeAnswer, normalizePracticeAnswer } from "@/server/practice/checking";

describe("normalizePracticeAnswer", () => {
  it("normalizes case, Unicode composition, apostrophes, punctuation and whitespace", () => {
    expect(normalizePracticeAnswer("  CAFÉ—don’t\tstop!  ")).toBe("café don't stop");
    expect(normalizePracticeAnswer("Cafe\u0301...  DON`T\nstop")).toBe("café don't stop");
  });
});

describe("checkPracticeAnswer", () => {
  it("accepts normalized typed answers and adjacent transpositions", () => {
    expect(checkPracticeAnswer({ rung: 4, answer: "  The   answer! ", expected: "the answer" })).toMatchObject({
      correct: true,
      normalizedAnswer: "the answer",
      typoDistance: 0,
    });
    expect(checkPracticeAnswer({ rung: 4, answer: "teh", expected: "the" })).toMatchObject({
      correct: true,
      typoDistance: 1,
    });
  });

  it("allows one typo below ten characters and two at ten or more", () => {
    expect(checkPracticeAnswer({ rung: 4, answer: "exampl", expected: "example" }).correct).toBe(true);
    expect(checkPracticeAnswer({ rung: 4, answer: "exampelx", expected: "example" }).correct).toBe(false);
    expect(checkPracticeAnswer({ rung: 4, answer: "abcdefghijx", expected: "abcdefghij" }).correct).toBe(true);
    expect(checkPracticeAnswer({ rung: 4, answer: "abcdefghijxyz", expected: "abcdefghij" }).correct).toBe(false);
  });

  it("keeps choice rungs exact and rejects answers outside the four options", () => {
    for (const rung of [1, 2, 3] as const) {
      const options = ["unlikely", "unlike", "unlocked", "likely"];
      expect(checkPracticeAnswer({ rung, answer: "unlike", expected: "unlikely", options }).correct).toBe(false);
      expect(checkPracticeAnswer({ rung, answer: "unlikel", expected: "unlikely", options }).correct).toBe(false);
      expect(checkPracticeAnswer({ rung, answer: "unlikely", expected: "unlikely", options }).correct).toBe(true);
      expect(checkPracticeAnswer({ rung, answer: "unlikely", expected: "unlikely", options: ["unlike", "unlocked", "likely", "unliked"] }).correct).toBe(false);
    }
  });

  it("rejects empty answers and I don't know even when the text matches", () => {
    expect(checkPracticeAnswer({ rung: 4, answer: "", expected: "word" }).correct).toBe(false);
    expect(checkPracticeAnswer({ rung: 4, answer: "word", expected: "word", dontKnow: true }).correct).toBe(false);
    expect(checkPracticeAnswer({ rung: 1, answer: "word", expected: "word", options: ["word"], dontKnow: true }).correct).toBe(false);
  });
});
