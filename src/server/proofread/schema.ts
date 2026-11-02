import { z } from "zod";
import { SuggestionCategory } from "@/shared/contracts";
import { parseModelJson } from "../models/json";

export const MAX_EDITS = 8;
export const MAX_EXPRESSION_EDITS = 2;
export const MAX_REASON_LENGTH = 120;
export const MAX_MEANING_LENGTH = 100;
// Reasoning and visible JSON share this output budget.
export const PROOFREAD_MAX_TOKENS = 4096;

// Flat JSON schema sent to the provider (strict mode: every property is
// required and no extra properties are allowed). Limits that strict mode may
// not support, such as maxItems, are enforced by the server instead.
export const PROOFREAD_JSON_SCHEMA = {
  name: "proofread_edits",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["edits"],
    properties: {
      edits: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentence_index", "original", "replacement", "category", "reason", "meaning"],
          properties: {
            sentence_index: { type: "integer" },
            original: { type: "string" },
            replacement: { type: "string" },
            category: { type: "string", enum: SuggestionCategory.options },
            reason: { type: "string" },
            meaning: { type: "string" },
          },
        },
      },
    },
  },
} as const;

const Envelope = z.object({ edits: z.array(z.unknown()) });

const RawEdit = z.object({
  sentence_index: z.number().int(),
  original: z.string(),
  replacement: z.string(),
  category: SuggestionCategory,
  reason: z.string(),
  // Empty for everything except "expression" edits; a missing or non-string
  // value is treated as empty rather than failing the whole edit.
  meaning: z.string().catch(""),
});
export type RawEdit = z.infer<typeof RawEdit>;

// Returns the usable edits, or null when the content is not the expected
// object at all. A single malformed edit is dropped, not fatal: the model
// proposes, the server decides what is usable.
export function parseProofreadOutput(content: string): RawEdit[] | null {
  const envelope = Envelope.safeParse(parseModelJson(content));
  if (!envelope.success) return null;

  const edits: RawEdit[] = [];
  for (const item of envelope.data.edits.slice(0, MAX_EDITS)) {
    const edit = RawEdit.safeParse(item);
    if (edit.success) edits.push(edit.data);
  }
  return edits;
}
