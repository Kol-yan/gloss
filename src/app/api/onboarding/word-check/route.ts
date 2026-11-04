import { WordCheckAnswersRequest, WordCheckAnswersResponse, WordCheckResponse } from "@/shared/contracts";
import { requireLearner } from "@/server/auth/request";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { pickWordCheckEntries, recordWordCheckAnswers } from "@/server/learning/onboarding/word-check";

// The Word check step of onboarding. GET serves the 24 starter entries around
// the learner's level, so the answers find the edge between passive and active
// vocabulary; a reload within the same round returns the same entries with the
// answers already given, so nothing answered is asked again. POST stores the
// answers and the level estimate. The Goals and topics step has no API:
// personal relevance comes from these answers.
//
// Both handlers authenticate first. A learner only ever reads or writes their
// own rounds; the POST accepts ids only from rounds this learner was served.

export async function GET() {
  try {
    const learner = await requireLearner();
    const round = pickWordCheckEntries(learner.id);
    return jsonOk(WordCheckResponse.parse(round));
  } catch (error) {
    return errorResponse(error);
  }
}

// At most 24 small answer objects; anything larger is not a Word check round.
const MAX_BODY_BYTES = 4096;

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return jsonError("invalid_request");
    let input;
    try {
      input = WordCheckAnswersRequest.parse(JSON.parse(raw));
    } catch {
      return jsonError("invalid_request");
    }
    const result = recordWordCheckAnswers(learner.id, input.answers);
    return jsonOk(WordCheckAnswersResponse.parse(result));
  } catch (error) {
    return errorResponse(error);
  }
}
