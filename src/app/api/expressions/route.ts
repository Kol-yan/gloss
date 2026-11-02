import {
  CreateExpressionRequest,
  CreateExpressionResponse,
  ExpressionsResponse,
} from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { createExpression, listExpressions } from "@/server/practice/expressions";

export async function GET() {
  try {
    const learner = await requireLearner();
    return jsonOk(ExpressionsResponse.parse(listExpressions(learner)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: CreateExpressionRequest;
    try {
      input = CreateExpressionRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(CreateExpressionResponse.parse(createExpression(learner, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
