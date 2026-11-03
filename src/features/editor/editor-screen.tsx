"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { canApply, normalizeText } from "@/lib/text";
import { MAX_TEXT_LENGTH, type Suggestion } from "@/shared/contracts";
import { TryYourselfCard } from "@/features/practice/try-yourself-card";
import { offerFromSuggestion, type Familiarity, type PracticeOffer } from "@/features/practice/types";
import { CheckBar } from "./check-bar";
import { canUndo, createDoc, editorReducer, reportApplied } from "./editor-reducer";
import { SuggestionRail, type RailNotice } from "./suggestion-rail";
import type { CheckLocal, CheckStatus, CheckWithAi, ProofreadOutcome, RecheckSentences } from "./types";
import { WritingSurface, type WritingSurfaceHandle } from "./writing-surface";
import type { LocalCheckStatus } from "./local-checker";

type OfferState = { phase: "ask" | "saving" | "error" | "started"; offer: PracticeOffer };

export type EditorScreenProps = {
  initialText?: string;
  // Must be ranges into initialText; anything that does not fit is dropped.
  initialSuggestions?: Suggestion[];
  // Checks left today; null when unknown. A number reported by a check wins over this.
  checksLeft?: number | null;
  // False when the server says cloud checking is off today. Local checks still work.
  aiAvailable?: boolean;
  initialCheckStatus?: CheckStatus;
  // Cloud check. When missing, the check button reports that AI checking is unavailable.
  checkWithAi?: CheckWithAi;
  // In-browser rule checker. Runs shortly after the learner stops typing.
  checkLocal?: CheckLocal;
  localCheckStatus?: LocalCheckStatus;
  // Adds the expression to the learner's practice list. Resolves true when it was saved.
  // Without it the card simply confirms (used by the gallery).
  onStartPractice?: (offer: PracticeOffer, familiarity: Familiarity) => Promise<boolean>;
  // Called for every decision on a suggestion, with the text the learner was looking at.
  // "stale" means a cloud suggestion disappeared without the learner deciding.
  onDecision?: (suggestion: Suggestion, decision: "accepted" | "rejected" | "stale", text: string) => void;
  // Called once after the learner applies a cloud suggestion, with the sentences
  // of the new text that changed (ranges into that text) and the text itself.
  recheckSentences?: RecheckSentences;
};

