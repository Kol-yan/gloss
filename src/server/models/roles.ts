// Settings for the model roles. Every role has an explicit max_tokens of at
// least 2048 (see the budget policy) and a tier: "fast" for routine jobs,
// "smart" for judging learner answers. The model itself comes from the tier
// (see resolveTextRoute). The fast tier always reasons at low effort, so its
// roles carry no reasoning setting.
import type { ModelTier } from "./access";

export const PROOFREAD_ROLE = { tier: "fast", maxTokens: 4096, temperature: 0 } as const satisfies {
  tier: ModelTier;
  maxTokens: number;
  temperature: number;
};
export const DETECT_ROLE = { tier: "fast", maxTokens: 2048, temperature: 0 } as const satisfies {
  tier: ModelTier;
  maxTokens: number;
  temperature: number;
};
export const BUILD_PRACTICE_ROLE = { tier: "fast", maxTokens: 4096, temperature: 0.7 } as const satisfies {
  tier: ModelTier;
  maxTokens: number;
  temperature: number;
};
// Tidies dictated speech: punctuation and fillers only, so little reasoning is needed.
export const DICTATION_CLEANUP_ROLE = {
  tier: "smart",
  maxTokens: 2048,
  reasoningEffort: "minimal",
  temperature: 0,
} as const satisfies { tier: ModelTier; maxTokens: number; reasoningEffort: string; temperature: number };
export const EVALUATE_ATTEMPT_ROLE = {
  tier: "smart",
  maxTokens: 4096,
  reasoningEffort: "low",
  temperature: 0,
} as const satisfies { tier: ModelTier; maxTokens: number; reasoningEffort: string; temperature: number };
