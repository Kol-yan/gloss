// Simulated model providers for end-to-end tests. Used only when
// GLOSSY_MODEL_MOCK=true; it is off by default and must stay off in any real
// deployment. It replaces the network call in sendProviderRequest and nothing
// else, so routing, budget reservations, response parsing and error handling
// run exactly as in production. Answers are deterministic and depend only on
// the request. This module has no imports so that tests can read its
// constants without loading the server.

// Learner text containing one of these makes the simulated provider fail in
// that way, so tests can check what a learner sees when a provider breaks.
export const MOCK_FAILURE_MARKERS = {
  // HTTP 500 with a raw error body.
  http: "mock-provider-http-error",
  // The connection drops before an answer arrives.
  network: "mock-provider-network-error",
  // HTTP 200 with a body that is not a provider answer.
  output: "mock-provider-bad-output",
} as const;

export type MockFailure = keyof typeof MOCK_FAILURE_MARKERS;

// Provider detail carried by the failures above. It must never reach a learner.
export const MOCK_RAW_ERROR_DETAIL = "Traceback (most recent call last): mock upstream worker crashed";

// Spelling mistakes the simulated proofreader corrects. The on-device checker
// leaves spelling alone, so these never compete with a local suggestion.
export const MOCK_CORRECTIONS = [
  { wrong: "recieve", right: "receive", reason: "“Receive” is spelled with “ei” after “c”." },
  { wrong: "untill", right: "until", reason: "“Until” ends with a single “l”." },
  { wrong: "definately", right: "definitely", reason: "“Definitely” is spelled with “ite” in the middle." },
] as const;

// Words the simulated proofreader offers a more precise expression for.
export const MOCK_EXPRESSIONS = [
  {
    original: "fix",
    replacement: "resolve",
    meaning: "to find a solution to a problem",
    ipa: "/rɪˈzɑlv/",
    reason: "“Resolve” sounds more precise when you talk about problems at work.",
  },
] as const;

export const MOCK_SITUATION =
  "A teammate asks how you plan to handle a delay on a shared project. Answer in one or two sentences.";

export const MOCK_TRANSCRIPT = "i will send the report tomorrow";

let announced = false;

