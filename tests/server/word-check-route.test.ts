import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WordCheckAnswersResponse,
  WordCheckResponse,
  type WordCheckAnswer,
} from "@/shared/contracts";
import { starterEntry } from "@/server/learning/starter";
import { GET, POST } from "@/app/api/onboarding/word-check/route";
import { db, installApp, login, postJson, session } from "./helpers/app";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

installApp();

const LEVELS = ["A2", "B1", "B2", "C1"];
const rank = (level: string) => LEVELS.indexOf(level);
const ROUTE = "http://localhost/api/onboarding/word-check";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

interface Learner {
  id: string;
  cookie: string;
}

// A new learner, made the current session.
function newLearner(): Learner {
  const { learner, sessionToken } = login();
  return { id: learner.id, cookie: sessionToken };
}

function asLearner(learner: Learner): void {
  session.cookie = learner.cookie;
}

async function fetchRound(learner: Learner): Promise<WordCheckResponse> {
  asLearner(learner);
  const response = await GET();
  expect(response.status).toBe(200);
  return WordCheckResponse.parse(await response.json());
}

async function submit(
  learner: Learner,
  answers: { id: string; answer: WordCheckAnswer }[],
): Promise<WordCheckAnswersResponse> {
  asLearner(learner);
  const response = await postJson(POST, { answers });
  expect(response.status).toBe(200);
  return WordCheckAnswersResponse.parse(await response.json());
}

async function expectApiError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(ApiError.parse(await response.json()).error.code).toBe(code);
}

function progressRows(learnerId: string): { text: string; status: string }[] {
  return db()
    .prepare("SELECT text, status FROM word_progress WHERE learner_id = ? ORDER BY text")
    .all(learnerId) as { text: string; status: string }[];
}

function statusOf(learnerId: string, text: string): string | undefined {
  return progressRows(learnerId).find((row) => row.text.toLowerCase() === text.toLowerCase())?.status;
}

function storedLevel(learnerId: string): string | null {
  return (db().prepare("SELECT level FROM learners WHERE id = ?").get(learnerId) as { level: string | null }).level;
}

function rowCount(table: "word_progress" | "word_check_entries"): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// The 12 highest-level entries of a 24-entry round, and the other 12.
function splitByLevel(entries: WordCheckResponse["entries"]) {
  const ranked = [...entries].sort((a, b) => rank(b.level) - rank(a.level));
  return { higher: ranked.slice(0, 12), lower: ranked.slice(12) };
}

