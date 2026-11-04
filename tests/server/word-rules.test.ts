import { describe, expect, it } from "vitest";
import {
  applyRealUse,
  nextRungDown,
  nextRungUp,
  recordAnswer,
} from "@/server/learning/priority/rules";
import type { AnswerInput } from "@/server/learning/priority/rules";
import type { StoredWord } from "@/server/learning/priority/types";

const NOW = new Date("2026-11-04T09:00:00.000Z");

function word(overrides: Partial<StoredWord> = {}): StoredWord {
  return {
    expressionId: "w1",
    learnerId: "learner",
    text: "bottleneck",
    normalized: "bottleneck",
    source: "saved",
    status: "learning",
    band: "common",
    rung: 1,
    productiveAnswers: 0,
    realUseCount: 0,
    realUseDocuments: 0,
    realUseDays: 0,
    realUseLastAt: null,
    wordCheckAnswer: null,
    consecutiveErrors: 0,
    answers: 0,
    correctAnswers: 0,
    deepKnown: 0,
    bland: 0,
    lastPracticedAt: null,
    nextAt: null,
    introducedOn: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function answer(overrides: Partial<AnswerInput> = {}): AnswerInput {
  return { expressionId: "w1", rung: 1, productive: false, correct: true, usedHint: false, ...overrides };
}

describe("practice ladder", () => {
  it("moves one rung up and down, bounded to 1..6", () => {
    expect(nextRungUp(1)).toBe(2);
    expect(nextRungUp(5)).toBe(6);
    expect(nextRungUp(6)).toBe(6);
    expect(nextRungDown(3)).toBe(2);
    expect(nextRungDown(1)).toBe(1);
    expect(nextRungUp(Number.NaN)).toBe(1);
  });

  it("a correct answer from Learning moves to Ready to activate", () => {
    const result = recordAnswer(answer({ rung: 1, correct: true }), word(), NOW);
    expect(result).toMatchObject({ status: "ready", nextRung: 2 });
    expect(Date.parse(result.comesBackAt)).toBeGreaterThan(NOW.getTime());
  });

  it("a wrong answer keeps a new word in Learning and brings it back tomorrow", () => {
    const result = recordAnswer(answer({ correct: false }), word(), NOW);
    expect(result.status).toBe("learning");
    expect(result.nextRung).toBe(1);
    expect(result.comesBackAt).toBe("2026-11-05T09:00:00.000Z");
  });
});

describe("active after 3 productive answers", () => {
  it("counts only correct productive answers", () => {
    const current = word({ status: "ready", rung: 4, productiveAnswers: 2 });
    const result = recordAnswer(answer({ rung: 4, productive: true, correct: true }), current, NOW, 0);
    expect(result.status).toBe("active");
  });

  it("does not count recognition or a wrong answer", () => {
    const afterRecognition = recordAnswer(
      answer({ rung: 1, productive: false, correct: true }),
      word({ status: "ready", rung: 2, productiveAnswers: 2 }),
      NOW,
      0,
    );
    expect(afterRecognition.status).toBe("ready");
    const afterWrong = recordAnswer(
      answer({ rung: 3, productive: true, correct: false }),
      word({ status: "ready", rung: 3, productiveAnswers: 2 }),
      NOW,
      1,
    );
    expect(afterWrong.status).toBe("ready");
  });

  it("any productive answer from a word that already has real use makes it active", () => {
    const result = recordAnswer(
      answer({ rung: 2, productive: true, correct: true }),
      word({ status: "ready", rung: 2, realUseCount: 2 }),
      NOW,
      0,
    );
    expect(result.status).toBe("active");
  });
});

describe("real use outweighs exercise", () => {
  it("two uses in the learner's own writing make a passive word active at once", () => {
    const first = applyRealUse(word({ status: "learning" }));
    expect(first).toEqual({ status: "ready", active: false });
    const second = applyRealUse(word({ status: "learning", realUseCount: 1 }));
    expect(second).toEqual({ status: "active", active: true });
  });

  it("one real use is enough sooner than one productive answer", () => {
    expect(applyRealUse(word({ status: "ready", realUseCount: 1 })).status).toBe("active");
    const oneAnswer = recordAnswer(
      answer({ rung: 2, productive: true, correct: true }),
      word({ status: "ready", rung: 2 }),
      NOW,
      0,
    );
    expect(oneAnswer.status).toBe("ready");
  });

  it("does not resurrect a hidden word", () => {
    expect(applyRealUse(word({ status: "hidden" }))).toEqual({ status: "hidden", active: false });
  });
});

describe("two errors in a row move a word one step down", () => {
  it("Ready falls to Learning", () => {
    const result = recordAnswer(answer({ rung: 2, correct: false }), word({ status: "ready", rung: 2, consecutiveErrors: 1 }), NOW, 2);
    expect(result.status).toBe("learning");
  });

  it("Active falls to Ready", () => {
    const result = recordAnswer(
      answer({ rung: 4, correct: false }),
      word({ status: "active", rung: 4, productiveAnswers: 3, consecutiveErrors: 1 }),
      NOW,
      2,
    );
    expect(result).toMatchObject({ status: "ready", nextRung: 3 });
  });

  it("one error does not move the status", () => {
    const result = recordAnswer(answer({ rung: 2, correct: false }), word({ status: "ready", rung: 2 }), NOW, 1);
    expect(result.status).toBe("ready");
  });

  it("the demotion holds even when old credit would lift the word again", () => {
    // A word that was Active with three productive answers falls to Ready on
    // the second error. The demotion resets the credit, so a third wrong
    // answer does not bring it back through the old counter.
    const demoted = word({ status: "active", rung: 4, productiveAnswers: 3, consecutiveErrors: 1 });
    const second = recordAnswer(answer({ rung: 4, correct: false }), demoted, NOW, 2);
    expect(second.status).toBe("ready");
    const third = recordAnswer(
      answer({ rung: 3, correct: false }),
      { ...demoted, status: "ready", rung: 3, productiveAnswers: 0, consecutiveErrors: 0 },
      NOW,
      1,
    );
    expect(third.status).toBe("ready");
    // A word that keeps two real uses stays Active: real use outranks practice.
    const realUse = recordAnswer(
      answer({ rung: 3, correct: false }),
      word({ status: "ready", rung: 3, realUseCount: 2 }),
      NOW,
      1,
    );
    expect(realUse.status).toBe("active");
  });

  it("a correct answer keeps Active", () => {
    const result = recordAnswer(
      answer({ rung: 4, productive: true, correct: true }),
      word({ status: "active", rung: 4, productiveAnswers: 3 }),
      NOW,
      0,
    );
    expect(result.status).toBe("active");
  });
});

describe("reactions", () => {
  it("Already know makes the word Active with a rare check", () => {
    const result = recordAnswer(answer({ reaction: "already_know" }), word({ status: "learning", rung: 1 }), NOW, 1);
    const days = (Date.parse(result.comesBackAt) - NOW.getTime()) / 86_400_000;
    expect(result.status).toBe("active");
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(14);
  });

  it("Not relevant hides the word and keeps it out of later sessions", () => {
    const result = recordAnswer(answer({ reaction: "not_relevant" }), word({ status: "ready", rung: 2 }), NOW, 0);
    expect(result.status).toBe("hidden");
    const later = recordAnswer(answer({ reaction: "too_easy" }), word({ status: "hidden", rung: 2 }), NOW, 0);
    expect(later.status).toBe("hidden");
  });

  it("Too hard moves to an easier rung and brings the word back tomorrow", () => {
    const result = recordAnswer(answer({ rung: 3, correct: false, reaction: "too_hard" }), word({ status: "ready", rung: 3 }), NOW, 1);
    expect(result.nextRung).toBe(2);
    expect(result.comesBackAt).toBe("2026-11-05T09:00:00.000Z");
    // One "too hard" is not an error streak; the word stays where it is.
    expect(result.status).toBe("ready");
  });

  it("Too hard from rung 1 never goes below 1", () => {
    const result = recordAnswer(answer({ rung: 1, correct: false, reaction: "too_hard" }), word({ rung: 1 }), NOW, 1);
    expect(result.nextRung).toBe(1);
    expect(result.status).toBe("learning");
  });

  it("Too easy jumps to productive work and marks the word ready", () => {
    const result = recordAnswer(answer({ rung: 1, reaction: "too_easy" }), word({ status: "learning", rung: 1 }), NOW, 0);
    expect(result.nextRung).toBe(2);
    expect(result.status).toBe("ready");
  });

  it("Too easy on an Active word keeps it Active", () => {
    const result = recordAnswer(answer({ rung: 3, reaction: "too_easy" }), word({ status: "active", rung: 3 }), NOW, 0);
    expect(result.status).toBe("active");
  });
});

describe("comeback time", () => {
  it("an Active word comes back for its rare check, sooner when produced more", () => {
    const result = recordAnswer(
      answer({ rung: 3, correct: true }),
      word({ status: "active", rung: 3, productiveAnswers: 0 }),
      NOW,
      0,
    );
    const days = (Date.parse(result.comesBackAt) - NOW.getTime()) / 86_400_000;
    expect(days).toBe(14);
  });

  it("a correct answer from Learning moves to Ready and comes back in two days", () => {
    const result = recordAnswer(answer({ rung: 1, correct: true }), word({ rung: 1 }), NOW, 0);
    expect(result.status).toBe("ready");
    expect(result.comesBackAt).toBe("2026-11-06T09:00:00.000Z");
  });

  it("a correct answer on Ready comes back in two days", () => {
    const result = recordAnswer(answer({ rung: 2, correct: true }), word({ status: "ready", rung: 2 }), NOW, 0);
    expect(result.comesBackAt).toBe("2026-11-06T09:00:00.000Z");
  });
});
