// Errors raised by model adapters. None of them carries provider response
// bodies or learner text, so they are safe to log.

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  // Cost the provider itself reported for the call, in micro-dollars. When
  // present it replaces tokens times the configured price.
  costMicros?: number;
}

// The outcome of the call is unknown: the provider may have done the work and
// billed for it. The budget reservation must stay counted.
export class ModelTimeoutError extends Error {
  constructor(
    readonly reason: "timeout" | "aborted" | "network",
    readonly latencyMs: number,
  ) {
    super(`Model call outcome unknown (${reason})`);
    this.name = "ModelTimeoutError";
  }
}

// The provider answered with a non-2xx status: a definite failure, no work billed.
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    readonly latencyMs: number,
  ) {
    super(`Model provider answered HTTP ${status}`);
    this.name = "ModelHttpError";
  }
}

// The provider answered, but the content is unusable (not JSON, wrong shape,
// truncated). The work was done and billed, so usage is kept for settling.
export class ModelOutputError extends Error {
  constructor(
    readonly reason: string,
    readonly usage: TokenUsage | null,
    readonly latencyMs: number,
    readonly servingProvider?: string,
  ) {
    super(`Model output rejected (${reason})`);
    this.name = "ModelOutputError";
  }
}

// The operator has not configured the provider (no API key).
export class ModelNotConfiguredError extends Error {
  constructor() {
    super("Model provider is not configured");
    this.name = "ModelNotConfiguredError";
  }
}

// No price is known for the model, so no cost upper bound exists: no call.
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`No price configured for model ${model}`);
    this.name = "UnknownModelError";
  }
}
