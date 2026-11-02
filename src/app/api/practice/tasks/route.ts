import { CreateTaskRequest, PracticeTask } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { createTask } from "@/server/practice/tasks";

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: CreateTaskRequest;
    try {
      input = CreateTaskRequest.parse(await request.json());
    } catch {
      return jsonError("invalid_request");
    }

    return jsonOk(PracticeTask.parse(await createTask(learner, input)));
  } catch (error) {
    return errorResponse(error);
  }
}
