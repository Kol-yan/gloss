import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapGuestAccess, createExpression, createTask, detect, enrollByok, getMe, listExpressions, newRequestId, proofread, recordDecision, signOut, submitAttempt, transcribe } from "@/features/api/client";
import { forgetProviderKey, getAccessSnapshot, getRequestProviderKey, saveProviderKey, setCurrentSession, subscribeAccess } from "@/features/api/access-store";
import type { MeResponse } from "@/shared/contracts";

const ME: MeResponse = {
  learner: { id: "l1", displayName: "Alex" },
  accessMode: "hosted",
  aiEnabled: true,
  quotas: { proofread: { used: 1, limit: 20 }, detect: { used: 0, limit: 20 }, evaluate: { used: 0, limit: 30 }, asrSeconds: { used: 0, limit: 600 } },
};
const VISITOR_KEY = "sk-or-v1-" + "visitor".repeat(8);
let stored: Map<string, string>;
let browser: EventTarget & { localStorage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> } };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  stored = new Map();
  browser = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }),
      removeItem: vi.fn((key: string) => { stored.delete(key); }),
    },
  });
  vi.stubGlobal("window", browser);
  forgetProviderKey();
  setCurrentSession(ME);
});

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("parses a valid response with the shared schema", async () => {
    const me = ME;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, me)));
    const result = await getMe();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.learner.displayName).toBe("Alex");
  });

  it("maps API errors to their code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(401, { error: { code: "unauthorized", message: "Open Settings to add your own OpenRouter key and keep going." } })));
    const result = await getMe();
    expect(result).toEqual({ ok: false, code: "unauthorized", message: "Open Settings to add your own OpenRouter key and keep going." });
  });

  it("creates only one guest when concurrent page bootstraps run", async () => {
    setCurrentSession(null);
    const fetchMock = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/me") return respond(401, { error: { code: "unauthorized", message: "Open Settings to add your own OpenRouter key and keep going." } });
      if (path === "/api/access/guest" && init?.method === "GET") return respond(200, { siteKey: null, available: true });
      if (path === "/api/access/guest" && init?.method === "POST") return respond(200, ME);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([bootstrapGuestAccess(), bootstrapGuestAccess(), bootstrapGuestAccess()]);

    expect(results).toEqual([{ kind: "ready" }, { kind: "ready" }, { kind: "ready" }]);
    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/api/me", "GET"], ["/api/access/guest", "GET"], ["/api/access/guest", "POST"],
    ]);
  });

  it("returns the server Turnstile site key and optional action without creating a guest", async () => {
    setCurrentSession(null);
    const fetchMock = vi.fn().mockImplementation(async (path: string) => path === "/api/me"
      ? respond(401, { error: { code: "unauthorized", message: "Open Settings to add your own OpenRouter key and keep going." } })
      : respond(200, { siteKey: "public-site-key", available: true, action: "guest_access" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapGuestAccess()).resolves.toEqual({ kind: "turnstile", siteKey: "public-site-key", action: "guest_access" });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/me", "/api/access/guest"]);
  });

  it("serializes key enrollment after an in-flight guest creation and keeps the upgraded learner", async () => {
    setCurrentSession(null);
    let resolveGuest!: (response: Response) => void;
    let markGuestStarted!: () => void;
    const guestResponse = new Promise<Response>((resolve) => { resolveGuest = resolve; });
    const guestStarted = new Promise<void>((resolve) => { markGuestStarted = resolve; });
    const fetchMock = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/me") return respond(401, { error: { code: "unauthorized", message: "Open Settings to add your own OpenRouter key and keep going." } });
      if (path === "/api/access/guest" && init?.method === "GET") return respond(200, { siteKey: null, available: true });
      if (path === "/api/access/guest" && init?.method === "POST") {
        markGuestStarted();
        return guestResponse;
      }
      if (path === "/api/access/byok") return respond(200, { ...ME, accessMode: "byok" });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootstrap = bootstrapGuestAccess();
    await guestStarted;
    const enrollment = enrollByok(VISITOR_KEY);
    await Promise.resolve();
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/access/byok");

    resolveGuest(respond(200, ME));
    await expect(bootstrap).resolves.toEqual({ kind: "ready" });
    expect(await enrollment).toMatchObject({ ok: true, data: { learner: { id: ME.learner.id }, accessMode: "byok" } });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/me", "/api/access/guest", "/api/access/guest", "/api/access/byok",
    ]);
    expect(getAccessSnapshot().session).toMatchObject({ learner: { id: ME.learner.id }, accessMode: "byok" });
    expect([...stored.values()]).toEqual([VISITOR_KEY]);
  });

  it("treats a response that breaks the contract as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { expressions: [{ nope: true }] })));
    const result = await listExpressions();
    expect(result).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("reports a network failure without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await getMe()).toMatchObject({ ok: false, code: "network" });
  });

  it("answers an unreadable error body with a generic internal failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 500 })));
    expect(await getMe()).toMatchObject({ ok: false, code: "internal", message: "Something went wrong. Please try again." });
  });

  it("sends a new request id with every proofread call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await proofread("one");
    await proofread("one");
    const ids = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).requestId as string);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("posts hashed sentences to the detector, parses probabilities and keeps the BYOK key in the header only", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const hash = "a".repeat(64);
    const answer = {
      requestId: "00000000-0000-4000-8000-000000000000",
      sentences: [{ hash, needs_correction: 0.9, needs_clarity: 0.1, needs_word_choice: 0 }],
      quota: { used: 1, limit: 20 },
    };
    const fetchMock = vi.fn().mockResolvedValue(respond(200, answer));
    vi.stubGlobal("fetch", fetchMock);
    const result = await detect([{ hash, text: "I go to school every day.", localRanges: [{ start: 2, end: 4 }] }]);
    expect(result).toEqual({ ok: true, data: answer });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/detect");
    expect(new Headers(init.headers).get("X-Gloss-Provider-Key")).toBe(VISITOR_KEY);
    const body = JSON.parse(init.body as string);
    expect(body.sentences).toEqual([{ hash, text: "I go to school every day.", localRanges: [{ start: 2, end: 4 }] }]);
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(init.body).not.toContain(VISITOR_KEY);
  });

  it("rejects a detector answer outside the contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, { requestId: "x", sentences: [], quota: { used: 0, limit: 1 } })));
    expect(await detect([{ hash: "b".repeat(64), text: "A sentence is here." }])).toMatchObject({ ok: false, code: "bad_response" });
  });

  it("uploads audio as multipart form data with the attempt id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { attemptId: "a1", text: "hello", durationSeconds: 1.5 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await transcribe("a1", new Blob(["RIFF"], { type: "audio/wav" }));
    expect(result.ok).toBe(true);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const form = init.body as FormData;
    expect(form.get("attemptId")).toBe("a1");
    expect((form.get("audio") as File).name).toBe("answer.wav");
    expect((init.headers as Record<string, string> | undefined)?.["Content-Type"]).toBeUndefined();
  });

  it("posts attempts to the attempt's own URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await submitAttempt("a/b", { answer: "x", hintUsed: false });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/practice/attempts/a%2Fb");
  });

  it("generates v4 ids even without crypto.randomUUID", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("attaches a browser key to each paid endpoint only", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const fetchMock = vi.fn().mockImplementation(async () => respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await proofread("An example");
    await createTask("expression", "written");
    await submitAttempt("attempt", { answer: "An answer", hintUsed: false });
    await transcribe("attempt", new Blob(["RIFF"], { type: "audio/wav" }));
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/proofread", "/api/practice/tasks", "/api/practice/attempts/attempt", "/api/speech/transcribe",
    ]);
    for (const [path, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("X-Gloss-Provider-Key")).toBe(VISITOR_KEY);
      expect(path).not.toContain(VISITOR_KEY);
      if (typeof init.body === "string") expect(init.body).not.toContain(VISITOR_KEY);
    }
  });

  it("keeps keys off history, decisions, expression saves and session reads", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const fetchMock = vi.fn().mockImplementation(async () => respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await listExpressions();
    await recordDecision("suggestion", "accepted", "hash");
    await createExpression({ suggestionId: "suggestion", familiarity: "new" });
    await getMe();
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).has("X-Gloss-Provider-Key")).toBe(false);
    }
  });

  it("never uses a saved visitor key for hosted access", async () => {
    saveProviderKey(VISITOR_KEY);
    const fetchMock = vi.fn().mockResolvedValue(respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await proofread("An example");
    expect(getAccessSnapshot().hasKey).toBe(true);
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has("X-Gloss-Provider-Key")).toBe(false);
  });

  it("resolves the session before a paid call when its access mode is unknown", async () => {
    saveProviderKey(VISITOR_KEY);
    setCurrentSession(null);
    const fetchMock = vi.fn().mockImplementation(async (path: string) => path === "/api/me"
      ? respond(200, { ...ME, accessMode: "byok" }) : respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await proofread("An example");
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/me", "/api/proofread"]);
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get("X-Gloss-Provider-Key")).toBe(VISITOR_KEY);
  });

  it("enrolls with a header and stores the key only in browser storage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ...ME, accessMode: "byok" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await enrollByok(VISITOR_KEY);
    expect(result.ok).toBe(true);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/access/byok");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("X-Gloss-Provider-Key")).toBe(VISITOR_KEY);
    expect([...stored.values()]).toEqual([VISITOR_KEY]);
    expect(JSON.stringify(getAccessSnapshot())).not.toContain(VISITOR_KEY);
    expect(JSON.stringify(result)).not.toContain(VISITOR_KEY);
  });

  it("allows key enrollment when no guest session exists yet", async () => {
    setCurrentSession(null);
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ...ME, accessMode: "byok" }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await enrollByok(VISITOR_KEY)).toMatchObject({ ok: true, data: { accessMode: "byok" } });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/access/byok"]);
    expect(getAccessSnapshot().session?.accessMode).toBe("byok");
    expect([...stored.values()]).toEqual([VISITOR_KEY]);
  });

  it("does not save a visitor key when enrollment preserves an existing hosted session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, ME)));
    expect((await enrollByok(VISITOR_KEY)).ok).toBe(true);
    expect(getAccessSnapshot().session?.accessMode).toBe("hosted");
    expect(getAccessSnapshot().hasKey).toBe(false);
    expect(stored.size).toBe(0);
  });

  it("forgets a key without changing the learner session or history scope", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const before = getAccessSnapshot();
    forgetProviderKey();
    expect(stored.size).toBe(0);
    expect(getRequestProviderKey()).toBe("");
    expect(getAccessSnapshot()).toMatchObject({ session: before.session, sessionRevision: before.sessionRevision, hasKey: false });
    const fetchMock = vi.fn().mockResolvedValue(respond(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    await proofread("An example");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has("X-Gloss-Provider-Key")).toBe(false);
  });

  it("continues in memory with an explicit warning when browser storage is blocked", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    browser.localStorage.setItem.mockImplementation(() => { throw new Error("blocked"); });
    saveProviderKey(VISITOR_KEY);
    expect(getAccessSnapshot().storageNotice).toContain("this tab only");
    expect(getRequestProviderKey()).toBe(VISITOR_KEY);
    browser.localStorage.removeItem.mockImplementation(() => { throw new Error("blocked"); });
    forgetProviderKey();
    expect(getRequestProviderKey()).toBe("");
    expect(getAccessSnapshot().storageNotice).toContain("could not be cleared");
  });

  it("observes another tab forgetting the key", () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const listener = vi.fn();
    const unsubscribe = subscribeAccess(listener);
    stored.clear();
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: null });
    browser.dispatchEvent(event);
    expect(getRequestProviderKey()).toBe("");
    expect(getAccessSnapshot().hasKey).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("does not echo a provider key returned in an error body", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(502, {
      error: { code: "model_unavailable", message: `Provider refused ${VISITOR_KEY}` },
    })));
    expect(await proofread("An example")).toEqual({ ok: false, code: "bad_response", message: "Something went wrong. Please try again." });
  });

  it("signs out without attaching a provider key and clears browser credentials", async () => {
    setCurrentSession({ ...ME, accessMode: "byok" });
    saveProviderKey(VISITOR_KEY);
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await signOut()).ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/access/signout");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has("X-Gloss-Provider-Key")).toBe(false);
    expect(stored.size).toBe(0);
    expect(getAccessSnapshot()).toMatchObject({ session: null, hasKey: false, checked: true });
  });
});
