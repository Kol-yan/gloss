"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CloseIcon, UndoIcon } from "@/components/ui/icons";
import type { Suggestion } from "@/shared/contracts";
import type { SentenceFlag } from "./sentence-detect";
import { SentenceFlagCard, type SentenceJobState } from "./sentence-flag-card";
import { SuggestionCard } from "./suggestion-card";

export type RailNotice = { id: number; text: string };

// Asks the rail to move keyboard focus to a suggestion's first action. `n` makes
// repeated requests for the same suggestion distinct.
export type FocusRequest = { id: string; n: number };

type RailItem =
  | { kind: "suggestion"; start: number; suggestion: Suggestion }
  | { kind: "flag"; start: number; flag: SentenceFlag };

export function SuggestionRail({
  suggestions,
  flags = [],
  jobs = {},
  activeFlagId = null,
  autoDetect = false,
  focusRequest = null,
  text,
  activeId,
  canUndo,
  safeCount = 0,
  notice,
  textIsEmpty,
  checkedClean,
  slot,
  slotKey,
  onActivate,
  onDeactivate,
  onFocusCard,
  onApply,
  onDismiss,
  onActivateFlag = () => {},
  onDeactivateFlag = () => {},
  onReviewFlag = () => {},
  onDismissFlag = () => {},
  onFixAll = () => {},
  onUndo,
  onClose,
}: {
  suggestions: Suggestion[];
  // Sentences the detector flagged that have no suggestions yet.
  flags?: SentenceFlag[];
  // Generator state per flagged sentence, by flag id.
  jobs?: Record<string, SentenceJobState>;
  activeFlagId?: string | null;
  // True when sentences are scanned automatically; only changes the empty message.
  autoDetect?: boolean;
  focusRequest?: FocusRequest | null;
  // The current text; cards show the words around each change.
  text: string;
  activeId: string | null;
  canUndo: boolean;
  // How many errors "Fix all safe errors" would apply.
  safeCount?: number;
  notice: RailNotice | null;
  textIsEmpty: boolean;
  // True after a cloud check that found nothing to change.
  checkedClean: boolean;
  // Extra block above the list, e.g. the "Try using this yourself" card.
  slot?: ReactNode;
  // Changes when a new slot appears, so the list scrolls back up to show it.
  slotKey?: string;
  onActivate: (id: string) => void;
  onDeactivate: (id: string) => void;
  onFocusCard: (id: string) => void;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  onActivateFlag?: (id: string) => void;
  onDeactivateFlag?: (id: string) => void;
  onReviewFlag?: (flag: SentenceFlag) => void;
  onDismissFlag?: (id: string) => void;
  onFixAll?: () => void;
  onUndo: () => void;
  // Present only where the rail is a sheet (narrow screens).
  onClose?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (slotKey) scrollRef.current?.scrollTo({ top: 0 });
  }, [slotKey]);

  // The badge the learner pressed is replaced by suggestion cards; keyboard focus
  // moves to the first one instead of falling back to the page.
  useEffect(() => {
    if (!focusRequest) return;
    const card = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-suggestion-id]") ?? []).find(
      (el) => el.dataset.suggestionId === focusRequest.id,
    );
    card?.querySelector<HTMLElement>("button")?.focus();
  }, [focusRequest]);

  // Suggestions and flagged sentences read in the order they appear in the text.
  const items = useMemo<RailItem[]>(
    () =>
      [
        ...suggestions.map((suggestion): RailItem => ({ kind: "suggestion", start: suggestion.start, suggestion })),
        ...flags.map((flag): RailItem => ({ kind: "flag", start: flag.start, flag })),
      ].sort((a, b) => a.start - b.start),
    [suggestions, flags],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="eyebrow">
          Suggestions{items.length > 0 ? <span className="ml-1.5 tabular-nums">({items.length})</span> : null}
        </h2>
        <div className="flex items-center gap-1">
          {canUndo ? (
            <Button size="sm" variant="secondary" onClick={onUndo}>
              <UndoIcon size={14} />
              Undo
            </Button>
          ) : null}
          {onClose ? (
            <Button size="sm" variant="quiet" onClick={onClose} aria-label="Close suggestions">
              <CloseIcon size={14} />
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {safeCount >= 2 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-2">
          <Button size="sm" variant="soft" onClick={onFixAll}>
            Fix all safe errors ({safeCount})
          </Button>
          <p className="text-xs leading-snug text-ink-muted">Skips changes to numbers, names and negation.</p>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className={notice ? "px-3 pb-2 text-sm font-semibold text-success" : "sr-only"}>
        {notice?.text ?? ""}
      </p>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {items.length > 0 ? (
          <p className="mb-2 hidden text-xs leading-snug text-ink-muted @3xl:block">
            Click an underline, or press Alt+Enter in the text, to review it where it is.
          </p>
        ) : null}
        {slot ? <div className="mb-2">{slot}</div> : null}

        {items.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {items.map((item) =>
              item.kind === "suggestion" ? (
                <SuggestionCard
                  key={item.suggestion.id}
                  suggestion={item.suggestion}
                  text={text}
                  active={activeId === item.suggestion.id}
                  onActivate={onActivate}
                  onDeactivate={onDeactivate}
                  onFocusCard={onFocusCard}
                  onApply={onApply}
                  onDismiss={onDismiss}
                />
              ) : (
                <SentenceFlagCard
                  key={`flag-${item.flag.id}`}
                  flag={item.flag}
                  job={jobs[item.flag.id]}
                  active={activeFlagId === item.flag.id}
                  onActivate={onActivateFlag}
                  onDeactivate={onDeactivateFlag}
                  onFocusCard={onFocusCard}
                  onReview={onReviewFlag}
                  onDismiss={onDismissFlag}
                />
              ),
            )}
          </ul>
        ) : (
          <p className="rounded-tile border border-dashed border-line-strong px-4 py-6 text-center text-sm leading-relaxed text-ink-muted">
            {textIsEmpty
              ? "Suggestions appear here once you write something."
              : checkedClean
                ? "Nothing to change. Your text looks good."
                : autoDetect
                  ? "Nothing flagged yet. Sentences that may need work appear here when you pause typing, or press Check with AI for a closer look."
                  : "No suggestions yet. Press Check with AI for a closer look."}
          </p>
        )}
      </div>
    </div>
  );
}
