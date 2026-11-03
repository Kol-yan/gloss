import type { Suggestion } from "@/shared/contracts";

// What the check button and its status line show.
//   idle         ready to check
//   pending      a cloud check is running
//   failed       the check did not complete (network or model problem; never the learner's fault)
//   quota        today's AI checks are used up
//   unavailable  cloud checking is switched off or the budget is spent; local checks still work
export type CheckStatus = "idle" | "pending" | "failed" | "quota" | "unavailable";

// Result of a cloud check, already mapped from the API by whoever wires the editor.
//   quota_exceeded                    -> "quota"
//   ai_disabled / budget_exhausted    -> "unavailable"
//   model_unavailable, network, parse -> "failed"
export type ProofreadOutcome =
  | { ok: true; suggestions: Suggestion[]; checksLeft?: number }
  | { ok: false; reason: "quota" | "unavailable" | "failed" };

// Receives text already normalized with normalizeText. Suggestions in the
// outcome must be ranges into that same text.
export type CheckWithAi = (text: string) => Promise<ProofreadOutcome>;

// In-browser rule checker. Returns suggestions with source "local".
export type CheckLocal = (text: string) => Promise<Suggestion[]> | Suggestion[];

// A span of the normalized text, as UTF-16 indices.
export type SentenceRange = { start: number; end: number };

// Called after the learner applies a cloud suggestion, with the sentences of the
// new text that the edit touched and that text. It is the point where a
// sentence-level re-check plugs in; the default does nothing.
export type RecheckSentences = (ranges: SentenceRange[], text: string) => void;

export const NO_RECHECK: RecheckSentences = () => {};

// Dictated speech, already mapped from the API by whoever wires the editor.
// `audio` is a RIFF/WAVE recording; `text` is ready to insert.
export type DictationOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "quota" | "unavailable" | "failed" };
export type Dictate = (audio: Blob, signal?: AbortSignal) => Promise<DictationOutcome>;
