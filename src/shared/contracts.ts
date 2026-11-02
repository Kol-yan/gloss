// Request and response contracts shared by the browser and the server.
// Every API handler validates its input with these schemas, and the client
// parses responses with them, so a mismatch fails loudly instead of silently.
import { z } from "zod";

export const MAX_TEXT_LENGTH = 6000;

// "error" must be fixed, "style" is optional polish, "expression" is a
// personal vocabulary suggestion. A correct sentence never gets an "error".
export const SuggestionCategory = z.enum(["error", "style", "expression"]);
export type SuggestionCategory = z.infer<typeof SuggestionCategory>;

// "local" suggestions come from the in-browser rule checker and never leave
// the device; "ai" suggestions come from a cloud model call.
export const SuggestionSource = z.enum(["local", "ai"]);
export type SuggestionSource = z.infer<typeof SuggestionSource>;

export const Suggestion = z.object({
  id: z.string(),
  source: SuggestionSource,
  category: SuggestionCategory,
  // UTF-16 indices into the normalized text the suggestion was computed for.
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  original: z.string(),
  replacement: z.string(),
  reason: z.string(),
  // True when the edit touches numbers, names or negation. Such edits are
  // shown with a warning and are never applied in bulk.
  meaningChange: z.boolean(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const ProofreadRequest = z.object({
  // Client-generated idempotency key: a retried request with the same id
  // returns the stored result instead of calling the model again.
  requestId: z.uuid(),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});
export type ProofreadRequest = z.infer<typeof ProofreadRequest>;

export const ProofreadResponse = z.object({
  checkRunId: z.string(),
  textHash: z.string(),
  suggestions: z.array(Suggestion),
});
export type ProofreadResponse = z.infer<typeof ProofreadResponse>;

export const SuggestionDecision = z.enum(["accepted", "rejected", "stale"]);
export type SuggestionDecision = z.infer<typeof SuggestionDecision>;

export const SuggestionDecisionRequest = z.object({
  decision: SuggestionDecision,
  // Hash of the text the learner saw when deciding; lets the server ignore
  // decisions about a text version it never checked.
  textHash: z.string(),
});
export type SuggestionDecisionRequest = z.infer<typeof SuggestionDecisionRequest>;

export const QuotaKind = z.enum(["proofread", "evaluate", "asrSeconds"]);
export type QuotaKind = z.infer<typeof QuotaKind>;

export const QuotaState = z.object({
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
});

export const MeResponse = z.object({
  learner: z.object({ id: z.string(), displayName: z.string() }),
  // False when the kill switch is off or today's budget is spent. Local
  // checking keeps working either way.
  aiEnabled: z.boolean(),
  quotas: z.record(QuotaKind, QuotaState),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ApiErrorCode = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  "conflict",
  "quota_exceeded",
  "budget_exhausted",
  "ai_disabled",
  "model_unavailable",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    // Short, learner-safe sentence. Never a provider message or stack trace.
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
