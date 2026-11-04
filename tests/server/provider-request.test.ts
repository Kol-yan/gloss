import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import { metaChat, type MetaChatInput } from "@/server/models/meta";
import { sendProviderRequest } from "@/server/budget/provider-request";
import { createBudgetedModelFixture, makeTestWav } from "./helpers/budgeted-model-call";

const config = loadConfig({ META_API_KEY: "meta-test-key" });
const input: MetaChatInput = {
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "A bounded prompt." }],
  jsonSchema: { name: "reply", schema: { type: "object", properties: { reply: { type: "string" } } } },
  maxTokens: 2048,
};
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function chatResponse() {
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"reply":"ok"}' } }] });
}

describe("mandatory provider budget transport", () => {
  it("rejects a direct transport call without an installed reservation", async () => {
    await expect(sendProviderRequest("https://meta.test/v1/chat/completions", {}, {
      timeoutMs: 1000, config,
    })).rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes one dispatch claim under concurrent reuse of the same reservation", async () => {
    fetchMock.mockResolvedValue(chatResponse());
    const fixture = createBudgetedModelFixture(input, config);
    try {
      const results = await Promise.allSettled([
        fixture.run(() => metaChat(input, { config })),
        fixture.run(() => metaChat(input, { config })),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM budget_dispatches WHERE reservation_id = ?")
        .get(fixture.reservation.id)?.n).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("blocks under-reserved and oversized payloads before fetch", async () => {
    const under = createBudgetedModelFixture(input, config, { maxCostMicros: 1 });
    try {
      await expect(under.run(() => metaChat(input, { config }))).rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
    } finally {
      under.cleanup();
    }

    const oversizedInput = { ...input, messages: [{ role: "user" as const, content: "x".repeat(100_001) }] };
    const oversized = createBudgetedModelFixture(oversizedInput, config);
    try {
      await expect(oversized.run(() => metaChat(oversizedInput, { config })))
        .rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
    } finally {
      oversized.cleanup();
    }

    const emptyMessageFlood = { ...input, messages: Array.from({ length: 10_000 }, () => ({ role: "user" as const, content: "" })) };
    const flood = createBudgetedModelFixture(emptyMessageFlood, config);
    try {
      await expect(flood.run(() => metaChat(emptyMessageFlood, { config })))
        .rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
    } finally {
      flood.cleanup();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks learner funding at send time", async () => {
    const fixture = createBudgetedModelFixture(input, config);
    try {
      fixture.db.prepare("UPDATE learners SET funding_source = 'byok' WHERE id = ?").run(fixture.learnerId);
      await expect(fixture.run(() => metaChat(input, { config }))).rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("rechecks the owner funding expiry against wall clock at send time", async () => {
    const expiry = new Date("2026-11-04T12:00:00.000Z");
    const expiringConfig = loadConfig({ META_API_KEY: "meta-test-key", OWNER_FUNDED_UNTIL: expiry.toISOString() });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(expiry.getTime() - 1));
    const fixture = createBudgetedModelFixture(input, expiringConfig, { now: new Date(expiry.getTime() - 1) });
    try {
      vi.setSystemTime(expiry);
      await expect(fixture.run(() => metaChat(input, { config: expiringConfig })))
        .rejects.toMatchObject({ name: "BudgetExhaustedError" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a pre-existing transaction before claiming or sending", async () => {
    const fixture = createBudgetedModelFixture(input, config);
    try {
      fixture.db.exec("BEGIN IMMEDIATE");
      await expect(fixture.run(() => metaChat(input, { config })))
        .rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
      fixture.db.exec("ROLLBACK");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM budget_dispatches WHERE reservation_id = ?")
        .get(fixture.reservation.id)?.n).toBe(0);
    } finally {
      if (fixture.db.isTransaction) fixture.db.exec("ROLLBACK");
      fixture.cleanup();
    }
  });

  it("does not send when the dispatch ledger refuses the claim", async () => {
    const fixture = createBudgetedModelFixture(input, config);
    try {
      fixture.db.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON budget_dispatches
        BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END`);
      await expect(fixture.run(() => metaChat(input, { config }))).rejects.toThrow("ledger unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(fixture.db.prepare("SELECT status FROM usage_reservations WHERE id = ?").get(fixture.reservation.id))
        .toMatchObject({ status: "reserved" });
    } finally {
      fixture.cleanup();
    }
  });

  it("sends the inspected private multipart snapshot after the caller mutates its original FormData", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ transcript: "ok" }));
    const audioInput = { model: "muse-voice-transcribe-1.0", audio: makeTestWav() };
    const fixture = createBudgetedModelFixture(audioInput, config, { role: "dictation_asr" });
    const originalForm = new FormData();
    originalForm.append("request", new Blob([JSON.stringify({
      mode: "PUSH_TO_TALK", model: audioInput.model, audioEncoding: "WAV", languageBias: ["English"],
    })], { type: "application/json" }));
    originalForm.append("audio", new Blob([audioInput.audio.buffer as ArrayBuffer], { type: "audio/wav" }), "audio.wav");
    try {
      const request = fixture.run(() => sendProviderRequest("https://api.meta.ai/v1/asr/transcribe", {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer meta-test-key", Accept: "application/json" },
        body: originalForm,
      }, { timeoutMs: 1000, config }));
      originalForm.set("audio", new Blob(["bad"], { type: "audio/wav" }), "bad.wav");
      await expect(request).resolves.toMatchObject({ bodyText: expect.stringContaining("transcript") });
      const outbound = fetchMock.mock.calls[0][1].body as FormData;
      expect(outbound.get("audio")).toBeInstanceOf(Blob);
      expect(await (outbound.get("audio") as Blob).arrayBuffer()).toEqual(audioInput.audio.buffer);
    } finally {
      fixture.cleanup();
    }
  });
});
