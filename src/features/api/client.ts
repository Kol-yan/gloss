// Typed browser requests. Credentials are attached only to explicit cloud calls;
// shared response schemas keep malformed results out of the interface.
import { z } from "zod";
import { forgetProviderKey, getAccessSnapshot, getRequestProviderKey, isProviderKey, saveProviderKey, setCurrentSession } from "./access-store";
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
const PROVIDER_HEADER = "X-Gloss-Provider-Key";
let sessionEpoch = 0;
let meRequest: Promise<ApiResult<MeResponse>> | null = null;

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

async function call<S extends z.ZodType>(path: string, init: RequestInit, schema: S, privateKey = ""): Promise<ApiResult<z.infer<S>>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch {
    return { ok: false, code: "network", message: "We couldn't reach gloss. Check your connection." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (privateKey && JSON.stringify(body)?.includes(privateKey)) {
    return { ok: false, code: "bad_response", message: GENERIC_MESSAGE };
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

export function getMe(): Promise<ApiResult<MeResponse>> {
  if (meRequest) return meRequest;
  const epoch = sessionEpoch;
  const request = call("/api/me", { method: "GET" }, MeResponse).then((result) => {
    if (epoch === sessionEpoch) {
      if (result.ok) setCurrentSession(result.data);
      else if (isUnauthorized(result)) setCurrentSession(null);
    }
    return result;
  });
  meRequest = request;
  void request.then(() => {
    if (meRequest === request) meRequest = null;
  });
  return request;
}

async function paidCall<S extends z.ZodType>(path: string, init: RequestInit, schema: S): Promise<ApiResult<z.infer<S>>> {
  if (!getAccessSnapshot().session) {
    const me = await getMe();
    if (!me.ok) return me;
  }
  const key = getRequestProviderKey();
  const headers = new Headers(init.headers);
  if (key) headers.set(PROVIDER_HEADER, key);
  return call(path, { ...init, headers }, schema, key);
}

export async function enrollByok(value: string): Promise<ApiResult<MeResponse>> {
  const key = value.trim();
  if (!isProviderKey(key)) {
    return { ok: false, code: "invalid_request", message: "Enter your OpenRouter key without spaces." };
  }
  const init = postJson({});
  const headers = new Headers(init.headers);
  headers.set(PROVIDER_HEADER, key);
  const result = await call("/api/access/byok", { ...init, headers }, MeResponse, key);
  if (result.ok) {
    sessionEpoch += 1;
    meRequest = null;
    if (result.data.accessMode === "byok") saveProviderKey(key);
    setCurrentSession(result.data);
  }
  return result;
}

export async function signOut() {
  const result = await call("/api/access/signout", postJson({}), z.object({ ok: z.literal(true) }));
  if (result.ok) {
    sessionEpoch += 1;
    meRequest = null;
    forgetProviderKey();
    setCurrentSession(null);
  }
  return result;
}

export function proofread(text: string, requestId: string = newRequestId()) {
  return paidCall("/api/proofread", postJson({ requestId, text }), ProofreadResponse);
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
  return paidCall("/api/practice/tasks", postJson({ requestId, expressionId, kind }), PracticeTask);
}

// `audio` must be RIFF/WAVE mono 16-bit PCM (see src/features/speech/wav.ts).
export function transcribe(attemptId: string, audio: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.set("attemptId", attemptId);
  form.set("audio", audio, "answer.wav");
  return paidCall("/api/speech/transcribe", { method: "POST", body: form, signal }, TranscribeResponse);
}

export function submitAttempt(attemptId: string, request: SubmitAttemptRequest) {
  return paidCall(`/api/practice/attempts/${encodeURIComponent(attemptId)}`, postJson(request), Evaluation);
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
