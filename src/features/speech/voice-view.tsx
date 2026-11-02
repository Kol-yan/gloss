"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertIcon, MicIcon, StopIcon } from "@/components/ui/icons";
import { FeedbackPanel } from "@/features/practice/feedback-panel";
import { PracticeShell, TaskCard } from "@/features/practice/practice-shell";
import type { PracticeTask } from "@/features/practice/types";
import { MAX_RECORDING_MS, type VoiceErrorReason, type VoiceView } from "./types";

export type VoiceHandlers = {
  onStart: () => void;
  onStop: () => void;
  // Cancels a recording or a transcription in progress.
  onCancel: () => void;
  onConfirm: (transcript: string) => void;
  onRecordAgain: () => void;
  // Opens the transcript box empty (or with the last transcript) so the learner can type the answer.
  onTypeInstead: () => void;
  // Re-runs the check on the same transcript after a model failure.
  onCheckAgain: () => void;
  onContinue: () => void;
  onSkip: () => void;
};

const ERROR_COPY: Record<VoiceErrorReason, { title: string; body: string }> = {
  mic_blocked: {
    title: "Your browser is blocking the microphone",
    body: "Allow microphone access for this site in the address bar, then try again. Or type your answer instead.",
  },
  no_microphone: {
    title: "We couldn't find a microphone",
    body: "Connect one and try again, or type your answer instead.",
  },
  unsupported: {
    title: "This browser can't record audio",
    body: "Type your answer instead, or open Glossy in another browser.",
  },
  nothing_recorded: {
    title: "We couldn't hear anything",
    body: "Check that your microphone is on and speak a little closer. Try again, or type your answer instead.",
  },
  transcribe_failed: {
    title: "We couldn't turn that into text",
    body: "That was on our side, not yours. Try again, or type your answer instead.",
  },
};

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Same height in every state so the layout does not jump.
function CardFrame({ children, align = "center" }: { children: ReactNode; align?: "center" | "start" }) {
  return (
    <div
      className={
        "flex h-52 flex-col gap-2 rounded-tile border border-line bg-card p-4 shadow-card " +
        (align === "center" ? "items-center justify-center text-center" : "items-stretch justify-start")
      }
    >
      {children}
    </div>
  );
}

