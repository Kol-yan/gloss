// Response helpers for route handlers. Messages are short and safe to show to
// a learner; provider details and stack traces never reach them.
import { unstable_rethrow } from "next/navigation";
import type { ApiError, ApiErrorCode } from "@/shared/contracts";
import {
  AiDisabledError,
  BudgetExhaustedError,
  ConflictError,
  InvalidInviteError,
  InvalidRequestError,
  NotFoundError,
  QuotaExceededError,
  RateLimitedError,
  UnauthorizedError,
} from "./errors";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
} from "./models/errors";

const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  quota_exceeded: 429,
  rate_limited: 429,
  budget_exhausted: 503,
  ai_disabled: 503,
  model_unavailable: 502,
  internal: 500,
};

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: "Open Settings to add your own OpenRouter key and keep going.",
  not_found: "We could not find that.",
  invalid_request: "That request was not valid.",
  conflict: "That changed in the meantime. Please try again.",
  quota_exceeded: "Today's free demo is used up. Add your own OpenRouter key in Settings to keep going.",
  rate_limited: "Please wait a moment before trying again.",
  budget_exhausted: "The free demo is used up. Add your own OpenRouter key in Settings to keep going.",
  ai_disabled: "Cloud checking is switched off right now. Local checking still works.",
  model_unavailable: "The cloud checker is not available right now. Please try again.",
  internal: "Something went wrong on our side. Please try again.",
};

// User-specific responses must never be stored by a shared cache.
const NO_STORE = { "Cache-Control": "no-store" } as const;

export function jsonOk<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function jsonError(
  code: ApiErrorCode,
  status: number = DEFAULT_STATUS[code],
  message: string = MESSAGES[code],
): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status, headers: NO_STORE });
}

// Maps any thrown value to a response. Known errors get their own code;
// framework control-flow errors are rethrown; everything else is logged (see
// logUnexpected) and answered with a generic 500 `internal`, never with the
// error's text.
export function errorResponse(error: unknown): Response {
  if (error instanceof UnauthorizedError) return jsonError("unauthorized");
  if (error instanceof QuotaExceededError) return jsonError("quota_exceeded");
  if (error instanceof RateLimitedError) return jsonError("rate_limited");
  if (error instanceof BudgetExhaustedError) return jsonError("budget_exhausted");
  if (error instanceof AiDisabledError) return jsonError("ai_disabled");
  if (error instanceof InvalidInviteError || error instanceof NotFoundError) {
    return jsonError("not_found");
  }
  if (error instanceof ConflictError) return jsonError("conflict");
  if (error instanceof InvalidRequestError) return jsonError("invalid_request");

  // A missing key or an unpriced model is an operator problem: cloud features
  // are off until it is fixed.
  if (error instanceof ModelNotConfiguredError || error instanceof UnknownModelError) {
    logUnexpected(error);
    return jsonError("ai_disabled");
  }
  if (error instanceof ModelTimeoutError) {
    console.warn("[gloss] model request incomplete:", error.reason, error.latencyMs);
    return jsonError("model_unavailable", 503);
  }
  if (error instanceof ModelHttpError) {
    console.warn("[gloss] model provider status:", error.status);
    return jsonError("model_unavailable", 503);
  }
  if (error instanceof ModelOutputError) {
    const reasons = new Set(["truncated", "empty_content", "envelope_not_json", "invalid_output"]);
    console.warn("[gloss] model output rejected:", reasons.has(error.reason) ? error.reason : "invalid_output");
    return jsonError("model_unavailable", 502);
  }

  // Next signals prerender bail-outs and redirects by throwing; those must
  // reach the framework, not become a 500.
  unstable_rethrow(error);
  logUnexpected(error);
  return jsonError("internal");
}

// Unexpected exceptions may contain learner text or credentials from a lower
// layer. Never log their message, stack or arbitrary object fields.
function logUnexpected(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("[gloss] unexpected non-error thrown:", typeof error);
    return;
  }
  console.error("[gloss] unexpected server error");
}
