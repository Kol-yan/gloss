import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFixturePracticeClient,
  practiceFixtureExercises,
  type PracticeFixtureName,
} from "@/lib/practice-session-fixtures";
import { livePracticeSessionClient } from "@/lib/practice-session-client";
import { forgetProviderKey, saveProviderKey, setCurrentSession } from "@/features/api/access-store";
import type {
  MeResponse,
  PracticeSessionAnswerResponse,
  PracticeSessionExercise,
  PracticeSessionFinishResponse,
  PracticeSessionHintResponse,
  PracticeSessionNextResponse,
  PracticeSessionReadiness,
} from "@/shared/contracts";

const SESSION_ID = "00000000-0000-4000-8000-000000000008";
const EXERCISE_ID = "00000000-0000-4000-8000-000000000004";
const REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const VISITOR_KEY = "example-openrouter-visitor-key";

const ME: MeResponse = {
  learner: { id: "learner-1", displayName: "Alex" },
  accessMode: "hosted",
  aiEnabled: true,
  quotas: {
    proofread: { used: 0, limit: 20 },
    detect: { used: 0, limit: 20 },
    evaluate: { used: 0, limit: 30 },
    asrSeconds: { used: 0, limit: 600 },
  },
};

const readiness: PracticeSessionReadiness = {
  sessionId: SESSION_ID,
  ready: 3,
  total: 8,
  status: "ready",
  canStart: true,
};

const exercise: PracticeSessionExercise = {
  exerciseId: EXERCISE_ID,
  rung: 2,
  sentence: "We need to ___ the meeting until Friday.",
  prompt: "Choose the meaning of the underlined phrase.",
  options: ["move it later", "cancel it", "start it", "write it down"],
};

const nextResponse: PracticeSessionNextResponse = { status: "ready", exercise };

const answerResponse: PracticeSessionAnswerResponse = {
  answer: {
    exerciseId: EXERCISE_ID,
    correct: true,
    word: "push back",
    frequency: "common",
    ipa: "/pʊʃ bæk/",
    meaning: "To move something to a later time.",
    example: "We pushed back the meeting until Friday.",
    comesBackText: "in 2 days",
    allowedReactions: ["already_know", "too_easy", "not_relevant", "too_hard"],
    reaction: null,
  },
};

const hintResponse: PracticeSessionHintResponse = {
  exerciseId: EXERCISE_ID,
  hint: "It starts with “p”.",
};

const finishResponse: PracticeSessionFinishResponse = {
  sessionId: SESSION_ID,
  summary: "8 words in 6 minutes.",
  correct: 6,
  answered: 8,
  total: 8,
  durationSeconds: 360,
  durationMinutes: 6,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
      removeItem: vi.fn((key: string) => { storage.delete(key); }),
    },
  }));
  setCurrentSession(ME);
});

afterEach(() => {
  forgetProviderKey();
  setCurrentSession(null);
  vi.unstubAllGlobals();
});

