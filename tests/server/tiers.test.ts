import { describe, expect, it, vi } from "vitest";
import { ApiError, Evaluation, PracticeTask, ProofreadResponse, TranscribeResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as taskRoute } from "@/app/api/practice/tasks/route";
import { POST as attemptRoute } from "@/app/api/practice/attempts/[attemptId]/route";
import { POST as proofreadRoute } from "@/app/api/proofread/route";
import { POST as speechRoute } from "@/app/api/speech/transcribe/route";
import { createByokSession } from "@/server/auth/byok";
import { loadConfig } from "@/server/config";
import { PROVIDER_KEY_HEADER, resolveTextRoute } from "@/server/models/access";
import { UnknownModelError, ModelNotConfiguredError } from "@/server/models/errors";
import { estimateMaxCostMicros } from "@/server/models/meta";
import { FAST_PRICE_DEFAULT } from "@/server/models/prices";
import { proofread } from "@/server/proofread/service";
import { PROOFREAD_JSON_SCHEMA } from "@/server/proofread/schema";
import {
  chatReply,
  db,
  fetchMock,
  installApp,
  login,
  makeWav,
  OWNER_OPENROUTER_KEY,
  proofreadReply,
  requestId,
  seedExpression,
  seedTask,
  sentBody,
  session,
} from "./helpers/app";

installApp();

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const META_CHAT = "https://meta.test/v1/chat/completions";
const PRESET = "@preset/gpt-oss-120b-balanced";
const visitorKey = "sk-or-v1-" + "visitor".repeat(8);
const SITUATION = "A colleague asks whether the deadline can move. Explain your view in one sentence.";
const FACTS = { task_completed: true, target_used: true, meaning_correct: true, form_correct: true, message: "Good.", correction: "" };

const json = (route: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  route(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers }));
const check = (text = "She go home.", headers: Record<string, string> = {}) =>
  json(proofreadRoute, "/api/proofread", { requestId: requestId(), text }, headers);
