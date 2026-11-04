import { PracticeSessionNextResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonOk } from "@/server/http";
import { nextPracticeExercise } from "@/server/practice/sessions";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    return jsonOk(PracticeSessionNextResponse.parse(nextPracticeExercise(learner.id, sessionId)));
  } catch (error) {
    return errorResponse(error);
  }
}
