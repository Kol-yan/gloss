import { z } from "zod";
import { parseModelJson } from "../models/json";
import { PROOFREAD_ROLE } from "../models/roles";

// Limits on what one check can turn into suggestions.
// - Error fixes come from whole corrected sentences. A sentence is kept with
//   all of its fixes or not at all, so applying every error suggestion always
//   reproduces the model's corrected sentence.
// - Improvements are optional fragment edits (style and expressions).
export const MAX_ERROR_SUGGESTIONS = 24;
export const MAX_IMPROVEMENTS = 8;
export const MAX_EXPRESSION_EDITS = 2;
export const MAX_REASON_LENGTH = 120;
export const MAX_MEANING_LENGTH = 100;
// Reasoning and visible JSON share this output budget.
export const PROOFREAD_MAX_TOKENS = PROOFREAD_ROLE.maxTokens;

// "style" is optional polish, "expression" is a personal vocabulary
// suggestion. Definite mistakes never travel as improvements.
export const ImprovementCategory = z.enum(["style", "expression"]);

// Flat JSON schema sent to the provider (strict mode: every property is
// required and no extra properties are allowed). Limits that strict mode may
// not support, such as maxItems, are enforced by the server instead.
export const PROOFREAD_JSON_SCHEMA = {
  name: "proofread_sentences",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["corrections", "improvements"],
    properties: {
      corrections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentence_index", "corrected", "changes"],
          properties: {
            sentence_index: { type: "integer" },
            corrected: { type: "string" },
            changes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["original", "replacement", "reason"],
                properties: {
                  original: { type: "string" },
                  replacement: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
          },
        },
      },
      improvements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentence_index", "original", "replacement", "category", "reason", "meaning", "ipa"],
          properties: {
            sentence_index: { type: "integer" },
            original: { type: "string" },
            replacement: { type: "string" },
            category: { type: "string", enum: ImprovementCategory.options },
            reason: { type: "string" },
            meaning: { type: "string" },
            ipa: { type: "string" },
          },
        },
      },
    },
  },
} as const;

// A note about one fix. Only its words and reason are used, to label the
// differences the server finds between a sentence and its corrected version.
const RawChange = z.object({
  original: z.string().catch(""),
  replacement: z.string().catch(""),
  reason: z.string().catch(""),
});
export type RawChange = z.infer<typeof RawChange>;

const RawCorrection = z.object({
  sentence_index: z.number().int(),
  corrected: z.string(),
  changes: z.array(z.unknown()).catch([]),
});
export interface RawCorrection {
  sentence_index: number;
  corrected: string;
  changes: RawChange[];
}

const RawImprovement = z.object({
  sentence_index: z.number().int(),
  original: z.string(),
  replacement: z.string(),
  category: ImprovementCategory,
  reason: z.string(),
  // Empty for everything except "expression" edits; a missing or non-string
  // value is treated as empty rather than failing the whole edit.
  meaning: z.string().catch(""),
  // Tolerate missing or unusable enrichment without losing the actual edit.
  ipa: z.string().max(128).catch(""),
});
export type RawImprovement = z.infer<typeof RawImprovement>;

export interface ProofreadOutput {
  corrections: RawCorrection[];
  improvements: RawImprovement[];
}

const Envelope = z.object({
  corrections: z.array(z.unknown()),
  improvements: z.array(z.unknown()).catch([]),
});

// Returns the usable parts, or null when the content is not the expected
// object at all. A single malformed entry is dropped, not fatal: the model
// proposes, the server decides what is usable.
export function parseProofreadOutput(content: string): ProofreadOutput | null {
  const envelope = Envelope.safeParse(parseModelJson(content));
  if (!envelope.success) return null;

  const corrections: RawCorrection[] = [];
  for (const item of envelope.data.corrections) {
    const parsed = RawCorrection.safeParse(item);
    if (!parsed.success) continue;
    const changes: RawChange[] = [];
    for (const change of parsed.data.changes) {
      const note = RawChange.safeParse(change);
      if (note.success) changes.push(note.data);
    }
    corrections.push({ ...parsed.data, changes });
  }

  const improvements: RawImprovement[] = [];
  for (const item of envelope.data.improvements.slice(0, MAX_IMPROVEMENTS)) {
    const edit = RawImprovement.safeParse(item);
    if (edit.success) improvements.push(edit.data);
  }
  return { corrections, improvements };
}
