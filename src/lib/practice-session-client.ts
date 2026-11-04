import { getMe, type ApiResult } from "@/features/api/client";
import { getAccessSnapshot, getRequestProviderKey } from "@/features/api/access-store";
import {
  ApiError,
  PracticeSessionAnswerResponse,
  PracticeSessionFinishResponse,
  PracticeSessionHintResponse,
  PracticeSessionNextResponse,
  PracticeSessionReadiness,
  type PracticeSessionAnswerRequest,
  type PracticeSessionAnswerResponse as PracticeAnswerResponse,
  type PracticeSessionFinishResponse as PracticeFinishResponse,
  type PracticeSessionHintRequest,
  type PracticeSessionHintResponse as PracticeHintResponse,
  type PracticeSessionNextResponse as PracticeNextResponse,
  type PracticeSessionPrepareRequest,
  type PracticeSessionReadiness as PracticeReadiness,
  type PracticeSessionReactionRequest,
} from "@/shared/contracts";
import { z } from "zod";

export type PracticeCallOptions = { signal?: AbortSignal };

export interface PracticeSessionClient {
  prepare(request: PracticeSessionPrepareRequest, options?: PracticeCallOptions): Promise<ApiResult<PracticeReadiness>>;
  readiness(sessionId: string, options?: PracticeCallOptions): Promise<ApiResult<PracticeReadiness>>;
  next(sessionId: string, options?: PracticeCallOptions): Promise<ApiResult<PracticeNextResponse>>;
  answer(sessionId: string, request: PracticeSessionAnswerRequest, options?: PracticeCallOptions): Promise<ApiResult<PracticeAnswerResponse>>;
  hint(sessionId: string, request: PracticeSessionHintRequest, options?: PracticeCallOptions): Promise<ApiResult<PracticeHintResponse>>;
  reaction(sessionId: string, request: PracticeSessionReactionRequest, options?: PracticeCallOptions): Promise<ApiResult<PracticeAnswerResponse>>;
  finish(sessionId: string, options?: PracticeCallOptions): Promise<ApiResult<PracticeFinishResponse>>;
}

const SAFE_FAILURE = "We couldn't finish that request. Please try again.";

async function request<S extends z.ZodType>(
  path: string,
  init: RequestInit,
  schema: S,
  options?: PracticeCallOptions,
  needsProviderKey = false,
): Promise<ApiResult<z.infer<S>>> {
  const access = getAccessSnapshot();
  if (!access.session) {
    const session = await getMe();
    if (!session.ok) return session as ApiResult<z.infer<S>>;
  }

  const key = needsProviderKey ? getRequestProviderKey() : "";
  const headers = new Headers(init.headers);
  if (key) headers.set("X-Gloss-Provider-Key", key);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "same-origin",
      signal: options?.signal,
    });
  } catch {
    return { ok: false, code: "network", message: "We couldn't reach gloss. Check your connection." };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (key && JSON.stringify(body)?.includes(key)) {
    return { ok: false, code: "bad_response", message: SAFE_FAILURE };
  }

  if (!response.ok) {
    const failure = ApiError.safeParse(body);
    if (failure.success) return { ok: false, code: failure.data.error.code, message: failure.data.error.message };
    return { ok: false, code: "internal", message: SAFE_FAILURE };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, code: "bad_response", message: SAFE_FAILURE };
  return { ok: true, data: parsed.data };
}

function postJson(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export const livePracticeSessionClient: PracticeSessionClient = {
  prepare: (input, options) => request("/api/practice/sessions", postJson(input), PracticeSessionReadiness, options, true),
  readiness: (sessionId, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" }, PracticeSessionReadiness, options, true),
  next: (sessionId, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/next`, { method: "GET" }, PracticeSessionNextResponse, options),
  answer: (sessionId, input, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/answers`, postJson(input), PracticeSessionAnswerResponse, options),
  hint: (sessionId, input, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/hint`, postJson(input), PracticeSessionHintResponse, options),
  reaction: (sessionId, input, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/reactions`, postJson(input), PracticeSessionAnswerResponse, options),
  finish: (sessionId, options) => request(`/api/practice/sessions/${encodeURIComponent(sessionId)}/finish`, { method: "POST" }, PracticeSessionFinishResponse, options),
};