export function EditorScreen({
  initialText = "",
  initialSuggestions = [],
  checksLeft: checksLeftProp = null,
  aiAvailable = true,
  initialCheckStatus = "idle",
  checkWithAi,
  checkLocal,
  localCheckStatus,
  onStartPractice,
  onDecision,
  recheckSentences,
}: EditorScreenProps) {
  const [doc, dispatch] = useReducer(editorReducer, undefined, () => createDoc(initialText, initialSuggestions));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<CheckStatus>(initialCheckStatus);
  // Set by a finished check; until then the number from the page is used.
  const [reportedChecksLeft, setReportedChecksLeft] = useState<number | null>(null);
  const checksLeft = reportedChecksLeft ?? checksLeftProp;
  const [checkedClean, setCheckedClean] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [notice, setNotice] = useState<RailNotice | null>(null);
  const [offerState, setOfferState] = useState<OfferState | null>(null);

  const surfaceRef = useRef<WritingSurfaceHandle>(null);
  const railRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const noticeCounter = useRef(0);

  const showNotice = useCallback((text: string) => {
    noticeCounter.current += 1;
    setNotice({ id: noticeCounter.current, text });
  }, []);

  // Status messages clear themselves.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Cloud suggestions that vanished without a decision are reported once per batch.
  const onDecisionRef = useRef(onDecision);
  const reportedStale = useRef(doc.stale);
  const recheckRef = useRef(recheckSentences);
  useEffect(() => {
    onDecisionRef.current = onDecision;
    recheckRef.current = recheckSentences;
  });
  useEffect(() => {
    if (reportedStale.current === doc.stale) return;
    reportedStale.current = doc.stale;
    for (const suggestion of doc.stale.items) onDecisionRef.current?.(suggestion, "stale", doc.stale.text);
  }, [doc.stale]);

  // A cloud suggestion that was just applied is passed on once, so the sentences
  // it changed can be checked again.
  const reportedApplied = useRef(doc.applied);
  useEffect(() => {
    reportedApplied.current = reportApplied(reportedApplied.current, doc.applied, recheckRef.current);
  }, [doc.applied]);

  // Local checks run shortly after typing stops. They are best effort: a
  // failing local checker must never get in the way of writing.
  useEffect(() => {
    if (!checkLocal || doc.text === "") return;
    const forText = doc.text;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await checkLocal(forText);
        if (!cancelled) dispatch({ type: "receive", source: "local", forText, suggestions: found });
      } catch {
        // Intentionally ignored, see above.
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkLocal, doc.text]);

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
    showNotice("Undone.");
  }, [showNotice]);

  // Cmd/Ctrl+Z undoes the last applied suggestion while focus is outside a text field.
  // Inside the textarea the browser's own undo keeps handling typing.
  const undoAvailable = canUndo(doc);
  useEffect(() => {
    if (!undoAvailable) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      event.preventDefault();
      undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undoAvailable, undo]);

  // Move focus into the sheet when it opens.
  useEffect(() => {
    if (!sheetOpen) return;
    railRef.current?.querySelector<HTMLElement>('button[aria-label="Close suggestions"]')?.focus();
  }, [sheetOpen]);

  const openSheet = () => {
    openerRef.current = document.activeElement as HTMLElement | null;
    setSheetOpen(true);
  };
  const closeSheet = () => {
    setSheetOpen(false);
    openerRef.current?.focus();
  };

  const handleChange = (raw: string, composing: boolean) => {
    // Normalizing mid-composition would fight the input method.
    dispatch({ type: "edit", text: composing ? raw : normalizeText(raw) });
    setCheckedClean(false);
  };

  const apply = (id: string) => {
    const suggestion = doc.suggestions.find((s) => s.id === id);
    if (!suggestion) return;
    const applicable = canApply(doc.text, suggestion);
    dispatch({ type: "apply", id });
    setActiveId(null);
    if (!applicable) return;
    showNotice(suggestion.replacement ? `Applied: ${suggestion.replacement}` : "Applied: removed");
    onDecision?.(suggestion, "accepted", doc.text);
    const offer = offerFromSuggestion(suggestion);
    if (offer) setOfferState({ phase: "ask", offer });
    if (sheetOpen && doc.suggestions.length <= 1 && !offer && !offerState) closeSheet();
  };

  const dismiss = (id: string) => {
    const suggestion = doc.suggestions.find((s) => s.id === id);
    dispatch({ type: "dismiss", id });
    setActiveId(null);
    if (suggestion) {
      showNotice("Dismissed.");
      onDecision?.(suggestion, "rejected", doc.text);
    }
    if (sheetOpen && doc.suggestions.length <= 1 && !offerState) closeSheet();
  };

  const runCheck = async () => {
    if (!checkWithAi || status === "pending") return;
    const text = normalizeText(doc.text);
    if (text.trim() === "") return;
    if (text !== doc.text) dispatch({ type: "edit", text });
    setStatus("pending");
    let outcome: ProofreadOutcome;
    try {
      outcome = await checkWithAi(text);
    } catch {
      outcome = { ok: false, reason: "failed" };
    }
    if (outcome.ok) {
      const reported = outcome.checksLeft;
      dispatch({ type: "receive", source: "ai", forText: text, suggestions: outcome.suggestions });
      setStatus("idle");
      setCheckedClean(outcome.suggestions.length === 0);
      // Prefer the server's number; otherwise count down locally.
      setReportedChecksLeft((current) => {
        if (reported !== undefined) return reported;
        const known = current ?? checksLeftProp;
        return known === null ? null : Math.max(0, known - 1);
      });
    } else {
      setStatus(outcome.reason === "quota" ? "quota" : outcome.reason === "unavailable" ? "unavailable" : "failed");
    }
  };

  const onSheetKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && sheetOpen) {
      event.stopPropagation();
      closeSheet();
    }
  };

  // Without a cloud checker wired in, the button explains instead of pretending.
  let effectiveStatus: CheckStatus = checkWithAi && aiAvailable ? status : "unavailable";
  if (effectiveStatus === "idle" && checksLeft !== null && checksLeft <= 0) effectiveStatus = "quota";

  const textIsEmpty = doc.text.trim() === "";
  const hasContent = doc.text !== "";

  const startPractice = async (offer: PracticeOffer, familiarity: Familiarity) => {
    setOfferState({ phase: "saving", offer });
    let saved = true;
    if (onStartPractice) {
      try {
        saved = await onStartPractice(offer, familiarity);
      } catch {
        saved = false;
      }
    }
    setOfferState({ phase: saved ? "started" : "error", offer });
  };

  const offerSlot = offerState ? (
    offerState.phase !== "started" ? (
      <TryYourselfCard
        offer={offerState.offer}
        status={offerState.phase === "saving" ? "saving" : offerState.phase === "error" ? "error" : "idle"}
        onStart={(familiarity) => void startPractice(offerState.offer, familiarity)}
        onSkip={() => {
          setOfferState(null);
          showNotice("Skipped.");
        }}
      />
    ) : (
      <section aria-label="Practice ready" className="rounded-tile border border-success/40 bg-success-soft p-3 text-sm text-success">
        <p className="font-semibold">Added to your practice list.</p>
        <p className="mt-1">
          <Link href="/practice" className="font-semibold underline underline-offset-2">
            Go to practice
          </Link>
          <button
            type="button"
            onClick={() => setOfferState(null)}
            className="ml-3 font-medium underline underline-offset-2"
          >
            Hide
          </button>
        </p>
      </section>
    )
  ) : null;

  return (
    <div className="@container relative mx-auto h-full w-full max-w-6xl">
      <h1 className="sr-only">Editor</h1>
      <div className="grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)_auto] @3xl:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="flex min-h-0 flex-col px-4 pt-3 pb-3 @3xl:pr-3">
          <WritingSurface
            value={doc.text}
            suggestions={doc.suggestions}
            activeId={activeId}
            onChange={handleChange}
            handleRef={surfaceRef}
            nearLimit={doc.text.length >= MAX_TEXT_LENGTH * 0.8}
          />
        </div>

        <div className="col-start-1 row-start-2">
          <CheckBar
            status={effectiveStatus}
            checksLeft={checksLeft}
            textIsEmpty={textIsEmpty}
            length={doc.text.length}
            suggestionCount={doc.suggestions.length}
            onCheck={runCheck}
            onOpenSheet={openSheet}
            localCheckStatus={localCheckStatus}
          />
        </div>

        {sheetOpen ? (
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeSheet}
            className="absolute inset-0 z-20 bg-ink/40 @3xl:hidden"
          />
        ) : null}

        <aside
          ref={railRef}
          aria-label="Suggestions"
          onKeyDown={onSheetKeyDown}
          className={
            "min-h-0 flex-col bg-card @3xl:static @3xl:z-auto @3xl:row-span-2 @3xl:row-start-1 @3xl:col-start-2 @3xl:flex @3xl:max-h-none @3xl:rounded-none @3xl:border-0 @3xl:border-l @3xl:border-line @3xl:bg-surface/70 @3xl:shadow-none " +
            (sheetOpen
              ? "absolute inset-x-0 bottom-0 z-30 flex max-h-[65%] rounded-t-card border border-b-0 border-line shadow-lift"
              : "hidden")
          }
        >
          <SuggestionRail
            suggestions={doc.suggestions}
            text={doc.text}
            activeId={activeId}
            canUndo={undoAvailable}
            notice={notice}
            textIsEmpty={!hasContent}
            checkedClean={checkedClean}
            slot={offerSlot}
            slotKey={offerState ? `${offerState.offer.suggestionId}:${offerState.phase}` : undefined}
            onActivate={setActiveId}
            onDeactivate={(id) => setActiveId((current) => (current === id ? null : current))}
            onFocusCard={(id) => surfaceRef.current?.reveal(id)}
            onApply={apply}
            onDismiss={dismiss}
            onUndo={undo}
            onClose={sheetOpen ? closeSheet : undefined}
          />
        </aside>
      </div>
    </div>
  );
}
