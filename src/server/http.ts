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
  budget_exhausted: 503,
  ai_disabled: 503,
  model_unavailable: 502,
  internal: 500,
};

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: "Please open your invite link to sign in.",
  not_found: "We could not find that.",
  invalid_request: "That request was not valid.",
  conflict: "That changed in the meantime. Please try again.",
  quota_exceeded: "You have used today's allowance for this feature. It resets at midnight UTC.",
  budget_exhausted: "Cloud checking is paused for today. Local checking still works.",
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
  if (error instanceof ModelTimeoutError || error instanceof ModelHttpError) {
    return jsonError("model_unavailable", 503);
  }
  if (error instanceof ModelOutputError) return jsonError("model_unavailable", 502);

  // Next signals prerender bail-outs and redirects by throwing; those must
  // reach the framework, not become a 500.
  unstable_rethrow(error);
  logUnexpected(error);
  return jsonError("internal");
}

// Server-side log line for an unexpected error: name, a capped message and a
// few stack frames. Our own errors never embed learner text, and the message
// is capped as a second guard.
function logUnexpected(error: unknown): void {
  if (!(error instanceof Error)) {
    console.error("[glossy] unexpected non-error thrown:", typeof error);
    return;
  }
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 6);
  console.error(`[glossy] ${error.name}: ${error.message.slice(0, 200)}\n${frames.join("\n")}`);
}
