import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetectResponse, ApiError, type DetectRequest as DetectRequestType } from "@/shared/contracts";
import { setAiEnabled } from "@/server/budget";

let sessionCookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "glossy_session_3000" && sessionCookie ? { name, value: sessionCookie } : undefined,
  }),
  headers: async () => new Headers({ host: "localhost:3000" }),
}));

import { POST as detectRoute } from "@/app/api/detect/route";
import { hashText } from "@/lib/text";
import { db, fetchMock, installApp, login as appLogin, requestId } from "./helpers/app";

installApp();
beforeEach(() => {
  sessionCookie = undefined;
});

function login() {
  const result = appLogin();
  sessionCookie = result.sessionToken;
  return result;
}

async function requestBody(text = "All good."): Promise<DetectRequestType> {
  return {
    requestId: requestId(),
    sentences: [{ hash: await hashText(text), text }],
  };
}

function post(body: unknown) {
  return detectRoute(new Request("http://localhost/api/detect", { method: "POST", body: JSON.stringify(body) }));
}

function reply(sentences: unknown[]) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ sentences }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00005 },
    provider: "Nebius",
  }), { status: 200 });
}

describe("POST /api/detect", () => {
  it("requires a learner session", async () => {
    const response = await post({ invalid: true });
    expect(response.status).toBe(401);
    expect(ApiError.parse(await response.json()).error.code).toBe("unauthorized");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strictly validates the request before reservation", async () => {
    login();
    const body = await requestBody();
    const response = await post({ ...body, ignored: true });
    expect(response.status).toBe(400);
    expect(ApiError.parse(await response.json()).error.code).toBe("invalid_request");

    const badRange = await requestBody("A sentence.");
    badRange.sentences[0].localRanges = [{ start: 5, end: 5 }];
    expect((await post(badRange)).status).toBe(400);

    const badHash = await requestBody();
    badHash.sentences[0].hash = "A".repeat(64);
    expect((await post(badHash)).status).toBe(400);

    const emptySentence = await requestBody(" \r\n ");
    expect((await post(emptySentence)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations").get()).toEqual({ n: 0 });
  });

  it("returns only typed probabilities and the detect quota", async () => {
    login();
    const body = await requestBody("A concise sentence.");
    fetchMock.mockResolvedValueOnce(reply([{
      sentence_index: 0,
      needs_correction: 0.05,
      needs_clarity: 0.8,
      needs_word_choice: 0.25,
    }]));
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(DetectResponse.parse(await response.json())).toMatchObject({
      requestId: body.requestId,
      sentences: [{ hash: body.sentences[0].hash, needs_correction: 0.05, needs_clarity: 0.8, needs_word_choice: 0.25 }],
      quota: { used: 1, limit: expect.any(Number) },
    });
  });

  it("returns ai_disabled without reserving or calling the provider when the kill switch is off", async () => {
    login();
    const body = await requestBody("A request blocked by the kill switch.");
    setAiEnabled(false);

    const response = await post(body);

    expect(response.status).toBe(503);
    expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT 1 FROM usage_reservations WHERE request_id = ?").get(body.requestId)).toBeUndefined();
    expect(db().prepare("SELECT 1 FROM detect_runs WHERE request_id = ?").get(body.requestId)).toBeUndefined();
  });

  it("returns budget_exhausted without reserving or calling the provider when the ceiling is spent", async () => {
    login();
    const body = await requestBody("A request blocked by the daily ceiling.");
    process.env.DAILY_BUDGET_USD = "0";

    const response = await post(body);

    expect(response.status).toBe(503);
    expect(ApiError.parse(await response.json()).error.code).toBe("budget_exhausted");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT 1 FROM usage_reservations WHERE request_id = ?").get(body.requestId)).toBeUndefined();
    expect(db().prepare("SELECT 1 FROM detect_runs WHERE request_id = ?").get(body.requestId)).toBeUndefined();
  });
});
