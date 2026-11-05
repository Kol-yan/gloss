"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { AccessUnavailable, DemoSpentNotice } from "@/components/invite-required";
import { LoadError, LoadingState } from "@/components/load-states";
import {
  createTask,
  getMe,
  isAiOff,
  isQuota,
  isUnauthorized,
  newRequestId,
  submitAttempt,
  transcribe,
  type ApiFailure,
} from "@/features/api/client";
import { VoicePractice } from "@/features/speech/voice-practice";
import { useAccess } from "@/features/api/use-access";
import { useLoad } from "@/features/api/use-load";
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
function unavailableEvaluation(attemptId: string, failure: ApiFailure, target: string): Evaluation {
  const retryable = !isQuota(failure) && !isAiOff(failure);
  const message = isQuota(failure) || failure.code === "budget_exhausted"
    ? "The free demo is used up. Add your own OpenRouter key in Settings to keep going."
    : isAiOff(failure)
      ? "Checking isn't available today. Your answer wasn't counted."
      : "We couldn't check this answer. It wasn't counted either way.";
  return {
    attemptId,
    target,
    verdict: "unavailable",
    message,
    correction: null,
    targetUsed: false,
    transcriptEdited: false,
    nextPracticeLabel: null,
    retryAttemptId: retryable ? attemptId : null,
  };
}

export function PracticeSession({ expressionId }: { expressionId: string }) {
  const { result, reload } = useLoad(getMe);
  if (!result) return <LoadingState label="Opening your practice" />;
  if (!result.ok) {
    if (isUnauthorized(result)) return <AccessUnavailable />;
    return <LoadError title="We couldn't open your practice" onRetry={reload}>Check your connection and try again.</LoadError>;
  }
  // A change of learner discards any answer or transcript from the previous session.
  return (
    <>
      {!result.data.aiEnabled && result.data.accessMode === "hosted" ? <DemoSpentNotice className="mx-auto mt-3 max-w-2xl" /> : null}
      <PracticeForLearner key={result.data.learner.id} expressionId={expressionId} />
    </>
  );
}

// One expression, practised in order: a written task, then a spoken one.
function PracticeForLearner({ expressionId }: { expressionId: string }) {
  const access = useAccess();
  const [stage, setStage] = useState<Stage>({ name: "loading", kind: "written" });
  const [sessionLost, setSessionLost] = useState(false);
  const [nextLabel, setNextLabel] = useState<string | null>(null);
  const started = useRef(false);

  const fetchTask = useCallback(async (kind: PracticeKind) => {
    // Every press is a new request: the server counts a failed attempt as spent, and
    // reusing its id would be refused as a conflict.
    const result = await createTask(expressionId, kind, newRequestId());
    if (result.ok) {
      setStage({ name: "task", task: result.data });
    } else if (isUnauthorized(result)) {
      setSessionLost(true);
      void getMe();
    } else {
      setStage({ name: "error", kind, failure: result });
    }
  }, [expressionId]);

  const loadTask = useCallback((kind: PracticeKind) => {
    setStage({ name: "loading", kind });
    void fetchTask(kind);
  }, [fetchTask]);

  // Start once. Effects run again when the route becomes visible after another
  // one was shown, and that must not request a second task.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchTask("written");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mounted session
  }, []);

  useEffect(() => {
    if (!sessionLost) return;
    let active = true;
    void getMe().then((result) => {
      if (active && result.ok) {
        setSessionLost(false);
        loadTask("written");
      }
    });
    return () => { active = false; };
  }, [sessionLost, access.sessionRevision, loadTask]);

  const submit: SubmitAnswer = async ({ attemptId, answer, hintUsed }) => {
    const result = await submitAttempt(attemptId, { answer, hintUsed });
    if (result.ok) return result.data;
    if (isUnauthorized(result)) setSessionLost(true);
    return unavailableEvaluation(attemptId, result, stage.name === "task" ? stage.task.expression ?? "" : "");
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

  if (sessionLost || (access.checked && !access.session)) {
    return <AccessUnavailable />;
  }

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
          The free demo is used up. Add your own OpenRouter key in{" "}
          <Link href="/settings" className="font-semibold underline underline-offset-2">Settings</Link> to keep going. Your expressions are saved.
        </LoadError>
      );
    }
    if (isAiOff(failure)) {
      return (
        <LoadError
          title="Practice isn't available today"
          action={
            <Link href="/editor" className={buttonClasses("primary")}>
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
