"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { EditorScreen } from "@/features/editor/editor-screen";
import { SAMPLE_SUGGESTIONS, SAMPLE_TEXT, sampleCheckWithAi } from "@/features/editor/fixtures";
import type { CheckStatus } from "@/features/editor/types";
import { ExpressionsScreen } from "@/features/expressions/expressions-screen";
import { SAMPLE_HISTORY } from "@/features/expressions/fixtures";
import {
  SAMPLE_ANSWER,
  SAMPLE_EVALUATIONS,
  SAMPLE_HIDDEN_TASK,
  SAMPLE_VOICE_TASK,
  SAMPLE_WRITTEN_TASK,
  sampleSubmit,
} from "@/features/practice/fixtures";
import { TryYourselfCard } from "@/features/practice/try-yourself-card";
import type { Familiarity, PracticeOffer, Verdict } from "@/features/practice/types";
import { WrittenPractice } from "@/features/practice/written-practice";
import { SAMPLE_VOICE_VIEWS } from "@/features/speech/fixtures";
import type { TranscribeResult } from "@/features/speech/types";
import { VoicePractice } from "@/features/speech/voice-practice";
import { VoiceTaskView, type VoiceHandlers } from "@/features/speech/voice-view";

const TABS = [
  { id: "empty", label: "Empty editor" },
  { id: "editor", label: "Editor with suggestions" },
  { id: "try", label: "Try it yourself" },
  { id: "written", label: "Written feedback" },
  { id: "speech", label: "Speech states" },
  { id: "history", label: "My expressions" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const OFFER: PracticeOffer = {
  suggestionId: "sample-ai-2",
  expression: "push back",
  meaning: "To move something to a later time.",
};

function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-sm font-semibold">{label}:</span>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={
            "min-h-8 rounded-full border px-3 text-sm font-medium transition-colors duration-150 " +
            (value === option.id
              ? "border-accent bg-accent-soft text-accent-strong"
              : "border-line-strong bg-card text-ink hover:bg-accent-soft")
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const CHECK_STATES: ReadonlyArray<{ id: CheckStatus; label: string }> = [
  { id: "idle", label: "Ready" },
  { id: "pending", label: "Checking" },
  { id: "failed", label: "Check failed" },
  { id: "quota", label: "No checks left" },
  { id: "unavailable", label: "AI unavailable" },
];

function EditorDemo({ phone }: { phone: boolean }) {
  const [status, setStatus] = useState<CheckStatus>("idle");
  const [rechecked, setRechecked] = useState<string | null>(null);
  return (
    <>
      <Chips label="Check button" options={CHECK_STATES} value={status} onChange={setStatus} />
      <p role="status" data-testid="recheck-log" className="text-sm text-ink-muted">
        {rechecked ?? "Applying an AI suggestion reports the sentences it changed here."}
      </p>
      <p className="text-sm text-ink-muted">
        Press Apply on the &quot;push the meeting back&quot; card to see the Try it yourself card. Hover or focus a card to
        highlight its words.
      </p>
      <Stage phone={phone}>
        <EditorScreen
          key={status}
          initialText={SAMPLE_TEXT}
          initialSuggestions={SAMPLE_SUGGESTIONS}
          checksLeft={status === "quota" ? 0 : 7}
          initialCheckStatus={status}
          checkWithAi={status === "unavailable" ? undefined : sampleCheckWithAi}
          recheckSentences={(ranges, text) =>
            setRechecked(`Re-check requested: ${ranges.map((r) => `"${text.slice(r.start, r.end)}"`).join(", ")}`)
          }
          onStartPractice={async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
            return true;
          }}
        />
      </Stage>
    </>
  );
}

type WrittenState = "answering" | "hidden" | Verdict;

const WRITTEN_STATES: ReadonlyArray<{ id: WrittenState; label: string }> = [
  { id: "answering", label: "Answering" },
  { id: "hidden", label: "Answering (expression hidden)" },
  { id: "used_well", label: "Used well" },
  { id: "almost", label: "Almost" },
  { id: "not_yet", label: "Not yet" },
  { id: "unavailable", label: "Couldn't check" },
];

function WrittenDemo({ phone }: { phone: boolean }) {
  const [state, setState] = useState<WrittenState>("almost");
  const verdict = state === "answering" || state === "hidden" ? null : state;
  return (
    <>
      <Chips label="State" options={WRITTEN_STATES} value={state} onChange={setState} />
      <Stage phone={phone}>
        <WrittenPractice
          key={state}
          task={state === "hidden" ? SAMPLE_HIDDEN_TASK : SAMPLE_WRITTEN_TASK}
          submit={sampleSubmit}
          initial={verdict ? { answer: SAMPLE_ANSWER, evaluation: SAMPLE_EVALUATIONS[verdict] } : undefined}
          onContinue={() => setState("answering")}
        />
      </Stage>
    </>
  );
}

const LIVE_ID = "live";

// Stands in for speech-to-text so the real recording flow can be tried with a microphone.
async function sampleTranscribe(): Promise<TranscribeResult> {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { ok: true, text: SAMPLE_ANSWER };
}

function SpeechDemo({ phone }: { phone: boolean }) {
  const [id, setId] = useState<string>("recording");
  const [last, setLast] = useState("");
  const options = [...SAMPLE_VOICE_VIEWS.map((v) => ({ id: v.id, label: v.label })), { id: LIVE_ID, label: "Live (uses your microphone)" }];
  const selected = SAMPLE_VOICE_VIEWS.find((v) => v.id === id);

  const handlers: VoiceHandlers = {
    onStart: () => setLast("Start"),
    onStop: () => setLast("Stop"),
    onCancel: () => setLast("Cancel"),
    onConfirm: () => setLast("Confirm"),
    onRecordAgain: () => setLast("Record again"),
    onTypeInstead: () => setLast("Type instead"),
    onCheckAgain: () => setLast("Try again (check)"),
    onShowHint: () => setLast("Need a hint?"),
    onContinue: () => setLast("Continue"),
    onSkip: () => setLast("Skip"),
  };

  return (
    <>
      <Chips label="State" options={options} value={id} onChange={(next) => { setId(next); setLast(""); }} />
      <p className="text-sm text-ink-muted" aria-live="polite">
        {selected
          ? `Static state. ${last ? `Last button pressed: ${last}.` : "Buttons only report here."}`
          : "Real recording flow with a made-up transcript. Your browser will ask for the microphone."}
      </p>
      <Stage phone={phone}>
        {selected ? (
          <VoiceTaskView task={SAMPLE_VOICE_TASK} view={selected.view} hintShown={false} {...handlers} />
        ) : (
          <VoicePractice
            task={SAMPLE_VOICE_TASK}
            transcribe={sampleTranscribe}
            submit={sampleSubmit}
            onContinue={() => setId("idle")}
          />
        )}
      </Stage>
    </>
  );
}

function TryDemo() {
  const [result, setResult] = useState("");
  return (
    <>
      <div className="w-full max-w-sm">
        <TryYourselfCard
          key={result}
          offer={OFFER}
          onStart={(familiarity: Familiarity) => setResult(`Start practice pressed with "${familiarity}".`)}
          onSkip={() => setResult("Skip pressed.")}
        />
      </div>
      <p className="text-sm text-ink-muted" aria-live="polite">
        {result || "Buttons report here."}
      </p>
    </>
  );
}

// A fixed-size viewport for one screen. The screens size themselves from their
// container, so the 375px toggle shows the real phone layout on a desktop window.
function Stage({ phone, children, scroll = false }: { phone: boolean; children: ReactNode; scroll?: boolean }) {
  return (
    <div
      className={
        "mx-auto h-[40rem] rounded-card border border-line-strong bg-paper " +
        (scroll ? "overflow-y-auto " : "overflow-hidden ") +
        (phone ? "w-[375px] max-w-full" : "w-full")
      }
    >
      {children}
    </div>
  );
}

export function StatesGallery() {
  const [tab, setTab] = useState<TabId>("empty");
  const [phone, setPhone] = useState(false);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4">
      <div>
        <p className="eyebrow">Development only</p>
        <h1 className="text-2xl font-semibold tracking-tight">UI states</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Sample data for design review. It is not model output and the real pages never show it. This route returns a
          404 in production.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="States" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls="states-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKeyDown}
              className={
                "min-h-9 rounded-full px-4 text-sm font-semibold transition-colors duration-150 " +
                (tab === t.id ? "bg-accent text-on-accent" : "border border-line-strong bg-card hover:bg-accent-soft")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={phone}
          onClick={() => setPhone((value) => !value)}
          className={
            "min-h-9 rounded-full border px-4 text-sm font-semibold transition-colors duration-150 " +
            (phone ? "border-accent bg-accent-soft text-accent-strong" : "border-line-strong bg-card hover:bg-accent-soft")
          }
        >
          Phone width (375px)
        </button>
      </div>

      <div id="states-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="flex flex-col gap-2">
        {tab === "empty" ? (
          <>
            <p className="text-sm text-ink-muted">What the real editor page shows right now.</p>
            <Stage phone={phone}>
              <EditorScreen />
            </Stage>
          </>
        ) : tab === "editor" ? (
          <EditorDemo phone={phone} />
        ) : tab === "try" ? (
          <TryDemo />
        ) : tab === "written" ? (
          <WrittenDemo phone={phone} />
        ) : tab === "speech" ? (
          <SpeechDemo phone={phone} />
        ) : (
          <Stage phone={phone} scroll>
            <ExpressionsScreen items={SAMPLE_HISTORY} />
          </Stage>
        )}
      </div>
    </div>
  );
}
