import type { PracticeFeedback } from "@/features/practice/types";

// Why a voice attempt could not continue. None of these is the learner's fault.
export type VoiceErrorReason =
  | "mic_blocked"
  | "no_microphone"
  | "unsupported"
  | "nothing_recorded"
  | "transcribe_failed";

export type VoiceView =
  | { kind: "idle" }
  // Waiting for the browser's microphone permission prompt.
  | { kind: "starting" }
  | { kind: "recording"; elapsedMs: number }
  // Audio is being turned into text.
  | { kind: "processing" }
  // The learner reads and may edit the transcript before anything is scored.
  | { kind: "confirm"; transcript: string }
  | { kind: "checking"; transcript: string }
  | { kind: "feedback"; transcript: string; feedback: PracticeFeedback }
  | { kind: "error"; reason: VoiceErrorReason; lastTranscript?: string };

export type TranscribeResult = { ok: true; text: string } | { ok: false };

// Sends audio to speech-to-text. Must resolve { ok: false } on failure and
// stop work when the signal aborts.
export type Transcribe = (audio: Blob, signal: AbortSignal) => Promise<TranscribeResult>;

export const MAX_RECORDING_MS = 60_000;
// Anything shorter than this is treated as "nothing recorded".
export const MIN_RECORDING_MS = 700;
