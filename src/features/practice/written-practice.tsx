"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { FeedbackPanel } from "./feedback-panel";
import { PracticeShell, TaskCard } from "./practice-shell";
import { canRetry, retryAttemptFor, type Evaluation, type PracticeTask, type SubmitAnswer } from "./types";

type Phase = "answer" | "checking" | "feedback";

export type WrittenPracticeProps = {
  task: PracticeTask;
  submit: SubmitAnswer;
  // `null` when the learner skipped the task.
  onContinue: (evaluation: Evaluation | null) => void;
  initial?: { answer: string; evaluation?: Evaluation; hintShown?: boolean };
};

export function WrittenPractice({ task, submit, onContinue, initial }: WrittenPracticeProps) {
  const [answer, setAnswer] = useState(initial?.answer ?? "");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(initial?.evaluation ?? null);
  const [phase, setPhase] = useState<Phase>(initial?.evaluation ? "feedback" : "answer");
  const [hintShown, setHintShown] = useState(initial?.hintShown ?? false);
  // Every try has its own attempt id; the server hands out the next one.
  const [attemptId, setAttemptId] = useState(task.attemptId);
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

  const send = async (id: string) => {
    const text = answer.trim();
    if (text === "" || phase === "checking") return;
    setAttemptId(id);
    setPhase("checking");
    setEvaluation(await submit({ attemptId: id, answer: text, hintUsed: hintShown }));
    setPhase("feedback");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
      event.preventDefault();
      void send(attemptId);
    }
  };

  const tryAgain = (nextAttemptId: string) => {
    refocus.current = true;
    setAttemptId(nextAttemptId);
    setPhase("answer");
  };

  // While re-checking after a failed check, the feedback stays on screen and its button shows progress.
  if (evaluation && phase !== "answer" && (phase === "feedback" || evaluation.verdict === "unavailable")) {
    const unavailable = evaluation.verdict === "unavailable";
    const rechecking = phase === "checking";
    const retry = canRetry(evaluation);
    const nextId = retryAttemptFor(evaluation) ?? attemptId;
    return (
      <PracticeShell
        rail={
          <>
            {unavailable && retry ? (
              <Button variant="quiet" onClick={() => onContinue(null)} disabled={rechecking}>
                Continue
              </Button>
            ) : !unavailable && evaluation.verdict !== "used_well" && retry ? (
              <Button variant="quiet" onClick={() => tryAgain(nextId)}>
                Try again
              </Button>
            ) : (
              <span />
            )}
            {unavailable && retry ? (
              <Button variant="primary" onClick={() => void send(nextId)} pending={rechecking}>
                {rechecking ? "Checking…" : "Try again"}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onContinue(unavailable ? null : evaluation)}>
                Continue
              </Button>
            )}
          </>
        }
      >
        <TaskCard task={task} withSituation={task.cue === "hidden"} label="Writing" />
        <FeedbackPanel feedback={evaluation} answer={answer.trim()} revealTarget={task.cue === "hidden"} />
      </PracticeShell>
    );
  }

  return (
    <PracticeShell
      rail={
        <>
          <Button variant="quiet" onClick={() => onContinue(null)} disabled={phase === "checking"}>
            Skip
          </Button>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-ink-muted @md:inline">Ctrl or ⌘ + Enter</span>
            <Button
              variant="primary"
              onClick={() => void send(attemptId)}
              disabled={!canSubmit && phase !== "checking"}
              pending={phase === "checking"}
            >
              {phase === "checking" ? "Checking…" : "Submit"}
            </Button>
          </div>
        </>
      }
    >
      <TaskCard task={task} label="Writing" hintShown={hintShown} onShowHint={() => setHintShown(true)} />
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
          maxLength={1000}
          spellCheck={false}
          lang="en"
          placeholder="Write one or two sentences in your own words."
          className="w-full resize-none rounded-field border border-line-strong bg-card px-4 py-3 text-base leading-6 text-ink shadow-card outline-none placeholder:text-ink-muted focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
      </div>
    </PracticeShell>
  );
}
