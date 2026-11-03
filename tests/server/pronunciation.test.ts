import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { isSingleLexicalWord, sanitizeIpa } from "@/lib/pronunciation";
import { CreateExpressionResponse, Evaluation, ExpressionsResponse, PracticeTask, ProofreadResponse } from "@/shared/contracts";

vi.mock("next/headers", async () => (await import("./helpers/app")).nextHeadersMock);

import { POST as proofreadRoute } from "@/app/api/proofread/route";
import { POST as decisionRoute } from "@/app/api/suggestions/[id]/route";
import { POST as expressionRoute, GET as historyRoute } from "@/app/api/expressions/route";
import { POST as taskRoute } from "@/app/api/practice/tasks/route";
import { POST as attemptRoute } from "@/app/api/practice/attempts/[attemptId]/route";
import { openDatabase } from "@/server/db";
import { defaultMigrationsDir, migrate } from "@/server/db/migrate";
import { resolveEdits } from "@/server/proofread/edits";
import { parseProofreadOutput, PROOFREAD_JSON_SCHEMA } from "@/server/proofread/schema";
import { splitSentences } from "@/lib/text";
import { chatReply, db, fetchMock, installApp, login, requestId, seedExpression, seedTask } from "./helpers/app";

installApp();

const WORD = "meticulous";
const IPA = "/məˈtɪkjələs/";
const SITUATION = "Your colleague asks how you approach an important report. Describe your attention to detail in one sentence.";
const facts = (targetUsed = true) => ({ task_completed: true, target_used: targetUsed,
  meaning_correct: true, form_correct: true, message: "Your meaning is clear.", correction: "" });

const jsonRequest = (body: unknown) => new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });

function evaluate(attemptId: string, answer = "I am meticulous about the report.") {
  return attemptRoute(jsonRequest({ answer, hintUsed: false }), { params: Promise.resolve({ attemptId }) });
}

function seedWord() {
  const { learner } = login();
  const { expressionId } = seedExpression(learner.id, { text: WORD, meaning: "very careful about details" });
  db().prepare("UPDATE expressions SET ipa = ? WHERE id = ?").run(IPA, expressionId);
  return { learner, expressionId };
}

function seedOldEvaluation(learnerId: string, expressionId: string) {
  const { attemptId } = seedTask(learnerId, expressionId);
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  db().prepare("UPDATE attempts SET status = 'evaluated', created_at = ?, evaluated_at = ? WHERE id = ?")
    .run(old, old, attemptId);
}

describe("single-word pronunciation validation", () => {
  it("accepts Latin words with accents and internal apostrophes or hyphens", () => {
    for (const word of [WORD, "café", "cafe\u0301", "can't", "mother-in-law", "re\u2011enter"]) {
      expect(isSingleLexicalWord(word), word).toBe(true);
    }
    for (const phrase of ["", "two words", "have a say", "word?", "word123", "a/b", "a\u05b0", "\u043e\u043d\u0430"]) {
      expect(isSingleLexicalWord(phrase), phrase).toBe(false);
    }
  });

  it("normalizes plausible bounded IPA to slashes and discards prose or invalid data", () => {
    expect(sanitizeIpa(IPA, WORD)).toBe(IPA);
    expect(sanitizeIpa(" [məˈtɪkjələs] ", WORD)).toBe(IPA);
    expect(sanitizeIpa("məˈtɪkjələs", WORD)).toBe(IPA);
    expect(sanitizeIpa("/test/", "test")).toBe("/test/");
    for (const value of [null, 12, "test", "Say this word carefully", "<b>test</b>", "/two words/",
      "/123/", "/ˈ/", "/./", "//", "/\u043e\u043d\u0430/", "/test/ extra", "/" + "a".repeat(100) + "/"]) {
      expect(sanitizeIpa(value, WORD)).toBeNull();
    }
    expect(sanitizeIpa(IPA, "very meticulous")).toBeNull();
  });

  it("requests IPA in the existing model schema and keeps it only on single-word expression edits", () => {
    expect(PROOFREAD_JSON_SCHEMA.schema.properties.improvements.items.required).toContain("ipa");
    const raw = { sentence_index: 0, original: "careful", replacement: WORD, category: "expression",
      reason: "A more precise word.", meaning: "very careful about details", ipa: IPA };
    const parsed = parseProofreadOutput(JSON.stringify({ corrections: [], improvements: [raw] }))!.improvements;
    const sentences = splitSentences("She is careful.");
    expect(resolveEdits(sentences, parsed)[0].ipa).toBe(IPA);
    expect(resolveEdits(sentences, [{ ...parsed[0], replacement: "very meticulous" }])[0].ipa).toBeNull();
    expect(resolveEdits(sentences, [{ ...parsed[0], category: "style" }])[0].ipa).toBeNull();
    expect(resolveEdits(sentences, [{ ...parsed[0], ipa: "Arbitrary prose" }])[0].ipa).toBeNull();
    expect(resolveEdits(sentences, [{ ...parsed[0], ipa: "" }])).toHaveLength(1);
  });
});

