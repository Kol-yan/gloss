// Sample voice states for the dev-only gallery. Not real recordings or transcripts.
import { SAMPLE_ANSWER, SAMPLE_FEEDBACK } from "@/features/practice/fixtures";
import type { VoiceView } from "./types";

export const SAMPLE_VOICE_VIEWS: ReadonlyArray<{ id: string; label: string; view: VoiceView }> = [
  { id: "idle", label: "Idle", view: { kind: "idle" } },
  { id: "starting", label: "Waiting for microphone", view: { kind: "starting" } },
  { id: "recording", label: "Recording", view: { kind: "recording", elapsedMs: 7_400 } },
  { id: "processing", label: "Processing", view: { kind: "processing" } },
  { id: "confirm", label: "Confirm transcript", view: { kind: "confirm", transcript: SAMPLE_ANSWER } },
  { id: "feedback", label: "Feedback", view: { kind: "feedback", transcript: SAMPLE_ANSWER, feedback: SAMPLE_FEEDBACK.used_well } },
  { id: "mic_blocked", label: "Error: microphone blocked", view: { kind: "error", reason: "mic_blocked" } },
  { id: "nothing_recorded", label: "Error: nothing recorded", view: { kind: "error", reason: "nothing_recorded" } },
  { id: "transcribe_failed", label: "Error: could not transcribe", view: { kind: "error", reason: "transcribe_failed" } },
  { id: "no_microphone", label: "Error: no microphone", view: { kind: "error", reason: "no_microphone" } },
];
