// Request and response contracts shared by the browser and the server.
// Every API handler validates its input with these schemas, and the client
// parses responses with them, so a mismatch fails loudly instead of silently.
import { z } from "zod";
import { MAX_IPA_LENGTH } from "@/lib/pronunciation";

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
  // One-line meaning of the suggested wording. Set for "expression"
  // suggestions, which can become practice; null for everything else.
  meaning: z.string().nullable(),
  // American English IPA for a single lexical word; null for phrases or unknown.
  ipa: z.string().max(MAX_IPA_LENGTH).nullable().optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const ProofreadRequest = z.object({
  // Client-generated idempotency key: a retried request with the same id
  // returns the stored result instead of calling the model again.
  requestId: z.uuid(),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
});
export type ProofreadRequest = z.infer<typeof ProofreadRequest>;

export const QuotaKind = z.enum(["proofread", "evaluate", "asrSeconds"]);
export type QuotaKind = z.infer<typeof QuotaKind>;

export const QuotaState = z.object({
  used: z.number().nonnegative(),
  limit: z.number().nonnegative(),
});
export type QuotaState = z.infer<typeof QuotaState>;

export const ProofreadResponse = z.object({
  checkRunId: z.string(),
  textHash: z.string(),
  suggestions: z.array(Suggestion),
  // Proofread quota after this check, so the editor can show checks left.
  quota: QuotaState,
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

export const SuggestionDecisionResponse = z.object({
  id: z.string(),
  status: SuggestionDecision,
});
export type SuggestionDecisionResponse = z.infer<typeof SuggestionDecisionResponse>;

export const MeResponse = z.object({
  learner: z.object({ id: z.string(), displayName: z.string() }),
  accessMode: z.enum(["hosted", "byok"]),
  // False when the kill switch is off or today's budget is spent. Local
  // checking keeps working either way.
  aiEnabled: z.boolean(),
  quotas: z.record(QuotaKind, QuotaState),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------------------------------------------------------------------------
// Practice
//
// An accepted suggestion is help, not knowledge. Practice asks the learner to
// produce the expression in a new situation, first with the expression shown,
// later with it hidden so they have to recall it themselves.

export const Familiarity = z.enum(["new", "known_unused", "used"]);
export type Familiarity = z.infer<typeof Familiarity>;

export const PracticeKind = z.enum(["written", "voice"]);
export type PracticeKind = z.infer<typeof PracticeKind>;

// "shown": the expression is part of the task. "hidden": only the situation
// is given and the learner has to recall the expression.
export const CueLevel = z.enum(["shown", "hidden"]);
export type CueLevel = z.infer<typeof CueLevel>;

// "unavailable" means the answer could not be checked (model or network
// failure). It is never counted against the learner.
export const Verdict = z.enum(["used_well", "almost", "not_yet", "unavailable"]);
export type Verdict = z.infer<typeof Verdict>;

export const Expression = z.object({
  id: z.string(),
  text: z.string(),
  meaning: z.string(),
  ipa: z.string().max(MAX_IPA_LENGTH).nullable().optional(),
  familiarity: Familiarity,
});
export type Expression = z.infer<typeof Expression>;

// POST /api/expressions — turn an accepted "expression" suggestion into
// something to practise. Idempotent per suggestion.
export const CreateExpressionRequest = z.object({
  suggestionId: z.string(),
  familiarity: Familiarity,
});
export type CreateExpressionRequest = z.infer<typeof CreateExpressionRequest>;

export const CreateExpressionResponse = z.object({ expression: Expression });
export type CreateExpressionResponse = z.infer<typeof CreateExpressionResponse>;

// POST /api/practice/tasks
export const CreateTaskRequest = z.object({
  requestId: z.uuid(),
  expressionId: z.string(),
  kind: PracticeKind,
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const PracticeTask = z.object({
  id: z.string(),
  expressionId: z.string(),
  kind: PracticeKind,
  cue: CueLevel,
  // Null when the cue is hidden.
  expression: z.string().nullable(),
  // Null while the target is hidden, even when the stored expression has IPA.
  ipa: z.string().max(MAX_IPA_LENGTH).nullable().optional(),
  meaning: z.string(),
  situation: z.string(),
  // Shown only on request for hidden tasks; using it is recorded.
  hint: z.string(),
  // Server-issued id for the learner's answer to this task.
  attemptId: z.string(),
});
export type PracticeTask = z.infer<typeof PracticeTask>;

// POST /api/speech/transcribe — multipart form with fields `attemptId` and
// `audio` (RIFF/WAVE, mono, 16-bit PCM, 16 or 24 kHz, at most 60 seconds).
// Empty text means nothing was heard.
export const TranscribeResponse = z.object({
  attemptId: z.string(),
  text: z.string(),
  durationSeconds: z.number().nonnegative(),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponse>;

// POST /api/practice/attempts/{attemptId}. For voice tasks `answer` is the
// transcript as confirmed by the learner; the server compares it with the
// raw transcript it stored and records substantial edits.
export const SubmitAttemptRequest = z.object({
  answer: z.string().trim().min(1).max(1000),
  hintUsed: z.boolean(),
});
export type SubmitAttemptRequest = z.infer<typeof SubmitAttemptRequest>;

export const Evaluation = z.object({
  attemptId: z.string(),
  // Revealed by a scored verdict; empty for unavailable hidden-cue feedback.
  target: z.string(),
  ipa: z.string().max(MAX_IPA_LENGTH).nullable().optional(),
  verdict: Verdict,
  // Short feedback for the learner.
  message: z.string(),
  // A corrected version of the learner's sentence, when one helps.
  correction: z.string().nullable(),
  targetUsed: z.boolean(),
  transcriptEdited: z.boolean(),
  // Human label such as "Tomorrow" or "In 3 days"; null if nothing scheduled.
  nextPracticeLabel: z.string().nullable(),
  // Id for another try at the same task; null when no retry is offered.
  retryAttemptId: z.string().nullable(),
});
export type Evaluation = z.infer<typeof Evaluation>;

// GET /api/expressions
export const HistoryEntryKind = z.enum(["assisted_use", "written_attempt", "spoken_attempt"]);
export type HistoryEntryKind = z.infer<typeof HistoryEntryKind>;

export const HistoryEntry = z.object({
  kind: HistoryEntryKind,
  verdict: Verdict.nullable(),
  cue: CueLevel.nullable(),
  hintUsed: z.boolean(),
  transcriptEdited: z.boolean(),
  // Formatted on the server, e.g. "Today", "Yesterday", "3 Nov".
  dayLabel: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const ExpressionHistory = z.object({
  expression: Expression,
  entries: z.array(HistoryEntry),
  nextPracticeLabel: z.string().nullable(),
  // True when the next practice is due now.
  due: z.boolean(),
});
export type ExpressionHistory = z.infer<typeof ExpressionHistory>;

export const ExpressionsResponse = z.object({ expressions: z.array(ExpressionHistory) });
export type ExpressionsResponse = z.infer<typeof ExpressionsResponse>;

// ---------------------------------------------------------------------------

export const ApiErrorCode = z.enum([
  "unauthorized",
  "not_found",
  "invalid_request",
  "conflict",
  "quota_exceeded",
  "rate_limited",
  "budget_exhausted",
  "ai_disabled",
  "model_unavailable",
  "internal",
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
