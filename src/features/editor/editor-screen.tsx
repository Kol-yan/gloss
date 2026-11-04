"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { canApply, normalizeText } from "@/lib/text";
import { MAX_TEXT_LENGTH, type Expression, type Suggestion } from "@/shared/contracts";
import { unassistedMatches, type WritingRange } from "@/lib/expression-matches";
import { TryYourselfCard } from "@/features/practice/try-yourself-card";
import { offerFromSuggestion, type Familiarity, type PracticeOffer } from "@/features/practice/types";
import { CheckBar } from "./check-bar";
import { DictateButton } from "./dictate-button";
import { canUndo, createDoc, editorReducer, planSafeFixes, reportApplied } from "./editor-reducer";
import { InlinePopover } from "./inline-popover";
import { pickSuggestion, popoverReducer, sortedIndex, suggestionForCaret, type PopoverState } from "./popover-state";
import {
  SentenceDetector,
  locateSentence,
  offsetSuggestions,
  sentenceTextsIn,
  type DetectInput,
  type DetectSentences,
  type SentenceFlag,
} from "./sentence-detect";
import type { SentenceJobState } from "./sentence-flag-card";
import { SuggestionRail, type LearningStatus, type RailNotice } from "./suggestion-rail";
import { tabForSuggestion, type RailTab } from "./rail-state";
import { SamplePicker } from "./sample-picker";
import type { CheckLocal, CheckStatus, CheckWithAi, Dictate, ProofreadOutcome, RecheckSentences } from "./types";
import { WritingSurface, type WritingSurfaceHandle } from "./writing-surface";
import type { LocalCheckStatus } from "./local-checker";

type OfferState = { phase: "ask" | "saving" | "error" | "started"; offer: PracticeOffer };

