"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CloseIcon, UndoIcon } from "@/components/ui/icons";
import type { Suggestion } from "@/shared/contracts";
import { SuggestionCard } from "./suggestion-card";

export type RailNotice = { id: number; text: string };

export function SuggestionRail({
  suggestions,
  activeId,
  canUndo,
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
  onUndo,
  onClose,
}: {
  suggestions: Suggestion[];
  activeId: string | null;
  canUndo: boolean;
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
  onUndo: () => void;
  // Present only where the rail is a sheet (narrow screens).
  onClose?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (slotKey) scrollRef.current?.scrollTo({ top: 0 });
  }, [slotKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="eyebrow">
          Suggestions{suggestions.length > 0 ? <span className="ml-1.5 tabular-nums">({suggestions.length})</span> : null}
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

      <p role="status" aria-live="polite" className={notice ? "px-3 pb-2 text-sm font-semibold text-success" : "sr-only"}>
        {notice?.text ?? ""}
      </p>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {slot ? <div className="mb-2">{slot}</div> : null}

        {suggestions.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {suggestions.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                active={activeId === suggestion.id}
                onActivate={onActivate}
                onDeactivate={onDeactivate}
                onFocusCard={onFocusCard}
                onApply={onApply}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-tile border border-dashed border-line-strong px-4 py-6 text-center text-sm leading-relaxed text-ink-muted">
            {textIsEmpty
              ? "Suggestions appear here once you write something."
              : checkedClean
                ? "Nothing to change. Your text looks good."
                : "No suggestions yet. Press Check with AI for a closer look."}
          </p>
        )}
      </div>
    </div>
  );
}
