import type { ApiResult } from "@/features/api/client";
import type {
  PracticeFrequencyBand,
  PracticeReaction,
  PracticeSessionAnswerRequest,
  PracticeSessionAnswerResponse,
  PracticeSessionExercise,
  PracticeSessionFinishResponse,
  PracticeSessionHintRequest,
  PracticeSessionHintResponse,
  PracticeSessionNextResponse,
  PracticeSessionReadiness,
  PracticeSessionReactionRequest,
} from "@/shared/contracts";
import type { PracticeSessionClient } from "./practice-session-client";

export type PracticeFixtureName =
  | "flow"
  | "preparing"
  | "recognise"
  | "meaning"
  | "gap"
  | "recall"
  | "correct"
  | "wrong"
  | "end"
  | "waiting"
  | "error";

type FixtureExercise = PracticeSessionExercise & {
  answer: string;
  word: string;
  frequency: PracticeFrequencyBand;
  ipa: string;
  meaning: string;
  example: string;
};

export const fixtureSessionId = "11111111-1111-4111-8111-111111111111";

export const practiceFixtureExercises: readonly FixtureExercise[] = [
  {
    exerciseId: "22222222-2222-4222-8222-222222222220",
    rung: 1,
    sentence: "The slow approval became a bottleneck for the team.",
    prompt: "What does bottleneck mean here?",
    options: ["A point that slows progress", "An early finish", "A clear decision", "A helpful shortcut"],
    answer: "A point that slows progress",
    word: "bottleneck",
    frequency: "common",
    ipa: "/ˈbɑtəlˌnɛk/",
    meaning: "A point that slows progress",
    example: "The slow approval became a bottleneck for the team.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222221",
    rung: 2,
    sentence: "Continuing at a regular, even pace.",
    prompt: "Choose the word for this meaning.",
    options: ["brief", "steady", "rare", "uncertain"],
    answer: "steady",
    word: "steady",
    frequency: "common",
    ipa: "/ˈstɛdi/",
    meaning: "Continuing at a regular, even pace",
    example: "A steady rhythm helped us finish on time.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222222",
    rung: 3,
    sentence: "Please keep your summary ___ and clear.",
    prompt: "Choose the word that fits.",
    options: ["distant", "costly", "concise", "uneven"],
    answer: "concise",
    word: "concise",
    frequency: "common",
    ipa: "/kənˈsaɪs/",
    meaning: "Using few words while staying clear",
    example: "Her concise note made the plan easy to follow.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222223",
    rung: 4,
    sentence: "Change your approach to fit new information.",
    prompt: "Type the word for this meaning.",
    options: null,
    answer: "adapt",
    word: "adapt",
    frequency: "common",
    ipa: "/əˈdæpt/",
    meaning: "Change to fit a new situation",
    example: "We had to adapt when the schedule changed.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222224",
    rung: 1,
    sentence: "The small nuance changed how the message sounded.",
    prompt: "What does nuance mean here?",
    options: ["A subtle difference", "A loud warning", "A final result", "A long delay"],
    answer: "A subtle difference",
    word: "nuance",
    frequency: "uncommon",
    ipa: "/ˈnuːɑːns/",
    meaning: "A small difference in meaning or feeling",
    example: "The small nuance changed how the message sounded.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222225",
    rung: 2,
    sentence: "The result of an action or process.",
    prompt: "Choose the word for this meaning.",
    options: ["outcome", "shortcut", "bottleneck", "signal"],
    answer: "outcome",
    word: "outcome",
    frequency: "common",
    ipa: "/ˈaʊtˌkʌm/",
    meaning: "The result of an action or process",
    example: "The outcome was better than we expected.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222226",
    rung: 3,
    sentence: "We need a ___ source that gives consistent results.",
    prompt: "Choose the word that fits.",
    options: ["reliable", "brief", "uncertain", "distant"],
    answer: "reliable",
    word: "reliable",
    frequency: "common",
    ipa: "/rɪˈlaɪəbəl/",
    meaning: "Able to be trusted to work well",
    example: "We need a reliable source that gives consistent results.",
  },
  {
    exerciseId: "22222222-2222-4222-8222-222222222227",
    rung: 4,
    sentence: "Make an idea easier to understand.",
    prompt: "Type the word for this meaning.",
    options: null,
    answer: "clarify",
    word: "clarify",
    frequency: "common",
    ipa: "/ˈklærəˌfaɪ/",
    meaning: "Make an idea easier to understand",
    example: "Could you clarify what happens next?",
  },
];

export const fixtureReactionLabels: Record<PracticeReaction, string> = {
  already_know: "I already know this",
  too_easy: "This was too easy",
  not_relevant: "This is not relevant",
  too_hard: "This was too hard",
};

const ALL_REACTIONS: PracticeReaction[] = ["already_know", "too_easy", "not_relevant", "too_hard"];

