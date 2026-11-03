// Which suggestion the inline popover shows, and where. Pure functions with no
// React or DOM so the keyboard flow (open, step, apply, dismiss, close) and the
// placement can be tested directly.
import type { Suggestion, SuggestionCategory } from "@/shared/contracts";
import { sortSuggestions } from "./editor-reducer";

// `via` is how the popover was opened. A popover the learner reached with the
// keyboard keeps going to the next suggestion after a decision; one opened with
// the pointer closes.
export type PopoverState = { id: string; via: "pointer" | "keyboard" } | null;

export type PopoverAction =
  | { type: "open"; id: string; via: "pointer" | "keyboard" }
  | { type: "step"; direction: 1 | -1 }
  | { type: "close" }
  // The open suggestion was applied or dismissed. `suggestions` is the list from before.
  | { type: "decided"; applied: boolean };

// When underlines overlap, the most urgent category is the one to show first.
const PRIORITY: Record<SuggestionCategory, number> = { error: 3, expression: 2, style: 1 };

// The best of several suggestions covering the same place: most urgent category,
// then the narrowest range, then the one that starts first.
export function pickSuggestion(candidates: Suggestion[]): Suggestion | null {
  let best: Suggestion | null = null;
  for (const s of candidates) {
    if (
      best === null ||
      PRIORITY[s.category] > PRIORITY[best.category] ||
      (PRIORITY[s.category] === PRIORITY[best.category] &&
        (s.end - s.start < best.end - best.start || (s.end - s.start === best.end - best.start && s.start < best.start)))
    ) {
      best = s;
    }
  }
  return best;
}

// The suggestion to show for a caret position: one covering the caret (a caret
// at either edge of the word counts), otherwise the next one after it, and after
// the last one the first again. Null only when there are no suggestions.
export function suggestionForCaret(suggestions: Suggestion[], caret: number): Suggestion | null {
  const covering = pickSuggestion(suggestions.filter((s) => s.start <= caret && caret <= s.end));
  if (covering) return covering;
  const sorted = sortSuggestions(suggestions);
  return sorted.find((s) => s.start > caret) ?? sorted[0] ?? null;
}

// Position of a suggestion in reading order, for "2 of 5"; 0 when it is unknown.
export function sortedIndex(suggestions: Suggestion[], id: string): number {
  return Math.max(0, sortSuggestions(suggestions).findIndex((s) => s.id === id));
}

// The suggestion after or before `id` in reading order, wrapping around.
export function stepSuggestion(suggestions: Suggestion[], id: string, direction: 1 | -1): Suggestion | null {
  const sorted = sortSuggestions(suggestions);
  if (sorted.length === 0) return null;
  const index = sorted.findIndex((s) => s.id === id);
  if (index === -1) return direction === 1 ? sorted[0] : sorted[sorted.length - 1];
  return sorted[(index + direction + sorted.length) % sorted.length];
}

// What a keyboard popover moves to once its suggestion has been applied (the
// ones overlapping the replaced words are gone with it) or dismissed: the next
// one in the text, else the first one before it, else nothing.
function nextAfterDecision(suggestions: Suggestion[], id: string, applied: boolean): Suggestion | null {
  const decided = suggestions.find((s) => s.id === id);
  if (!decided) return null;
  const remaining = sortSuggestions(
    suggestions.filter((s) => s.id !== id && (!applied || s.end <= decided.start || s.start >= decided.end)),
  );
  return remaining.find((s) => s.start >= decided.end) ?? remaining[0] ?? null;
}

export function popoverReducer(state: PopoverState, action: PopoverAction, suggestions: Suggestion[]): PopoverState {
  switch (action.type) {
    case "open":
      return suggestions.some((s) => s.id === action.id) ? { id: action.id, via: action.via } : null;
    case "close":
      return null;
    case "step": {
      if (!state) return state;
      const next = stepSuggestion(suggestions, state.id, action.direction);
      return next ? { id: next.id, via: "keyboard" } : null;
    }
    case "decided": {
      if (!state || state.via !== "keyboard") return null;
      const next = nextAfterDecision(suggestions, state.id, action.applied);
      return next ? { id: next.id, via: "keyboard" } : null;
    }
  }
}

// A popover whose suggestion is gone (edited, replaced by a newer check) closes.
export function syncPopover(state: PopoverState, suggestions: Suggestion[]): PopoverState {
  return state && suggestions.some((s) => s.id === state.id) ? state : null;
}

export type Box = { left: number; top: number; right: number; bottom: number };

// Places the popover under the word, or above it when there is no room below,
// and keeps it inside the container. All values are pixels relative to the
// container.
export function placePopover(
  anchor: Box,
  container: { width: number; height: number },
  size: { width: number; height: number },
  gap = 8,
  margin = 8,
): { left: number; top: number; placement: "below" | "above" } {
  const maxLeft = Math.max(margin, container.width - size.width - margin);
  const left = Math.min(Math.max(anchor.left, margin), maxLeft);
  const below = anchor.bottom + gap;
  if (below + size.height <= container.height - margin) return { left, top: below, placement: "below" };
  const above = anchor.top - gap - size.height;
  if (above >= margin) return { left, top: above, placement: "above" };
  // Neither side fits: stay below, as far up as the container allows.
  return { left, top: Math.max(margin, container.height - margin - size.height), placement: "below" };
}
