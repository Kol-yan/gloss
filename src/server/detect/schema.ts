import { z } from "zod";
import { parseModelJson } from "../models/json";
import { DETECT_ROLE } from "../models/roles";

export const DETECT_MAX_TOKENS = DETECT_ROLE.maxTokens;

const probability = { type: "number", minimum: 0, maximum: 1 } as const;

export const DETECT_JSON_SCHEMA = {
  name: "detect_sentence_needs",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentences"],
    properties: {
      sentences: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sentence_index", "needs_correction", "needs_clarity", "needs_word_choice"],
          properties: {
            sentence_index: { type: "integer", minimum: 0 },
            needs_correction: probability,
            needs_clarity: probability,
            needs_word_choice: probability,
          },
        },
      },
    },
  },
} as const;

const Probability = z.number().finite().min(0).max(1);
const DetectDecision = z.object({
  sentence_index: z.number().int().nonnegative(),
  needs_correction: Probability,
  needs_clarity: Probability,
  needs_word_choice: Probability,
}).strict();
const DetectOutput = z.object({ sentences: z.array(DetectDecision) }).strict();

export type DetectDecision = z.infer<typeof DetectDecision>;

// The provider returns indices rather than repeating learner text or hashes.
// Require exact, unique coverage before the caller maps decisions to hashes.
export function parseDetectOutput(content: string, expectedCount: number): DetectDecision[] | null {
  const parsed = DetectOutput.safeParse(parseModelJson(content));
  if (!parsed.success || parsed.data.sentences.length !== expectedCount) return null;

  const ordered: DetectDecision[] = Array(expectedCount);
  for (const decision of parsed.data.sentences) {
    if (decision.sentence_index >= expectedCount || ordered[decision.sentence_index]) return null;
    ordered[decision.sentence_index] = decision;
  }
  return ordered.every(Boolean) ? ordered : null;
}
