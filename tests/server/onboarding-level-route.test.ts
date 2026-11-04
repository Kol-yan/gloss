import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  CefrLevel,
  ONBOARDING_LEVEL_GROUPS,
  ONBOARDING_LEVEL_GROUP_LIST,
  OnboardingLevelGroup,
  OnboardingLevelRequest,
  WordCheckResponse,
  resolveOnboardingEngineLevel,
} from "@/shared/contracts";
import { POST as postLevel } from "@/app/api/onboarding/level/route";
import { GET as getWordCheck, POST as postWordCheck } from "@/app/api/onboarding/word-check/route";
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

  it("accepts every legacy CEFR level and returns it unchanged", async () => {
    for (const level of ["A2", "B1", "B2", "C1"] as const) {
      const learner = newLearner();
      asLearner(learner);
      const response = await postJson(postLevel, { level });
      expect(response.status).toBe(200);
      expect(CefrLevel.parse(await response.json())).toBe(level);
      expect(storedLevel(learner.id)).toBe(level);
    }
  });
});

describe("onboarding level groups", () => {
  it("exports typed group definitions with labels, ranges and engine mapping", () => {
    expect(ONBOARDING_LEVEL_GROUPS.proficient).toMatchObject({
      label: "Proficient or native",
      displayLevel: "C2",
      engineLevel: "C1",
    });
    expect(ONBOARDING_LEVEL_GROUPS.advanced.engineLevel).toBe("B2");
    expect(ONBOARDING_LEVEL_GROUPS.advanced.rangeLabel).toContain("B2");
    expect(ONBOARDING_LEVEL_GROUPS.intermediate.engineLevel).toBe("B1");
    expect(ONBOARDING_LEVEL_GROUPS.elementary.engineLevel).toBe("A2");
    expect(ONBOARDING_LEVEL_GROUPS.elementary.rangeLabel).toContain("A1");
    expect(ONBOARDING_LEVEL_GROUPS.unsure.engineLevel).toBe("B1");
    for (const definition of ONBOARDING_LEVEL_GROUP_LIST) {
      expect(OnboardingLevelGroup.parse(definition.group)).toBe(definition.group);
      expect(CefrLevel.parse(definition.engineLevel)).toBe(definition.engineLevel);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.rangeLabel.length).toBeGreaterThan(0);
      expect(definition.displayLevel.length).toBeGreaterThan(0);
    }
    expect(resolveOnboardingEngineLevel("proficient")).toBe("C1");
    expect(resolveOnboardingEngineLevel("advanced")).toBe("B2");
    expect(resolveOnboardingEngineLevel("intermediate")).toBe("B1");
    expect(resolveOnboardingEngineLevel("elementary")).toBe("A2");
    expect(resolveOnboardingEngineLevel("unsure")).toBe("B1");
    expect(resolveOnboardingEngineLevel("B2")).toBe("B2");
    expect(OnboardingLevelRequest.parse({ level: "advanced" })).toEqual({ level: "advanced" });
    expect(OnboardingLevelRequest.parse({ level: "B1" })).toEqual({ level: "B1" });
  });

  it("stores the mapped canonical level for every group and returns it", async () => {
    const expected: Record<string, string> = {
      proficient: "C1",
      advanced: "B2",
      intermediate: "B1",
      elementary: "A2",
      unsure: "B1",
    };
    for (const [group, canonical] of Object.entries(expected)) {
      const learner = newLearner();
      asLearner(learner);
      const response = await postJson(postLevel, { level: group });
      expect(response.status).toBe(200);
      expect(CefrLevel.parse(await response.json())).toBe(canonical);
      expect(storedLevel(learner.id)).toBe(canonical);
    }
  });

  it("keeps group choices isolated between learners", async () => {
    const first = newLearner();
    const second = newLearner();
    asLearner(first);
    expect((await postJson(postLevel, { level: "proficient" })).status).toBe(200);
    asLearner(second);
    expect((await postJson(postLevel, { level: "elementary" })).status).toBe(200);
    expect(storedLevel(first.id)).toBe("C1");
    expect(storedLevel(second.id)).toBe("A2");
    expect(await (await postJson(postLevel, { level: "advanced" })).json()).toBe("B2");
    expect(storedLevel(first.id)).toBe("C1");
  });

  it("rejects unknown groups without writing", async () => {
    const learner = newLearner();
    asLearner(learner);
    for (const body of [
      { level: "expert" },
      { level: "Proficient" },
      { level: "native" },
      { level: "c2" },
      { level: "" },
      { level: null },
      { level: "B2 ", },
      { level: "unsure", extra: 1 },
    ]) {
      await expectApiError(await postJson(postLevel, body), 400, "invalid_request");
    }
    expect(storedLevel(learner.id)).toBeNull();
  });

  it("drives the Word check round from the mapped level", async () => {
    const learner = newLearner();
    asLearner(learner);
    expect((await postJson(postLevel, { level: "elementary" })).status).toBe(200);
    const round = await fetchRound(learner);
    expect(round.level).toBe("A2");
    expect(round.entries.filter((entry) => entry.level === "A2")).toHaveLength(16);
    expect(round.entries.filter((entry) => entry.level === "B1")).toHaveLength(8);

    const top = newLearner();
    asLearner(top);
    expect((await postJson(postLevel, { level: "proficient" })).status).toBe(200);
    const high = await fetchRound(top);
    expect(high.level).toBe("C1");
    expect(high.entries.filter((entry) => entry.level === "C1")).toHaveLength(16);
  });

  it("refines the chosen canonical level once Word check answers exist", async () => {
    const learner = newLearner();
    asLearner(learner);
    expect((await postJson(postLevel, { level: "proficient" })).status).toBe(200);
    expect(storedLevel(learner.id)).toBe("C1");
    const round = await fetchRound(learner);
    expect(round.level).toBe("C1");
    const answers = round.entries.map((entry) => ({ id: entry.id, answer: "new" as const }));
    asLearner(learner);
    const result = await postWordCheck(
      new Request("http://localhost/api/onboarding/word-check", {
        method: "POST",
        body: JSON.stringify({ answers }),
      }),
    );
    expect(result.status).toBe(200);
    const body = (await result.json()) as { level: string };
    expect(body.level).toBe("A2");
    expect(storedLevel(learner.id)).toBe("A2");
  });
});
