import { afterEach, describe, expect, it, vi } from "vitest";
import { onboardingClient } from "@/features/onboarding/client";
const fetchMock = vi.fn();
afterEach(() => vi.unstubAllGlobals());

describe("onboarding requests", () => {
  it("sends the chosen group without any provider key", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValueOnce(Response.json("B1")));
    const result = await onboardingClient.level("unsure");
    expect(result).toEqual({ ok: true, data: "B1" });
    expect(fetchMock.mock.calls.at(-1)).toEqual(["/api/onboarding/level", expect.objectContaining({ method: "POST", body: '{"level":"unsure"}', credentials: "same-origin", headers: { "Content-Type": "application/json" } })]);
  });
  it("keeps upstream failures and malformed data out of learner copy", async () => {
    vi.stubGlobal("fetch", fetchMock.mockResolvedValueOnce(Response.json({ stack: "private failure" }, { status: 500 })));
    const result = await onboardingClient.round();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private failure");
  });
  it("saves exactly the served entry answer and finishes with an empty body", async () => {
    vi.stubGlobal("fetch", fetchMock
      .mockResolvedValueOnce(Response.json({ level: "B1", answered: 1, counts: { active: 0, ready: 1, learning: 0 } }))
      .mockResolvedValueOnce(Response.json({ completed: true })));
    expect((await onboardingClient.answer([{ id: "served-id", answer: "know_unused" }])).ok).toBe(true);
    expect(fetchMock.mock.calls.at(-1)?.[1].body).toBe('{"answers":[{"id":"served-id","answer":"know_unused"}]}');
    expect((await onboardingClient.complete()).ok).toBe(true);
    expect(fetchMock.mock.calls.at(-1)?.[1].body).toBe("{}");
  });
});