export type EditorScreenProps = {
  expressions?: Expression[];
  learningListFailed?: boolean;
  learnWithAi?: (text: string) => Promise<{ ok: true; suggestions: Suggestion[] } | { ok: false; reason: "failed" | "quota" | "unavailable" }>;
  onIndependentWriting?: (text: string, assistedRanges: WritingRange[]) => Promise<boolean>;
  practiceHref?: string;
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
  // Stage 1. When given, sentences that changed are sent here after a typing
  // pause; the answers become badges. Without it the editor only has the button.
  detectSentences?: DetectSentences;
  // Overrides the typing pause (milliseconds); the default is for real use.
  detectPauseMs?: number;
  // Voice input: turns speech into text inserted at the caret. No button without it.
  dictate?: Dictate;
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
  detectSentences,
  detectPauseMs,
  expressions = [],
  learningListFailed = false,
  learnWithAi,
  onIndependentWriting,
  practiceHref = "/practice",
  dictate,
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
  const [sampleNotice, setSampleNotice] = useState("");
  const [offerState, setOfferState] = useState<OfferState | null>(null);
  const [activeFlagId, setActiveFlagId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, SentenceJobState>>({});
  const [activeTab, setActiveTab] = useState<RailTab>("checks");
  const [learningState, setLearningState] = useState<{ text: string; status: LearningStatus }>({ text: "", status: "idle" });
  const learningRequests = useRef(new Map<string, { status: LearningStatus; suggestions?: Suggestion[] }>());
  const independent = useMemo(() => {
    const found = unassistedMatches(doc.text, expressions, doc.assisted);
    return [...new Map(found.map((match) => [match.expression.id, match.expression])).values()];
  }, [doc.text, expressions, doc.assisted]);
  const recordedWriting = useRef(new Set<string>());
  const composingRef = useRef(false);
  useEffect(() => {
    if (!onIndependentWriting || independent.length === 0) return;
    const text = doc.text;
    const assisted = doc.assisted;
    const timer = setTimeout(() => {
      if (composingRef.current || recordedWriting.current.has(text)) return;
      recordedWriting.current.add(text);
      void onIndependentWriting(text, assisted).then((ok) => {
        if (!ok) recordedWriting.current.delete(text);
      }).catch(() => recordedWriting.current.delete(text));
    }, 800);
    return () => clearTimeout(timer);
  }, [doc.text, doc.assisted, independent, onIndependentWriting]);
  const [popover, setPopover] = useState<PopoverState>(null);
  // Bumped when the text scrolls or resizes, so the popover follows its word.
  const [layoutTick, setLayoutTick] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);
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

  // Latest values for callbacks that outlive a render (timers, finished requests).
  const docRef = useRef(doc);
  const checkWithAiRef = useRef(checkWithAi);
  const jobsRef = useRef(jobs);
  const detectInputRef = useRef<DetectInput>({ text: doc.text, localRanges: [], holdRanges: [] });
  useEffect(() => {
    docRef.current = doc;
    checkWithAiRef.current = checkWithAi;
    jobsRef.current = jobs;
  });

  // Stage 1: the detector looks at changed sentences after a typing pause.
  const [detector] = useState(() => new SentenceDetector({ pauseMs: detectPauseMs }));
  useEffect(() => {
    detector.setDetect(detectSentences);
  }, [detector, detectSentences]);
  // Leaving the page or switching learner ends the queue: sentences that were
  // not sent yet belong to a text nobody is looking at any more.
  useEffect(() => () => detector.stop(), [detector]);
  const detectVersion = useSyncExternalStore(detector.subscribe, detector.getVersion, detector.getVersion);
  const detectStatus = detector.getStatus();
  const detectEnabled = detectSentences !== undefined && aiAvailable;

  // Cloud suggestions that are still pending hold their sentence back from the
  // detector: the cards already say what is wrong there.
  const localRanges = useMemo(
    () => doc.suggestions.filter((s) => s.source === "local").map(({ start, end }) => ({ start, end })),
    [doc.suggestions],
  );
  const holdRanges = useMemo(
    () => doc.suggestions.filter((s) => s.source === "ai" && s.origin !== "learning").map(({ start, end }) => ({ start, end })),
    [doc.suggestions],
  );
  useEffect(() => {
    detectInputRef.current = { text: doc.text, localRanges, holdRanges };
  }, [doc.text, localRanges, holdRanges]);

  // The pause restarts with every keystroke. Declared before the applied-fix
  // effect below, so that an immediate re-check wins over the pause.
  useEffect(() => {
    if (!detectEnabled || doc.text === "") return;
    detector.schedule(() => detectInputRef.current);
    return () => detector.cancel();
  }, [detector, detectEnabled, doc.text]);

  const flags = useMemo(
    () => (detectEnabled ? detector.flagsFor(doc.text, holdRanges) : []),
    // detectVersion changes whenever the detector learns something new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detector, detectEnabled, detectVersion, doc.text, holdRanges],
  );

  // Cloud suggestions that vanished without a decision are reported once per batch.
  const onDecisionRef = useRef(onDecision);
  const reportedStale = useRef(doc.stale);
  const recheckRef = useRef(recheckSentences);
  useEffect(() => {
    onDecisionRef.current = onDecision;
    recheckRef.current = (ranges, text) => {
      recheckSentences?.(ranges, text);
      // Only the sentence the fix changed is unknown to the detector; everything
      // else comes from its cache. No pause: nothing is being typed. The changed
      // sentence is checked even if it still has other cloud suggestions waiting.
      if (detectEnabled) detector.flush(() => detectInputRef.current, sentenceTextsIn(text, ranges));
    };
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
    setPopover(null);
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

  // The inline popover shows one suggestion at the underlined word; a popover
  // whose suggestion is gone (edited, replaced, applied elsewhere) is not drawn.
  const popoverSuggestion = popover ? doc.suggestions.find((s) => s.id === popover.id) : undefined;
  const popoverId = popoverSuggestion ? popoverSuggestion.id : null;
  const popoverVia = popover ? popover.via : "pointer";
  const safeCount = useMemo(() => planSafeFixes(doc.text, doc.suggestions).length, [doc.text, doc.suggestions]);

  const getPopoverAnchor = () => {
    const container = containerRef.current;
    return popoverId && container ? (surfaceRef.current?.anchorOf(popoverId, container) ?? null) : null;
  };
  const revealPopoverWord = () => {
    if (popoverId) surfaceRef.current?.reveal(popoverId);
  };
  const bumpLayout = () => setLayoutTick((tick) => tick + 1);
  const lostPopover = () => setPopover(null);

  // A click anywhere else on the page puts the popover away; clicks in the text
  // are handled by the text itself (they may open another underline).
  useEffect(() => {
    if (!popoverId) return;
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest("[data-inline-popover], [data-writing-surface]")) return;
      setPopover(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [popoverId]);

  // After a fix from the popover the caret goes behind the new words, so typing
  // can go on where the learner was.
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    if (pendingCaret.current === null) return;
    surfaceRef.current?.focus(pendingCaret.current);
    pendingCaret.current = null;
  }, [doc.text]);

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
    composingRef.current = composing;
    // Normalizing mid-composition would fight the input method.
    dispatch({ type: "edit", text: composing ? raw : normalizeText(raw) });
    setPopover(null);
    setCheckedClean(false);
    setSampleNotice("");
  };

  const insertSample = (text: string) => {
    dispatch({ type: "replace", text: normalizeText(text) });
    setCheckedClean(false);
    setStatus("idle");
    setActiveId(null);
    setActiveFlagId(null);
    setPopover(null);
    setOfferState(null);
    setJobs({});
    setNotice(null);
    setSampleNotice("Sample added. Press Check with AI for suggestions.");
    surfaceRef.current?.focus();
  };

  // Dictated text goes in at the caret, or at the end, separated by spaces.
  const insertDictation = (spoken: string) => {
    const text = doc.text;
    const at = surfaceRef.current?.caret() ?? text.length;
    const before = text.slice(0, at);
    const after = text.slice(at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    const insert = lead + spoken.trim() + trail;
    const next = (before + insert + after).slice(0, MAX_TEXT_LENGTH);
    handleChange(next, false);
    const caret = Math.min(before.length + insert.length - trail.length, next.length);
    requestAnimationFrame(() => surfaceRef.current?.focus(caret));
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
    const offer = suggestion.origin === "learning" ? null : offerFromSuggestion(suggestion);
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

  // Fixes every safe error at once. One Undo puts them all back. Each fix is
  // reported as an accepted decision, like an Apply on its own card.
  const fixAllSafe = () => {
    const plan = planSafeFixes(doc.text, doc.suggestions);
    if (plan.length === 0) return;
    dispatch({ type: "applySafe" });
    setActiveId(null);
    setPopover(null);
    showNotice(`Fixed ${plan.length} ${plan.length === 1 ? "error" : "errors"}. Undo puts them back.`);
    for (const fix of plan) onDecision?.(fix, "accepted", doc.text);
  };

  const openPopoverFor = (ids: string[]) => {
    const picked = pickSuggestion(doc.suggestions.filter((s) => ids.includes(s.id)));
    setPopover(picked ? { id: picked.id, via: "pointer" } : null);
    if (picked) setActiveTab(tabForSuggestion(picked));
    // On a touch screen the keyboard would cover the sheet; tapping the text again brings it back.
    if (picked && window.matchMedia("(pointer: coarse)").matches) (document.activeElement as HTMLElement | null)?.blur();
  };

  // Where the keyboard goes after a decision: the next underline, or back to the text.
  const settlePopover = (next: PopoverState, caret: number | null) => {
    setPopover(next);
    if (!next && caret !== null) pendingCaret.current = caret;
  };

  const applyFromPopover = (id: string) => {
    const target = doc.suggestions.find((s) => s.id === id);
    if (!target) return;
    const next = popoverReducer(popover, { type: "decided", applied: true }, doc.suggestions);
    apply(id);
    settlePopover(next, canApply(doc.text, target) ? target.start + target.replacement.length : null);
  };

  const dismissFromPopover = (id: string) => {
    const target = doc.suggestions.find((s) => s.id === id);
    if (!target) return;
    const next = popoverReducer(popover, { type: "decided", applied: false }, doc.suggestions);
    dismiss(id);
    setPopover(next);
    // The text did not change, so the textarea takes the focus back right away.
    if (!next) surfaceRef.current?.focus(popover?.via === "keyboard" ? target.end : undefined);
  };

  const closePopover = (viaKeyboard: boolean) => {
    setPopover(null);
    surfaceRef.current?.focus(viaKeyboard && popoverSuggestion ? popoverSuggestion.end : undefined);
  };

  const stepPopover = (direction: 1 | -1) => setPopover((current) => popoverReducer(current, { type: "step", direction }, doc.suggestions));

  // Alt+Enter in the text opens the popover at the caret, or at the next
  // underline after it. Escape puts an open popover away.
  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && popoverId) {
      event.preventDefault();
      setPopover(null);
      return;
    }
    if (event.key !== "Enter" || !event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const target = suggestionForCaret(doc.suggestions, event.currentTarget.selectionStart);
    if (!target) {
      showNotice("Nothing to review yet.");
      return;
    }
    setPopover({ id: target.id, via: "keyboard" });
    setActiveTab(tabForSuggestion(target));
  };

  // Prefer the server's number; otherwise count down locally.
  const noteChecksUsed = useCallback(
    (reported: number | undefined) => {
      setReportedChecksLeft((current) => {
        if (reported !== undefined) return reported;
        const known = current ?? checksLeftProp;
        return known === null ? null : Math.max(0, known - 1);
      });
    },
    [checksLeftProp],
  );

  const setJob = useCallback((id: string, state: SentenceJobState | null) => {
    const updated = { ...jobsRef.current };
    if (state === null) delete updated[id];
    else updated[id] = state;
    jobsRef.current = updated;
    setJobs((current) => {
      const next = { ...current };
      if (state === null) delete next[id];
      else next[id] = state;
      return next;
    });
  }, []);

  // Stage 2: the generator. One whole-sentence check; the existing diff turns it
  // into suggestions that are placed back into the document.
  const reviewSentence = useCallback(
    async (flag: SentenceFlag) => {
      const check = checkWithAiRef.current;
      if (jobsRef.current[flag.id] === "analyzing") return;
      if (!check) {
        setJob(flag.id, "unavailable");
        return;
      }
      if (checksLeft !== null && checksLeft <= 0) {
        setJob(flag.id, "quota");
        return;
      }
      setJob(flag.id, "analyzing");
      let outcome: ProofreadOutcome;
      try {
        outcome = await check(flag.text);
      } catch {
        outcome = { ok: false, reason: "failed" };
      }
      if (!outcome.ok) {
        setJob(flag.id, outcome.reason);
        return;
      }
      setJob(flag.id, null);
      noteChecksUsed(outcome.checksLeft);
      // Whatever came back, this sentence has been looked at.
      detector.markHandled(flag.id);

      const where = locateSentence(docRef.current.text, flag.text, flag.start);
      if (!where) {
        showNotice("That sentence changed while we were looking at it.");
        return;
      }
      const placed = offsetSuggestions(outcome.suggestions, where.start);
      dispatch({ type: "receiveSentence", sentenceText: flag.text, start: where.start, end: where.end, suggestions: placed });
      if (placed.length === 0) {
        showNotice("Nothing to change in that sentence.");
        return;
      }
    },
    [checksLeft, detector, noteChecksUsed, setJob, showNotice],
  );

  const dismissFlag = (id: string) => {
    detector.markHandled(id);
    setActiveFlagId(null);
    setJob(id, null);
    showNotice("Dismissed.");
  };

  // Opening AI is the generator action. One request at a time; closing the
  // phone sheet stops the unsent queue, and failed sentences need an explicit retry.
  const reviewedFlags = useRef(new Set<string>());
  useEffect(() => {
    if (activeTab !== "ai" || !checkWithAi || !aiAvailable || status === "pending") return;
    if (railRef.current && getComputedStyle(railRef.current).display === "none") return;
    if (Object.values(jobs).includes("analyzing")) return;
    const next = flags.find((flag) => !reviewedFlags.current.has(flag.id));
    if (!next) return;
    reviewedFlags.current.add(next.id);
    void reviewSentence(next);
  }, [activeTab, sheetOpen, checkWithAi, aiAvailable, flags, jobs, status, reviewSentence]);

  const runLearning = async (retry = false) => {
    const text = docRef.current.text;
    if (!text.trim()) return;
    const cached = learningRequests.current.get(text);
    if (cached && (!retry || cached.status === "pending")) {
      setLearningState({ text, status: cached.status });
      if (cached.suggestions) dispatch({ type: "receiveLearning", forText: text, suggestions: cached.suggestions });
      return;
    }
    if (!learnWithAi || !aiAvailable) {
      setLearningState({ text, status: "unavailable" });
      return;
    }
    learningRequests.current.set(text, { status: "pending" });
    setLearningState({ text, status: "pending" });
    try {
      const result = await learnWithAi(text);
      const status = result.ok ? "ready" : result.reason;
      learningRequests.current.set(text, { status, ...(result.ok ? { suggestions: result.suggestions } : {}) });
      setLearningState((current) => current.text === text ? { text, status } : current);
      if (result.ok && docRef.current.text === text) dispatch({ type: "receiveLearning", forText: text, suggestions: result.suggestions });
    } catch {
      learningRequests.current.set(text, { status: "failed" });
      setLearningState((current) => current.text === text ? { text, status: "failed" } : current);
    }
  };

  const selectTab = (tab: RailTab) => {
    setActiveTab(tab);
    if (tab === "learning") void runLearning();
  };

  const runCheck = async () => {
    if (!checkWithAi || status === "pending") return;
    const text = normalizeText(doc.text);
    if (text.trim() === "") return;
    if (text !== doc.text) dispatch({ type: "edit", text });
    setStatus("pending");
    setActiveTab("ai");
    let outcome: ProofreadOutcome;
    try {
      outcome = await checkWithAi(text);
    } catch {
      outcome = { ok: false, reason: "failed" };
    }
    if (outcome.ok) {
      dispatch({ type: "receive", source: "ai", forText: text, suggestions: outcome.suggestions });
      setStatus("idle");
      setCheckedClean(outcome.suggestions.length === 0);
      noteChecksUsed(outcome.checksLeft);
      // The whole text was just looked at; sentence badges for it would repeat that.
      for (const flag of detector.flagsFor(text)) detector.markHandled(flag.id);
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
        saveOnly
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
    <div ref={containerRef} className="@container relative mx-auto h-full w-full max-w-6xl">
      <h1 className="sr-only">Editor</h1>
      <div className="grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)_auto] @3xl:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="flex min-h-0 flex-col px-4 pt-3 pb-3 @3xl:pr-3">
          <div className="flex shrink-0 items-center justify-between gap-3 pb-2">
            <p role="status" aria-live="polite" className={sampleNotice ? "text-sm text-ink-muted" : "sr-only"}>
              {sampleNotice}
            </p>
            <div className="flex items-start gap-2">
              {dictate ? <DictateButton dictate={dictate} disabled={!aiAvailable} onText={insertDictation} /> : null}
              <SamplePicker onSelect={insertSample} hasText={hasContent} />
            </div>
          </div>
          <WritingSurface
            value={doc.text}
            suggestions={doc.suggestions}
            activeId={popoverId ?? activeId}
            activeFlagId={activeFlagId}
            onChange={handleChange}
            onTextClick={openPopoverFor}
            onEditorKeyDown={handleEditorKeyDown}
            onLayoutChange={popoverId ? bumpLayout : undefined}
            handleRef={surfaceRef}
            nearLimit={doc.text.length >= MAX_TEXT_LENGTH * 0.8}
          />
        </div>

        <div className="col-start-1 row-start-2">
          {popoverSuggestion ? (
            <InlinePopover
              suggestion={popoverSuggestion}
              text={doc.text}
              index={sortedIndex(doc.suggestions, popoverSuggestion.id)}
              count={doc.suggestions.length}
              via={popoverVia}
              getAnchor={getPopoverAnchor}
              reveal={revealPopoverWord}
              layoutKey={layoutTick}
              onApply={applyFromPopover}
              onDismiss={dismissFromPopover}
              onStep={stepPopover}
              onClose={closePopover}
              onLost={lostPopover}
            />
          ) : null}
          <CheckBar
            status={effectiveStatus}
            checksLeft={checksLeft}
            textIsEmpty={textIsEmpty}
            length={doc.text.length}
            suggestionCount={doc.suggestions.length + flags.length + independent.length}
            detectStatus={detectEnabled ? detectStatus : "idle"}
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
            activeTab={activeTab}
            onTabChange={selectTab}
            learningExpressions={independent}
            learningStatus={learningState.text === doc.text ? learningState.status : "idle"}
            learningListFailed={learningListFailed}
            onRetryLearning={() => void runLearning(true)}
            onRetryAi={() => {
              for (const flag of flags) {
                if (jobs[flag.id] === "failed") {
                  reviewedFlags.current.delete(flag.id);
                  setJob(flag.id, null);
                }
              }
            }}
            practiceHref={practiceHref}
            suggestions={doc.suggestions}
            flags={flags}
            jobs={jobs}
            activeFlagId={activeFlagId}
            autoDetect={detectEnabled}
            text={doc.text}
            activeId={activeId}
            canUndo={undoAvailable}
            safeCount={safeCount}
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
            onActivateFlag={setActiveFlagId}
            onDeactivateFlag={(id) => setActiveFlagId((current) => (current === id ? null : current))}
            onDismissFlag={dismissFlag}
            onFixAll={fixAllSafe}
            onUndo={undo}
            onClose={sheetOpen ? closeSheet : undefined}
          />
        </aside>
      </div>
    </div>
  );
}