const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });

const failure = (message: string): ApiResult<never> => ({ ok: false, code: "internal", message });

function readiness(ready: number, status: PracticeSessionReadiness["status"]): PracticeSessionReadiness {
  return { sessionId: fixtureSessionId, ready, total: 8, status, canStart: ready >= 3 };
}

function answerView(exercise: FixtureExercise, correct: boolean, reaction: PracticeReaction | null = null): PracticeSessionAnswerResponse {
  return {
    answer: {
      exerciseId: exercise.exerciseId,
      correct,
      word: exercise.word,
      frequency: exercise.frequency,
      ipa: exercise.ipa,
      meaning: exercise.meaning,
      example: exercise.example,
      comesBackText: correct ? "in 2 days" : "tomorrow",
      allowedReactions: ALL_REACTIONS,
      reaction,
    },
  };
}

export function createFixturePracticeClient(name: PracticeFixtureName): PracticeSessionClient {
  let readyCount = name === "flow" || name === "waiting" ? 3 : 8;
  const startIndex = name === "recognise" ? 0
    : name === "meaning" ? 1
    : name === "gap" ? 2
      : name === "recall" ? 3
        : name === "correct" || name === "wrong" ? 3
          : -1;
  let cursor = startIndex + 1;
  let answered = name === "correct" || name === "wrong" ? 1 : 0;
  let correctCount = name === "correct" ? 1 : 0;
  let lastExercise: FixtureExercise | null = startIndex >= 0 ? practiceFixtureExercises[startIndex] : null;
  let lastAnswer: PracticeSessionAnswerResponse | null = name === "correct" || name === "wrong"
    ? answerView(practiceFixtureExercises[startIndex], name === "correct")
    : null;
  let waitingShown = false;

  return {
    async prepare() {
      if (name === "error") return failure("Practice could not be prepared.");
      if (name === "preparing") return ok(readiness(2, "preparing"));
      return ok(readiness(readyCount, readyCount === 8 ? "ready" : "preparing"));
    },
    async readiness() {
      if (name === "preparing") return ok(readiness(2, "preparing"));
      readyCount = Math.min(8, readyCount + 1);
      return ok(readiness(readyCount, readyCount === 8 ? "ready" : "preparing"));
    },
    async next(): Promise<ApiResult<PracticeSessionNextResponse>> {
      if (name === "error") return failure("Practice could not be prepared.");
      if (name === "waiting" && !waitingShown) {
        waitingShown = true;
        return ok({ status: "waiting", exercise: null });
      }
      if (cursor >= practiceFixtureExercises.length) return ok({ status: "complete", exercise: null });
      if (cursor >= readyCount) return ok({ status: "waiting", exercise: null });
      lastExercise = practiceFixtureExercises[cursor];
      cursor += 1;
      const exercise: PracticeSessionExercise = {
        exerciseId: lastExercise.exerciseId,
        rung: lastExercise.rung,
        sentence: lastExercise.sentence,
        prompt: lastExercise.prompt,
        options: lastExercise.options,
      };
      return ok({ status: "ready", exercise });
    },
    async answer(_sessionId: string, input: PracticeSessionAnswerRequest) {
      if (!lastExercise || input.exerciseId !== lastExercise.exerciseId) return failure("That answer is no longer available.");
      const correct = !input.dontKnow && input.answer.trim().toLocaleLowerCase() === lastExercise.answer.toLocaleLowerCase();
      lastAnswer = answerView(lastExercise, correct);
      answered += 1;
      if (correct) correctCount += 1;
      return ok(lastAnswer);
    },
    async hint(_sessionId: string, input: PracticeSessionHintRequest): Promise<ApiResult<PracticeSessionHintResponse>> {
      if (!lastExercise || input.exerciseId !== lastExercise.exerciseId) return failure("That hint is no longer available.");
      return ok({ exerciseId: input.exerciseId, hint: `Starts with ${lastExercise.word[0]}: ${lastExercise.meaning.toLowerCase()}` });
    },
    async reaction(_sessionId: string, input: PracticeSessionReactionRequest) {
      if (!lastExercise || !lastAnswer || input.exerciseId !== lastExercise.exerciseId) return failure("That reaction is no longer available.");
      lastAnswer = {
        answer: {
          ...lastAnswer.answer,
          reaction: input.reaction,
          comesBackText: input.reaction === "not_relevant" ? "hidden from practice" : lastAnswer.answer.comesBackText,
        },
      };
      return ok(lastAnswer);
    },
    async finish(): Promise<ApiResult<PracticeSessionFinishResponse>> {
      return ok({
        sessionId: fixtureSessionId,
        summary: `${answered || 8} words in 6 minutes.`,
        correct: correctCount,
        answered: answered || 8,
        total: 8,
        durationSeconds: 360,
        durationMinutes: 6,
      });
    },
  };
}
