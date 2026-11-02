"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { retryAttemptFor, type Evaluation, type PracticeTask, type SubmitAnswer } from "@/features/practice/types";
import { startRecording, type RecordingSession } from "./recorder";
import { MAX_RECORDING_MS, MIN_RECORDING_MS, type Transcribe, type VoiceView } from "./types";
import { recordingToWav } from "./wav";
import { VoiceTaskView } from "./voice-view";

export type VoicePracticeProps = {
  task: PracticeTask;
  transcribe: Transcribe;
  submit: SubmitAnswer;
  // `null` when the learner skipped the task or the answer was never judged.
  onContinue: (evaluation: Evaluation | null) => void;
};

export function VoicePractice({ task, transcribe, submit, onContinue }: VoicePracticeProps) {
  const [view, setView] = useState<VoiceView>({ kind: "idle" });
  const [hintShown, setHintShown] = useState(false);
  // Every try has its own attempt id; the server hands out the next one.
  const [attemptId, setAttemptId] = useState(task.attemptId);
  const sessionRef = useRef<RecordingSession | null>(null);
  const startedAtRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastTranscriptRef = useRef("");
  // Bumped whenever a running step stops mattering (cancel, new start, unmount).
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

    let wav: Blob;
    try {
      wav = await recordingToWav(recording.blob);
    } catch {
      if (run === runRef.current) {
        setView({ kind: "error", reason: "transcribe_failed", lastTranscript: lastTranscriptRef.current });
      }
      return;
    }
    if (run !== runRef.current) return;

    const controller = new AbortController();
    abortRef.current = controller;
    let result: Awaited<ReturnType<Transcribe>>;
    try {
      result = await transcribe(wav, attemptId, controller.signal);
    } catch {
      result = { ok: false, reason: "failed" };
    }
    if (run !== runRef.current) return;

    if (!result.ok) {
      const reason =
        result.reason === "limit_reached" ? "limit_reached" : result.reason === "service_off" ? "service_off" : "transcribe_failed";
      setView({ kind: "error", reason, lastTranscript: lastTranscriptRef.current });
      return;
    }
    const text = result.text.trim();
    if (text === "") {
      setView({ kind: "error", reason: "nothing_recorded", lastTranscript: lastTranscriptRef.current });
    } else {
      lastTranscriptRef.current = text;
      setView({ kind: "confirm", transcript: text });
    }
  }, [transcribe, attemptId]);

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

  const check = async (transcript: string, id: string) => {
    const run = ++runRef.current;
    lastTranscriptRef.current = transcript;
    setAttemptId(id);
    setView({ kind: "checking", transcript });
    const evaluation = await submit({ attemptId: id, answer: transcript, hintUsed: hintShown });
    if (run !== runRef.current) return;
    setView({ kind: "feedback", transcript, evaluation });
  };

  return (
    <VoiceTaskView
      task={task}
      view={view}
      hintShown={hintShown}
      onShowHint={() => setHintShown(true)}
      onStart={start}
      onStop={stop}
      onCancel={cancel}
      onConfirm={(transcript) => void check(transcript, attemptId)}
      onRecordAgain={() => {
        // After a judged try the server offers a fresh attempt id.
        if (view.kind === "feedback") {
          const nextId = retryAttemptFor(view.evaluation);
          if (nextId) setAttemptId(nextId);
        }
        void start();
      }}
      onTypeInstead={() => setView({ kind: "confirm", transcript: lastTranscriptRef.current })}
      onCheckAgain={() => {
        if (view.kind === "feedback") void check(view.transcript, retryAttemptFor(view.evaluation) ?? attemptId);
      }}
      onContinue={() => onContinue(view.kind === "feedback" && view.evaluation.verdict !== "unavailable" ? view.evaluation : null)}
      onSkip={() => {
        if (!isBusy) onContinue(null);
      }}
    />
  );
}
