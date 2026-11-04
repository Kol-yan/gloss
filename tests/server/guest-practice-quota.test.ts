import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePracticeSession } from "@/server/practice/sessions";
import { QuotaExceededError } from "@/server/errors";
import { createTempDb, insertLearner, testConfig, type TempDb } from "./helpers/db";

let temp: TempDb;
beforeEach(() => { temp = createTempDb(); });
afterEach(() => temp.cleanup());
const now = new Date("2026-11-04T23:59:59.000Z");
const config = testConfig();

describe("guest practice allowance", () => {
  it("claims at most three sessions, replays without spending, and resets at UTC midnight", () => {
    const id = insertLearner(temp.db, "guest");
    const learner = { id, displayName: "Guest", quotaProfile: "guest" as const };
    const deps = { db: temp.db, now, config };
    const requestId = crypto.randomUUID();
    const first = preparePracticeSession(learner, { requestId }, deps);
    expect(preparePracticeSession(learner, { requestId }, deps).sessionId).toBe(first.sessionId);
    for (let i = 0; i < 2; i++) preparePracticeSession(learner, { requestId: crypto.randomUUID() }, deps);
    expect(() => preparePracticeSession(learner, { requestId: crypto.randomUUID() }, deps)).toThrow(QuotaExceededError);
    expect(preparePracticeSession(learner, { requestId: crypto.randomUUID() }, {
      ...deps, now: new Date("2026-11-05T00:00:00.000Z"),
    }).sessionId).toBeTruthy();
  });
});