describe("live practice session client", () => {
  it("uses the session endpoints and exact request contracts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(readiness))
      .mockResolvedValueOnce(jsonResponse(readiness))
      .mockResolvedValueOnce(jsonResponse(nextResponse))
      .mockResolvedValueOnce(jsonResponse(answerResponse))
      .mockResolvedValueOnce(jsonResponse(hintResponse))
      .mockResolvedValueOnce(jsonResponse(answerResponse))
      .mockResolvedValueOnce(jsonResponse(finishResponse));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    const results = await Promise.all([
      livePracticeSessionClient.prepare({ requestId: REQUEST_ID, size: 8 }, { signal }),
      livePracticeSessionClient.readiness(SESSION_ID, { signal }),
      livePracticeSessionClient.next(SESSION_ID, { signal }),
      livePracticeSessionClient.answer(SESSION_ID, {
        exerciseId: EXERCISE_ID,
        answer: "move it later",
        usedHint: false,
      }, { signal }),
      livePracticeSessionClient.hint(SESSION_ID, { exerciseId: EXERCISE_ID }, { signal }),
      livePracticeSessionClient.reaction(SESSION_ID, {
        exerciseId: EXERCISE_ID,
        reaction: "too_easy",
      }, { signal }),
      livePracticeSessionClient.finish(SESSION_ID, { signal }),
    ]);

    expect(results).toEqual([
      { ok: true, data: readiness },
      { ok: true, data: readiness },
      { ok: true, data: nextResponse },
      { ok: true, data: answerResponse },
      { ok: true, data: hintResponse },
      { ok: true, data: answerResponse },
      { ok: true, data: finishResponse },
    ]);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([path]) => path)).toEqual([
      "/api/practice/sessions",
      `/api/practice/sessions/${SESSION_ID}`,
      `/api/practice/sessions/${SESSION_ID}/next`,
      `/api/practice/sessions/${SESSION_ID}/answers`,
      `/api/practice/sessions/${SESSION_ID}/hint`,
      `/api/practice/sessions/${SESSION_ID}/reactions`,
      `/api/practice/sessions/${SESSION_ID}/finish`,
    ]);
    expect(calls.map(([, init]) => init.method ?? "GET")).toEqual([
      "POST", "GET", "GET", "POST", "POST", "POST", "POST",
    ]);
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ requestId: REQUEST_ID, size: 8 });
    expect(calls[1][1].body).toBeUndefined();
    expect(calls[2][1].body).toBeUndefined();
    expect(JSON.parse(calls[3][1].body as string)).toEqual({
      exerciseId: EXERCISE_ID,
      answer: "move it later",
      usedHint: false,
    });
    expect(JSON.parse(calls[4][1].body as string)).toEqual({ exerciseId: EXERCISE_ID });
    expect(JSON.parse(calls[5][1].body as string)).toEqual({ exerciseId: EXERCISE_ID, reaction: "too_easy" });
    expect(calls[6][1].body).toBeUndefined();
    expect(calls[6][1].signal).toBe(signal);
    for (const [, init] of calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBe(signal);
    }
  });

  it("rejects responses with the wrong number of choices or choices on typed recall", async () => {
    const invalidExercises = [
      { ...exercise, rung: 3, options: ["one", "two", "three"] },
      { ...exercise, rung: 4, options: ["one", "two", "three", "four"] },
    ];

    for (const invalidExercise of invalidExercises) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ready", exercise: invalidExercise }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await livePracticeSessionClient.next(SESSION_ID);

      expect(result).toMatchObject({ ok: false, code: "bad_response" });
      if (!result.ok) expect(result.message).toBe("We couldn't finish that request. Please try again.");
    }
  });

  it("accepts typed recall only when its options are null", async () => {
    const recall: PracticeSessionNextResponse = {
      status: "ready",
      exercise: { ...exercise, rung: 4, options: null },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(recall)));

    expect(await livePracticeSessionClient.next(SESSION_ID)).toEqual({ ok: true, data: recall });
  });

  it("keeps unreadable server failures short and free of raw details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("provider stack trace: private upstream detail", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await livePracticeSessionClient.prepare({ requestId: REQUEST_ID, size: 8 });

    expect(result).toMatchObject({ ok: false, code: "internal" });
    expect(JSON.stringify(result)).not.toContain("provider stack trace");
    expect(JSON.stringify(result)).not.toContain("private upstream detail");
  });

  it("turns a rejected request into a short network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch with upstream trace")));

    const result = await livePracticeSessionClient.next(SESSION_ID);

    expect(result).toMatchObject({ ok: false, code: "network" });
    expect(JSON.stringify(result)).not.toContain("upstream trace");
  });

  it("sends BYOK only in the request header for practice preparation", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const bodies: unknown[] = [readiness, readiness, nextResponse, answerResponse, hintResponse, answerResponse, finishResponse];
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(bodies.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await livePracticeSessionClient.prepare({ requestId: REQUEST_ID, size: 8 });
    await livePracticeSessionClient.readiness(SESSION_ID);
    await livePracticeSessionClient.next(SESSION_ID);
    await livePracticeSessionClient.answer(SESSION_ID, { exerciseId: EXERCISE_ID, answer: "move it later", usedHint: false });
    await livePracticeSessionClient.hint(SESSION_ID, { exerciseId: EXERCISE_ID });
    await livePracticeSessionClient.reaction(SESSION_ID, { exerciseId: EXERCISE_ID, reaction: "too_easy" });
    await livePracticeSessionClient.finish(SESSION_ID);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => new Headers(init.headers).get("X-Gloss-Provider-Key"))).toEqual([
      VISITOR_KEY, VISITOR_KEY, null, null, null, null, null,
    ]);
    for (const [path, init] of calls) {
      expect(String(init.body)).not.toContain(VISITOR_KEY);
      expect(path).not.toContain(VISITOR_KEY);
    }
  });

  it("does not attach a saved visitor key to a hosted learner", async () => {
    saveProviderKey(VISITOR_KEY);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(readiness));
    vi.stubGlobal("fetch", fetchMock);

    await livePracticeSessionClient.prepare({ requestId: REQUEST_ID, size: 8 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has("X-Gloss-Provider-Key")).toBe(false);
  });

  it("does not echo a BYOK credential reflected in a response", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...readiness, unexpected: VISITOR_KEY })));

    const result = await livePracticeSessionClient.prepare({ requestId: REQUEST_ID, size: 8 });

    expect(result).toMatchObject({ ok: false, code: "bad_response" });
    expect(JSON.stringify(result)).not.toContain(VISITOR_KEY);
  });
});

describe("local practice fixture client", () => {
  it("runs the eight-exercise flow entirely in memory", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createFixturePracticeClient("flow");
    const prepared = await client.prepare({ requestId: REQUEST_ID, size: 8 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const seen: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      if (index >= 3) await client.readiness(prepared.data.sessionId);
      const next = await client.next(prepared.data.sessionId);
      expect(next.ok).toBe(true);
      if (!next.ok || !next.data.exercise) throw new Error("The fixture ended before all eight exercises.");
      seen.push(next.data.exercise.exerciseId);
      if (index === 0) {
        const hint = await client.hint(prepared.data.sessionId, { exerciseId: next.data.exercise.exerciseId });
        expect(hint.ok).toBe(true);
      }
      const answer = await client.answer(prepared.data.sessionId, {
        exerciseId: next.data.exercise.exerciseId,
        answer: practiceFixtureExercises[index].answer,
        usedHint: index === 0,
      });
      expect(answer.ok).toBe(true);
      if (index === 0) {
        const reaction = await client.reaction(prepared.data.sessionId, {
          exerciseId: next.data.exercise.exerciseId,
          reaction: "too_easy",
        });
        expect(reaction.ok).toBe(true);
      }
    }

    const completed = await client.next(prepared.data.sessionId);
    const finished = await client.finish(prepared.data.sessionId);
    expect(new Set(seen).size).toBe(8);
    expect(completed).toMatchObject({ ok: true, data: { status: "complete", exercise: null } });
    expect(finished).toMatchObject({ ok: true, data: { correct: 8, total: 8, durationMinutes: 6 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts each documented fixed-state fixture name", () => {
    const names: PracticeFixtureName[] = [
      "preparing", "recognise", "meaning", "gap", "recall", "correct", "wrong", "end", "waiting", "error",
    ];
    for (const name of names) expect(createFixturePracticeClient(name)).toBeDefined();
  });
});
