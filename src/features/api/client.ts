// Typed fetch helpers for the Glossy API. Client-only: it uses the session
// cookie the browser already holds and never sees a secret. Every response is
// parsed with the shared zod schema, so a mismatch becomes a clean failure
// instead of undefined behaviour further down.
import type { z } from "zod";
import {
  ApiError,
  CreateExpressionResponse,
  Evaluation,
  ExpressionsResponse,
  MeResponse,
  PracticeTask,
  ProofreadResponse,
  SuggestionDecisionResponse,
  TranscribeResponse,
  type ApiErrorCode,
  type CreateExpressionRequest,
  type PracticeKind,
  type SubmitAttemptRequest,
  type SuggestionDecision,
} from "@/shared/contracts";

// "network": the request never got an answer. "bad_response": the answer did
// not match the contract. Everything else is the server's own code.
export type FailureCode = ApiErrorCode | "network" | "bad_response";

export type ApiFailure = { ok: false; code: FailureCode; message: string };
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

// RFC 4122 v4 id. crypto.randomUUID only exists on secure origins, and the dev
// server is often opened by IP address.
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function call<S extends z.ZodType>(path: string, init: RequestInit, schema: S): Promise<ApiResult<z.infer<S>>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch {
    return { ok: false, code: "network", message: "We couldn't reach Glossy. Check your connection." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const parsed = ApiError.safeParse(body);
    if (parsed.success) return { ok: false, code: parsed.data.error.code, message: parsed.data.error.message };
    return { ok: false, code: "internal", message: GENERIC_MESSAGE };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, code: "bad_response", message: GENERIC_MESSAGE };
  return { ok: true, data: parsed.data };
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function getMe() {
  return call("/api/me", { method: "GET" }, MeResponse);
}

export function proofread(text: string, requestId: string = newRequestId()) {
  return call("/api/proofread", postJson({ requestId, text }), ProofreadResponse);
}

export function recordDecision(suggestionId: string, decision: SuggestionDecision, textHash: string) {
  return call(`/api/suggestions/${encodeURIComponent(suggestionId)}`, postJson({ decision, textHash }), SuggestionDecisionResponse);
}

export function createExpression(request: CreateExpressionRequest) {
  return call("/api/expressions", postJson(request), CreateExpressionResponse);
}

export function listExpressions() {
  return call("/api/expressions", { method: "GET" }, ExpressionsResponse);
}

export function createTask(expressionId: string, kind: PracticeKind, requestId: string = newRequestId()) {
  return call("/api/practice/tasks", postJson({ requestId, expressionId, kind }), PracticeTask);
}

// `audio` must be RIFF/WAVE mono 16-bit PCM (see src/features/speech/wav.ts).
export function transcribe(attemptId: string, audio: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.set("attemptId", attemptId);
  form.set("audio", audio, "answer.wav");
  return call("/api/speech/transcribe", { method: "POST", body: form, signal }, TranscribeResponse);
}

export function submitAttempt(attemptId: string, request: SubmitAttemptRequest) {
  return call(`/api/practice/attempts/${encodeURIComponent(attemptId)}`, postJson(request), Evaluation);
}

export function isUnauthorized(failure: ApiFailure): boolean {
  return failure.code === "unauthorized";
}

// Cloud features are off for today (kill switch or spent budget).
export function isAiOff(failure: ApiFailure): boolean {
  return failure.code === "ai_disabled" || failure.code === "budget_exhausted";
}

export function isQuota(failure: ApiFailure): boolean {
  return failure.code === "quota_exceeded";
}
