import type { AppConfig } from "../config";
import { ModelOutputError, type TokenUsage } from "./errors";
import { DEFAULT_TIMEOUT_MS, MIN_MAX_TOKENS, sendProviderRequest, type MetaChatInput, type MetaChatResult } from "./meta";
import { ASR_TIMEOUT_MS, type MetaTranscribeInput, type MetaTranscribeResult } from "./meta-asr";
import { asrPrice, textPrice } from "./prices";
import { providerKey } from "./access";

const BASE_URL = "https://openrouter.ai/api/v1";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function parseEnvelope(body: string, latencyMs: number): Record<string, unknown> {
  try {
    return record(JSON.parse(body));
  } catch {
    throw new ModelOutputError("envelope_not_json", null, latencyMs);
  }
}

function usageFrom(value: unknown): TokenUsage | null {
  const usage = record(value);
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 &&
    typeof output === "number" && Number.isSafeInteger(output) && output >= 0
    ? { inputTokens: input, outputTokens: output } : null;
}

function headers(apiKey: string, config: AppConfig): Record<string, string> {
  return { Authorization: `Bearer ${providerKey(apiKey)}`, Accept: "application/json",
    "HTTP-Referer": config.publicUrl, "X-OpenRouter-Title": "gloss" };
}

export async function openRouterChat(
  input: MetaChatInput,
  apiKey: string,
  config: AppConfig,
): Promise<MetaChatResult> {
  textPrice(input.model);
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < MIN_MAX_TOKENS) {
    throw new RangeError("Output token budget is too small");
  }
  const { bodyText, latencyMs } = await sendProviderRequest(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { ...headers(apiKey, config), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      response_format: { type: "json_schema", json_schema: {
        name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema,
      } },
      provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny" },
    }),
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal: input.signal });
  const json = parseEnvelope(bodyText, latencyMs);
  const usage = usageFrom(json.usage);
  const choice = record(Array.isArray(json.choices) ? json.choices[0] : undefined);
  if (choice.finish_reason === "length") throw new ModelOutputError("truncated", usage, latencyMs);
  const content = record(choice.message).content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.map(part => typeof record(part).text === "string" ? record(part).text : "").join("") : "";
  if (!text.trim()) throw new ModelOutputError("empty_content", usage, latencyMs);
  return { content: text, usage, latencyMs };
}

export async function openRouterTranscribe(
  input: MetaTranscribeInput,
  apiKey: string,
  config: AppConfig,
): Promise<MetaTranscribeResult> {
  asrPrice(input.model);
  const form = new FormData();
  form.set("model", input.model);
  form.set("language", "en");
  form.set("provider", JSON.stringify({ data_collection: "deny" }));
  form.set("file", new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), "answer.wav");
  const { bodyText, latencyMs } = await sendProviderRequest(`${BASE_URL}/audio/transcriptions`, {
    method: "POST", headers: headers(apiKey, config), body: form,
  }, { timeoutMs: ASR_TIMEOUT_MS, signal: input.signal });
  const json = parseEnvelope(bodyText, latencyMs);
  if (typeof json.text !== "string") throw new ModelOutputError("no_transcript", null, latencyMs);
  const duration = json.duration;
  return { text: json.text.trim(), latencyMs,
    durationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration * 1000 : null };
}
