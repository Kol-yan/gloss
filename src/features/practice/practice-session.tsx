"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { InviteRequired } from "@/components/invite-required";
import { LoadError, LoadingState } from "@/components/load-states";
import {
  createTask,
  isAiOff,
  isQuota,
  isUnauthorized,
  newRequestId,
  submitAttempt,
  transcribe,
  type ApiFailure,
} from "@/features/api/client";
import { VoicePractice } from "@/features/speech/voice-practice";
import type { Transcribe } from "@/features/speech/types";
import type { PracticeKind } from "@/shared/contracts";
import { WrittenPractice } from "./written-practice";
import type { Evaluation, PracticeTask, SubmitAnswer } from "./types";

type Stage =
  | { name: "loading"; kind: PracticeKind }
  | { name: "task"; task: PracticeTask }
  | { name: "error"; kind: PracticeKind; failure: ApiFailure }
  | { name: "done" };

// The answer could not be judged. It is never counted, and the message says so.
function unavailableEvaluation(attemptId: string, failure: ApiFailure): Evaluation {
  const retryable = !isQuota(failure) && !isAiOff(failure);
  const message = isQuota(failure)
    ? "You've used today's practice checks. They come back tomorrow."
    : isAiOff(failure)
      ? "Checking isn't available today. Your answer wasn't counted."
      : "We couldn't check this answer. It wasn't counted either way.";
  return {
    attemptId,
    verdict: "unavailable",
    message,
    correction: null,
    targetUsed: false,
    transcriptEdited: false,
    nextPracticeLabel: null,
    retryAttemptId: retryable ? attemptId : null,
  };
}

// One expression, practised in order: a written task, then a spoken one.
export function PracticeSession({ expressionId }: { expressionId: string }) {
  const [stage, setStage] = useState<Stage>({ name: "loading", kind: "written" });
  const [sessionLost, setSessionLost] = useState(false);
  const [nextLabel, setNextLabel] = useState<string | null>(null);
  const started = useRef(false);

  const fetchTask = async (kind: PracticeKind) => {
    // Every press is a new request: the server counts a failed attempt as spent, and
    // reusing its id would be refused as a conflict.
    const result = await createTask(expressionId, kind, newRequestId());
    if (result.ok) {
      setStage({ name: "task", task: result.data });
    } else if (isUnauthorized(result)) {
      setSessionLost(true);
    } else {
      setStage({ name: "error", kind, failure: result });
    }
  };

  const loadTask = (kind: PracticeKind) => {
    setStage({ name: "loading", kind });
    void fetchTask(kind);
  };

  // Start once. Effects run again when the route becomes visible after another
  // one was shown, and that must not request a second task.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchTask("written");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mounted session
  }, []);

  const submit: SubmitAnswer = async ({ attemptId, answer, hintUsed }) => {
    const result = await submitAttempt(attemptId, { answer, hintUsed });
    if (result.ok) return result.data;
    if (isUnauthorized(result)) setSessionLost(true);
    return unavailableEvaluation(attemptId, result);
  };

  const transcribeAudio: Transcribe = async (wav, attemptId, signal) => {
    const result = await transcribe(attemptId, wav, signal);
    if (result.ok) return { ok: true, text: result.data.text };
    if (isUnauthorized(result)) setSessionLost(true);
    return { ok: false, reason: isQuota(result) ? "limit_reached" : isAiOff(result) ? "service_off" : "failed" };
  };

  const finish = (finished: PracticeKind, evaluation: Evaluation | null) => {
    if (evaluation?.nextPracticeLabel) setNextLabel(evaluation.nextPracticeLabel);
    if (finished === "written") loadTask("voice");
    else setStage({ name: "done" });
  };

  if (sessionLost) return <InviteRequired onRetry={() => window.location.reload()} />;

  if (stage.name === "loading") return <LoadingState label="Preparing your task" />;

  if (stage.name === "error") {
    const { failure, kind } = stage;
    if (isQuota(failure)) {
      return (
        <LoadError
          title="You've used today's practice allowance"
          action={
            <Link href="/expressions" className={buttonClasses("primary")}>
              See my expressions
            </Link>
          }
        >
          It comes back tomorrow. Your expressions are saved.
        </LoadError>
      );
    }
    if (isAiOff(failure)) {
      return (
        <LoadError
          title="Practice isn't available today"
          action={
            <Link href="/" className={buttonClasses("primary")}>
              Open the editor
            </Link>
          }
        >
          Cloud features are paused for now. Checking your writing on this device still works.
        </LoadError>
      );
    }
    if (failure.code === "not_found") {
      return (
        <LoadError
          title="We couldn't find that expression"
          action={
            <Link href="/expressions" className={buttonClasses("primary")}>
              See my expressions
            </Link>
          }
        >
          It may have been removed. Pick another one from your list.
        </LoadError>
      );
    }
    return (
      <LoadError title="We couldn't prepare your task" onRetry={() => loadTask(kind)}>
        That was on our side, not yours. Try again in a moment.
      </LoadError>
    );
  }

  if (stage.name === "done") {
    return (
      <EmptyState
        eyebrow="Practice done"
        title="That's it for now"
        action={
          <Link href="/expressions" className={buttonClasses("primary")}>
            See my expressions
          </Link>
        }
      >
        {nextLabel ? `Next practice: ${nextLabel}.` : "We'll bring this expression back later."}
      </EmptyState>
    );
  }

  const { task } = stage;
  return task.kind === "written" ? (
    <WrittenPractice key={task.id} task={task} submit={submit} onContinue={(evaluation) => finish("written", evaluation)} />
  ) : (
    <VoicePractice
      key={task.id}
      task={task}
      transcribe={transcribeAudio}
      submit={submit}
      onContinue={(evaluation) => finish("voice", evaluation)}
    />
  );
}
