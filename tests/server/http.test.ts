import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiErrorCode } from "@/shared/contracts";
import {
  AiDisabledError,
  BudgetExhaustedError,
  ConflictError,
  InvalidInviteError,
  InvalidRequestError,
  NotFoundError,
  QuotaExceededError,
  UnauthorizedError,
} from "@/server/errors";
import { errorResponse, jsonError } from "@/server/http";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
} from "@/server/models/errors";

describe("jsonError", () => {
  it("produces a valid ApiError for every code with a short message", async () => {
    for (const code of ApiErrorCode.options) {
      const response = jsonError(code);
      const body = ApiError.parse(await response.json());
      expect(body.error.code).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(5);
      expect(body.error.message.length).toBeLessThan(100);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("allows overriding status and message", async () => {
    const response = jsonError("conflict", 412, "Try later.");
    expect(response.status).toBe(412);
    expect((await response.json()).error.message).toBe("Try later.");
  });
});

describe("errorResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps typed errors to ApiError responses", async () => {
    const cases: [unknown, number, string][] = [
      [new UnauthorizedError(), 401, "unauthorized"],
      [new QuotaExceededError("proofread", 20, 20), 429, "quota_exceeded"],
      [new BudgetExhaustedError(), 503, "budget_exhausted"],
      [new AiDisabledError(), 503, "ai_disabled"],
      [new InvalidInviteError("expired"), 404, "not_found"],
      [new NotFoundError(), 404, "not_found"],
      [new ConflictError(), 409, "conflict"],
      [new InvalidRequestError(), 400, "invalid_request"],
      [new ModelTimeoutError("timeout", 20_000), 503, "model_unavailable"],
      [new ModelHttpError(500, 80), 503, "model_unavailable"],
      [new ModelOutputError("invalid_output", null, 80), 502, "model_unavailable"],
    ];
    for (const [error, status, code] of cases) {
      const response = errorResponse(error);
      expect(response.status).toBe(status);
      expect(ApiError.parse(await response.json()).error.code).toBe(code);
    }
  });

  it("treats operator misconfiguration as ai_disabled and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [new ModelNotConfiguredError(), new UnknownModelError("x-1")]) {
      const response = errorResponse(error);
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("ai_disabled");
    }
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never leaks internal error text", async () => {
    const body = JSON.stringify(await errorResponse(new QuotaExceededError("proofread", 20, 20)).json());
    expect(body).not.toContain("20/20");
    expect(body).not.toContain("QuotaExceededError");
  });

  it("logs only safe provider status or timeout metadata", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorResponse(new ModelHttpError(429, 80));
    errorResponse(new ModelTimeoutError("timeout", 20_000));
    expect(log.mock.calls).toEqual([
      ["[gloss] model provider status:", 429],
      ["[gloss] model request incomplete:", "timeout", 20_000],
    ]);
  });

  it("answers unexpected errors with a generic 500 and logs without the full text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(new Error("provider said: key sk-123 invalid"));
    expect(response.status).toBe(500);
    const body = ApiError.parse(await response.json());
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("sk-123");
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sk-123");

    expect(errorResponse("boom").status).toBe(500);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("rethrows Next control-flow errors instead of answering 500", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/;307;",
    });
    expect(() => errorResponse(redirect)).toThrow(redirect);
    expect(log).not.toHaveBeenCalled();
  });

  it("caps the logged message length", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    errorResponse(new Error("x".repeat(5000)));
    expect(String(log.mock.calls[0][0]).length).toBeLessThan(1500);
  });
});
