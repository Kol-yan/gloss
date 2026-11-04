import type { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError, Evaluation, MeResponse, PracticeTask, ProofreadResponse, TranscribeResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as enrollRoute } from "@/app/api/access/byok/route";
import { POST as signoutRoute } from "@/app/api/access/signout/route";
import { GET as meRoute } from "@/app/api/me/route";
import { POST as proofreadRoute } from "@/app/api/proofread/route";
import { POST as taskRoute } from "@/app/api/practice/tasks/route";
import { POST as attemptRoute } from "@/app/api/practice/attempts/[attemptId]/route";
import { POST as speechRoute } from "@/app/api/speech/transcribe/route";
import { createByokSession } from "@/server/auth/byok";
import { createEnrollmentLimiter } from "@/server/auth/enrollment-rate";
import { findLearnerBySessionToken, getSessionCookieName } from "@/server/auth/sessions";
import { getBudgetStatus, reserve, setAiEnabled, settle } from "@/server/budget";
import { RateLimitedError, QuotaExceededError } from "@/server/errors";
import { PROVIDER_KEY_HEADER, resolveProviderAccess } from "@/server/models/access";
import { chatReply, db, fetchMock, installApp, login, makeWav, OWNER_OPENROUTER_KEY, proofreadReply, requestId, sentBody, seedExpression, seedTask, session } from "./helpers/app";

installApp();

const visitorKey = "sk-or-v1-" + "visitor".repeat(8);

