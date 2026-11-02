// Pure editor state: the text, the suggestions pinned to it, dismissed ideas
// and the undo stack for applied suggestions. No React in here so the rules
// (stale suggestions disappear, ranges follow edits, undo never loses typing)
// can be tested directly.
import { applyRange, canApply } from "@/lib/text";
import type { Suggestion, SuggestionSource } from "@/shared/contracts";

export type UndoEntry = {
  // Document before the suggestion was applied.
  before: { text: string; suggestions: Suggestion[] };
  // Text right after applying. Undo is only offered while the text still equals this.
  after: string;
  applied: Suggestion;
};

export type EditorDoc = {
  text: string;
  suggestions: Suggestion[];
  // Keys of suggestions the learner dismissed; a later check does not bring them back.
  dismissed: string[];
  undo: UndoEntry[];
};

export type EditorAction =
  | { type: "edit"; text: string }
  | { type: "apply"; id: string }
  | { type: "dismiss"; id: string }
  | { type: "undo" }
  | { type: "receive"; source: SuggestionSource; forText: string; suggestions: Suggestion[] };

const MAX_UNDO = 50;

export function createDoc(text = "", suggestions: Suggestion[] = []): EditorDoc {
  return { text, suggestions: sortSuggestions(suggestions.filter((s) => canApply(text, s))), dismissed: [], undo: [] };
}

export function suggestionKey(s: Pick<Suggestion, "category" | "original" | "replacement">): string {
  return `${s.category}\u0000${s.original}\u0000${s.replacement}`;
}

export function sortSuggestions(list: Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

export function canUndo(doc: EditorDoc): boolean {
  const top = doc.undo.at(-1);
  return top !== undefined && top.after === doc.text;
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

// The smallest span of oldText that was replaced to get newText.
function changedSpan(oldText: string, newText: string): { start: number; oldEnd: number; newEnd: number } {
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix++;
  }
  return { start: prefix, oldEnd: oldText.length - suffix, newEnd: newText.length - suffix };
}

// Moves suggestions from oldText to newText. A suggestion survives when the
// edit happened entirely before or after it, shifting it as needed. Edits that
// touch it, or that glue a word onto it, drop it. Whatever survives is checked
// with canApply, so a suggestion can never point at the wrong characters.
export function rebaseSuggestions(oldText: string, newText: string, suggestions: Suggestion[]): Suggestion[] {
  if (oldText === newText) return suggestions.filter((s) => canApply(newText, s));
  const { start, oldEnd, newEnd } = changedSpan(oldText, newText);
  const delta = newEnd - oldEnd;
  const result: Suggestion[] = [];
  for (const s of suggestions) {
    let next: Suggestion | null = null;
    if (s.end < start || (s.end === start && !isWordChar(newText[s.end]))) {
      next = s;
    } else if (s.start > oldEnd || (s.start === oldEnd && !isWordChar(newText[s.start + delta - 1]))) {
      next = { ...s, start: s.start + delta, end: s.end + delta };
    }
    if (next && canApply(newText, next)) result.push(next);
  }
  return result;
}

function mergeBySource(doc: EditorDoc, source: SuggestionSource, incoming: Suggestion[]): Suggestion[] {
  const dismissed = new Set(doc.dismissed);
  const fresh = incoming.filter((s) => s.source === source && !dismissed.has(suggestionKey(s)) && canApply(doc.text, s));
  const kept = doc.suggestions.filter((s) => s.source !== source);
  const all = [...kept, ...fresh];
  // The same fix reported by both sources is shown once, as the local one.
  const seen = new Map<string, Suggestion>();
  for (const s of all) {
    const key = `${s.start}:${s.end}:${s.replacement}`;
    const existing = seen.get(key);
    if (!existing || (existing.source === "ai" && s.source === "local")) seen.set(key, s);
  }
  return sortSuggestions([...seen.values()]);
}

export function editorReducer(doc: EditorDoc, action: EditorAction): EditorDoc {
  switch (action.type) {
    case "edit": {
      if (action.text === doc.text) return doc;
      return {
        ...doc,
        text: action.text,
        suggestions: rebaseSuggestions(doc.text, action.text, doc.suggestions),
        // Typing is undone with the textarea's own undo; ours only covers untouched text.
        undo: [],
      };
    }

    case "apply": {
      const target = doc.suggestions.find((s) => s.id === action.id);
      if (!target) return doc;
      const next = applyRange(doc.text, target);
      if (next === null) {
        return { ...doc, suggestions: doc.suggestions.filter((s) => s.id !== action.id) };
      }
      // Anything overlapping the replaced words describes text that no longer exists.
      const others = doc.suggestions.filter((s) => s.id !== target.id && (s.end <= target.start || s.start >= target.end));
      const entry: UndoEntry = {
        before: { text: doc.text, suggestions: doc.suggestions },
        after: next,
        applied: target,
      };
      return {
        ...doc,
        text: next,
        suggestions: rebaseSuggestions(doc.text, next, others),
        undo: [...doc.undo, entry].slice(-MAX_UNDO),
      };
    }

    case "dismiss": {
      const target = doc.suggestions.find((s) => s.id === action.id);
      if (!target) return doc;
      const key = suggestionKey(target);
      return {
        ...doc,
        suggestions: doc.suggestions.filter((s) => s.id !== action.id),
        dismissed: doc.dismissed.includes(key) ? doc.dismissed : [...doc.dismissed, key],
      };
    }

    case "undo": {
      const top = doc.undo.at(-1);
      if (!top || top.after !== doc.text) return doc;
      const dismissed = new Set(doc.dismissed);
      const restored = top.before.suggestions.filter((s) => !dismissed.has(suggestionKey(s)));
      const knownIds = new Set(restored.map((s) => s.id));
      // Results that arrived after the edit are kept if they still make sense.
      const arrivedLater = rebaseSuggestions(doc.text, top.before.text, doc.suggestions).filter(
        (s) => !knownIds.has(s.id),
      );
      return {
        ...doc,
        text: top.before.text,
        suggestions: sortSuggestions([...restored, ...arrivedLater].filter((s) => canApply(top.before.text, s))),
        undo: doc.undo.slice(0, -1),
      };
    }

    case "receive": {
      // The checker may answer for an older version of the text.
      const incoming = rebaseSuggestions(action.forText, doc.text, action.suggestions);
      return { ...doc, suggestions: mergeBySource(doc, action.source, incoming) };
    }
  }
}
