// Settings for the model roles used by practice. Every role has an explicit
// max_tokens of at least 2048 (see the budget policy); the model itself comes
// from configuration.
export const BUILD_PRACTICE_ROLE = { maxTokens: 2048, temperature: 0.7 } as const;
export const EVALUATE_ATTEMPT_ROLE = { maxTokens: 2048, temperature: 0 } as const;