// The database is shared by the tests of this file, so every query is scoped to the current learner.
let current = "";
function start(profile: "pilot" | "judge" | "owner" = "judge") {
  const redemption = login(profile);
  current = redemption.learner.id;
  return redemption;
}
const count = (table: string) =>
  db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE learner_id = ?`).get(current) as { n: number };
const proofreadReservation = () =>
  db().prepare("SELECT * FROM usage_reservations WHERE learner_id = ? AND kind = 'proofread' ORDER BY rowid DESC")
    .get(current) as { max_cost_micros: number; actual_cost_micros: number | null; status: string };

function setup(profile: "pilot" | "judge" | "owner" = "judge") {
  const { learner } = start(profile);
  const { expressionId } = seedExpression(learner.id, { text: "unlikely to happen", meaning: "not likely to happen" });
  return { learner, expressionId };
}

function evaluate(attemptId: string) {
  return attemptRoute(
    new Request("http://localhost/api/practice/attempts/x", {
      method: "POST",
      body: JSON.stringify({ answer: "That is unlikely to happen.", hintUsed: false }),
    }),
    { params: Promise.resolve({ attemptId }) },
  );
}

async function upload(attemptId: string) {
  const form = new FormData();
  form.set("attemptId", attemptId);
  form.set("audio", new Blob([makeWav() as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "answer.wav");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return speechRoute(new Request("http://localhost/api/speech/transcribe", { method: "POST", body,
    headers: { "content-type": encoded.headers.get("content-type")!, "content-length": String(body.length) } }));
}

describe("routing of operator-funded jobs", () => {
  it("sends proofreading and practice situations to OpenRouter, evaluation and speech to Meta", async () => {
    const { learner, expressionId } = setup();

    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect((await check()).status).toBe(200);

    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const created = await json(taskRoute, "/api/practice/tasks", { requestId: requestId(), expressionId, kind: "written" });
    const task = PracticeTask.parse(await created.json());

    fetchMock.mockResolvedValueOnce(chatReply(FACTS));
    expect(Evaluation.parse(await (await evaluate(task.attemptId)).json()).verdict).toBe("used_well");

    const voice = seedTask(learner.id, expressionId, { kind: "voice" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ transcript: "hello", audioDurationMs: 2000 })));
    expect(TranscribeResponse.parse(await (await upload(voice.attemptId)).json()).text).toBe("hello");

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init.headers.Authorization]);
    expect(calls).toEqual([
      [OPENROUTER_CHAT, `Bearer ${OWNER_OPENROUTER_KEY}`],
      [OPENROUTER_CHAT, `Bearer ${OWNER_OPENROUTER_KEY}`],
      [META_CHAT, "Bearer test-key"],
      ["https://meta.test/v1/asr/transcribe", "Bearer test-key"],
    ]);

    // Meta keeps its own request shape: no OpenRouter fields.
    expect(sentBody(2)).toMatchObject({ model: "muse-spark-1.3", reasoning_effort: "low", max_tokens: 4096 });
    for (const field of ["reasoning", "usage", "provider"]) expect(sentBody(2)).not.toHaveProperty(field);
    expect(db().prepare("SELECT model FROM evaluations WHERE learner_id = ?").get(current)).toEqual({ model: "muse-spark-1.3" });
    expect(db().prepare("SELECT model FROM practice_tasks WHERE id = ?").get(task.id)).toEqual({ model: "openai/gpt-oss-120b" });
  });

  it("asks OpenRouter for strict structured output from a capable provider, at low reasoning", async () => {
    start();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    await check();

    expect(sentBody(0)).toMatchObject({
      model: "openai/gpt-oss-120b",
      max_tokens: 4096,
      temperature: 0,
      reasoning: { effort: "low" },
      usage: { include: true },
      // The quickest capable provider: price-balanced routing picked one that took over a minute.
      provider: { require_parameters: true, allow_fallbacks: false, data_collection: "deny", sort: "latency" },
      response_format: { type: "json_schema", json_schema: { name: "proofread_sentences", strict: true } },
    });
    expect(sentBody(0)).not.toHaveProperty("reasoning_effort");
    expect(sentBody(0).max_tokens).toBeGreaterThanOrEqual(2048);
    expect(timeout).toHaveBeenCalledWith(20_000);
    timeout.mockRestore();
  });

  it("uses a configured preset as the model id", async () => {
    start();
    process.env.OPENROUTER_FAST_MODEL = PRESET;
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect((await check()).status).toBe(200);
    expect(sentBody(0).model).toBe(PRESET);
    expect(db().prepare("SELECT provider, model FROM check_runs WHERE learner_id = ?").get(current)).toEqual({ provider: "openrouter", model: PRESET });
  });

  it("reads the legacy OPENROUTER_PROOFREAD_MODEL as an alias, with the new name winning", async () => {
    start();
    delete process.env.OPENROUTER_FAST_MODEL;
    process.env.OPENROUTER_PROOFREAD_MODEL = PRESET;
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    await check();
    expect(sentBody(0).model).toBe(PRESET);

    process.env.OPENROUTER_FAST_MODEL = "openai/gpt-oss-120b:floor";
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    await check("Another text.");
    expect(sentBody(1).model).toBe("openai/gpt-oss-120b:floor");
  });

  it("reserves the same bound for a preset as for the default model, and a configured bound otherwise", async () => {
    start();
    fetchMock.mockImplementation(async () => proofreadReply([]));
    await check("Same text.");
    const defaultBound = proofreadReservation().max_cost_micros;

    process.env.OPENROUTER_FAST_MODEL = PRESET;
    await check("Same text.");
    expect(proofreadReservation().max_cost_micros).toBe(defaultBound);

    // 1000 * 2 + 200 * 10 micro-dollars at the configured prices.
    process.env.OPENROUTER_FAST_PRICE_IN_PER_M = "2";
    process.env.OPENROUTER_FAST_PRICE_OUT_PER_M = "10";
    await check("Same text.");
    const configured = proofreadReservation();
    expect(configured.max_cost_micros).toBeGreaterThan(defaultBound);
    expect(configured.actual_cost_micros).toBe(4000);
  });

  it("bounds the reservation by the fast price, input size and output budget", async () => {
    start();
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    await check("Bounded text.");
    const sent = sentBody(0).messages as { content: string }[];
    const chars = sent.reduce((total, m) => total + m.content.length, 0) + JSON.stringify(PROOFREAD_JSON_SCHEMA).length;
    expect(proofreadReservation().max_cost_micros).toBe(estimateMaxCostMicros("openai/gpt-oss-120b", chars, 4096));
    expect(FAST_PRICE_DEFAULT).toMatchObject({ inputUsdPerMTok: 0.7, outputUsdPerMTok: 1.9 });
  });

  it("refuses a model without a price, but not a preset, and accepts a model with both prices", async () => {
    start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.OPENROUTER_FAST_MODEL = "vendor/expensive-model";
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("ai_disabled");
    process.env.OPENROUTER_FAST_PRICE_IN_PER_M = "1";
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count("usage_reservations")).toEqual({ n: 0 });

    process.env.OPENROUTER_FAST_PRICE_OUT_PER_M = "3";
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect((await check()).status).toBe(200);
    expect(sentBody(0).model).toBe("vendor/expensive-model");
    vi.restoreAllMocks();
  });
});

describe("settling the cost of a fast call", () => {
  it("settles at the cost OpenRouter reports, rounded up to a micro-dollar", async () => {
    start();
    for (const [cost, micros] of [[0.000123, 123], [0.0001234, 124], [0, 0], [0.5, 500_000]] as const) {
      fetchMock.mockResolvedValueOnce(proofreadReply([], [], { prompt_tokens: 1000, completion_tokens: 200, cost }));
      expect((await check(`Text ${cost}.`)).status).toBe(200);
      expect(proofreadReservation()).toMatchObject({ status: "settled", actual_cost_micros: micros });
    }
  });

  it("falls back to tokens times the price when no usable cost is reported", async () => {
    start();
    const usages = [
      { prompt_tokens: 1000, completion_tokens: 200 },
      { prompt_tokens: 1000, completion_tokens: 200, cost: null },
      { prompt_tokens: 1000, completion_tokens: 200, cost: -1 },
      { prompt_tokens: 1000, completion_tokens: 200, cost: "0.5" },
      // A key brought to OpenRouter: `cost` is only its fee, and the upstream part is missing.
      { prompt_tokens: 1000, completion_tokens: 200, cost: 0.00001, is_byok: true },
    ];
    for (const [index, usage] of usages.entries()) {
      fetchMock.mockResolvedValueOnce(proofreadReply([], [], usage));
      await check(`Fallback ${index}.`);
      expect(proofreadReservation().actual_cost_micros, JSON.stringify(usage)).toBe(1080);
    }
  });

  it("adds the upstream share when the account brings its own provider key", async () => {
    start();
    fetchMock.mockResolvedValueOnce(proofreadReply([], [], {
      prompt_tokens: 1000, completion_tokens: 200, cost: 0.00001, is_byok: true, cost_details: { upstream_inference_cost: 0.0001 },
    }));
    await check();
    expect(proofreadReservation().actual_cost_micros).toBe(110);
  });

  it("uses the reported cost when the output is unusable, and the bound when nothing was reported", async () => {
    start();
    fetchMock.mockResolvedValueOnce(chatReply("not json", { prompt_tokens: 1000, completion_tokens: 200, cost: 0.000321 }));
    expect((await check("Unusable one.")).status).toBe(502);
    expect(proofreadReservation().actual_cost_micros).toBe(321);

    fetchMock.mockResolvedValueOnce(chatReply("not json", null));
    await check("Unusable two.");
    const reservation = proofreadReservation();
    expect(reservation.actual_cost_micros).toBe(reservation.max_cost_micros);
  });

  it("settles a practice situation at the reported cost too", async () => {
    const { expressionId } = setup();
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }, { prompt_tokens: 900, completion_tokens: 100, cost: 0.000042 }));
    const id = requestId();
    expect((await json(taskRoute, "/api/practice/tasks", { requestId: id, expressionId, kind: "written" })).status).toBe(200);
    expect(db().prepare("SELECT actual_cost_micros FROM usage_reservations WHERE request_id LIKE ?").get(`${id}%`)).toEqual({
      actual_cost_micros: 42,
    });
  });
});

describe("a missing key or tier is refused, never replaced", () => {
  it("answers ai_disabled for fast jobs without an OpenRouter key, and never calls Meta instead", async () => {
    const { expressionId } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.OPENROUTER_API_KEY;
    const body = { requestId: requestId(), expressionId, kind: "written" };
    for (const response of [await check(), await json(taskRoute, "/api/practice/tasks", body)]) {
      expect(response.status).toBe(503);
      expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count("usage_reservations")).toEqual({ n: 0 });
    expect(count("practice_task_requests")).toEqual({ n: 0 });
    vi.restoreAllMocks();
  });

  it("treats a malformed operator key like a missing one", async () => {
    start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.OPENROUTER_API_KEY = "not-a-key";
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count("usage_reservations")).toEqual({ n: 0 });
    vi.restoreAllMocks();
  });

  it("keeps evaluation on Meta when the OpenRouter key is missing, and fails it without a Meta key", async () => {
    const { learner, expressionId } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.OPENROUTER_API_KEY;
    const first = seedTask(learner.id, expressionId);
    fetchMock.mockResolvedValueOnce(chatReply(FACTS));
    expect((await evaluate(first.attemptId)).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(META_CHAT);

    process.env.OPENROUTER_API_KEY = OWNER_OPENROUTER_KEY;
    delete process.env.META_API_KEY;
    const second = seedTask(learner.id, expressionId);
    const response = await evaluate(second.attemptId);
    expect(ApiError.parse(await response.json()).error.code).toBe("ai_disabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("refuses an evaluation model without a price", async () => {
    const { learner, expressionId } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.META_TEXT_MODEL = "unpriced-model-9";
    const { attemptId } = seedTask(learner.id, expressionId);
    expect(ApiError.parse(await (await evaluate(attemptId)).json()).error.code).toBe("ai_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(count("usage_reservations")).toEqual({ n: 0 });
    vi.restoreAllMocks();
  });

  it("does not try another provider or tier after a failure", async () => {
    start();
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 500 }));
    expect((await check()).status).toBe(503);
    fetchMock.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    expect((await check("Second text.")).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([OPENROUTER_CHAT, OPENROUTER_CHAT]);
  });

  it("keeps the kill switch, quotas and the ceiling in front of fast calls", async () => {
    const { learner } = start("pilot");
    process.env.DAILY_BUDGET_USD = "0.001";
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("budget_exhausted");
    process.env.DAILY_BUDGET_USD = "5";
    process.env.AI_ENABLED = "false";
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("ai_disabled");
    process.env.AI_ENABLED = "true";
    for (let i = 0; i < 20; i++) {
      db().prepare(
        `INSERT INTO usage_reservations
           (id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros, status, created_at, settled_at, funding_source)
         VALUES (?, ?, 'proofread', ?, 1, 1, 1, 'settled', ?, ?, 'hosted')`,
      ).run(`fill-${i}`, learner.id, `fill-${i}`, new Date().toISOString(), new Date().toISOString());
    }
    expect(ApiError.parse(await (await check()).json()).error.code).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routing of visitor-funded (BYOK) jobs", () => {
  function visitor() {
    const redemption = createByokSession();
    session.cookie = redemption.sessionToken;
    current = redemption.learner.id;
    return redemption.learner;
  }
  const key = { [PROVIDER_KEY_HEADER]: visitorKey };

  it("uses gpt-oss-120b for the fast tier and Muse Spark for evaluation, with the visitor's key only", async () => {
    const learner = visitor();
    const { expressionId } = seedExpression(learner.id, { text: "unlikely to happen", meaning: "not likely to happen" });
    // The operator's settings must not leak into visitor routing.
    process.env.OPENROUTER_FAST_MODEL = PRESET;

    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect(ProofreadResponse.parse(await (await check("A short sentence.", key)).json()).suggestions).toEqual([]);
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const task = PracticeTask.parse(await (await json(taskRoute, "/api/practice/tasks",
      { requestId: requestId(), expressionId, kind: "written" }, key)).json());
    fetchMock.mockResolvedValueOnce(chatReply(FACTS));
    const response = await attemptRoute(
      new Request("http://localhost/api/practice/attempts/x", { method: "POST", headers: key,
        body: JSON.stringify({ answer: "That is unlikely to happen.", hintUsed: false }) }),
      { params: Promise.resolve({ attemptId: task.attemptId }) },
    );
    expect(response.status).toBe(200);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.headers.Authorization])).toEqual([
      [OPENROUTER_CHAT, `Bearer ${visitorKey}`],
      [OPENROUTER_CHAT, `Bearer ${visitorKey}`],
      [OPENROUTER_CHAT, `Bearer ${visitorKey}`],
    ]);
    expect(sentBody(0)).toMatchObject({ model: "openai/gpt-oss-120b", reasoning: { effort: "low" }, usage: { include: true },
      provider: { require_parameters: true } });
    expect(sentBody(1)).toMatchObject({ model: "openai/gpt-oss-120b", reasoning: { effort: "low" } });
    expect(sentBody(2)).toMatchObject({ model: "meta/muse-spark-1.3", reasoning_effort: "low" });
    // Latency sorting is for the fast tier only.
    expect(sentBody(0).provider).toMatchObject({ sort: "latency" });
    expect(sentBody(2).provider).not.toHaveProperty("sort");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(OWNER_OPENROUTER_KEY);
  });

  it("does not need the operator's OpenRouter key, and never borrows it", async () => {
    visitor();
    delete process.env.OPENROUTER_API_KEY;
    fetchMock.mockResolvedValueOnce(proofreadReply([]));
    expect((await check("A short sentence.", key)).status).toBe(200);

    process.env.OPENROUTER_API_KEY = OWNER_OPENROUTER_KEY;
    expect(ApiError.parse(await (await check("Another sentence.")).json()).error.code).toBe("ai_disabled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTextRoute", () => {
  const config = (env: Record<string, string>) =>
    loadConfig({ META_API_KEY: "m", OPENROUTER_API_KEY: OWNER_OPENROUTER_KEY, ...env });
  const hosted = { provider: "meta" } as const;

  it("returns the table of routes", () => {
    const visitor = { provider: "openrouter", apiKey: visitorKey } as const;
    expect(resolveTextRoute(hosted, config({}), "fast")).toMatchObject({
      provider: "openrouter", model: "openai/gpt-oss-120b", apiKey: OWNER_OPENROUTER_KEY, price: FAST_PRICE_DEFAULT,
    });
    expect(resolveTextRoute(hosted, config({}), "smart")).toMatchObject({ provider: "meta", model: "muse-spark-1.3" });
    expect(resolveTextRoute(visitor, config({}), "fast")).toMatchObject({
      provider: "openrouter", model: "openai/gpt-oss-120b", apiKey: visitorKey,
    });
    expect(resolveTextRoute(visitor, config({}), "smart")).toMatchObject({
      provider: "openrouter", model: "meta/muse-spark-1.3", apiKey: visitorKey,
    });
  });

  it("takes the fast model and price from configuration", () => {
    const route = resolveTextRoute(hosted, config({
      OPENROUTER_FAST_MODEL: PRESET, OPENROUTER_FAST_PRICE_IN_PER_M: "0.2", OPENROUTER_FAST_PRICE_OUT_PER_M: "0.9",
    }), "fast");
    expect(route).toMatchObject({ model: PRESET, price: { inputUsdPerMTok: 0.2, outputUsdPerMTok: 0.9 } });
    // One price alone keeps the default for the other.
    expect(resolveTextRoute(hosted, config({ OPENROUTER_FAST_MODEL: PRESET, OPENROUTER_FAST_PRICE_IN_PER_M: "0.2" }), "fast").price)
      .toMatchObject({ inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.9 });
  });

  it("refuses without a key, and an unpriced model, with the right errors", () => {
    expect(() => resolveTextRoute(hosted, loadConfig({ META_API_KEY: "m" }), "fast")).toThrow(ModelNotConfiguredError);
    expect(() => resolveTextRoute(hosted, loadConfig({ OPENROUTER_API_KEY: OWNER_OPENROUTER_KEY }), "smart")).toThrow(ModelNotConfiguredError);
    expect(() => resolveTextRoute(hosted, config({ OPENROUTER_FAST_MODEL: "vendor/other" }), "fast")).toThrow(UnknownModelError);
    expect(() => resolveTextRoute(hosted, config({ META_TEXT_MODEL: "mystery-1" }), "smart")).toThrow(UnknownModelError);
  });

  it("verify mode reports only errors and nothing for an unchanged sentence", async () => {
    const { learner } = start();
    const text = "She go home. The meeting was very good.";
    fetchMock.mockResolvedValueOnce(proofreadReply(
      [{ sentence_index: 0, corrected: "She goes home.", changes: [] }, { sentence_index: 1, corrected: "The meeting was very good.", changes: [] }],
      [{ sentence_index: 1, original: "very good", replacement: "excellent", category: "style", reason: "Stronger.", meaning: "", ipa: "" }],
    ));
    const result = await proofread(learner, { requestId: requestId(), text }, { mode: "verify" });
    expect(result.suggestions.map((s) => [s.category, s.original])).toEqual([["error", "go"]]);
    expect(sentBody(0).messages[0].content).toContain('"improvements" must always be an empty list');

    // The corrected text comes back unchanged: nothing to report.
    fetchMock.mockResolvedValueOnce(proofreadReply([{ sentence_index: 0, corrected: "She goes home.", changes: [] }]));
    const again = await proofread(learner, { requestId: requestId(), text: "She goes home." }, { mode: "verify" });
    expect(again.suggestions).toEqual([]);
  });
});
