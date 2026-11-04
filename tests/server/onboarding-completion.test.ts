import { describe, expect, it, vi } from "vitest";
import { POST as postComplete } from "@/app/api/onboarding/complete/route";
import { GET as getWordCheck, POST as postWordCheck } from "@/app/api/onboarding/word-check/route";
import { closeDb, getDb } from "@/server/db";
import { hasCompletedOnboarding, completeOnboarding } from "@/server/learning/onboarding/completion";
import { ApiError, WordCheckResponse } from "@/shared/contracts";
import { db, installApp, login, postJson, session } from "./helpers/app";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

installApp();

interface Learner {
  id: string;
  cookie: string;
}

function newLearner(): Learner {
  const { learner, sessionToken } = login();
  return { id: learner.id, cookie: sessionToken };
}

function asLearner(learner: Learner): void {
  session.cookie = learner.cookie;
}

async function serveRound(learner: Learner): Promise<WordCheckResponse> {
  asLearner(learner);
  const response = await getWordCheck();
  expect(response.status).toBe(200);
  return WordCheckResponse.parse(await response.json());
}

async function answerRound(learner: Learner): Promise<void> {
  const round = await serveRound(learner);
  const response = await postJson(postWordCheck, {
    answers: round.entries.map(({ id }) => ({ id, answer: "use" })),
  });
  expect(response.status).toBe(200);
}

async function expectApiError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(ApiError.parse(await response.json()).error.code).toBe(code);
}

function completedAt(learnerId: string): string | null {
  const row = db()
    .prepare("SELECT onboarding_completed_at FROM learners WHERE id = ?")
    .get(learnerId) as { onboarding_completed_at: string | null };
  return row.onboarding_completed_at;
}

describe("POST /api/onboarding/complete", () => {
  it("requires an authenticated learner", async () => {
    await expectApiError(await postJson(postComplete, {}), 401, "unauthorized");
    expect((db().prepare("SELECT COUNT(*) AS count FROM learners WHERE onboarding_completed_at IS NOT NULL").get() as { count: number }).count).toBe(0);
  });

  it("accepts only a small empty JSON object", async () => {
    const learner = newLearner();
    asLearner(learner);

    for (const body of [null, [], { extra: true }, "{}", 1]) {
      await expectApiError(await postJson(postComplete, body), 400, "invalid_request");
    }
    const tooLarge = await postComplete(
      new Request("http://localhost/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ value: "x".repeat(256) }),
      }),
    );
    await expectApiError(tooLarge, 400, "invalid_request");
    expect(completedAt(learner.id)).toBeNull();
  });

  it("refuses learners with no served round or an incomplete round", async () => {
    const learner = newLearner();
    asLearner(learner);
    await expectApiError(await postJson(postComplete, {}), 400, "invalid_request");

    const round = await serveRound(learner);
    const partial = await postJson(postWordCheck, {
      answers: [{ id: round.entries[0].id, answer: "use" }],
    });
    expect(partial.status).toBe(200);
    await expectApiError(await postJson(postComplete, {}), 400, "invalid_request");
    expect(hasCompletedOnboarding(learner.id, db())).toBe(false);
  });

  it("records completion after a finished 24-entry round and keeps it after reopening", async () => {
    const learner = newLearner();
    const round = await serveRound(learner);
    expect(round.roundSize).toBe(24);
    await answerRound(learner);

    asLearner(learner);
    const response = await postJson(postComplete, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true });
    const timestamp = completedAt(learner.id);
    expect(timestamp).toBeTruthy();
    expect(hasCompletedOnboarding(learner.id, db())).toBe(true);

    closeDb();
    expect(hasCompletedOnboarding(learner.id, getDb())).toBe(true);
    asLearner(learner);
    expect((await postJson(postComplete, {})).status).toBe(200);
    expect(completedAt(learner.id)).toBe(timestamp);
  });

  it("keeps completion isolated to the learner with the finished round", async () => {
    const first = newLearner();
    const second = newLearner();
    await answerRound(first);
    asLearner(first);
    expect((await postJson(postComplete, {})).status).toBe(200);

    asLearner(second);
    await expectApiError(await postJson(postComplete, {}), 400, "invalid_request");
    expect(hasCompletedOnboarding(first.id, db())).toBe(true);
    expect(hasCompletedOnboarding(second.id, db())).toBe(false);
    expect(completedAt(second.id)).toBeNull();
  });

  it("allows a completed shorter round when that is all the learner was served", async () => {
    const learner = newLearner();
    const round = await serveRound(learner);
    const dbConnection = db();
    dbConnection.prepare("DELETE FROM word_check_entries WHERE learner_id = ? AND id <> ?").run(learner.id, round.entries[0].id);
    const response = await postJson(postWordCheck, {
      answers: [{ id: round.entries[0].id, answer: "use" }],
    });
    expect(response.status).toBe(200);
    asLearner(learner);
    expect((await postJson(postComplete, {})).status).toBe(200);
    expect(hasCompletedOnboarding(learner.id, dbConnection)).toBe(true);
  });
});

describe("completeOnboarding service", () => {
  it("is idempotent when called repeatedly after a completed round", async () => {
    const learner = newLearner();
    await answerRound(learner);
    completeOnboarding(learner.id, db());
    const timestamp = completedAt(learner.id);
    completeOnboarding(learner.id, db());
    expect(completedAt(learner.id)).toBe(timestamp);
  });
});
