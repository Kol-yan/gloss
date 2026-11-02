import { Evaluation, SubmitAttemptRequest } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { submitAttempt } from "@/server/practice/attempts";

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  try {
    const learner = await requireLearner();
    const { attemptId } = await context.params;

    let input: SubmitAttemptRequest;
    try {
      input = SubmitAttemptRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(Evaluation.parse(await submitAttempt(learner, attemptId, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
