import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { completeOnboarding } from "@/server/learning/onboarding/completion";
import { OnboardingCompletionRequest, OnboardingCompletionResponse } from "@/shared/contracts";

const MAX_BODY_BYTES = 128;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return jsonError("invalid_request");

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonError("invalid_request");
    }
    if (!OnboardingCompletionRequest.safeParse(body).success) {
      return jsonError("invalid_request");
    }

    completeOnboarding(learner.id);
    return jsonOk(OnboardingCompletionResponse.parse({ completed: true }));
  } catch (error) {
    return errorResponse(error);
  }
}
