import { PracticeSessionAnswerResponse, PracticeSessionReactionRequest } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { recordPracticeReaction } from "@/server/practice/sessions";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const learner = await requireLearner();
    const { sessionId } = await context.params;
    let input: PracticeSessionReactionRequest;
    try {
      input = PracticeSessionReactionRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }
    return jsonOk(PracticeSessionAnswerResponse.parse(recordPracticeReaction(learner.id, sessionId, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
