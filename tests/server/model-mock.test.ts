import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "@/server/config";
import { ModelHttpError, ModelOutputError, ModelTimeoutError } from "@/server/models/errors";
import { metaChat, type MetaChatInput } from "@/server/models/meta";
import { metaTranscribe } from "@/server/models/meta-asr";
import { MOCK_FAILURE_MARKERS, MOCK_SITUATION, MOCK_TRANSCRIPT } from "@/server/models/mock-provider";

const mocked = loadConfig({ META_API_KEY: "placeholder", GLOSSY_MODEL_MOCK: "true" });

const situationInput: MetaChatInput = {
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "The learner will answer in writing." }],
  jsonSchema: { name: "practice_situation", schema: { type: "object", properties: {} } },
  maxTokens: 2048,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GLOSSY_MODEL_MOCK", () => {
  it("is off unless set to true", () => {
    expect(loadConfig({}).modelMock).toBe(false);
    expect(loadConfig({ GLOSSY_MODEL_MOCK: "" }).modelMock).toBe(false);
    expect(loadConfig({ GLOSSY_MODEL_MOCK: "false" }).modelMock).toBe(false);
    expect(mocked.modelMock).toBe(true);
    expect(() => loadConfig({ GLOSSY_MODEL_MOCK: "maybe" })).toThrow(ConfigError);
  });

  it("answers model calls without any network request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chat = await metaChat(situationInput, { config: mocked });
    expect(JSON.parse(chat.content)).toEqual({ situation: MOCK_SITUATION });

    const speech = await metaTranscribe({ model: "muse-voice-transcribe-1.0", audio: new Uint8Array(4) }, { config: mocked });
    expect(speech.text).toBe(MOCK_TRANSCRIPT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on request as a provider would", async () => {
    const asking = (marker: string): MetaChatInput => ({
      ...situationInput,
      messages: [{ role: "user", content: `An answer with ${marker} in it.` }],
    });
    await expect(metaChat(asking(MOCK_FAILURE_MARKERS.http), { config: mocked })).rejects.toBeInstanceOf(ModelHttpError);
    await expect(metaChat(asking(MOCK_FAILURE_MARKERS.network), { config: mocked })).rejects.toBeInstanceOf(ModelTimeoutError);
    await expect(metaChat(asking(MOCK_FAILURE_MARKERS.output), { config: mocked })).rejects.toBeInstanceOf(ModelOutputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves real provider calls alone when off", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"situation":"real"}' } }] }),
    );
    const config = loadConfig({ META_API_KEY: "placeholder" });
    await expect(metaChat(situationInput, { config })).resolves.toMatchObject({ content: '{"situation":"real"}' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
