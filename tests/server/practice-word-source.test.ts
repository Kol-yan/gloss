import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  pickSessionWords: vi.fn(),
  recordPracticeResult: vi.fn(),
  recordPracticeReaction: vi.fn(),
}));

vi.mock("@/server/learning/priority/engine", () => engine);

import {
  pickSessionWords,
  recordPracticeReaction,
  recordPracticeResult,
} from "@/server/practice/word-source";

beforeEach(() => vi.clearAllMocks());

describe("practice word-source adapter", () => {
  it("returns the engine's priority mix and forwards the learner, limit and transaction", () => {
    const selected = [
      { expressionId: "edge", text: "edge", slot: "activate", status: "ready", startRung: 2, frequency: "core", why: "Core word" },
      { expressionId: "new", text: "new", slot: "learn", status: "learning", startRung: 1, frequency: "common", why: "Common word" },
      { expressionId: "keep", text: "keep", slot: "keep", status: "active", startRung: 4, frequency: "common", why: "Common word" },
    ];
    const deps = { db: {} as never, now: new Date("2026-11-04T12:00:00.000Z") };
    engine.pickSessionWords.mockReturnValue(selected);

    expect(pickSessionWords("learner-7", 8, deps)).toBe(selected);
    expect(engine.pickSessionWords).toHaveBeenCalledWith("learner-7", 8, deps);
  });

  it("forwards answer and reaction writes to the engine without maintaining adapter state", () => {
    const answer = { learnerId: "learner-7", expressionId: "word-1", rung: 4, productive: true, correct: true, usedHint: false, eventId: "item-1" };
    const reaction = { learnerId: "learner-7", expressionId: "word-1", eventId: "item-1", reaction: "too_easy", correct: true } as const;
    const deps = { db: {} as never, now: new Date("2026-11-04T12:00:00.000Z") };
    engine.recordPracticeResult.mockReturnValue({ status: "active", nextRung: 5, comesBackAt: "2026-11-07T12:00:00.000Z" });
    engine.recordPracticeReaction.mockReturnValue({ status: "active", nextRung: 5, comesBackAt: "2026-11-07T12:00:00.000Z" });

    expect(recordPracticeResult(answer, deps)).toEqual(engine.recordPracticeResult.mock.results[0]?.value);
    expect(recordPracticeReaction(reaction, deps)).toEqual(engine.recordPracticeReaction.mock.results[0]?.value);
    expect(engine.recordPracticeResult).toHaveBeenCalledWith(answer, deps);
    expect(engine.recordPracticeReaction).toHaveBeenCalledWith(reaction, deps);
  });
});
