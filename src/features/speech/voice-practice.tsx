"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PracticeFeedback, PracticeTask } from "@/features/practice/types";
import { startRecording, type RecordingSession } from "./recorder";
import { MAX_RECORDING_MS, MIN_RECORDING_MS, type Transcribe, type VoiceView } from "./types";
import { VoiceTaskView } from "./voice-view";

export type VoicePracticeProps = {
  task: PracticeTask;
  // Speech-to-text. Without it the task cannot turn audio into text and says so.
  transcribe?: Transcribe;
  // Judges the confirmed transcript. Any failure should come back as verdict "unavailable".
  evaluate?: (transcript: string) => Promise<PracticeFeedback>;
  onContinue: () => void;
  onSkip: () => void;
};

const COULD_NOT_CHECK: PracticeFeedback = {
  verdict: "unavailable",
  message: "We couldn't check this answer. It wasn't counted either way.",
};

export function VoicePractice({ task, transcribe, evaluate, onContinue, onSkip }: VoicePracticeProps) {
  const [view, setView] = useState<VoiceView>({ kind: "idle" });
  const sessionRef = useRef<RecordingSession | null>(null);
  const startedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastTranscriptRef = useRef("");
  const runRef = useRef(0);

  const isBusy = view.kind === "starting" || view.kind === "recording" || view.kind === "processing";

  // Leaving the screen (or hiding it while another route is shown) releases the microphone.
  useLayoutEffect(() => {
    return () => {
      runRef.current += 1;
      sessionRef.current?.cancel();
      sessionRef.current = null;
      abortRef.current?.abort();
      setView((current) =>
        current.kind === "starting" || current.kind === "recording" || current.kind === "processing"
          ? { kind: "idle" }
          : current,
      );
    };
  }, []);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    const run = ++runRef.current;
    setView({ kind: "processing" });

    const recording = await session.stop();
    if (run !== runRef.current) return;
    if (recording.durationMs < MIN_RECORDING_MS || recording.blob.size < 1000) {
      setView({ kind: "error", reason: "nothing_recorded", lastTranscript: lastTranscriptRef.current });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let text: string | null = null;
    try {
      const result = transcribe ? await transcribe(recording.blob, controller.signal) : { ok: false as const };
      text = result.ok ? result.text.trim() : null;
    } catch {
      text = null;
    }
    if (run !== runRef.current) return;

    if (text === null) {
      setView({ kind: "error", reason: "transcribe_failed", lastTranscript: lastTranscriptRef.current });
    } else if (text === "") {
      setView({ kind: "error", reason: "nothing_recorded", lastTranscript: lastTranscriptRef.current });
    } else {
      lastTranscriptRef.current = text;
      setView({ kind: "confirm", transcript: text });
    }
  }, [transcribe]);

  const start = useCallback(async () => {
    const run = ++runRef.current;
    setView({ kind: "starting" });
    const result = await startRecording();
    if (run !== runRef.current) {
      if (result.ok) result.session.cancel();
      return;
    }
    if (!result.ok) {
      setView({ kind: "error", reason: result.reason, lastTranscript: lastTranscriptRef.current });
      return;
    }
    sessionRef.current = result.session;
    startedAtRef.current = performance.now();
    setView({ kind: "recording", elapsedMs: 0 });
  }, []);

  // Timer for the recording view; also enforces the length limit.
  const recording = view.kind === "recording";
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      const elapsedMs = performance.now() - startedAtRef.current;
      if (elapsedMs >= MAX_RECORDING_MS) {
        clearInterval(timer);
        void stop();
        return;
      }
      setView((current) => (current.kind === "recording" ? { kind: "recording", elapsedMs } : current));
    }, 250);
    return () => clearInterval(timer);
  }, [recording, stop]);

  const cancel = () => {
    runRef.current += 1;
    sessionRef.current?.cancel();
    sessionRef.current = null;
    abortRef.current?.abort();
    setView({ kind: "idle" });
  };

  const check = async (transcript: string) => {
    const run = ++runRef.current;
    lastTranscriptRef.current = transcript;
    setView({ kind: "checking", transcript });
    let feedback: PracticeFeedback;
    try {
      feedback = evaluate ? await evaluate(transcript) : COULD_NOT_CHECK;
    } catch {
      feedback = COULD_NOT_CHECK;
    }
    if (run !== runRef.current) return;
    setView({ kind: "feedback", transcript, feedback });
  };

  return (
    <VoiceTaskView
      task={task}
      view={view}
      onStart={start}
      onStop={stop}
      onCancel={cancel}
      onConfirm={check}
      onRecordAgain={() => {
        void start();
      }}
      onTypeInstead={() => setView({ kind: "confirm", transcript: lastTranscriptRef.current })}
      onCheckAgain={() => {
        if (view.kind === "feedback") void check(view.transcript);
      }}
      onContinue={onContinue}
      onSkip={() => {
        if (!isBusy) onSkip();
      }}
    />
  );
}
