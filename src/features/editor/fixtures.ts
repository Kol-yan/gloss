// Sample data for the dev-only gallery (/dev/states) and tests. It is NOT
// model output and must never be imported by a real page.
import { touchesMeaning } from "@/lib/text";
import type { Suggestion, SuggestionCategory, SuggestionSource } from "@/shared/contracts";
import type { PracticeOffer } from "@/features/practice/types";
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
    });
  }
  return result;
}

export const SAMPLE_SUGGESTIONS = buildSampleSuggestions(SAMPLE_TEXT);

const OFFERS: Record<string, PracticeOffer> = {
  "sample-ai-2": {
    suggestionId: "sample-ai-2",
    expression: "push back",
    meaning: "To move something to a later time.",
  },
};

export function getSampleOffer(suggestion: Suggestion): PracticeOffer | null {
  return OFFERS[suggestion.id] ?? null;
}

// Stands in for the cloud check in the gallery.
export async function sampleCheckWithAi(text: string): Promise<ProofreadOutcome> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { ok: true, suggestions: buildSampleSuggestions(text, ["ai"]) };
}
