import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/server/config";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
} from "@/server/models/errors";
import { metaChat, type MetaChatInput } from "@/server/models/meta";

const config = loadConfig({
  META_API_KEY: "secret-key",
  META_API_BASE_URL: "https://meta.test/v1/",
});

const input: MetaChatInput = {
  model: "muse-spark-1.3",
  messages: [{ role: "user", content: "hi" }],
  jsonSchema: { name: "thing", schema: { type: "object", properties: {} } },
  maxTokens: 2048,
  temperature: 0,
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (message: unknown, extra: Record<string, unknown> = {}, status = 200) =>
  new Response(JSON.stringify({ choices: [message], ...extra }), { status });
const ok = (content: unknown, extra: Record<string, unknown> = {}) =>
  reply({ message: { content }, finish_reason: "stop" }, extra);

describe("metaChat request", () => {
  it("posts an OpenAI-style strict json_schema request with bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(ok('{"a":1}', { usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const result = await metaChat(input, { config });

    expect(result).toMatchObject({ content: '{"a":1}', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://meta.test/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      model: "muse-spark-1.3",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2048,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "thing", strict: true, schema: input.jsonSchema.schema },
      },
    });
  });

  it("omits temperature when not given", async () => {
    fetchMock.mockResolvedValueOnce(ok("{}"));
    await metaChat({ ...input, temperature: undefined }, { config });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("temperature");
  });

  it("refuses to call without a key, with an unpriced model or with a small max_tokens", async () => {
    await expect(metaChat(input, { config: loadConfig({}) })).rejects.toThrow(ModelNotConfiguredError);
    await expect(metaChat({ ...input, model: "mystery-1" }, { config })).rejects.toThrow(UnknownModelError);
    await expect(metaChat({ ...input, maxTokens: 1024 }, { config })).rejects.toThrow(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("metaChat usage", () => {
  it("accepts input/output token names", async () => {
    fetchMock.mockResolvedValueOnce(ok("{}", { usage: { input_tokens: 7, output_tokens: 3 } }));
    expect((await metaChat(input, { config })).usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("reports null for missing or malformed usage", async () => {
    for (const usage of [undefined, {}, { prompt_tokens: 5 }, { prompt_tokens: "5", completion_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 1 }]) {
      fetchMock.mockResolvedValueOnce(ok("{}", usage === undefined ? {} : { usage }));
      expect((await metaChat(input, { config })).usage).toBeNull();
    }
  });

  it("joins text parts when content is a list", async () => {
    fetchMock.mockResolvedValueOnce(ok([{ type: "text", text: '{"a"' }, { type: "text", text: ":1}" }]));
    expect((await metaChat(input, { config })).content).toBe('{"a":1}');
  });
});

describe("metaChat errors", () => {
  it("reports non-2xx answers as ModelHttpError without the body", async () => {
    for (const status of [400, 401, 429, 500, 503]) {
      fetchMock.mockResolvedValueOnce(new Response("secret provider detail", { status }));
      const error = await metaChat(input, { config }).catch((e) => e);
      expect(error).toBeInstanceOf(ModelHttpError);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("secret");
    }
  });

  it("reports unusable answers as ModelOutputError and keeps usage for settling", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));
    await expect(metaChat(input, { config })).rejects.toMatchObject({
      name: "ModelOutputError",
      reason: "envelope_not_json",
      usage: null,
    });

    fetchMock.mockResolvedValueOnce(
      reply({ message: { content: '{"edits":[' }, finish_reason: "length" }, {
        usage: { prompt_tokens: 100, completion_tokens: 2048 },
      }),
    );
    await expect(metaChat(input, { config })).rejects.toMatchObject({
      reason: "truncated",
      usage: { inputTokens: 100, outputTokens: 2048 },
    });

    fetchMock.mockResolvedValueOnce(ok("   ", { usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    await expect(metaChat(input, { config })).rejects.toBeInstanceOf(ModelOutputError);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(metaChat(input, { config })).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("treats a dropped connection as outcome unknown", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(metaChat(input, { config })).rejects.toMatchObject({
      name: "ModelTimeoutError",
      reason: "network",
    });
  });

  it("times out via AbortSignal", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = await metaChat(input, { config, timeoutMs: 20 }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect(error.reason).toBe("timeout");
  });

  it("reports a caller abort as outcome unknown", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort();
        }),
    );
    const error = await metaChat({ ...input, signal: controller.signal }, { config }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect(error.reason).toBe("aborted");
  });
});