describe("GET /api/onboarding/word-check", () => {
  it("requires a learner session and writes nothing", async () => {
    const before = rowCount("word_check_entries");
    const response = await GET();
    await expectApiError(response, 401, "unauthorized");
    expect(rowCount("word_check_entries")).toBe(before);
  });

  it("serves 24 distinct starter entries around B1 to a fresh learner", async () => {
    const learner = newLearner();
    const round = await fetchRound(learner);

    expect(round.level).toBeNull();
    expect(round.entries).toHaveLength(24);
    expect(new Set(round.entries.map((entry) => entry.id)).size).toBe(24);
    expect(new Set(round.entries.map((entry) => entry.text)).size).toBe(24);

    for (const entry of round.entries) {
      const starter = starterEntry(entry.text);
      expect(starter, entry.text).toBeDefined();
      expect(entry.level, entry.text).toBe(starter?.level);
      expect(entry.definition, entry.text).toBe(starter?.definition);
      expect(entry.definition.length, entry.text).toBeGreaterThan(0);
      expect(Math.abs(rank(entry.level) - rank("B1")), entry.text).toBeLessThanOrEqual(1);
    }

    const levels = round.entries.map((entry) => entry.level);
    expect(levels).toContain("B1");
    expect(levels.some((level) => level === "A2" || level === "B2")).toBe(true);
  });

  it("serves the same persisted round again on the same day", async () => {
    const learner = newLearner();
    const first = await fetchRound(learner);
    const stored = rowCount("word_check_entries");
    const second = await fetchRound(learner);

    // The contract fixes the set, not the order: ids are compared sorted.
    const ids = (round: WordCheckResponse) => round.entries.map((entry) => entry.id).sort();
    expect(ids(second)).toEqual(ids(first));
    expect(rowCount("word_check_entries")).toBe(stored);
    expect(second).toMatchObject({ roundSize: 24, answered: 0, completed: false });
  });

  it("returns the answers of a partial round and re-opens no answered entry", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);
    const answers: { id: string; answer: WordCheckAnswer }[] = [
      { id: entries[0].id, answer: "use" },
      { id: entries[1].id, answer: "use" },
      { id: entries[2].id, answer: "know_unused" },
      { id: entries[3].id, answer: "new" },
    ];
    await submit(learner, answers);

    const again = await fetchRound(learner);
    expect(again.answered).toBe(4);
    expect(again.completed).toBe(false);
    expect(again.entries).toHaveLength(24);
    const byId = new Map(again.entries.map((entry) => [entry.id, entry]));
    for (const { id, answer } of answers) expect(byId.get(id)?.answer, id).toBe(answer);
    // Every other entry is still open, so the page knows what to ask.
    const open = again.entries.filter((entry) => entry.answer === null);
    expect(open).toHaveLength(20);
    expect(open.some((entry) => answers.some(({ id }) => id === entry.id))).toBe(false);

    // Finishing the rest completes the round; the repeat GET keeps it so.
    await submit(
      learner,
      open.map((entry) => ({ id: entry.id, answer: "not_sure" as const })),
    );
    const done = await fetchRound(learner);
    expect(done).toMatchObject({ roundSize: 24, answered: 24, completed: true });
    expect(done.entries.every((entry) => entry.answer !== null)).toBe(true);
  });

  it("does not re-ask words answered 'use' in full after a full POST", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);
    const result = await submit(
      learner,
      entries.map((entry) => ({ id: entry.id, answer: "use" as const })),
    );
    expect(result.counts).toEqual({ active: 24, ready: 0, learning: 0 });
    // "I use it" never becomes a My words row.
    expect(progressRows(learner.id)).toEqual([]);

    const again = await fetchRound(learner);
    expect(again.completed).toBe(true);
    expect(again.entries.every((entry) => entry.answer === "use")).toBe(true);
    expect(again.entries.filter((entry) => entry.answer === null)).toEqual([]);
  });
});

