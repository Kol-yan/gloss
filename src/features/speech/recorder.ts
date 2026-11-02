// Thin wrapper around MediaRecorder. The page owns the UI state; this module
// only starts a recording and hands back a session that can stop or cancel it.
import type { VoiceErrorReason } from "./types";

export type Recording = { blob: Blob; durationMs: number };

export type RecordingSession = {
  stop: () => Promise<Recording>;
  // Discards the audio and releases the microphone.
  cancel: () => void;
};

export type StartResult =
  | { ok: true; session: RecordingSession }
  | { ok: false; reason: Extract<VoiceErrorReason, "mic_blocked" | "no_microphone" | "unsupported"> };

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export async function startRecording(): Promise<StartResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    return { ok: false, reason: "unsupported" };
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    const missing = name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError";
    return { ok: false, reason: missing ? "no_microphone" : "mic_blocked" };
  }

  const release = () => stream.getTracks().forEach((track) => track.stop());
  const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    release();
    return { ok: false, reason: "unsupported" };
  }

  const chunks: Blob[] = [];
  const startedAt = performance.now();
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  const finish = (): Recording => ({
    blob: new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }),
    durationMs: performance.now() - startedAt,
  });

  return {
    ok: true,
    session: {
      stop: () =>
        new Promise<Recording>((resolve) => {
          if (recorder.state === "inactive") {
            release();
            resolve(finish());
            return;
          }
          recorder.onstop = () => {
            release();
            resolve(finish());
          };
          recorder.stop();
        }),
      cancel: () => {
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        release();
      },
    },
  };
}