describe("pronunciation persistence", () => {
  it("upgrades existing rows from the previous schema and preserves IPA after reopening", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pronunciation-upgrade-"));
    const migrations = path.join(dir, "migrations");
    const file = path.join(dir, "test.db");
    mkdirSync(migrations);
    let connection: DatabaseSync | undefined;
    try {
      for (const name of readdirSync(defaultMigrationsDir()).filter(name => name.endsWith(".sql") && name < "0006")) {
        copyFileSync(path.join(defaultMigrationsDir(), name), path.join(migrations, name));
      }
      connection = new DatabaseSync(file);
      connection.exec("PRAGMA foreign_keys = ON");
      migrate(connection, migrations);
      connection.exec(`
        INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('l', 'Writer', 'pilot', '2026-11-03');
        INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
          VALUES ('r', 'l', 'request', 'hash', 4, 'meta', 'muse-spark-1.3', 'ok', '2026-11-03');
        INSERT INTO suggestions (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason, meaning, status)
          VALUES ('s', 'r', 'l', 0, 4, 'careful', 'meticulous', 'expression', 'A reason', 'careful about details', 'accepted');
        INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
          VALUES ('e', 'l', 's', 'meticulous', 'careful about details', 'new', '2026-11-03');
      `);
      expect(migrate(connection)).toContain("0006_word_pronunciation.sql");
      expect(connection.prepare("SELECT ipa FROM suggestions WHERE id = 's'").get()?.ipa).toBeNull();
      expect(connection.prepare("SELECT ipa FROM expressions WHERE id = 'e'").get()?.ipa).toBeNull();
      connection.prepare("UPDATE suggestions SET ipa = ? WHERE id = 's'").run(IPA);
      connection.prepare("UPDATE expressions SET ipa = ? WHERE id = 'e'").run(IPA);
      expect(() => connection!.prepare("UPDATE expressions SET ipa = 'not IPA' WHERE id = 'e'").run()).toThrow();
      connection.close();
      connection = openDatabase(file);
      expect(connection.prepare("SELECT text, ipa FROM expressions WHERE id = 'e'").get()).toEqual({ text: WORD, ipa: IPA });
      expect(connection.prepare("SELECT ipa FROM suggestions WHERE id = 's'").get()?.ipa).toBe(IPA);
    } finally {
      connection?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the same budgeted IPA through replay, acceptance, history, task and evaluation", async () => {
    login();
    const id = requestId();
    const input = { requestId: id, text: "She is careful." };
    fetchMock.mockResolvedValueOnce(chatReply({ corrections: [], improvements: [{ sentence_index: 0, original: "careful",
      replacement: WORD, category: "expression", reason: "A more precise word.", meaning: "very careful about details", ipa: IPA }] }));
    const checked = ProofreadResponse.parse(await (await proofreadRoute(jsonRequest(input))).json());
    expect(checked.suggestions[0].ipa).toBe(IPA);
    const replay = ProofreadResponse.parse(await (await proofreadRoute(jsonRequest(input))).json());
    expect(replay.suggestions[0].ipa).toBe(IPA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const suggestionId = checked.suggestions[0].id;
    await decisionRoute(jsonRequest({ decision: "accepted", textHash: checked.textHash }), { params: Promise.resolve({ id: suggestionId }) });
    const created = CreateExpressionResponse.parse(await (await expressionRoute(jsonRequest({ suggestionId, familiarity: "new" }))).json());
    expect(created.expression.ipa).toBe(IPA);
    const history = ExpressionsResponse.parse(await (await historyRoute()).json());
    expect(history.expressions.find(row => row.expression.id === created.expression.id)?.expression.ipa).toBe(IPA);

    const taskInput = { requestId: requestId(), expressionId: created.expression.id, kind: "written" };
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const task = PracticeTask.parse(await (await taskRoute(jsonRequest(taskInput))).json());
    expect(task).toMatchObject({ cue: "shown", expression: WORD, ipa: IPA });
    const taskReplay = PracticeTask.parse(await (await taskRoute(jsonRequest(taskInput))).json());
    expect(taskReplay.ipa).toBe(IPA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(chatReply(facts()));
    expect(Evaluation.parse(await (await evaluate(task.attemptId)).json())).toMatchObject({ target: WORD, ipa: IPA });
    expect(Evaluation.parse(await (await evaluate(task.attemptId)).json())).toMatchObject({ target: WORD, ipa: IPA });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("hidden cues and recall evidence", () => {
  it("withholds the word and IPA on hidden tasks and unavailable feedback, then reveals scored feedback", async () => {
    const { learner, expressionId } = seedWord();
    seedOldEvaluation(learner.id, expressionId);
    const input = { requestId: requestId(), expressionId, kind: "written" };
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const task = PracticeTask.parse(await (await taskRoute(jsonRequest(input))).json());
    expect(task).toMatchObject({ cue: "hidden", expression: null, ipa: null });
    const taskReplay = PracticeTask.parse(await (await taskRoute(jsonRequest(input))).json());
    expect(taskReplay).toMatchObject({ expression: null, ipa: null });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const unavailable = Evaluation.parse(await (await evaluate(task.attemptId)).json());
    expect(unavailable).toMatchObject({ verdict: "unavailable", target: "", ipa: null, retryAttemptId: task.attemptId });
    expect(JSON.stringify(unavailable)).not.toContain(WORD);
    expect(db().prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE attempt_id = ?").get(task.attemptId)?.n).toBe(0);

    fetchMock.mockResolvedValueOnce(chatReply(facts()));
    const scored = Evaluation.parse(await (await evaluate(task.attemptId)).json());
    expect(scored).toMatchObject({ verdict: "used_well", target: WORD, ipa: IPA });
    expect(db().prepare("SELECT cue FROM evidence_events WHERE attempt_id = ?").get(task.attemptId)?.cue).toBe("hidden");
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const immediate = PracticeTask.parse(await (await taskRoute(jsonRequest({ ...input, requestId: requestId() }))).json());
    expect(immediate).toMatchObject({ cue: "shown", expression: WORD, ipa: IPA });
  });

  it("records a retry after scored feedback as assisted rather than hidden recall", async () => {
    const { learner, expressionId } = seedWord();
    seedOldEvaluation(learner.id, expressionId);
    fetchMock.mockResolvedValueOnce(chatReply({ situation: SITUATION }));
    const task = PracticeTask.parse(await (await taskRoute(jsonRequest({ requestId: requestId(), expressionId, kind: "written" }))).json());
    expect(task.cue).toBe("hidden");
    fetchMock.mockResolvedValueOnce(chatReply(facts(false)));
    const first = Evaluation.parse(await (await evaluate(task.attemptId, "I pay attention to details.")).json());
    expect(first).toMatchObject({ verdict: "not_yet", target: WORD, ipa: IPA });
    expect(first.retryAttemptId).not.toBeNull();
    const scheduled = db().prepare("SELECT next_practice_at FROM expressions WHERE id = ?").get(expressionId)?.next_practice_at;
    fetchMock.mockResolvedValueOnce(chatReply(facts()));
    const retry = Evaluation.parse(await (await evaluate(first.retryAttemptId!)).json());
    expect(retry).toMatchObject({ verdict: "used_well", target: WORD, ipa: IPA });
    expect(db().prepare("SELECT cue FROM evidence_events WHERE attempt_id = ?").get(task.attemptId)?.cue).toBe("hidden");
    expect(db().prepare("SELECT cue FROM evidence_events WHERE attempt_id = ?").get(first.retryAttemptId!)?.cue).toBe("shown");
    expect(db().prepare("SELECT next_practice_at FROM expressions WHERE id = ?").get(expressionId)?.next_practice_at).toBe(scheduled);
  });
});