function request(path: string, body: unknown = {}, key: string | null = visitorKey) {
  return new Request(`http://localhost${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost", "sec-fetch-site": "same-origin",
      ...(key === null ? {} : { [PROVIDER_KEY_HEADER]: key }) },
  });
}

const meRequest = () => new Request("http://localhost:3000/api/me");

async function enroll() {
  const response = await enrollRoute(request("/api/access/byok"));
  expect(response.status).toBe(200);
  const body = MeResponse.parse(await response.json());
  session.cookie = (response as NextResponse).cookies.get(getSessionCookieName(new Request("http://localhost/api/access/byok")))?.value;
  expect(session.cookie).toBeTruthy();
  return body;
}

async function upload(attemptId: string) {
  const form = new FormData();
  form.set("attemptId", attemptId);
  form.set("audio", new Blob([makeWav() as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "answer.wav");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return speechRoute(new Request("http://localhost/api/speech/transcribe", { method: "POST", body,
    headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length),
      [PROVIDER_KEY_HEADER]: visitorKey } }));
}

describe("public BYOK access", () => {
  it("creates an isolated browser session without sending or persisting the key", async () => {
    const body = await enroll();
    expect(body.accessMode).toBe("byok");
    expect(body.quotas.proofread.limit).toBe(20);
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = db().prepare("SELECT * FROM learners WHERE id = ?").all(body.learner.id);
    expect(rows[0]).toMatchObject({ funding_source: "byok", quota_profile: "pilot" });
    const saved = JSON.stringify([rows, db().prepare("SELECT * FROM sessions WHERE learner_id = ?").all(body.learner.id)]);
    expect(saved).not.toContain(visitorKey);
    expect(saved).not.toContain(session.cookie);
    expect(JSON.stringify(body)).not.toContain(visitorKey);
    const second = await enrollRoute(request("/api/access/byok"));
    expect(MeResponse.parse(await second.json()).learner.id).toBe(body.learner.id);
  });

  it("rejects cross-site enrollment and unexpected or oversized bodies", async () => {
    const before = Number(db().prepare("SELECT COUNT(*) AS n FROM learners").get()?.n);
    const cross = request("/api/access/byok");
    cross.headers.set("origin", "https://other.example");
    cross.headers.set("sec-fetch-site", "cross-site");
    expect((await enrollRoute(cross)).status).toBe(403);
    expect((await enrollRoute(request("/api/access/byok", { key: visitorKey }))).status).toBe(400);
    expect((await enrollRoute(request("/api/access/byok", { ignored: "x".repeat(1000) }))).status).toBe(400);
    expect(Number(db().prepare("SELECT COUNT(*) AS n FROM learners").get()?.n)).toBe(before);
  });

  it("requires a valid key and switches a hosted learner to BYOK in place", async () => {
    const absent = await enrollRoute(request("/api/access/byok", {}, null));
    expect(ApiError.parse(await absent.json()).error.code).toBe("ai_disabled");
    const hosted = login();
    seedExpression(hosted.learner.id);
    session.cookie = hosted.sessionToken;
    const missingKey = await enrollRoute(request("/api/access/byok", {}, null));
    expect(ApiError.parse(await missingKey.json()).error.code).toBe("ai_disabled");
    expect(db().prepare("SELECT funding_source FROM learners WHERE id = ?").get(hosted.learner.id))
      .toEqual({ funding_source: "hosted" });

    const response = await enrollRoute(request("/api/access/byok"));
    expect(MeResponse.parse(await response.json())).toMatchObject({
      accessMode: "byok", learner: { id: hosted.learner.id },
    });
    expect(session.cookie).toBe(hosted.sessionToken);
    expect(db().prepare("SELECT funding_source, quota_profile FROM learners WHERE id = ?").get(hosted.learner.id))
      .toEqual({ funding_source: "byok", quota_profile: "judge" });
    expect(db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?").get(hosted.learner.id))
      .toEqual({ n: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps BYOK available when the operator budget is spent, while honoring the kill switch", async () => {
    await enroll();
    process.env.DAILY_BUDGET_USD = "0";
    const ownerKey = process.env.OPENROUTER_API_KEY;
    try {
      delete process.env.OPENROUTER_API_KEY;
      expect(MeResponse.parse(await (await meRoute(meRequest())).json()).aiEnabled).toBe(true);
      process.env.OPENROUTER_API_KEY = "invalid";
      expect(MeResponse.parse(await (await meRoute(meRequest())).json()).aiEnabled).toBe(true);
    } finally {
      if (ownerKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = ownerKey;
    }
    expect(MeResponse.parse(await (await meRoute(meRequest())).json()).aiEnabled).toBe(true);
    setAiEnabled(false);
    expect(MeResponse.parse(await (await meRoute(meRequest())).json()).aiEnabled).toBe(false);
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    const response = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "A short sentence." }));
    expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never substitutes the operator key for missing or invalid visitor credentials", async () => {
    const body = await enroll();
    for (const key of [null, "invalid"]) {
      const response = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "A short sentence." }, key));
      expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    }
    expect(() => resolveProviderAccess(body.learner.id, { provider: "meta" })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db().prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE learner_id = ?").get(body.learner.id)?.n).toBe(0);
  });

  it("cannot use a visitor key to access another learner's expression", async () => {
    const hosted = login();
    const { expressionId } = seedExpression(hosted.learner.id);
    const visitor = createByokSession();
    session.cookie = visitor.sessionToken;
    const response = await taskRoute(request("/api/practice/tasks", { requestId: requestId(), expressionId, kind: "written" }));
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes hosted proofreading to the operator's OpenRouter account even when a visitor header is present", async () => {
    login();
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    const response = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "A short sentence." }));
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("authorization")).toBe(`Bearer ${OWNER_OPENROUTER_KEY}`);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(visitorKey);
  });

  it("uses the visitor key for proofreading, tasks, evaluation and JSON speech", async () => {
    const body = await enroll();
    const initialOwnerSpend = getBudgetStatus().spentMicros;
    process.env.DAILY_BUDGET_USD = "0";
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    const checked = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "A short sentence." }));
    expect(ProofreadResponse.parse(await checked.json()).suggestions).toEqual([]);

    const { expressionId } = seedExpression(body.learner.id);
    fetchMock.mockResolvedValueOnce(chatReply({ situation: "A colleague asks whether the deadline can move. Explain your view in one sentence." }));
    const taskResponse = await taskRoute(request("/api/practice/tasks", { requestId: requestId(), expressionId, kind: "written" }));
    const task = PracticeTask.parse(await taskResponse.json());
    fetchMock.mockResolvedValueOnce(chatReply({ task_completed: true, target_used: true, meaning_correct: true,
      form_correct: true, message: "That sounds natural.", correction: "" }));
    const evaluated = await attemptRoute(request("/api/practice/attempts/x", { answer: "That is unlikely to happen.", hintUsed: false }),
      { params: Promise.resolve({ attemptId: task.attemptId }) });
    expect(Evaluation.parse(await evaluated.json())).toMatchObject({ verdict: "used_well", target: "unlikely to happen" });

    const voice = seedTask(body.learner.id, expressionId, { kind: "voice" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: "That is unlikely to happen.", duration: 2 })));
    expect(TranscribeResponse.parse(await (await upload(voice.attemptId)).json()).text).toBe("That is unlikely to happen.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\//);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${visitorKey}`);
    }
    // Visitors get the fast model for proofreading and situations, Muse Spark for evaluation.
    const options = { max_tokens: 4096, usage: { include: true } };
    const fastProvider = {
      require_parameters: true,
      allow_fallbacks: true,
      data_collection: "deny",
      sort: "throughput",
      max_price: { prompt: 0.16, completion: 0.65 },
    };
    const smartProvider = { require_parameters: true, data_collection: "deny" };
    expect(sentBody(0)).toMatchObject({ model: "openai/gpt-oss-120b", reasoning: { effort: "low" },
      ...options, provider: fastProvider });
    expect(sentBody(1)).toMatchObject({ model: "openai/gpt-oss-120b", reasoning: { effort: "low" },
      ...options, provider: fastProvider });
    expect(sentBody(2)).toMatchObject({ model: "meta/muse-spark-1.3", reasoning_effort: "low",
      ...options, provider: smartProvider });
    expect(sentBody(2)).not.toHaveProperty("reasoning");
    const speechInit = fetchMock.mock.calls[3][1];
    expect(new Headers(speechInit.headers).get("content-type")).toBe("application/json");
    const speechBody = JSON.parse(speechInit.body);
    expect(speechBody).toMatchObject({
      model: "meta/muse-voice-transcribe-1.0",
      input_audio: { format: "wav", data: Buffer.from(makeWav()).toString("base64") },
      language: "en",
      provider: { data_collection: "deny" },
    });
    expect(getBudgetStatus().spentMicros).toBe(initialOwnerSpend);
    const reservations = db().prepare("SELECT * FROM usage_reservations WHERE learner_id = ?").all(body.learner.id);
    expect(reservations).toHaveLength(4);
    expect(reservations.every(row => row.funding_source === "byok" && row.status === "settled")).toBe(true);
    expect(JSON.stringify(reservations)).not.toContain(visitorKey);
  });

  it("does not retain credentials in provider failures, logs or API responses", async () => {
    const body = await enroll();
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValueOnce(new Response(visitorKey, { status: 401 }));
      const response = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "A short sentence." }));
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain(visitorKey);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(visitorKey);
      const rows = db().prepare("SELECT * FROM check_runs WHERE learner_id = ?").all(body.learner.id);
      expect(JSON.stringify(rows)).not.toContain(visitorKey);
    } finally {
      logs.mockRestore();
    }
  });

  it("rejects a third concurrent visitor call before sending it to the provider", async () => {
    await enroll();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    fetchMock.mockImplementation(() => waiting.then(() => proofreadReply([])));
    const first = proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "First sentence." }));
    const second = proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "Second sentence." }));
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const third = await proofreadRoute(request("/api/proofread", { requestId: requestId(), text: "Third sentence." }));
      expect(third.status).toBe(429);
      expect(ApiError.parse(await third.json()).error.code).toBe("rate_limited");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it("signs out only the current session and preserves learner history", async () => {
    const body = await enroll();
    const cookie = session.cookie;
    seedExpression(body.learner.id);
    const cross = request("/api/access/signout", {}, null);
    cross.headers.set("sec-fetch-site", "cross-site");
    expect((await signoutRoute(cross)).status).toBe(403);
    expect(findLearnerBySessionToken(cookie)).not.toBeNull();
    const response = await signoutRoute(request("/api/access/signout", {}, null));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(findLearnerBySessionToken(cookie)).toBeNull();
    expect(db().prepare("SELECT COUNT(*) AS n FROM expressions WHERE learner_id = ?").get(body.learner.id)?.n).toBe(1);
  });
});

