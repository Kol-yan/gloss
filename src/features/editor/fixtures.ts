// Sample data for the dev-only gallery (/dev/states) and tests. It is NOT
// model output and must never be imported by a real page.
import { touchesMeaning } from "@/lib/text";
import type { Suggestion, SuggestionCategory, SuggestionSource } from "@/shared/contracts";
import type { DetectBatchItem, DetectOutcome, DetectScores } from "./sentence-detect";
import type { ProofreadOutcome } from "./types";

export const SAMPLE_TEXT = [
  "Dear Ms Carter,",
  "",
  "I am writing to tell you that I can not attend the meeting on 14 March. I recieved your invitation yesterday, but unfortunatelly I have already a client visit that day. Could we move the meeting to 15 March? I would be grateful for your answer.",
  "",
  "Best regards,",
  "Alex",
].join("\n");

type Template = {
  id: string;
  source: SuggestionSource;
  category: SuggestionCategory;
  fragment: string;
  replacement: string;
  reason: string;
  meaning?: string;
};

const TEMPLATES: Template[] = [
  {
    id: "sample-local-1",
    source: "local",
    category: "error",
    fragment: "recieved",
    replacement: "received",
    reason: "Spelling: i comes before e, except after c.",
  },
  {
    id: "sample-local-2",
    source: "local",
    category: "error",
    fragment: "unfortunatelly",
    replacement: "unfortunately",
    reason: "Spelling: this adverb ends in -ly, not -lly.",
  },
  {
    id: "sample-local-3",
    source: "local",
    category: "style",
    fragment: "can not",
    replacement: "cannot",
    reason: "Written as one word in standard English.",
  },
  {
    id: "sample-ai-1",
    source: "ai",
    category: "error",
    fragment: "I have already a client visit",
    replacement: "I already have a client visit",
    reason: "Put \"already\" before the main verb.",
  },
  {
    id: "sample-ai-2",
    source: "ai",
    category: "expression",
    fragment: "move the meeting",
    replacement: "push the meeting back",
    reason: "\"Push back\" is a natural way to say you want a later date.",
    meaning: "To move something to a later time.",
  },
  {
    id: "sample-ai-3",
    source: "ai",
    category: "style",
    fragment: "I would be grateful for your answer",
    replacement: "I would appreciate your reply",
    reason: "A little more natural in a business email.",
  },
];

// Places each template in the given text. Templates whose fragment is missing
// or ambiguous are skipped, like the real pipeline would.
export function buildSampleSuggestions(text: string, sources: SuggestionSource[] = ["local", "ai"]): Suggestion[] {
  const result: Suggestion[] = [];
  for (const t of TEMPLATES) {
    if (!sources.includes(t.source)) continue;
    const start = text.indexOf(t.fragment);
    if (start === -1 || text.indexOf(t.fragment, start + 1) !== -1) continue;
    result.push({
      id: t.id,
      source: t.source,
      category: t.category,
      start,
      end: start + t.fragment.length,
      original: t.fragment,
      replacement: t.replacement,
      reason: t.reason,
      meaningChange: touchesMeaning(t.fragment, t.replacement),
      meaning: t.meaning ?? null,
    });
  }
  return result;
}

export const SAMPLE_SUGGESTIONS = buildSampleSuggestions(SAMPLE_TEXT);

// Stands in for the cloud check in the gallery.
export async function sampleCheckWithAi(text: string): Promise<ProofreadOutcome> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { ok: true, suggestions: buildSampleSuggestions(text, ["ai"]) };
}

// ---------------------------------------------------------------------------
// Two-stage flow: a text with mistakes for the detector and generator fakes.

export const FLOW_TEXT = [
  "Yesterday I go to the store and buy some milk.",
  "The report is very much good for readers.",
  "Our team have finished the project last week.",
  "We are looking forward to hearing from you.",
].join(" ");

// What the fake detector answers, by the start of the sentence.
const FLOW_SCORES: Array<[string, DetectScores]> = [
  ["Yesterday I go", { correction: 0.95, clarity: 0.12, word_choice: 0.2 }],
  ["The report is", { correction: 0.1, clarity: 0.35, word_choice: 0.82 }],
  ["Our team have", { correction: 0.88, clarity: 0.64, word_choice: 0.05 }],
];

// Stands in for POST /api/detect in the gallery. `onRequest` lets the page show
// which sentences were really sent.
export function sampleDetectSentences(onRequest?: (batch: DetectBatchItem[]) => void) {
  return async (batch: DetectBatchItem[]): Promise<DetectOutcome> => {
    onRequest?.(batch);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      ok: true,
      results: batch.map((item) => ({
        hash: item.hash,
        scores: FLOW_SCORES.find(([start]) => item.text.startsWith(start))?.[1] ?? { correction: 0, clarity: 0, word_choice: 0 },
      })),
    };
  };
}

const FLOW_FIXES: Array<{ id: string; category: SuggestionCategory; fragment: string; replacement: string; reason: string }> = [
  { id: "flow-1a", category: "error", fragment: "go", replacement: "went", reason: "\"Yesterday\" needs the past tense." },
  { id: "flow-1b", category: "error", fragment: "buy", replacement: "bought", reason: "Keep both verbs in the past tense." },
  { id: "flow-2", category: "style", fragment: "very much good", replacement: "very useful", reason: "\"Very much good\" is not idiomatic; \"very useful\" says what you mean." },
  { id: "flow-3", category: "error", fragment: "have finished the project last week", replacement: "finished the project last week", reason: "A finished action with \"last week\" takes the simple past." },
];

// Stands in for the cloud check, whole text or one sentence. Fixes are placed
// like the real pipeline would: only when the fragment occurs exactly once.
export async function sampleCheckFlow(text: string): Promise<ProofreadOutcome> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  const suggestions: Suggestion[] = [];
  for (const fix of FLOW_FIXES) {
    const start = text.indexOf(fix.fragment);
    if (start === -1 || text.indexOf(fix.fragment, start + 1) !== -1) continue;
    suggestions.push({
      id: fix.id,
      source: "ai",
      category: fix.category,
      start,
      end: start + fix.fragment.length,
      original: fix.fragment,
      replacement: fix.replacement,
      reason: fix.reason,
      meaningChange: touchesMeaning(fix.fragment, fix.replacement),
      meaning: null,
    });
  }
  return { ok: true, suggestions };
}
