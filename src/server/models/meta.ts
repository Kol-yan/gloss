// Adapter for the Meta model API (OpenAI-style chat completions). This is the
// only place that talks to the provider. One call, no retries, no fallback to
// another provider: a failed call is reported and the budget reservation
// decides what it cost.
import { getConfig, type AppConfig } from "../config";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  type TokenUsage,
} from "./errors";
import { textCostMicros, textPrice } from "./prices";

export const MIN_MAX_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 20_000;

// Estimated input tokens per character is deliberately pessimistic (3 chars
// per token), plus a fixed allowance for message framing and the schema.
const CHARS_PER_TOKEN = 3;
const INPUT_OVERHEAD_TOKENS = 600;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MetaChatInput {
  model: string;
  messages: ChatMessage[];
  // Keep the schema flat: the provider rejects recursive schemas.
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface MetaChatResult {
  content: string;
  // Null when the provider did not report usage in a shape we recognise.
  usage: TokenUsage | null;
  latencyMs: number;
}

export interface MetaChatOptions {
  config?: AppConfig;
  timeoutMs?: number;
}

// Upper bound on what one call can cost, in micro-dollars. Throws
// UnknownModelError for a model without a price.
export function estimateMaxCostMicros(
  model: string,
  inputChars: number,
  maxTokens: number,
): number {
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN + INPUT_OVERHEAD_TOKENS);
  return textCostMicros(model, inputTokens, maxTokens);
}

export async function metaChat(
  input: MetaChatInput,
  options: MetaChatOptions = {},
): Promise<MetaChatResult> {
  const { apiKey, baseUrl } = (options.config ?? getConfig()).meta;
  if (!apiKey) throw new ModelNotConfiguredError();
  // No price, no call.
  textPrice(input.model);
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < MIN_MAX_TOKENS) {
    throw new RangeError(`maxTokens must be an integer >= ${MIN_MAX_TOKENS}`);
  }

  const body = {
    model: input.model,
    messages: input.messages,
    max_tokens: input.maxTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    response_format: {
      type: "json_schema",
      json_schema: { name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema },
    },
  };

  const { bodyText, latencyMs } = await sendProviderRequest(
    `${baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: input.signal },
  );

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ModelOutputError("envelope_not_json", null, latencyMs);
  }

  const usage = readUsage(json);
  const choice = firstChoice(json);
  if (choice?.finish_reason === "length") throw new ModelOutputError("truncated", usage, latencyMs);
  const content = readContent(choice?.message?.content);
  if (!content) throw new ModelOutputError("empty_content", usage, latencyMs);

  return { content, usage, latencyMs };
}

// Sends one provider request. Resolves with the body of a 2xx answer; throws
// ModelHttpError for any other status (the body is never read into the error)
// and ModelTimeoutError when the outcome is unknown (timeout, abort, dropped
// connection).
export async function sendProviderRequest(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ bodyText: string; latencyMs: number }> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let status: number;
  let bodyText = "";
  try {
    const response = await fetch(url, { ...init, signal });
    status = response.status;
    if (response.ok) bodyText = await response.text();
    else await response.body?.cancel().catch(() => undefined);
  } catch {
    // The provider may still have done the work, so the outcome is unknown.
    const reason = timeout.aborted ? "timeout" : options.signal?.aborted ? "aborted" : "network";
    throw new ModelTimeoutError(reason, elapsed());
  }

  const latencyMs = elapsed();
  if (status < 200 || status >= 300) throw new ModelHttpError(status, latencyMs);
  return { bodyText, latencyMs };
}

type Choice = { finish_reason?: unknown; message?: { content?: unknown } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstChoice(json: unknown): Choice | undefined {
  if (!isRecord(json) || !Array.isArray(json.choices)) return undefined;
  const choice = json.choices[0];
  return isRecord(choice) ? (choice as Choice) : undefined;
}

// Some APIs return content as a list of text parts.
function readContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
    return text.trim() ? text : null;
  }
  return null;
}

// Accepts OpenAI-style (prompt/completion) and input/output token names.
function readUsage(json: unknown): TokenUsage | null {
  if (!isRecord(json) || !isRecord(json.usage)) return null;
  const input = tokenCount(json.usage.prompt_tokens ?? json.usage.input_tokens);
  const output = tokenCount(json.usage.completion_tokens ?? json.usage.output_tokens);
  return input === null || output === null ? null : { inputTokens: input, outputTokens: output };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
