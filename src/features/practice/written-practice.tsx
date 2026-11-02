"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { FeedbackPanel } from "./feedback-panel";
import { PracticeShell, TaskCard } from "./practice-shell";
import type { PracticeFeedback, PracticeTask } from "./types";

type Phase = "answer" | "checking" | "feedback";

export type WrittenPracticeProps = {
  task: PracticeTask;
  // Judges the answer. Any failure should come back as verdict "unavailable".
  evaluate?: (answer: string) => Promise<PracticeFeedback>;
  onContinue: () => void;
  onSkip: () => void;
  initial?: { answer: string; feedback?: PracticeFeedback };
};

const COULD_NOT_CHECK: PracticeFeedback = {
  verdict: "unavailable",
  message: "We couldn't check this answer. It wasn't counted either way.",
};

export function WrittenPractice({ task, evaluate, onContinue, onSkip, initial }: WrittenPracticeProps) {
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const [feedback, setFeedback] = useState<PracticeFeedback | null>(initial?.feedback ?? null);
  const [phase, setPhase] = useState<Phase>(initial?.feedback ? "feedback" : "answer");
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const refocus = useRef(false);

  // After "Try again" the cursor goes straight back into the answer.
  useEffect(() => {
    if (phase === "answer" && refocus.current) {
      refocus.current = false;
      answerRef.current?.focus();
    }
  }, [phase]);

  const canSubmit = answer.trim() !== "" && phase === "answer";

  const submit = async () => {
    const text = answer.trim();
    if (text === "" || phase === "checking") return;
    setPhase("checking");
    let result: PracticeFeedback;
    try {
      result = evaluate ? await evaluate(text) : COULD_NOT_CHECK;
    } catch {
      result = COULD_NOT_CHECK;
    }
    setFeedback(result);
    setPhase("feedback");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
      event.preventDefault();
      void submit();
    }
  };

  const tryAgain = () => {
    refocus.current = true;
    setPhase("answer");
  };

  // While re-checking after a failed check, the feedback stays on screen and its button shows progress.
  if (feedback && phase !== "answer" && (phase === "feedback" || feedback.verdict === "unavailable")) {
    const unavailable = feedback.verdict === "unavailable";
    const rechecking = phase === "checking";
    return (
      <PracticeShell
        rail={
          <>
            {unavailable ? (
              <Button variant="quiet" onClick={onContinue} disabled={rechecking}>
                Continue
              </Button>
            ) : feedback.verdict === "used_well" ? (
              <span />
            ) : (
              <Button variant="quiet" onClick={tryAgain}>
                Try again
              </Button>
            )}
            {unavailable ? (
              <Button variant="primary" onClick={submit} pending={rechecking}>
                {rechecking ? "Checking…" : "Try again"}
              </Button>
            ) : (
              <Button variant="primary" onClick={onContinue}>
                Continue
              </Button>
            )}
          </>
        }
      >
        <TaskCard task={task} withSituation={false} label="Writing" />
        <FeedbackPanel feedback={feedback} answer={answer.trim()} />
      </PracticeShell>
    );
  }

  return (
    <PracticeShell
      rail={
        <>
          <Button variant="quiet" onClick={onSkip} disabled={phase === "checking"}>
            Skip
          </Button>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-ink-muted @md:inline">Ctrl or ⌘ + Enter</span>
            <Button variant="primary" onClick={submit} disabled={!canSubmit && phase !== "checking"} pending={phase === "checking"}>
              {phase === "checking" ? "Checking…" : "Submit"}
            </Button>
          </div>
        </>
      }
    >
      <TaskCard task={task} label="Writing" />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="written-answer" className="text-sm font-semibold">
          Your answer
        </label>
        <textarea
          id="written-answer"
          ref={answerRef}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={phase === "checking"}
          rows={3}
          maxLength={600}
          spellCheck={false}
          lang="en"
          placeholder="Write one or two sentences in your own words."
          className="w-full resize-none rounded-field border border-line-strong bg-card px-4 py-3 text-base leading-6 text-ink shadow-card outline-none placeholder:text-ink-muted focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
      </div>
    </PracticeShell>
  );
}
