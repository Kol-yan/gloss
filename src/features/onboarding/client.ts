import { z } from "zod";
import { CefrLevel, OnboardingCompletionResponse, WordCheckAnswersResponse, WordCheckResponse, type OnboardingLevelGroup, type WordCheckAnswerInput } from "@/shared/contracts";
import type { ApiResult } from "@/features/api/client";

// Onboarding is local vocabulary work: no provider credentials or model calls.
async function request<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<ApiResult<z.infer<S>>> {
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const parsed = schema.safeParse(await response.json());
    if (response.ok && parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, code: response.status === 401 ? "unauthorized" : "bad_response", message: "We couldn't save that. Please try again." };
  } catch {
    return { ok: false, code: "network", message: "We couldn't connect. Check your connection and try again." };
  }
}

export const onboardingClient = {
  level: (level: OnboardingLevelGroup) => request("/api/onboarding/level", CefrLevel, { level }),
  round: () => request("/api/onboarding/word-check", WordCheckResponse),
  answer: (answers: WordCheckAnswerInput[]) => request("/api/onboarding/word-check", WordCheckAnswersResponse, { answers }),
  complete: () => request("/api/onboarding/complete", OnboardingCompletionResponse, {}),
};
export type OnboardingClient = typeof onboardingClient;
