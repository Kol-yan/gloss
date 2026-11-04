import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock("@/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db")>()),
  getDb: getDbMock,
}));

import { openDatabase } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { pickSessionWords, recordPracticeResult } from "@/server/practice/word-source";

let db: DatabaseSync;
let sequence = 0;
const now = new Date("2026-11-03T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  db = openDatabase(":memory:");
  getDbMock.mockReturnValue(db);
  sequence = 0;
  db.prepare("INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES (?, ?, 'pilot', ?)").run(
    "learner-a", "A", now.toISOString(),
  );
  db.prepare("INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES (?, ?, 'pilot', ?)").run(
    "learner-b", "B", now.toISOString(),
  );
});

afterEach(() => {
  getDbMock.mockReset();
  db.close();
  vi.useRealTimers();
});

function seedExpression(
  learnerId: string,
  text: string,
  familiarity: "new" | "known_unused" | "used" = "new",
  nextPracticeAt: string | null = null,
  createdAt = now.toISOString(),
): string {
  const id = `expression-${++sequence}`;
  const runId = `run-${sequence}`;
  const suggestionId = `suggestion-${sequence}`;
  db.prepare(
    `INSERT INTO check_runs
       (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
     VALUES (?, ?, ?, 'h', 1, 'meta', 'muse-spark-1.3', 'ok', ?)`,
  ).run(runId, learnerId, `request-${sequence}`, createdAt);
  db.prepare(
    `INSERT INTO suggestions
       (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning_change, status)
     VALUES (?, ?, ?, 0, 1, 'x', ?, 'expression', 'reason', 0, 'accepted')`,
  ).run(suggestionId, runId, learnerId, text);
  db.prepare(
    `INSERT INTO expressions
       (id, learner_id, suggestion_id, text, meaning, familiarity, next_practice_at, created_at)
     VALUES (?, ?, ?, ?, 'meaning', ?, ?, ?)`,
  ).run(id, learnerId, suggestionId, text, familiarity, nextPracticeAt, createdAt);
  return id;
}

function progress(expressionId: string) {
  return db.prepare("SELECT * FROM practice_word_progress WHERE learner_id = 'learner-a' AND expression_id = ?").get(expressionId) as
    | Record<string, unknown>
    | undefined;
}

describe("practice word source", () => {
  it("maps saved expressions to slots and starter rungs with short reasons", () => {
    const ready = seedExpression("learner-a", "the", "known_unused");
    const learning = seedExpression("learner-a", "serendipity", "new");
    const active = seedExpression("learner-a", "work", "used");
    expect(pickSessionWords("learner-a", 3)).toEqual([
      expect.objectContaining({ expressionId: ready, slot: "activate", status: "ready", startRung: 2, frequency: "core" }),
      expect.objectContaining({ expressionId: learning, slot: "learn", status: "learning", startRung: 1, frequency: "uncommon" }),
      expect.objectContaining({ expressionId: active, slot: "keep", status: "active", startRung: 4, frequency: "core" }),
    ]);
    expect(pickSessionWords("learner-a", 1)[0].why).toContain("you know it but don't use it yet");
  });

  it("orders due expressions before familiarity and bounds session size to one through eight", () => {
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    const futureKnown = seedExpression("learner-a", "known future", "known_unused", future);
    const dueNew = seedExpression("learner-a", "new due", "new");
    const dueKnown = seedExpression("learner-a", "known due", "known_unused");
    const laterCreation = new Date(now.getTime() + 1_000).toISOString();
    for (let i = 0; i < 9; i++) seedExpression("learner-a", `extra ${i}`, "new", null, laterCreation);
    const selected = pickSessionWords("learner-a", 20);
    expect(selected).toHaveLength(8);
    expect(selected.slice(0, 2).map((word) => word.expressionId)).toEqual([dueKnown, dueNew]);
    expect(selected.at(-1)?.expressionId).not.toBe(futureKnown);
    expect(pickSessionWords("learner-a", 0)).toHaveLength(1);
    expect(pickSessionWords("learner-a", -2)).toHaveLength(1);
  });

  it("keeps learner ownership and hidden expressions scoped", () => {
    const own = seedExpression("learner-a", "own word");
    const hidden = seedExpression("learner-a", "hidden word");
    const other = seedExpression("learner-b", "other learner word");
    recordPracticeResult({ learnerId: "learner-a", expressionId: hidden, rung: 1, productive: false, correct: false, usedHint: false, reaction: "not_relevant" });
    expect(pickSessionWords("learner-a").map((word) => word.expressionId)).toContain(own);
    expect(pickSessionWords("learner-a").map((word) => word.expressionId)).not.toContain(hidden);
    expect(pickSessionWords("learner-a").map((word) => word.expressionId)).not.toContain(other);
    expect(() => recordPracticeResult({ learnerId: "learner-a", expressionId: other, rung: 1, productive: true, correct: true, usedHint: false })).toThrow(NotFoundError);
    expect(progress(other)).toBeUndefined();
  });

  it("promotes after three correct productive unhinted answers and updates the expression schedule", () => {
    const id = seedExpression("learner-a", "build");
    let result = recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 1, productive: true, correct: true, usedHint: false });
    expect(result).toMatchObject({ status: "learning", nextRung: 2 });
    result = recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 2, productive: true, correct: true, usedHint: false });
    expect(result).toMatchObject({ status: "learning", nextRung: 3 });
    result = recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 3, productive: true, correct: true, usedHint: false });
    expect(result).toMatchObject({ status: "active", nextRung: 4 });
    expect(progress(id)).toMatchObject({ status: "active", productive_successes: 3, next_rung: 4 });
    expect(db.prepare("SELECT familiarity, next_practice_at FROM expressions WHERE id = ?").get(id)).toEqual({
      familiarity: "used",
      next_practice_at: new Date(now.getTime() + 86_400_000).toISOString(),
    });
  });

  it("moves down once per pair of consecutive wrong answers", () => {
    const id = seedExpression("learner-a", "hard", "known_unused");
    recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 2, productive: false, correct: false, usedHint: false });
    expect(progress(id)).toMatchObject({ next_rung: 2, wrong_streak: 1 });
    recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 2, productive: false, correct: false, usedHint: false });
    expect(progress(id)).toMatchObject({ next_rung: 1, wrong_streak: 0 });
  });

  it("applies reactions without counting the answer again", () => {
    const id = seedExpression("learner-a", "reaction");
    const tooHard = recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 3, productive: true, correct: false, usedHint: false, reaction: "too_hard" });
    expect(tooHard).toMatchObject({ status: "learning", nextRung: 2 });
    expect(progress(id)).toMatchObject({ wrong_streak: 0, productive_successes: 0, last_reaction: "too_hard" });
    const alreadyKnow = recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 2, productive: true, correct: false, usedHint: false, reaction: "already_know" });
    expect(alreadyKnow).toMatchObject({ status: "active", nextRung: 4 });
    expect(db.prepare("SELECT familiarity FROM expressions WHERE id = ?").get(id)).toEqual({ familiarity: "used" });
  });

  it("rolls back progress if scheduling the owned expression fails", () => {
    const id = seedExpression("learner-a", "atomic");
    db.exec(`CREATE TRIGGER stop_schedule BEFORE UPDATE OF next_practice_at ON expressions
      BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
    expect(() => recordPracticeResult({ learnerId: "learner-a", expressionId: id, rung: 1, productive: false, correct: true, usedHint: false })).toThrow();
    expect(progress(id)).toBeUndefined();
  });
});
