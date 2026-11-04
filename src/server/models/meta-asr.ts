// Adapter for the Meta batch speech-to-text API: POST {base}/asr/transcribe
// with multipart/form-data holding a JSON `request` part and an `audio` part
// (RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz). One call, no retries. The audio
// stays in memory: it is never written to disk or logged.
import { getConfig, type AppConfig } from "../config";
import { ModelNotConfiguredError, ModelOutputError } from "./errors";
import { sendProviderRequest } from "./meta";
import { asrPrice } from "./prices";

export const ASR_TIMEOUT_MS = 30_000;

export interface MetaTranscribeInput {
  model: string;
  // A complete WAV file.
  audio: Uint8Array;
  signal?: AbortSignal;
}

export interface MetaTranscribeResult {
  // The complete transcript. Empty when nothing was heard.
  text: string;
  // Duration the provider measured, when it reports one.
  durationMs: number | null;
  latencyMs: number;
}

export interface MetaTranscribeOptions {
  config?: AppConfig;
  timeoutMs?: number;
}

export async function metaTranscribe(
  input: MetaTranscribeInput,
  options: MetaTranscribeOptions = {},
): Promise<MetaTranscribeResult> {
  const config = options.config ?? getConfig();
  const { apiKey, baseUrl } = config.meta;
  if (!apiKey) throw new ModelNotConfiguredError();
  // No price, no call.
  asrPrice(input.model);

  // PUSH_TO_TALK returns the whole transcript in `transcript`. The language
  // bias is a hint for English; it does not force the language.
  const settings = {
    mode: "PUSH_TO_TALK",
    model: input.model,
    audioEncoding: "WAV",
    languageBias: ["English"],
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(settings)], { type: "application/json" }));
  form.append(
    "audio",
    new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
    "audio.wav",
  );

  // No Content-Type header: fetch adds the multipart boundary itself.
  const { bodyText, latencyMs } = await sendProviderRequest(
    `${baseUrl}/asr/transcribe`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      body: form,
    },
    { timeoutMs: options.timeoutMs ?? ASR_TIMEOUT_MS, signal: input.signal, config },
  );

  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ModelOutputError("envelope_not_json", null, latencyMs);
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  if (typeof record.transcript !== "string") {
    throw new ModelOutputError("no_transcript", null, latencyMs);
  }

  const duration = record.audioDurationMs;
  return {
    text: record.transcript.trim(),
    durationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : null,
    latencyMs,
  };
}
