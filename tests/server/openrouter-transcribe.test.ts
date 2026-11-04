import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/server/config";

vi.mock("@/server/budget/provider-request", () => ({
  sendProviderRequest: vi.fn(),
}));

import { sendProviderRequest } from "@/server/budget/provider-request";
import { openRouterTranscribe } from "@/server/models/openrouter";
import { TEST_BYOK_KEY } from "./helpers/budgeted-model-call";

const config = {
  publicUrl: "http://localhost:3000",
  modelMock: true,
} as AppConfig;

describe("openRouterTranscribe", () => {
  it("sends WAV audio as raw base64 JSON and normalizes the transcript", async () => {
    const audio = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x20, 0x30, 0x40]);
    vi.mocked(sendProviderRequest).mockResolvedValueOnce({
      bodyText: JSON.stringify({ text: "  A clear sentence.  ", duration: 1.25 }),
      latencyMs: 18,
    });

    const result = await openRouterTranscribe({
      model: "meta/muse-voice-transcribe-1.0",
      audio,
    }, TEST_BYOK_KEY, config);

    expect(sendProviderRequest).toHaveBeenCalledOnce();
    const [url, init, options] = vi.mocked(sendProviderRequest).mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${TEST_BYOK_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-OpenRouter-Title": "gloss",
      },
    });
    expect(typeof init.body).toBe("string");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "meta/muse-voice-transcribe-1.0",
      input_audio: { data: Buffer.from(audio).toString("base64"), format: "wav" },
      language: "en",
      provider: { data_collection: "deny" },
    });
    expect(options).toMatchObject({ timeoutMs: 30_000, config });
    expect(result).toEqual({ text: "A clear sentence.", latencyMs: 18, durationMs: 1250 });
  });
});
