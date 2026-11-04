import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "@/server/config";
import { ModelHttpError, ModelOutputError, ModelTimeoutError } from "@/server/models/errors";
import { metaChat, type MetaChatInput } from "@/server/models/meta";
import { metaTranscribe } from "@/server/models/meta-asr";
import { MOCK_FAILURE_MARKERS, MOCK_SITUATION, MOCK_TRANSCRIPT } from "@/server/models/mock-provider";
import { makeTestWav, runBudgetedModelCall } from "./helpers/budgeted-model-call";

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
    const chat = await runBudgetedModelCall(situationInput, mocked, () => metaChat(situationInput, { config: mocked }));
    expect(JSON.parse(chat.content)).toEqual({ situation: MOCK_SITUATION });

    const input = { model: "muse-voice-transcribe-1.0", audio: makeTestWav() };
    const speech = await runBudgetedModelCall(input, mocked, () => metaTranscribe(input, { config: mocked }));
    expect(speech.text).toBe(MOCK_TRANSCRIPT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on request as a provider would", async () => {
    const asking = (marker: string): MetaChatInput => ({
      ...situationInput,
      messages: [{ role: "user", content: `An answer with ${marker} in it.` }],
    });
    for (const marker of [MOCK_FAILURE_MARKERS.http, MOCK_FAILURE_MARKERS.network, MOCK_FAILURE_MARKERS.output]) {
      const input = asking(marker);
      const result = runBudgetedModelCall(input, mocked, () => metaChat(input, { config: mocked }));
      if (marker === MOCK_FAILURE_MARKERS.http) await expect(result).rejects.toBeInstanceOf(ModelHttpError);
      else if (marker === MOCK_FAILURE_MARKERS.network) await expect(result).rejects.toBeInstanceOf(ModelTimeoutError);
      else await expect(result).rejects.toBeInstanceOf(ModelOutputError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves real provider calls alone when off", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"situation":"real"}' } }] }),
    );
    const config = loadConfig({ META_API_KEY: "placeholder" });
    await expect(runBudgetedModelCall(situationInput, config, () => metaChat(situationInput, { config })))
      .resolves.toMatchObject({ content: '{"situation":"real"}' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
