// Thin wrapper around MediaRecorder. The page owns the UI state; this module
// only starts a recording and hands back a session that can stop or cancel it.
import type { VoiceErrorReason } from "./types";
import { blockPronunciationForMicrophone } from "./pronunciation";

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

export async function startRecording(signal?: AbortSignal): Promise<StartResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    return { ok: false, reason: "unsupported" };
  }
  if (signal?.aborted) return { ok: false, reason: "mic_blocked" };

  let releaseSpeech: () => void;
  try {
    releaseSpeech = blockPronunciationForMicrophone();
  } catch {
    return { ok: false, reason: "unsupported" };
  }

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let released = false;
  const release = () => {
    stream?.getTracks().forEach((track) => track.stop());
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", abort);
    releaseSpeech();
  };
  const abort = () => {
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      // Releasing tracks is still required if the recorder has already failed.
    } finally {
      release();
    }
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    release();
    const name = error instanceof DOMException ? error.name : "";
    const missing = name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError";
    return { ok: false, reason: missing ? "no_microphone" : "mic_blocked" };
  }
  if (signal?.aborted || released) {
    release();
    return { ok: false, reason: "mic_blocked" };
  }

  let mimeType: string | undefined;
  try {
    mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch {
    abort();
    return { ok: false, reason: "unsupported" };
  }

  const chunks: Blob[] = [];
  const startedAt = performance.now();
  const capture = recorder;
  let stopPromise: Promise<Recording> | null = null;
  let resolveStop: ((recording: Recording) => void) | null = null;
  const finish = (): Recording => ({
    blob: new Blob(chunks, { type: capture.mimeType || mimeType || "audio/webm" }),
    durationMs: performance.now() - startedAt,
  });
  capture.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  capture.onstop = () => {
    release();
    resolveStop?.(finish());
  };
  capture.onerror = () => {
    chunks.length = 0;
    capture.ondataavailable = null;
    release();
    resolveStop?.(finish());
  };
  try {
    capture.start();
  } catch {
    abort();
    return { ok: false, reason: "unsupported" };
  }

  return {
    ok: true,
    session: {
      stop: () => {
        stopPromise ??= new Promise<Recording>((resolve) => {
          resolveStop = resolve;
          if (capture.state === "inactive" || released) {
            release();
            resolve(finish());
            return;
          }
          try {
            capture.stop();
          } catch {
            release();
            resolve(finish());
          }
        });
        return stopPromise;
      },
      cancel: () => {
        chunks.length = 0;
        capture.ondataavailable = null;
        try {
          if (capture.state !== "inactive") capture.stop();
        } catch {
          // Cancellation must release the microphone even after a recorder error.
        } finally {
          release();
        }
      },
    },
  };
}
