// Shared setup for route-level tests. The handlers run outside a Next request,
// so only the cookie reader is replaced (via `nextHeadersMock`); SQL, budget
// and routes are real. The model provider is the `fetchMock` stub, so no test
// touches the network.
//
// A test file mocks cookies with:
//   vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createInvite, redeemInvite } from "@/server/auth/invites";
import { setAiEnabled } from "@/server/budget";
import { closeDb, getDb } from "@/server/db";
import { newId } from "@/server/ids";

export const session: { cookie?: string } = {};

export const nextHeadersMock = {
  cookies: async () => ({
    get: (name: string) =>
      name === "glossy_session" && session.cookie ? { name, value: session.cookie } : undefined,
  }),
};

export const fetchMock = vi.fn();

// The operator's OpenRouter key funds the fast tier; the Meta key funds the
// smart tier and speech-to-text.
export const OWNER_OPENROUTER_KEY = "sk-or-v1-" + "owner".repeat(8);

export const ENV = {
  META_API_KEY: "test-key",
  META_API_BASE_URL: "https://meta.test/v1",
  META_TEXT_MODEL: "muse-spark-1.3",
  META_ASR_MODEL: "muse-voice-transcribe-1.0",
  OPENROUTER_API_KEY: OWNER_OPENROUTER_KEY,
  OPENROUTER_FAST_MODEL: "openai/gpt-oss-120b",
  DAILY_BUDGET_USD: "5",
  AI_ENABLED: "true",
};

// Optional settings that a test may set; each test starts without them.
export const OPTIONAL_ENV = [
  "OPENROUTER_PROOFREAD_MODEL",
  "OPENROUTER_FAST_PRICE_IN_PER_M",
  "OPENROUTER_FAST_PRICE_OUT_PER_M",
];

// Registers the per-file hooks: a scratch database, test environment
// variables, a fetch stub and a clean session before each test.
export function installApp(): void {
  const saved: Record<string, string | undefined> = {};
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "glossy-app-test-"));
    for (const key of [...Object.keys(ENV), ...OPTIONAL_ENV, "GLOSSY_DATABASE_PATH"]) saved[key] = process.env[key];
    process.env.GLOSSY_DATABASE_PATH = path.join(dir, "test.db");
  });

  afterAll(() => {
    closeDb();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(process.env, ENV);
    for (const key of OPTIONAL_ENV) delete process.env[key];
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setAiEnabled(true);
    session.cookie = undefined;
  });

  afterEach(() => vi.unstubAllGlobals());
}

export type Profile = "pilot" | "judge" | "owner";

// Creates a learner and makes them the current session.
export function login(profile: Profile = "judge") {
  const { token } = createInvite({ label: "Writer", maxUses: 1, quotaProfile: profile });
  const redemption = redeemInvite(token);
  session.cookie = redemption.sessionToken;
  return redemption;
}

export const requestId = () => crypto.randomUUID();

export function postJson(route: (request: Request) => Promise<Response>, body: unknown) {
  return route(
    new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) }),
  );
}

// An OpenAI-style chat completion whose content is the given JSON value.
export function chatReply(
  content: unknown,
  usage: Record<string, unknown> | null = { prompt_tokens: 1000, completion_tokens: 200 },
  finishReason = "stop",
): Response {
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200 },
  );
}

// A proofreading answer: corrected sentences plus optional improvements.
export function proofreadReply(
  corrections: unknown[],
  improvements: unknown[] = [],
  usage?: Record<string, unknown> | null,
): Response {
  return usage === undefined
    ? chatReply({ corrections, improvements })
    : chatReply({ corrections, improvements }, usage);
}

export function sentBody(callIndex = 0): Record<string, unknown> & { model: string; messages: { content: string }[]; max_tokens: number } {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

export function sentMessages(callIndex = 0): { role: string; content: string }[] {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body).messages;
}

export const db = () => getDb();

// --- direct seeding (skips the routes under test) ----------------------------

export interface SeededExpression {
  expressionId: string;
  suggestionId: string;
}

export function seedExpression(
  learnerId: string,
  over: { text?: string; meaning?: string; nextPracticeAt?: string | null; createdAt?: string } = {},
): SeededExpression {
  const now = new Date().toISOString();
  const runId = newId();
  const suggestionId = newId();
  const expressionId = newId();
  const text = over.text ?? "unlikely to happen";
  const meaning = over.meaning ?? "not likely to happen";
  const d = getDb();
  d.prepare(
    `INSERT INTO check_runs
       (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
     VALUES (?, ?, ?, 'h', 10, 'meta', 'muse-spark-1.3', 'ok', ?)`,
  ).run(runId, learnerId, newId(), now);
  d.prepare(
    `INSERT INTO suggestions
       (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason,
        meaning_change, meaning, status)
     VALUES (?, ?, ?, 0, 4, 'x', ?, 'expression', 'r', 0, ?, 'accepted')`,
  ).run(suggestionId, runId, learnerId, text, meaning);
  d.prepare(
    `INSERT INTO expressions
       (id, learner_id, suggestion_id, text, meaning, familiarity, next_practice_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
  ).run(expressionId, learnerId, suggestionId, text, meaning, over.nextPracticeAt ?? null, over.createdAt ?? now);
  return { expressionId, suggestionId };
}

export interface SeededTask {
  taskId: string;
  attemptId: string;
}

export function seedTask(
  learnerId: string,
  expressionId: string,
  over: { kind?: "written" | "voice"; cue?: "shown" | "hidden"; situation?: string } = {},
): SeededTask {
  const taskId = newId();
  const attemptId = newId();
  const now = new Date().toISOString();
  const d = getDb();
  d.prepare(
    `INSERT INTO practice_tasks
       (id, learner_id, expression_id, kind, cue, situation, hint, request_id, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'hint', ?, 'muse-spark-1.3', ?)`,
  ).run(
    taskId,
    learnerId,
    expressionId,
    over.kind ?? "written",
    over.cue ?? "shown",
    over.situation ?? "A colleague asks whether the launch will slip. Reply in a sentence or two.",
    newId(),
    now,
  );
  d.prepare(
    "INSERT INTO attempts (id, learner_id, task_id, status, created_at) VALUES (?, ?, ?, 'issued', ?)",
  ).run(attemptId, learnerId, taskId, now);
  return { taskId, attemptId };
}

// A mono 16-bit PCM WAV of silence, or a deliberately broken variant.
export function makeWav(
  opts: {
    seconds?: number;
    sampleRate?: number;
    channels?: number;
    bits?: number;
    format?: number;
    dataBytes?: number;
  } = {},
): Uint8Array {
  const sampleRate = opts.sampleRate ?? 16_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const format = opts.format ?? 1;
  const dataBytes =
    opts.dataBytes ?? Math.floor((opts.seconds ?? 2) * sampleRate) * channels * (bits / 8);
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}
