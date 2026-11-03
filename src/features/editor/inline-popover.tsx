"use client";

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { AlertIcon, CloseIcon } from "@/components/ui/icons";
import { VocabularyPronunciation } from "@/components/vocabulary-pronunciation";
import type { Suggestion } from "@/shared/contracts";
import { describeChange, spoken } from "./change-view";
import { placePopover, type Box } from "./popover-state";
import { CategoryBadge, ChangeSummary } from "./suggestion-card";

// Below the container's `xl` width the popover is a sheet docked above the check
// bar; the `--pop-sheet` property tells the script which of the two it is.
const SHEET_FLAG = "--pop-sheet";

export function InlinePopover({
  suggestion,
  text,
  index,
  count,
  via,
  getAnchor,
  reveal,
  layoutKey,
  onApply,
  onDismiss,
  onStep,
  onClose,
  onLost,
}: {
  suggestion: Suggestion;
  text: string;
  // Position among the suggestions, for "2 of 5".
  index: number;
  count: number;
  via: "pointer" | "keyboard";
  // The underlined word, in pixels relative to the popover's container; null when
  // it is not on screen (scrolled away).
  getAnchor: () => Box | null;
  // Scrolls the word into view. Runs once for each suggestion the popover shows.
  reveal: () => void;
  // Changes when the text scrolled or resized, so the popover follows the word.
  layoutKey: unknown;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: (viaKeyboard: boolean) => void;
  // The word scrolled out of view.
  onLost: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<string | null>(null);
  const { id, category, original, replacement, reason, meaningChange } = suggestion;
  const change = describeChange(text, suggestion);
  // Harper's message for a spacing or punctuation edit says what the label says.
  const showReason = !(change.label && suggestion.source === "local");
  const summary = change.label ?? `${spoken(original)} to ${spoken(replacement)}`;

  // Sits under the word (above it when there is no room); on narrow screens CSS
  // docks it instead and the position is not used.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const container = root?.offsetParent;
    if (!root || !container) return;
    if (revealed.current !== id) {
      revealed.current = id;
      reveal();
    }
    if (getComputedStyle(root).getPropertyValue(SHEET_FLAG).trim() === "1") return;
    const anchor = getAnchor();
    if (!anchor) {
      onLost();
      return;
    }
    const { left, top } = placePopover(
      anchor,
      { width: container.clientWidth, height: container.clientHeight },
      { width: root.offsetWidth, height: root.offsetHeight },
    );
    root.style.setProperty("--pop-left", `${left}px`);
    root.style.setProperty("--pop-top", `${top}px`);
  }, [id, text, layoutKey, getAnchor, reveal, onLost]);

  // A keyboard learner is already working with the keyboard, so focus follows
  // the popover; Apply is the action Enter takes.
  useEffect(() => {
    if (via === "keyboard") rootRef.current?.querySelector<HTMLElement>("[data-popover-apply]")?.focus();
  }, [id, via]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    switch (event.key) {
      case "Tab":
        event.preventDefault();
        onStep(event.shiftKey ? -1 : 1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        break;
      case "Enter":
        // Other buttons keep their own meaning for Enter.
        if (target.hasAttribute("data-popover-apply") || target === event.currentTarget) {
          event.preventDefault();
          onApply(id);
        }
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-popover-action]"));
        const at = buttons.indexOf(target);
        if (at === -1) break;
        event.preventDefault();
        buttons[(at + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        break;
      }
    }
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Review suggestion"
      data-inline-popover
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={
        "absolute top-(--pop-top) left-(--pop-left) z-30 w-80 max-w-[calc(100%-1rem)] rounded-tile border border-line bg-card p-3 shadow-card outline-none " +
        "[--pop-sheet:0] @max-xl:relative @max-xl:top-0 @max-xl:left-0 @max-xl:w-auto @max-xl:max-w-none @max-xl:rounded-t-card @max-xl:rounded-b-none " +
        "@max-xl:border-x-0 @max-xl:border-b-0 @max-xl:px-4 @max-xl:pb-3 @max-xl:shadow-lift @max-xl:[--pop-sheet:1]"
      }
    >
      <div className="flex items-center gap-2 pr-8">
        <CategoryBadge category={category} />
        <span className="text-xs tabular-nums text-ink-muted">
          {index + 1} of {count}
        </span>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {`Suggestion ${index + 1} of ${count}: ${summary}`}
      </p>

      <ChangeSummary suggestion={suggestion} change={change} className="mt-1" />

      {category === "expression" ? <VocabularyPronunciation text={replacement} ipa={suggestion.ipa} /> : null}

      {showReason ? <p className="mt-1 text-sm leading-snug text-ink-muted">{reason}</p> : null}

      {meaningChange ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-chip bg-caution-soft px-2 py-1.5 text-xs font-semibold leading-snug text-caution">
          <AlertIcon size={14} className="mt-px shrink-0" />
          <span>Changes meaning. Check it still says what you mean.</span>
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1">
        <Button
          data-popover-apply
          data-popover-action
          size="sm"
          variant="soft"
          onClick={() => onApply(id)}
          aria-label={`Apply: ${summary}`}
        >
          Apply
        </Button>
        <Button
          data-popover-action
          size="sm"
          variant="quiet"
          onClick={() => onDismiss(id)}
          aria-label={`Dismiss: ${change.label ?? spoken(original)}`}
        >
          Dismiss
        </Button>
      </div>

      <p className="mt-2 hidden text-xs text-ink-muted @xl:block">Tab next · Enter apply · Esc close</p>

      {/* Last in the tab order, so Tab from the text reaches Apply first. */}
      <Button
        data-popover-action
        size="sm"
        variant="quiet"
        className="absolute top-2 right-2 px-1"
        onClick={() => onClose(false)}
        aria-label="Close suggestion"
      >
        <CloseIcon size={14} />
      </Button>
    </div>
  );
}
