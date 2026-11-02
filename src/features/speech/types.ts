import type { Evaluation } from "@/features/practice/types";

// Why a voice attempt could not continue. None of these is the learner's fault.
export type VoiceErrorReason =
  | "mic_blocked"
  | "no_microphone"
  | "unsupported"
  | "nothing_recorded"
  | "transcribe_failed"
  // Today's speaking time is used up.
  | "limit_reached"
  // Speech-to-text is switched off or paused for today.
  | "service_off";

export type VoiceView =
  | { kind: "idle" }
  // Waiting for the browser's microphone permission prompt.
  | { kind: "starting" }
  | { kind: "recording"; elapsedMs: number }
  // Audio is being converted and turned into text.
  | { kind: "processing" }
  // The learner reads and may edit the transcript before anything is scored.
  | { kind: "confirm"; transcript: string }
  | { kind: "checking"; transcript: string }
  | { kind: "feedback"; transcript: string; evaluation: Evaluation }
  | { kind: "error"; reason: VoiceErrorReason; lastTranscript?: string };

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: "failed" | "limit_reached" | "service_off" };

// Sends a WAV recording for one attempt to speech-to-text. Must resolve with
// { ok: false } on failure and stop work when the signal aborts. Empty text
// means nothing was heard.
export type Transcribe = (wav: Blob, attemptId: string, signal: AbortSignal) => Promise<TranscribeResult>;

export const MAX_RECORDING_MS = 60_000;
// Anything shorter than this is treated as "nothing recorded".
export const MIN_RECORDING_MS = 700;
