// How a word enters the engine.
//
// Personal relevance comes from what the learner did: saved an expression,
// answered Word check, wrote a word themselves. Nothing is inferred from a
// profile or a topic list; the owner removed that screen on Nov 3.

import type { FrequencyBand, WordSource, WordStatus } from "./types";

export type WordCheckAnswer = "use" | "know_unused" | "not_sure" | "new";

// What Word check answers mean, from the owner decisions:
// - "use": the learner already uses it, so it is not added to My words at all.
// - "know but don't use": Ready to activate.
// - "not sure" and "new": Learning.
export interface WordCheckOutcome {
  add: boolean;
  status: WordStatus;
  source: WordSource | null;
}

export function wordCheckOutcome(answer: WordCheckAnswer): WordCheckOutcome {
  switch (answer) {
    case "use":
      // Known vocabulary, not active use: no row at all. The "status" is only
      // how a result screen groups the answers.
      return { add: false, status: "active", source: null };
    case "know_unused":
      return { add: true, status: "ready", source: "word_check" };
    case "not_sure":
    case "new":
      return { add: true, status: "learning", source: "word_check" };
  }
}

// Where a word that is not in the starter set starts. A Word check "i know the
// meaning" answer means the learner already recognises it, so it may start on
// the ladder at rung 2; a brand-new saved word starts at rung 1.
export function entryRung(status: WordStatus): 1 | 2 {
  return status === "ready" ? 2 : 1;
}

// Saved expressions carry no curated band; they are ranked by the documented
// estimate below until a band is assigned by hand.
const OWN_LIST = new Set([
  "a", "an", "and", "are", "at", "be", "but", "by", "can", "do", "for", "get",
  "go", "have", "he", "here", "how", "i", "in", "is", "it", "look", "make",
  "me", "my", "no", "not",
]);
const OWN_EXPRESSIONS = new Set([
  "a lot", "again", "at home", "best wishes", "a bit", "all right", "excuse me",
  "good morning", "good night", "how are you", "i think", "in the end",
  "never mind", "of course", "on time", "right now", "see you", "thank you",
  "the same", "what about",
]);
const DAILY_OR_TIME = new Set(["daily", "time"]);

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// The provisional band estimate from ARCHITECTURE.md: one linear pass, no
// corpus, no network. A curated band, when one exists, always wins.
export function estimateBand(text: string, tags: readonly string[] = []): FrequencyBand {
  const normalized = normalizeWord(text);
  if (OWN_LIST.has(normalized)) return "core";
  if (OWN_EXPRESSIONS.has(normalized)) return "core";
  const dailyTag = tags.some((tag) => DAILY_OR_TIME.has(tag));
  if (normalized.includes(" ")) return dailyTag ? "common" : "uncommon";
  const letters = normalized.replace(/[^a-z]/g, "").length;
  const score = 2 + (dailyTag ? 1 : 0) + (letters <= 7 ? 1 : 0);
  return score >= 4 ? "core" : score === 3 ? "common" : "uncommon";
}
