import { CreateTaskRequest, PracticeTask } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { createTask } from "@/server/practice/tasks";
import { providerAccessFromRequest } from "@/server/models/access";

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: CreateTaskRequest;
    try {
      input = CreateTaskRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(PracticeTask.parse(await createTask(learner, input, {
      providerAccess: providerAccessFromRequest(request, learner),
    })));
  } catch (error) {
    return errorResponse(error);
  }
}