function Dots() {
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      {[0, 140, 280].map((delay) => (
        <span
          key={delay}
          className="size-2 animate-dot rounded-full bg-accent"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

function VoiceCard({
  view,
  draft,
  onDraftChange,
  onStart,
  onStop,
}: {
  view: VoiceView;
  draft: string;
  onDraftChange: (value: string) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  switch (view.kind) {
    case "idle":
      return (
        <CardFrame>
          <button
            type="button"
            onClick={onStart}
            aria-label="Start recording"
            className="grid size-20 place-items-center rounded-full bg-accent text-on-accent shadow-lift transition duration-150 hover:bg-accent-strong active:scale-95"
          >
            <MicIcon size={32} />
          </button>
          <p className="text-base font-semibold">Tap to record</p>
          <p className="max-w-xs text-sm leading-snug text-ink-muted">
            Say it out loud in two or three sentences. You check the text before it counts.
          </p>
        </CardFrame>
      );

    case "starting":
      return (
        <CardFrame>
          <span className="grid size-20 place-items-center rounded-full bg-line text-ink-muted">
            <MicIcon size={32} />
          </span>
          <p role="status" className="text-base font-semibold">
            Waiting for your microphone
          </p>
          <p className="max-w-xs text-sm leading-snug text-ink-muted">Choose Allow if your browser asks.</p>
        </CardFrame>
      );

    case "recording":
      return (
        <CardFrame>
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop recording"
            className="grid size-20 animate-record place-items-center rounded-full bg-error text-paper transition duration-150 active:scale-95"
          >
            <StopIcon size={30} />
          </button>
          <p className="text-2xl font-semibold tabular-nums" role="timer" aria-label="Recording time">
            {formatTime(view.elapsedMs)}
          </p>
          <p className="text-sm text-ink-muted">Recording. Tap the square to stop.</p>
          <span className="sr-only">Up to {formatTime(MAX_RECORDING_MS)}.</span>
        </CardFrame>
      );

    case "processing":
      return (
        <CardFrame>
          <Dots />
          <p role="status" className="text-base font-semibold">
            Turning your speech into text
          </p>
          <p className="text-sm text-ink-muted">This usually takes a few seconds.</p>
        </CardFrame>
      );

    case "confirm":
      return (
        <CardFrame align="start">
          <label htmlFor="voice-transcript" className="text-sm font-semibold">
            We heard:
          </label>
          <textarea
            id="voice-transcript"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            spellCheck={false}
            lang="en"
            rows={4}
            maxLength={600}
            placeholder="Type what you wanted to say."
            className="min-h-0 w-full flex-1 resize-none rounded-field border border-line-strong bg-surface px-3 py-2 text-base leading-6 text-ink outline-none placeholder:text-ink-muted focus:border-accent focus:ring-4 focus:ring-accent/15"
          />
          <p className="text-xs leading-snug text-ink-muted">Fix anything we got wrong. Nothing counts until you confirm.</p>
        </CardFrame>
      );

    case "checking":
      return (
        <CardFrame align="start">
          <p className="text-sm font-semibold">We heard:</p>
          <p className="min-h-0 flex-1 overflow-y-auto text-base leading-6 [overflow-wrap:anywhere]">{view.transcript}</p>
          <div role="status" className="flex items-center gap-2 text-sm text-ink-muted">
            <Dots />
            Checking your answer
          </div>
        </CardFrame>
      );

    case "error": {
      const copy = ERROR_COPY[view.reason];
      return (
        <CardFrame>
          <span className="grid size-10 place-items-center rounded-full bg-neutral-soft text-neutral">
            <AlertIcon size={20} />
          </span>
          <p role="alert" className="text-base font-semibold leading-snug">
            {copy.title}
          </p>
          <p className="max-w-sm text-sm leading-snug text-ink-muted">{copy.body}</p>
        </CardFrame>
      );
    }

    case "feedback":
      return null;
  }
}

// Presentational: every state of the voice task is a pure function of `view`,
// which is what the dev gallery renders. VoicePractice supplies the real behaviour.
export function VoiceTaskView(props: { task: PracticeTask; view: VoiceView } & VoiceHandlers) {
  // The draft lives in the keyed inner component so each new transcript starts fresh.
  const key = props.view.kind === "confirm" ? `confirm:${props.view.transcript}` : props.view.kind;
  return <VoiceTaskInner key={key} {...props} />;
}

function VoiceTaskInner({ task, view, ...handlers }: { task: PracticeTask; view: VoiceView } & VoiceHandlers) {
  const [draft, setDraft] = useState(view.kind === "confirm" ? view.transcript : "");

  let rail: ReactNode;
  switch (view.kind) {
    case "idle":
      rail = (
        <>
          <Button variant="quiet" onClick={handlers.onSkip}>
            Skip
          </Button>
          <span />
        </>
      );
      break;
    case "starting":
    case "recording":
    case "processing":
      rail = (
        <>
          <Button variant="quiet" onClick={handlers.onCancel} disabled={view.kind === "starting"}>
            Cancel
          </Button>
          <span />
        </>
      );
      break;
    case "confirm":
      rail = (
        <>
          <Button variant="secondary" onClick={handlers.onRecordAgain}>
            Record again
          </Button>
          <Button variant="primary" onClick={() => handlers.onConfirm(draft.trim())} disabled={draft.trim() === ""}>
            Confirm
          </Button>
        </>
      );
      break;
    case "checking":
      rail = (
        <>
          <span />
          <Button variant="primary" pending>
            Checking…
          </Button>
        </>
      );
      break;
    case "error":
      rail = (
        <>
          <Button variant="secondary" onClick={handlers.onTypeInstead}>
            Type instead
          </Button>
          <Button variant="primary" onClick={handlers.onStart}>
            Try again
          </Button>
        </>
      );
      break;
    case "feedback": {
      const verdict = view.feedback.verdict;
      rail =
        verdict === "unavailable" ? (
          <>
            <Button variant="quiet" onClick={handlers.onContinue}>
              Continue
            </Button>
            <Button variant="primary" onClick={handlers.onCheckAgain}>
              Try again
            </Button>
          </>
        ) : verdict === "used_well" ? (
          <>
            <span />
            <Button variant="primary" onClick={handlers.onContinue}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={handlers.onRecordAgain}>
              Try again
            </Button>
            <Button variant="primary" onClick={handlers.onContinue}>
              Continue
            </Button>
          </>
        );
      break;
    }
  }

  return (
    <PracticeShell rail={rail}>
      <TaskCard task={task} withSituation={view.kind !== "feedback"} label="Speaking" />
      {view.kind === "feedback" ? (
        <FeedbackPanel feedback={view.feedback} answer={view.transcript} answerLabel="We heard" />
      ) : (
        <VoiceCard
          view={view}
          draft={draft}
          onDraftChange={setDraft}
          onStart={handlers.onStart}
          onStop={handlers.onStop}
        />
      )}
    </PracticeShell>
  );
}
