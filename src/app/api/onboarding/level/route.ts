import { CefrLevel, OnboardingLevelRequest } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { recordChosenLevel } from "@/server/learning/onboarding/word-check";

// The Level step of onboarding: the learner picks a starting CEFR level, which
// becomes `learners.level` and is the starting point for the first Word check
// round. It has no GET: the stored level is part of the Word check response.
//
// The choice is not final. Word check answers refine the level from their own
// evidence on every POST (see estimateLevel), so the explicit choice only
// decides the first round and stays until answers exist.

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    const raw = await request.text();
    if (raw.length > 1024) return jsonError("invalid_request");
    let input;
    try {
      input = OnboardingLevelRequest.parse(JSON.parse(raw));
    } catch {
      return jsonError("invalid_request");
    }
    const level = recordChosenLevel(learner.id, input.level);
    return jsonOk(CefrLevel.parse(level));
  } catch (error) {
    return errorResponse(error);
  }
}
