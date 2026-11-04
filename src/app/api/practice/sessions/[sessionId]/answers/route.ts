import { PracticeSessionAnswerRequest, PracticeSessionAnswerResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { submitPracticeAnswer } from "@/server/practice/sessions";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    let input: PracticeSessionAnswerRequest;
    try {
      input = PracticeSessionAnswerRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }
    return jsonOk(PracticeSessionAnswerResponse.parse(submitPracticeAnswer(learner.id, sessionId, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