export async function mockProviderFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!announced) {
    announced = true;
    console.warn("[gloss] GLOSSY_MODEL_MOCK is on: model providers are simulated");
  }
  if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

  const path = new URL(url).pathname;
  if (path.endsWith("/asr/transcribe")) return Response.json({ transcript: MOCK_TRANSCRIPT });
  if (path.endsWith("/audio/transcriptions")) return Response.json({ text: MOCK_TRANSCRIPT });
  if (!path.endsWith("/chat/completions") || typeof init.body !== "string") {
    return new Response("Not found", { status: 404 });
  }

  const request = record(JSON.parse(init.body));
  const messages = Array.isArray(request.messages) ? request.messages.map(record) : [];
  const textOf = (role: string) =>
    messages.filter((m) => m.role === role && typeof m.content === "string").map((m) => String(m.content)).join("\n");
  const user = textOf("user");

  const failure = (Object.keys(MOCK_FAILURE_MARKERS) as MockFailure[]).find((kind) =>
    user.includes(MOCK_FAILURE_MARKERS[kind]),
  );
  if (failure === "network") throw new TypeError("fetch failed");
  if (failure === "http") {
    return Response.json(
      { error: { code: 500, message: MOCK_RAW_ERROR_DETAIL } },
      { status: 500, statusText: "Internal Server Error" },
    );
  }
  if (failure === "output") {
    return new Response(`<html><body>${MOCK_RAW_ERROR_DETAIL}</body></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  }

  const schema = String(record(record(request.response_format).json_schema).name ?? "");
  const answer = answerFor(schema, user, textOf("system"));
  if (answer === null) {
    console.warn("[gloss] model mock has no answer for schema", schema);
    return new Response("Unsupported request", { status: 400 });
  }
  return Response.json({
    id: "mock-completion",
    provider: "mock",
    model: request.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: Math.ceil(init.body.length / 4), completion_tokens: 64 },
  });
}

function answerFor(schema: string, user: string, system: string): unknown {
  switch (schema) {
    case "detect_sentence_needs":
      return detect(user);
    case "proofread_sentences":
      return proofread(user, system);
    case "practice_situation":
      return { situation: MOCK_SITUATION };
    case "practice_exercise_pool":
      return practicePool(user);
    case "attempt_evaluation":
      return evaluate(user);
    case "dictation_cleanup":
      return cleanUp(user);
    default:
      return null;
  }
}

// The exercise pool asks for eight exercises for one expression: two on each
// of the four rungs. The nonce in the request keeps repeated generations
// distinct, as the real prompt asks for variation.
function practicePool(user: string) {
  const expression = user.match(/<expression>([^<]*)<\/expression>/)?.[1] ?? "resolve";
  const meaning = user.match(/<meaning>([^<]*)<\/meaning>/)?.[1] ?? "to find a solution to a problem";
  const nonce = (user.match(/Variation nonce: ([0-9a-f-]+)/)?.[1] ?? "0").slice(0, 8);
  const lexical = ["resolve", "review", "remind", "reject"];
  const meanings = [meaning, "to read something again", "to tell someone about a task", "to decide against something"];
  const make = (rung: number, sentence: string, prompt: string, options: string[] | null, answer: string, hint: string) => ({
    rung, sentence: `${sentence} (batch ${nonce})`, prompt, options, answer, hint,
    example: `Example for batch ${nonce}: We used the expression in a short update.`,
  });
  return {
    exercises: [
      make(1, `The team agreed to ${expression} the billing issue before Friday.`, "What does the highlighted expression mean?",
        meanings, meaning, "It is about ending a problem."),
      make(1, `She helped ${expression} the scheduling conflict in one call.`, "What does the highlighted expression mean?",
        [...meanings].reverse(), meaning, "It is about ending a problem."),
      make(2, `We need to settle the billing issue before Friday.`, `Which expression means: ${meaning}?`,
        lexical, expression, "The expression begins with r."),
      make(2, `The two leads will settle the scheduling conflict in one call.`, `Which expression means: ${meaning}?`,
        [...lexical].reverse(), expression, "The expression begins with r."),
      make(3, `We need to ___ the billing issue before Friday.`, "Choose the best expression for the gap.",
        lexical, expression, "The expression begins with r."),
      make(3, `The two leads will ___ the scheduling conflict in one call.`, "Choose the best expression for the gap.",
        [...lexical].reverse(), expression, "The expression begins with r."),
      make(4, "A problem with billing is holding up the launch.", `Which expression means: ${meaning}?`,
        null, expression, "Recall the verb that starts with r."),
      make(4, "A schedule clash is stopping both teams from starting.", `Which expression means: ${meaning}?`,
        null, expression, "Recall the verb that starts with r."),
    ],
  };
}

// The user message is an instruction line followed by the sentences as JSON.
function detect(user: string) {
  const rows: unknown[] = JSON.parse(user.slice(user.indexOf("\n") + 1));
  return {
    sentences: rows.map((row, index) => {
      const text = String(record(row).text ?? "");
      return {
        sentence_index: index,
        needs_correction: correctionsIn(text).length > 0 ? 0.96 : 0.03,
        needs_clarity: 0.02,
        needs_word_choice: expressionsIn(text).length > 0 ? 0.72 : 0.04,
      };
    }),
  };
}

// Sentences arrive one per line as "[n] text" between <text> tags.
function proofread(user: string, system: string) {
  const verify = system.includes('"improvements" must always be an empty list');
  const corrections: unknown[] = [];
  const improvements: unknown[] = [];
  for (const line of user.split("\n")) {
    const match = /^\[(\d+)\] (.*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const sentence = match[2];

    const fixes = correctionsIn(sentence);
    if (fixes.length > 0) {
      const corrected = fixes.reduce((text, fix) => text.replace(wordPattern(fix.wrong), fix.right), sentence);
      corrections.push({
        sentence_index: index,
        corrected,
        changes: fixes.map((fix) => ({ original: fix.wrong, replacement: fix.right, reason: fix.reason })),
      });
    }
    if (verify) continue;
    for (const expression of expressionsIn(sentence)) {
      improvements.push({
        sentence_index: index,
        original: expression.original,
        replacement: expression.replacement,
        category: "expression",
        reason: expression.reason,
        meaning: expression.meaning,
        ipa: expression.ipa,
      });
    }
  }
  return { corrections, improvements };
}

// A target counts as used when the answer contains it.
function evaluate(user: string) {
  const target = /^Target expression: (.*)$/m.exec(user)?.[1]?.trim() ?? "";
  const answer = /<answer>\n([\s\S]*)\n<\/answer>/.exec(user)?.[1] ?? "";
  const used = target !== "" && answer.toLowerCase().includes(target.toLowerCase());
  return {
    task_completed: answer.trim() !== "",
    target_used: used,
    meaning_correct: used,
    form_correct: used,
    message: used
      ? `Nice work: “${target}” fits your answer naturally.`
      : `Good answer. Next time, try to use “${target}” in it.`,
    correction: "",
  };
}

// Only capitalization and a full stop, so every word is still one the speaker said.
function cleanUp(user: string) {
  const transcript = /<<<\n([\s\S]*)\n>>>/.exec(user)?.[1]?.trim() ?? "";
  const sentence = transcript.charAt(0).toUpperCase() + transcript.slice(1);
  return { text: /[.!?]$/.test(sentence) ? sentence : `${sentence}.` };
}

function correctionsIn(text: string) {
  return MOCK_CORRECTIONS.filter((fix) => wordPattern(fix.wrong).test(text));
}

function expressionsIn(text: string) {
  return MOCK_EXPRESSIONS.filter((expression) => wordPattern(expression.original).test(text));
}

function wordPattern(word: string): RegExp {
  return new RegExp(`\\b${word}\\b`, "g");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
