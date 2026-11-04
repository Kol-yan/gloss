"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CloseIcon, UndoIcon } from "@/components/ui/icons";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import type { Expression, Suggestion } from "@/shared/contracts";
import type { SentenceFlag } from "./sentence-detect";
import { SentenceFlagCard, type SentenceJobState } from "./sentence-flag-card";
import { SuggestionCard } from "./suggestion-card";
import { nextRailTab, RAIL_LABEL, RAIL_TABS, railIndicators, tabForSuggestion, type RailTab } from "./rail-state";

export type RailNotice = { id: number; text: string };
export type FocusRequest = { id: string; n: number };
export type LearningStatus = "idle" | "pending" | "ready" | "failed" | "quota" | "unavailable";

// Hosts own tab state and supply data, callbacks and the website practice URL.
// This panel knows no session, router, network or editor implementation.
export function SuggestionRail({
  suggestions, flags = [], jobs = {}, activeFlagId = null, autoDetect = false,
  activeTab = "checks", onTabChange = () => {},
  learningExpressions = [], learningStatus = "idle", learningListFailed = false,
  onRetryLearning, practiceHref = "/practice", onRetryAi,
  focusRequest = null, text, activeId, canUndo, safeCount = 0,
  notice, textIsEmpty, checkedClean, slot, slotKey,
  onActivate, onDeactivate, onFocusCard, onApply, onDismiss,
  onActivateFlag = () => {}, onDeactivateFlag = () => {}, onDismissFlag = () => {},
  onFixAll = () => {}, onUndo, onClose,
}: {
  suggestions: Suggestion[];
  flags?: SentenceFlag[];
  jobs?: Record<string, SentenceJobState>;
  activeFlagId?: string | null;
  autoDetect?: boolean;
  activeTab?: RailTab;
  onTabChange?: (tab: RailTab) => void;
  learningExpressions?: Expression[];
  learningStatus?: LearningStatus;
  learningListFailed?: boolean;
  onRetryLearning?: () => void;
  onRetryAi?: () => void;
  practiceHref?: string;
  focusRequest?: FocusRequest | null;
  text: string;
  activeId: string | null;
  canUndo: boolean;
  safeCount?: number;
  notice: RailNotice | null;
  textIsEmpty: boolean;
  checkedClean: boolean;
  slot?: ReactNode;
  slotKey?: string;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onFocusCard: (id: string) => void;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  onActivateFlag?: (id: string) => void;
  onDeactivateFlag?: (id: string) => void;
  onDismissFlag?: (id: string) => void;
  onFixAll?: () => void;
  onUndo: () => void;
  onClose?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const counts = railIndicators(suggestions, flags.length, learningExpressions.length + (slot ? 1 : 0));
  const visible = suggestions.filter((suggestion) => tabForSuggestion(suggestion) === activeTab);
  const aiBusy = Object.values(jobs).includes("analyzing");
  const busy = activeTab === "learning" ? learningStatus === "pending" : activeTab === "ai" && aiBusy;

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [activeTab, slotKey]);
  useEffect(() => {
    if (!focusRequest) return;
    const card = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-suggestion-id]") ?? [])
      .find((el) => el.dataset.suggestionId === focusRequest.id);
    card?.querySelector<HTMLElement>("button")?.focus();
  }, [focusRequest, activeTab]);

  const empty = textIsEmpty ? "Write something to see suggestions." : activeTab === "checks"
    ? "No spelling or grammar suggestions on this device."
    : activeTab === "learning" ? "Nothing from your list fits here right now."
      : checkedClean ? "Nothing to change. Your text looks good."
        : autoDetect ? "No AI suggestions to review. The tab lights up when you pause typing."
          : "No suggestions yet. Press Check with AI for a closer look.";

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-suggestion-panel>
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="eyebrow">Suggestions</h2>
        <div className="flex items-center gap-1">
          {canUndo ? <Button size="sm" variant="secondary" onClick={onUndo}><UndoIcon size={14} />Undo</Button> : null}
          {onClose ? <Button size="sm" variant="quiet" onClick={onClose} aria-label="Close suggestions"><CloseIcon size={14} />Close</Button> : null}
        </div>
      </div>
      <div ref={tabsRef} role="tablist" aria-label="Suggestion types" className="mx-3 mb-3 grid shrink-0 grid-cols-3 border-b border-line">
        {RAIL_TABS.map((tab) => {
          const tabBusy = tab === "ai" ? aiBusy : tab === "learning" && learningStatus === "pending";
          return (
            <button key={tab} id={`${panelId}-${tab}`} role="tab" type="button"
              aria-selected={activeTab === tab} aria-controls={`${panelId}-panel`}
              tabIndex={activeTab === tab ? 0 : -1}
              onClick={() => onTabChange(tab)}
              onKeyDown={(event) => {
                if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = nextRailTab(tab, event.key);
                onTabChange(next);
                tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
              }}
              data-tab={tab}
              className={`flex min-h-11 items-center justify-center gap-1.5 border-b-2 px-1 text-sm font-semibold transition-colors ${activeTab === tab ? "border-accent text-accent-strong" : "border-transparent text-ink-muted hover:text-ink"}`}>
              {RAIL_LABEL[tab]}
              {counts[tab] > 0 || tabBusy ? (
                <span className="inline-flex items-center gap-1 text-xs tabular-nums" data-tab-indicator={tab}>
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full bg-accent ${tabBusy ? "motion-safe:animate-pulse" : ""}`} />
                  <span aria-label={`${counts[tab]} ${tab === "ai" ? "sentences or suggestions" : "suggestions"}`}>{counts[tab] || ""}</span>
                  {tabBusy ? <span className="sr-only">Analyzing</span> : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {safeCount >= 2 && activeTab !== "learning" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2">
          <Button size="sm" variant="soft" onClick={onFixAll}>Fix all safe errors ({safeCount})</Button>
          <p className="text-xs leading-snug text-ink-muted">Skips changes to numbers, names and negation.</p>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className={notice ? "px-3 pb-2 text-sm font-semibold text-success" : "sr-only"}>{notice?.text ?? ""}</p>
      <div ref={scrollRef} id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${activeTab}`} tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {visible.length ? <p className="mb-2 hidden text-xs leading-snug text-ink-muted @3xl:block">Click an underline, or press Alt+Enter in the text, to review it where it is.</p> : null}
        {activeTab === "learning" ? (
          <>
            {learningExpressions.map((expression) => (
              <section key={expression.id} className="mb-3 border-b border-line pb-3" aria-label="Independent use">
                <p className="text-sm leading-snug">You used one of your words: <strong>{expression.text}</strong></p>
                <VocabularyPronunciation text={expression.text} ipa={expression.ipa} />
                <p className="mt-1 text-sm text-ink-muted">{expression.meaning}</p>
              </section>
            ))}
            {slot ? <div className="mb-3">{slot}</div> : null}
            {learningListFailed ? <p role="alert" className="mb-2 text-sm text-caution">We couldn&apos;t load your expressions.</p> : null}
            {learningStatus === "pending" ? <p role="status" className="mb-3 text-sm text-ink-muted">Looking for a natural fit…</p> : null}
            {learningStatus === "failed" || learningStatus === "quota" || learningStatus === "unavailable" ? (
              <p role="status" className="mb-3 text-sm text-caution">
                {learningStatus === "quota" ? "Today's automatic checking allowance is used up." : learningStatus === "unavailable" ? "Learning suggestions aren't available right now." : "We couldn't look for a fit just now."}
                {onRetryLearning && learningStatus === "failed" ? <button type="button" className="ml-2 underline" onClick={onRetryLearning}>Try again</button> : null}
              </p>
            ) : null}
          </>
        ) : null}
        {visible.length ? <ul className="flex flex-col gap-2">{visible.map((suggestion) => (
          <SuggestionCard key={suggestion.id} compact suggestion={suggestion} text={text} active={activeId === suggestion.id}
            onActivate={onActivate} onDeactivate={onDeactivate} onFocusCard={onFocusCard} onApply={onApply} onDismiss={onDismiss} />
        ))}</ul> : !busy && !(activeTab === "learning" && (slot || learningExpressions.length || learningListFailed)) && !(activeTab === "ai" && flags.length) ? (
          <p className="py-5 text-center text-sm leading-relaxed text-ink-muted">{empty}</p>
        ) : null}
        {activeTab === "ai" && flags.length ? <ul className="mt-2 flex flex-col gap-2">{flags.map((flag) => (
          <SentenceFlagCard key={flag.id} flag={flag} job={jobs[flag.id]} active={activeFlagId === flag.id}
            onActivate={onActivateFlag} onDeactivate={onDeactivateFlag} onFocusCard={onFocusCard} onDismiss={onDismissFlag} />
        ))}</ul> : null}
        {activeTab === "ai" && flags.some((flag) => jobs[flag.id] === "failed") && onRetryAi ? <button type="button" className="mt-3 text-sm font-semibold text-accent-strong underline" onClick={onRetryAi}>Try analysis again</button> : null}
      </div>
      {activeTab === "learning" ? <a href={practiceHref} className="mx-3 shrink-0 border-t border-line py-3 text-sm font-semibold text-accent-strong underline underline-offset-4">Open practice on the website</a> : null}
    </div>
  );
}
