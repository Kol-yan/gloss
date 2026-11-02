import { afterEach, describe, expect, it, vi } from "vitest";
import { getMe, listExpressions, newRequestId, proofread, submitAttempt, transcribe } from "@/features/api/client";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("parses a valid response with the shared schema", async () => {
    const me = { learner: { id: "l1", displayName: "Alex" }, aiEnabled: true, quotas: { proofread: { used: 1, limit: 20 }, evaluate: { used: 0, limit: 30 }, asrSeconds: { used: 0, limit: 600 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, me)));
    const result = await getMe();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.learner.displayName).toBe("Alex");
  });

  it("maps API errors to their code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(401, { error: { code: "unauthorized", message: "Please open your invite link to sign in." } })));
    const result = await getMe();
    expect(result).toEqual({ ok: false, code: "unauthorized", message: "Please open your invite link to sign in." });
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
});
