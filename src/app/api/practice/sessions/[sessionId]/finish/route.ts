import { PracticeSessionFinishResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonOk } from "@/server/http";
import { finishPracticeSession } from "@/server/practice/sessions";

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    return jsonOk(PracticeSessionFinishResponse.parse(finishPracticeSession(learner.id, sessionId)));
  } catch (error) {
    return errorResponse(error);
  }
}