describe("visitor accounting and rate limits", () => {
  it("limits six calls per minute while keeping daily quota checks", () => {
    const now = new Date("2026-11-03T01:00:00Z");
    const { learner } = createByokSession({ now });
    for (let i = 0; i < 6; i++) {
      const row = reserve({ learnerId: learner.id, kind: "proofread", requestId: requestId(), units: 1, maxCostMicros: 10 }, { now });
      settle(row.id, 5, { now });
    }
    expect(() => reserve({ learnerId: learner.id, kind: "proofread", requestId: requestId(), units: 1, maxCostMicros: 10 }, { now })).toThrow(RateLimitedError);
    expect(() => reserve({ learnerId: learner.id, kind: "asrSeconds", requestId: requestId(), units: 181, maxCostMicros: 10 }, { now })).toThrow(QuotaExceededError);
    expect(() => db().prepare("UPDATE learners SET funding_source = 'hosted' WHERE id = ?").run(learner.id)).toThrow();
    expect(() => reserve({ learnerId: learner.id, kind: "proofread", requestId: requestId(), units: 1, maxCostMicros: 10 },
      { now: new Date(now.getTime() + 60_001) })).not.toThrow();
  });

  it("does not trust spoofed forwarding headers", () => {
    const limit = createEnrollmentLimiter();
    // A handful of retries in one hour is fine; a flood is not.
    for (let i = 0; i < 12; i++) {
      const r = request("/api/access/byok");
      r.headers.set("cf-connecting-ip", `192.0.2.${i + 1}`);
      limit(r, false, 1000);
    }
    expect(() => limit(request("/api/access/byok"), false, 1000)).toThrow(RateLimitedError);
    expect(() => limit(request("/api/access/byok"), false, 3_601_001)).not.toThrow();
    const trusted = createEnrollmentLimiter();
    const r = request("/api/access/byok");
    r.headers.set("cf-connecting-ip", "192.0.2.1");
    for (let i = 0; i < 5; i++) trusted(r, true, 1000);
    expect(() => trusted(r, true, 1000)).toThrow(RateLimitedError);
  });

  it("bounds retained enrollment identities under client-IP churn", () => {
    const limit = createEnrollmentLimiter();
    const r = request("/api/access/byok");
    for (let i = 0; i < 4096; i++) {
      r.headers.set("cf-connecting-ip", `2001:db8::${i.toString(16)}`);
      limit(r, true, 1000);
    }
    r.headers.set("cf-connecting-ip", "2001:db8::ffff");
    expect(() => limit(r, true, 1000)).toThrow(RateLimitedError);
  });
});