describe("POST /api/onboarding/word-check", () => {
  it("requires a learner session and writes nothing", async () => {
    const before = rowCount("word_progress");
    const response = await postJson(POST, { answers: [{ id: UNKNOWN_ID, answer: "new" }] });
    await expectApiError(response, 401, "unauthorized");
    expect(rowCount("word_progress")).toBe(before);
  });

  it("keeps 'use' out of My words and stores the other answers by status", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);

    const result = await submit(learner, [
      { id: entries[0].id, answer: "use" },
      { id: entries[1].id, answer: "use" },
      { id: entries[2].id, answer: "know_unused" },
      { id: entries[3].id, answer: "not_sure" },
      { id: entries[4].id, answer: "not_sure" },
      { id: entries[5].id, answer: "new" },
    ]);

    expect(result.answered).toBe(6);
    expect(result.counts).toEqual({ active: 2, ready: 1, learning: 3 });
    expect(statusOf(learner.id, entries[0].text)).toBeUndefined();
    expect(statusOf(learner.id, entries[1].text)).toBeUndefined();
    expect(statusOf(learner.id, entries[2].text)).toBe("ready");
    expect(statusOf(learner.id, entries[3].text)).toBe("learning");
    expect(statusOf(learner.id, entries[4].text)).toBe("learning");
    expect(statusOf(learner.id, entries[5].text)).toBe("learning");
    expect(progressRows(learner.id)).toHaveLength(4);
  });

  it("estimates a lower level for a lower answer pattern and stores it per learner", async () => {
    const low = newLearner();
    const high = newLearner();
    const lowRound = await fetchRound(low);
    const highRound = await fetchRound(high);

    // Higher half "use" in both; the lower half is "new" for one learner and
    // "know_unused" for the other.
    const answersFor = (round: WordCheckResponse, lowerAnswer: WordCheckAnswer) => {
      const { higher, lower } = splitByLevel(round.entries);
      return [
        ...higher.map((entry) => ({ id: entry.id, answer: "use" as const })),
        ...lower.map((entry) => ({ id: entry.id, answer: lowerAnswer })),
      ];
    };

    const lowResult = await submit(low, answersFor(lowRound, "new"));
    const highResult = await submit(high, answersFor(highRound, "know_unused"));

    expect(LEVELS).toContain(lowResult.level);
    expect(LEVELS).toContain(highResult.level);
    expect(rank(lowResult.level)).toBeLessThan(rank(highResult.level));

    // The estimate is stored: a second GET returns it for that learner only.
    expect((await fetchRound(low)).level).toBe(lowResult.level);
    expect((await fetchRound(high)).level).toBe(highResult.level);
    expect(storedLevel(low.id)).toBe(lowResult.level);

    const unanswered = newLearner();
    expect((await fetchRound(unanswered)).level).toBeNull();
  });

  it("rejects another learner's ids and invented ids without writing anything", async () => {
    const a = newLearner();
    const b = newLearner();
    const aRound = await fetchRound(a);
    const bRound = await fetchRound(b);
    const bAnswers = bRound.entries.map((entry) => ({ id: entry.id, answer: "new" as const }));

    asLearner(a);
    await expectApiError(await postJson(POST, { answers: bAnswers }), 400, "invalid_request");
    await expectApiError(
      await postJson(POST, { answers: [{ id: UNKNOWN_ID, answer: "new" }] }),
      400,
      "invalid_request",
    );
    // One of A's own ids does not rescue a request that also names B's id.
    await expectApiError(
      await postJson(POST, {
        answers: [
          { id: aRound.entries[0].id, answer: "know_unused" },
          { id: bRound.entries[0].id, answer: "new" },
        ],
      }),
      400,
      "invalid_request",
    );

    expect(progressRows(a.id)).toEqual([]);
    expect(progressRows(b.id)).toEqual([]);
    expect(storedLevel(a.id)).toBeNull();

    // B's own ids are accepted, so the rejections above are about ownership.
    const accepted = await submit(b, bAnswers.slice(0, 1));
    expect(accepted.answered).toBe(1);
    expect(progressRows(a.id)).toEqual([]);
  });

  it("is idempotent: re-posting the same body returns the same response and adds no rows", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);
    const answers: { id: string; answer: WordCheckAnswer }[] = [
      { id: entries[0].id, answer: "use" },
      { id: entries[1].id, answer: "know_unused" },
      { id: entries[2].id, answer: "not_sure" },
      { id: entries[3].id, answer: "new" },
    ];

    const first = await submit(learner, answers);
    const rowsAfterFirst = progressRows(learner.id);
    const second = await submit(learner, answers);

    expect(second).toEqual(first);
    expect(progressRows(learner.id)).toEqual(rowsAfterFirst);
  });

  it("accepts a single answer", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);

    const result = await submit(learner, [{ id: entries[0].id, answer: "new" }]);

    expect(result.answered).toBe(1);
    expect(result.counts).toEqual({ active: 0, ready: 0, learning: 1 });
    expect(statusOf(learner.id, entries[0].text)).toBe("learning");
  });

  it("rejects malformed bodies with invalid_request and writes nothing", async () => {
    const learner = newLearner();
    const { entries } = await fetchRound(learner);
    asLearner(learner);
    const valid = { id: entries[0].id, answer: "new" };
    const before = rowCount("word_progress");

    const bodies: unknown[] = [
      { answers: [] },
      { answers: Array.from({ length: 25 }, () => valid) },
      { answers: [{ id: entries[0].id, answer: "maybe" }] },
      { answers: [valid], extra: true },
    ];
    for (const body of bodies) {
      await expectApiError(await postJson(POST, body), 400, "invalid_request");
    }

    const raw = await POST(new Request(ROUTE, { method: "POST", body: "{not json" }));
    await expectApiError(raw, 400, "invalid_request");

    expect(rowCount("word_progress")).toBe(before);
    expect(progressRows(learner.id)).toEqual([]);
    expect(storedLevel(learner.id)).toBeNull();
  });
});
