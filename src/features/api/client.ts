import { PROVIDER_KEY_MESSAGE } from "@/shared/provider-key";
// Typed browser requests. Credentials are attached only to explicit cloud calls;
// shared response schemas keep malformed results out of the interface.
import { z } from "zod";
import { forgetProviderKey, getAccessSnapshot, getRequestProviderKey, isProviderKey, saveProviderKey, setCurrentSession } from "./access-store";
import {
  ApiError,
  CreateExpressionResponse,
  DetectResponse,
  DictationResponse,
  Evaluation,
  ExpressionsResponse,
  LearningResponse,
  WritingEvidenceResponse,
  MeResponse,
  PracticeTask,
  ProofreadResponse,
  SuggestionDecisionResponse,
  TranscribeResponse,
  type ApiErrorCode,
  type CreateExpressionRequest,
  type DetectSentenceRequest,
  type PracticeKind,
  type SubmitAttemptRequest,
  type SuggestionDecision,
  type WritingEvidenceRequest,
} from "@/shared/contracts";

// "network": the request never got an answer. "bad_response": the answer did
// not match the contract. Everything else is the server's own code.
export type FailureCode = ApiErrorCode | "network" | "bad_response";

export type ApiFailure = { ok: false; code: FailureCode; message: string };
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const PROVIDER_HEADER = "X-Gloss-Provider-Key";
const GuestAccessResponse = z.object({
  siteKey: z.string().nullable(),
  available: z.boolean(),
  action: z.string().max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type GuestBootstrapResult =
  | { kind: "ready" }
  | { kind: "turnstile"; siteKey: string; action?: string }
  | { kind: "unavailable"; message?: string };
let sessionEpoch = 0;
let meRequest: Promise<ApiResult<MeResponse>> | null = null;
let guestBootstrapRequest: Promise<GuestBootstrapResult> | null = null;
let guestSessionRequest: Promise<ApiResult<MeResponse>> | null = null;
let accessMutationQueue: Promise<void> = Promise.resolve();
let accessMutationEpoch = 0;

function queueAccessMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = accessMutationQueue.then(operation, operation);
  accessMutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

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

// The first page visit checks guest availability before creating a learner.
// Sharing this promise also protects development StrictMode from duplicate
// guest creation when several page components ask for the session together.
export function bootstrapGuestAccess(): Promise<GuestBootstrapResult> {
  if (guestBootstrapRequest) return guestBootstrapRequest;
  const mutationEpoch = accessMutationEpoch;
  const request = (async (): Promise<GuestBootstrapResult> => {
    const me = await getMe();
    if (me.ok) return { kind: "ready" };
    if (!isUnauthorized(me)) return { kind: "unavailable" };

    const access = await call("/api/access/guest", { method: "GET" }, GuestAccessResponse);
    if (mutationEpoch !== accessMutationEpoch) {
      return getAccessSnapshot().session ? { kind: "ready" } : { kind: "unavailable" };
    }
    if (!access.ok || !access.data.available) return { kind: "unavailable" };
    if (access.data.siteKey) return {
      kind: "turnstile",
      siteKey: access.data.siteKey,
      ...(access.data.action ? { action: access.data.action } : {}),
    };

    const created = await createGuestSession();
    return created.ok ? { kind: "ready" } : { kind: "unavailable", message: created.message };
  })();
  guestBootstrapRequest = request;
  void request.then(() => {
    if (guestBootstrapRequest === request) guestBootstrapRequest = null;
  });
  return request;
}

export function createGuestSession(turnstileToken?: string): Promise<ApiResult<MeResponse>> {
  const current = getAccessSnapshot().session;
  if (current) return Promise.resolve({ ok: true, data: current });
  if (guestSessionRequest) return guestSessionRequest;

  const mutationEpoch = accessMutationEpoch;
  const body = turnstileToken ? { turnstileToken } : {};
  const request = queueAccessMutation(async () => {
    const session = getAccessSnapshot().session;
    if (session) return { ok: true as const, data: session };
    if (mutationEpoch !== accessMutationEpoch) {
      return { ok: false as const, code: "unauthorized" as const, message: "Open Settings to add your own OpenRouter key and keep going." };
    }
    const result = await call("/api/access/guest", postJson(body), MeResponse);
    if (result.ok) {
      sessionEpoch += 1;
      meRequest = null;
      setCurrentSession(result.data);
    }
    return result;
  });
  guestSessionRequest = request;
  void request.then(() => {
    if (guestSessionRequest === request) guestSessionRequest = null;
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
    return { ok: false, code: "invalid_request", message: PROVIDER_KEY_MESSAGE };
  }
  // Mark the intent before waiting for an in-flight session read or guest
  // creation. Stale reads and guest bootstrap results must not win this race.
  accessMutationEpoch += 1;
  sessionEpoch += 1;
  meRequest = null;
  return queueAccessMutation(async () => {
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
  });
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

// Classifies changed sentences after a typing pause. Sentences are identified by
// the SHA-256 of their normalized text; the response carries probabilities only.
export function detect(sentences: DetectSentenceRequest[], requestId: string = newRequestId()) {
  return paidCall("/api/detect", postJson({ requestId, sentences }), DetectResponse);
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

export function learnExpressions(text: string, requestId: string = newRequestId()) {
  return paidCall("/api/learning", postJson({ requestId, text }), LearningResponse);
}

export function recordWritingEvidence(input: WritingEvidenceRequest) {
  return call("/api/expressions/writing", postJson(input), WritingEvidenceResponse);
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

// Same audio format as transcribe. Returns text ready to insert where the learner writes.
export function dictate(audio: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.set("audio", audio, "dictation.wav");
  return paidCall("/api/speech/dictate", { method: "POST", body: form, signal }, DictationResponse);
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
