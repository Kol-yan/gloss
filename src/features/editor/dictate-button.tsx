"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { startRecording, type RecordingSession } from "@/features/speech/recorder";
import { MAX_RECORDING_MS, MIN_RECORDING_MS } from "@/features/speech/types";
import { recordingToWav } from "@/features/speech/wav";
import type { Dictate } from "./types";

type View =
  | { kind: "idle"; message?: string }
  | { kind: "starting" }
  | { kind: "recording"; elapsedMs: number }
  | { kind: "working" };

const seconds = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, "0")}`;

// One button: press to start talking, press again to finish. The cleaned text
// goes to `onText`; nothing is inserted when nothing was heard.
export function DictateButton({
  dictate,
  disabled = false,
  onText,
}: {
  dictate: Dictate;
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: "idle" });
  const sessionRef = useRef<RecordingSession | null>(null);
  const startedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Release the microphone and drop a pending request when the editor goes away.
  useEffect(() => () => {
    sessionRef.current?.cancel();
    abortRef.current?.abort();
  }, []);

  const finish = async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    const elapsedMs = performance.now() - startedAtRef.current;
    if (elapsedMs < MIN_RECORDING_MS) {
      session.cancel();
      setView({ kind: "idle", message: "Too short. Press Dictate, speak, then press Done." });
      return;
    }
    setView({ kind: "working" });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const recording = await session.stop();
      const wav = await recordingToWav(recording.blob);
      const result = await dictate(wav, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) {
        const message =
          result.reason === "quota"
            ? "Today's voice minutes are used up."
            : result.reason === "unavailable"
              ? "Voice input is switched off for today."
              : "Could not turn your speech into text. Try again.";
        setView({ kind: "idle", message });
        return;
      }
      if (result.text.trim() === "") {
        setView({ kind: "idle", message: "Nothing was heard. Try again a little closer to the microphone." });
        return;
      }
      onText(result.text);
      setView({ kind: "idle", message: "Dictated text added." });
    } catch {
      if (!controller.signal.aborted) setView({ kind: "idle", message: "Could not turn your speech into text. Try again." });
    }
  };

  const recording = view.kind === "recording";
  // Recording time on screen, and the length limit.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsedMs = performance.now() - startedAtRef.current;
      if (elapsedMs >= MAX_RECORDING_MS) {
        clearInterval(timer);
        void finish();
        return;
      }
      setView((current) => (current.kind === "recording" ? { kind: "recording", elapsedMs } : current));
    }, 250);
    return () => clearInterval(timer);
    // `finish` reads refs only; restarting the timer on each render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const start = async () => {
    setView({ kind: "starting" });
    const result = await startRecording();
    if (!result.ok) {
      const message =
        result.reason === "mic_blocked"
          ? "Allow the microphone for this site to dictate."
          : result.reason === "no_microphone"
            ? "No microphone was found."
            : "This browser cannot record audio.";
      setView({ kind: "idle", message });
      return;
    }
    sessionRef.current = result.session;
    startedAtRef.current = performance.now();
    setView({ kind: "recording", elapsedMs: 0 });
  };

  const status =
    view.kind === "recording"
      ? `Listening ${seconds(view.elapsedMs)}. Press Done when you finish.`
      : view.kind === "working"
        ? "Turning speech into text…"
        : view.kind === "idle"
          ? (view.message ?? "")
          : "";

  return (
    <div className="flex items-center gap-2">
      <p role="status" aria-live="polite" className={status ? "text-sm text-ink-muted" : "sr-only"}>
        {status}
      </p>
      <button
        type="button"
        className={buttonClasses(recording ? "soft" : "secondary", "sm")}
        aria-pressed={recording}
        disabled={disabled || view.kind === "starting" || view.kind === "working"}
        onClick={() => void (recording ? finish() : start())}
      >
        {recording ? "Done" : "Dictate"}
      </button>
    </div>
  );
}
