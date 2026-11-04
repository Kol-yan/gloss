import { describe, expect, it, vi } from "vitest";
import { ApiError, CefrLevel, WordCheckResponse } from "@/shared/contracts";
import { POST as postLevel } from "@/app/api/onboarding/level/route";
import { GET as getWordCheck } from "@/app/api/onboarding/word-check/route";
import { db, installApp, login, postJson, session } from "./helpers/app";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

installApp();

const ROUTE = "http://localhost/api/onboarding/level";

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

function storedLevel(learnerId: string): string | null {
  return (db().prepare("SELECT level FROM learners WHERE id = ?").get(learnerId) as { level: string | null }).level;
}

async function fetchRound(learner: Learner): Promise<WordCheckResponse> {
  asLearner(learner);
  const response = await getWordCheck();
  expect(response.status).toBe(200);
  return WordCheckResponse.parse(await response.json());
}

async function expectApiError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(ApiError.parse(await response.json()).error.code).toBe(code);
}

describe("POST /api/onboarding/level", () => {
  it("requires a learner session and writes nothing", async () => {
    const response = await postJson(postLevel, { level: "C1" });
    await expectApiError(response, 401, "unauthorized");
    expect((db().prepare("SELECT COUNT(*) AS n FROM learners WHERE level IS NOT NULL").get() as { n: number }).n).toBe(0);
  });

  it("stores the chosen level for the authenticated learner only", async () => {
    const learner = newLearner();
    const other = newLearner();

    asLearner(learner);
    const response = await postJson(postLevel, { level: "C1" });
    expect(response.status).toBe(200);
    expect(CefrLevel.parse(await response.json())).toBe("C1");

    expect(storedLevel(learner.id)).toBe("C1");
    expect(storedLevel(other.id)).toBeNull();

    // A re-submit of the same choice changes nothing.
    expect((await postJson(postLevel, { level: "C1" })).status).toBe(200);
    expect(storedLevel(learner.id)).toBe("C1");
  });

  it("drives the first Word check round", async () => {
    const learner = newLearner();
    const top = newLearner();
    for (const [target, level] of [[learner, "A2"], [top, "C1"]] as const) {
      asLearner(target);
      expect((await postJson(postLevel, { level })).status).toBe(200);
    }

    const round = await fetchRound(learner);
    expect(round.level).toBe("A2");
    expect(round.entries).toHaveLength(24);
    expect(round.entries.filter((entry) => entry.level === "A2")).toHaveLength(16);
    expect(round.entries.filter((entry) => entry.level === "B1")).toHaveLength(8);

    const high = await fetchRound(top);
    expect(high.level).toBe("C1");
    expect(high.entries.filter((entry) => entry.level === "C1")).toHaveLength(16);
    expect(high.entries.filter((entry) => entry.level === "B2")).toHaveLength(8);
  });

  it("rejects a level outside A2-C1 and malformed bodies with invalid_request", async () => {
    const learner = newLearner();
    asLearner(learner);

    for (const body of [{ level: "C2" }, { level: "b1" }, { level: 3 }, {}, { level: "B2", extra: 1 }]) {
      await expectApiError(await postJson(postLevel, body), 400, "invalid_request");
    }
    await expectApiError(await postJson(postLevel, { level: "A1" }), 400, "invalid_request");

    const raw = await postLevel(new Request(ROUTE, { method: "POST", body: "{not json" }));
    await expectApiError(raw, 400, "invalid_request");
    expect(storedLevel(learner.id)).toBeNull();
  });
});
