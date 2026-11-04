// Adapter for the Meta model API (OpenAI-style chat completions). This is the
// only place that talks to the provider. One call, no retries, no fallback to
// another provider: a failed call is reported and the budget reservation
// decides what it cost.
import { getConfig, type AppConfig } from "../config";
import { sendProviderRequest } from "../budget/provider-request";
import {
  ModelNotConfiguredError,
  ModelOutputError,
  type TokenUsage,
} from "./errors";
import { textPrice } from "./prices";
export { estimateMaxCostMicros } from "./prices";

export const MIN_MAX_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 20_000;

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
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number;
  signal?: AbortSignal;
  // Overrides the default provider deadline. Only offline benches set this;
  // production callers keep the shared limit.
  timeoutMs?: number;
}

export interface MetaChatResult {
  content: string;
  // Null when the provider did not report usage in a shape we recognise.
  usage: TokenUsage | null;
  latencyMs: number;
  // OpenRouter reports which upstream provider served the request.
  servingProvider?: string;
}

export interface MetaChatOptions {
  config?: AppConfig;
  timeoutMs?: number;
}

export async function metaChat(
  input: MetaChatInput,
  options: MetaChatOptions = {},
): Promise<MetaChatResult> {
  const config = options.config ?? getConfig();
  const { apiKey, baseUrl } = config.meta;
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
    ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
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
      redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: input.signal, config },
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
  if (input === null || output === null) return null;
  const reportedUsd = typeof json.usage.cost === "number" && Number.isFinite(json.usage.cost) && json.usage.cost > 0
    ? json.usage.cost
    : undefined;
  const reportedMicros = reportedUsd === undefined ? undefined : Math.ceil(Math.round(reportedUsd * 1e9) / 1e3);
  return {
    inputTokens: input,
    outputTokens: output,
    ...(reportedMicros && reportedMicros > 0 && Number.isSafeInteger(reportedMicros) ? { costMicros: reportedMicros } : {}),
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
