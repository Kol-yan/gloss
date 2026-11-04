// Typed server errors. Route handlers map them to ApiError responses in
// `src/server/http.ts`; none of them carries text meant for learners.
import type { QuotaKind } from "@/shared/contracts";

export class UnauthorizedError extends Error {
  constructor() {
    super("No valid session");
    this.name = "UnauthorizedError";
  }
}

export type InvalidInviteReason = "unknown" | "expired" | "used_up";

export class InvalidInviteError extends Error {
  constructor(readonly reason: InvalidInviteReason) {
    super(`Invite rejected: ${reason}`);
    this.name = "InvalidInviteError";
  }
}

export class QuotaExceededError extends Error {
  constructor(
    readonly kind: QuotaKind,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Daily quota for ${kind} exceeded (${used}/${limit})`);
    this.name = "QuotaExceededError";
  }
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs = 0) {
    super("Request rate limit reached");
    this.name = "RateLimitedError";
  }
}

// The instance-wide daily spend ceiling would be crossed.
export class BudgetExhaustedError extends Error {
  constructor() {
    super("Daily budget ceiling reached");
    this.name = "BudgetExhaustedError";
  }
}

// The kill switch (AI_ENABLED or the runtime setting) is off.
export class AiDisabledError extends Error {
  constructor() {
    super("Cloud model calls are disabled");
    this.name = "AiDisabledError";
  }
}

// The target exists but its state does not allow the request, e.g. the same
// request id reused for different text, or a decision that contradicts an
// earlier final one.
export class ConflictError extends Error {
  constructor(message = "Request conflicts with the current state") {
    super(message);
    this.name = "ConflictError";
  }
}

// The row does not exist, or belongs to another learner. The two cases are
// deliberately indistinguishable.
export class NotFoundError extends Error {
  constructor() {
    super("Not found");
    this.name = "NotFoundError";
  }
}

export class InvalidRequestError extends Error {
  constructor(message = "Invalid request") {
    super(message);
    this.name = "InvalidRequestError";
  }
}
