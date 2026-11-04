import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import { openRouterChat, openRouterTranscribe } from "@/server/models/openrouter";
import { OPENROUTER_FAST_MODEL, OPENROUTER_TEXT_MODEL } from "@/server/models/access";
import { textPrice } from "@/server/models/prices";
import { createBudgetedModelFixture, makeTestWav, runBudgetedModelCall, TEST_BYOK_KEY } from "./helpers/budgeted-model-call";
import type { MetaChatInput } from "@/server/models/meta";

const config = loadConfig({ META_API_KEY: "owner-meta-secret", OPENROUTER_API_KEY: "owner-or-secret" });
const byokKey = TEST_BYOK_KEY;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const chatInput: MetaChatInput = {
  model: OPENROUTER_FAST_MODEL,
  messages: [{ role: "user", content: "A short request." }],
  jsonSchema: { name: "reply", schema: { type: "object", properties: { reply: { type: "string" } } } },
  maxTokens: 2048,
};

describe("OpenRouter budget transport", () => {
  it("uses the reservation-backed chat adapter and records positive provider cost evidence", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      choices: [{ finish_reason: "stop", message: { content: '{"reply":"ok"}' } }],
      usage: { prompt_tokens: 25, completion_tokens: 4, cost: 0.000001 },
    }));
    const fixture = createBudgetedModelFixture(chatInput, config, {
      provider: "openrouter",
      apiKey: byokKey,
      fundingSource: "byok",
      role: "detect",
    });
    try {
      const route = { tier: "fast" as const, provider: "openrouter" as const,
        model: OPENROUTER_FAST_MODEL, price: textPrice(OPENROUTER_FAST_MODEL), apiKey: byokKey };
      const result = await fixture.run(() => openRouterChat(chatInput, route, config));
      expect(result.content).toBe('{"reply":"ok"}');
      const row = fixture.db.prepare("SELECT status, reported_cost_micros FROM usage_reservations WHERE id = ?")
        .get(fixture.reservation.id);
      expect(row).toMatchObject({ status: "settled", reported_cost_micros: 1 });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${byokKey}`);
      expect(JSON.parse(init.body)).toMatchObject({
        model: OPENROUTER_FAST_MODEL,
        provider: {
          require_parameters: true,
          data_collection: "deny",
          max_price: { prompt: 0.16, completion: 0.65 },
        },
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("sends transcription WAV as the documented base64 JSON input_audio shape", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ text: " A transcript. ", duration: 1 }));
    const input = { model: "meta/muse-voice-transcribe-1.0", audio: makeTestWav() };
    const result = await runBudgetedModelCall(input, config, () =>
      openRouterTranscribe(input, byokKey, config), {
        provider: "openrouter",
        apiKey: byokKey,
        fundingSource: "byok",
      });
    expect(result.text).toBe("A transcript.");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      model: input.model,
      input_audio: { data: Buffer.from(input.audio).toString("base64"), format: "wav" },
      language: "en",
      provider: { data_collection: "deny" },
    });
  });

  it("rejects an OpenRouter key that aliases an owner credential before network access", async () => {
    // A well-formed visitor key that is byte-identical to the operator key is
    // still refused: it would bill the owner's account.
    const ownerKey = ["sk", "or", "v1", "owner", "credential", "000000"].join("-");
    const ownerConfig = loadConfig({ META_API_KEY: "owner-meta-secret", OPENROUTER_API_KEY: ownerKey });
    const route = { tier: "smart" as const, provider: "openrouter" as const,
      model: OPENROUTER_TEXT_MODEL, price: textPrice(OPENROUTER_TEXT_MODEL), apiKey: ownerKey };
    const fixture = createBudgetedModelFixture({ ...chatInput, model: OPENROUTER_TEXT_MODEL }, ownerConfig, {
      provider: "openrouter",
      apiKey: ownerKey,
      fundingSource: "byok",
      role: "detect",
    });
    try {
      await expect(fixture.run(() => openRouterChat({ ...chatInput, model: OPENROUTER_TEXT_MODEL }, route, ownerConfig)))
        .rejects.toMatchObject({ name: "ProviderRequestBlockedError" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});
