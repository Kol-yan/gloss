import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate } from "@/server/db";
import {
  normalizeWord,
  pickSessionWords,
  recordPracticeResult,
  recordRealUse,
  recordWordCheckAnswer,
  seedStarterWords,
  wordEngineCounts,
} from "@/server/learning/priority";
import { recordPracticeReaction } from "@/server/learning/priority/engine";
import { recordWriting } from "@/server/learning/service";
import type { Learner } from "@/server/auth/sessions";
import { createTempDb, insertLearner, type TempDb } from "./helpers/db";

let temp: TempDb | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const NOW = new Date("2026-11-04T09:00:00.000Z");

function learnerRow(id: string): Learner {
  return { id, displayName: "Learner", quotaProfile: "pilot" };
}

// A saved expression the engine can work with, created the way the editor
// does: a suggestion plus an expression row.
function addExpression(db: DatabaseSync, learnerId: string, id: string, text: string, familiarity = "new") {
  db.prepare(
    `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
     VALUES (?, ?, ?, 'h', 1, 'openrouter', 'model', 'ok', '2026-11-01')`,
  ).run(`run-${id}`, learnerId, `request-${id}`);
  db.prepare(
    `INSERT INTO suggestions (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning, meaning_change, status)
     VALUES (?, ?, ?, 0, 1, 'x', ?, 'expression', 'A fit.', 'A meaning.', 0, 'accepted')`,
  ).run(`sug-${id}`, `run-${id}`, learnerId, text);
  db.prepare(
    `INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
     VALUES (?, ?, ?, ?, 'A meaning.', ?, '2026-11-01T00:00:00.000Z')`,
  ).run(id, learnerId, `sug-${id}`, text, familiarity);
}

describe("word engine migrations", () => {
  it("adds the word tables to a fresh database", () => {
    temp = createTempDb();
    const tables = temp.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'word_%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    expect(tables).toEqual(["word_check_entries", "word_practice_events", "word_progress"]);
    const columns = temp.db
      .prepare("PRAGMA table_info(word_progress)")
      .all()
      .map((row) => String(row.name));
    for (const column of [
      "status", "rung", "productive_answers", "real_use_count",
      "real_use_documents", "real_use_days", "real_use_last_at", "word_check_answer",
      "consecutive_errors", "band",
    ]) {
      expect(columns).toContain(column);
    }
    expect(temp.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("applies on a copy of the current schema and keeps existing data", () => {    const dir = mkdtempSync(path.join(tmpdir(), "glossy-word-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    for (const file of readdirSync(source).filter((name) => /^000[1-9]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      migrate(db, oldMigrations);
      insertLearner(db, "pilot", "Existing");
      const learner = String(db.prepare("SELECT id FROM learners").get()?.id);
      db.exec(`INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
        VALUES ('run', '${learner}', 'request', 'h', 1, 'openrouter', 'model', 'ok', '2026-11-01')`);
      db.exec(`INSERT INTO suggestions (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning, meaning_change, status)
        VALUES ('sug', 'run', '${learner}', 0, 1, 'x', 'bottleneck', 'expression', 'A fit.', 'A delay.', 0, 'accepted')`);
      db.exec(`INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
        VALUES ('expression', '${learner}', 'sug', 'bottleneck', 'A delay.', 'new', '2026-11-01')`);
      const before = db.prepare("SELECT * FROM expressions WHERE id = 'expression'").get();

      expect(migrate(db, source)).toEqual([
        "0010_word_engine.sql",
        "0011_word_real_use.sql",
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
      ]);
      expect(db.prepare("SELECT * FROM expressions WHERE id = 'expression'").get()).toEqual(before);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      // The saved expression is picked up on the next session.
      const picked = pickSessionWords(learner, 8, { db, now: NOW });
      expect(picked.map((word) => word.text)).toContain("bottleneck");

      // Deleting the learner removes the engine rows with it.
      db.exec(`DELETE FROM learners WHERE id = '${learner}'`);
      expect(db.prepare("SELECT COUNT(*) AS n FROM word_progress").get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts independent writing recorded before the engine tables existed", () => {
    // Upgrading a real database applies 0010 and 0011 to a schema in which the
    // learner already wrote the word. The old evidence rows must reach the
    // engine without a new document being written.
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-word-old-writing-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    for (const file of readdirSync(source).filter((name) => /^000[1-9]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    // A copy of the real 0010: the table as it shipped in this branch.
    copyFileSync(path.join(source, "0010_word_engine.sql"), path.join(oldMigrations, "0010_word_engine.sql"));
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      migrate(db, oldMigrations);
      insertLearner(db, "pilot", "Existing");
      const learner = String(db.prepare("SELECT id FROM learners").get()?.id);
      const iso = NOW.toISOString();
      db.exec(`INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('old', 'Old', 'pilot', '${iso}')`);
      db.exec(`INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
        VALUES ('run', 'old', 'request', 'h', 1, 'openrouter', 'model', 'ok', '${iso}')`);
      db.exec(`INSERT INTO suggestions (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning, meaning_change, status)
        VALUES ('sug', 'run', 'old', 0, 1, 'x', 'bottleneck', 'expression', 'A fit.', 'A delay.', 0, 'accepted')`);
      db.exec(`INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
        VALUES ('expression', 'old', 'sug', 'bottleneck', 'A delay.', 'new', '${iso}')`);
      for (const [index, documentId] of ["before-one", "before-two"].entries()) {
        db.exec(`INSERT INTO evidence_events (id, learner_id, expression_id, kind, document_id, created_at)
          VALUES ('e${index}', 'old', 'expression', 'independent_writing', '${documentId}', '${iso}')`);
      }

      expect(migrate(db, source)).toEqual([
        "0011_word_real_use.sql",
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
      ]);
      expect(pickSessionWords("old", 8, { db, now: NOW })).toEqual([]);
      expect(
        db.prepare("SELECT status, real_use_count FROM word_progress WHERE expression_id = 'expression'").get(),
      ).toEqual({ status: "active", real_use_count: 2 });
      expect(learner).toBeTruthy();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickSessionWords", () => {
  it("returns the track B shape and hides active words that are not due", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    seedStarterWords(learner, "A2", { db: temp.db, now: NOW });
    const picked = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    expect(picked.length).toBeGreaterThan(0);
    for (const word of picked) {
      expect(Object.keys(word).sort()).toEqual([
        "expressionId", "frequency", "slot", "startRung", "status", "text", "why",
      ]);
      expect(["activate", "learn", "keep"]).toContain(word.slot);
      expect(["learning", "ready", "active", "hidden"]).toContain(word.status);
      expect(word.startRung).toBeGreaterThanOrEqual(1);
      expect(word.startRung).toBeLessThanOrEqual(6);
      expect(word.why.length).toBeLessThanOrEqual(60);
      expect(word.why).not.toMatch(/\d/);
    }
  });

  it("learns three brand-new words and no more, then works on started ones", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    seedStarterWords(learner, "A2", { db: temp.db, now: NOW });
    const first = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    const newWords = first.filter((word) => word.slot === "learn");
    expect(newWords).toHaveLength(3);

    for (const word of newWords) {
      recordPracticeResult(
        { learnerId: learner, expressionId: word.expressionId, rung: 1, productive: false, correct: true, usedHint: false },
        { db: temp.db, now: NOW },
      );
    }

    const later = pickSessionWords(learner, 8, { db: temp.db, now: new Date("2026-11-04T10:00:00Z") });
    const untouched = new Set(
      temp.db
        .prepare(
          "SELECT expression_id FROM word_progress WHERE learner_id = ? AND answers = 0 AND status = 'learning'",
        )
        .all(learner!)
        .map((row) => String(row.expression_id)),
    );
    // No session ever starts a word that has never been answered after the
    // day's three places: the next 8 words are all work the learner has begun.
    expect(later.every((word) => !untouched.has(word.expressionId))).toBe(true);
  });

  it("excludes another learner's words", () => {
    temp = createTempDb();
    const first = insertLearner(temp.db, "pilot", "First");
    const second = insertLearner(temp.db, "pilot", "Second");
    seedStarterWords(first, "A2", { db: temp.db, now: NOW });
    expect(pickSessionWords(second, 8, { db: temp.db, now: NOW })).toEqual([]);
  });

  it("is deterministic", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    seedStarterWords(learner, "A2", { db: temp.db, now: NOW });
    const a = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    const again = temp.db
      .prepare("SELECT introduced_on FROM word_progress WHERE learner_id = ? AND introduced_on IS NOT NULL")
      .all(learner);
    temp.db
      .prepare("UPDATE word_progress SET introduced_on = NULL WHERE learner_id = ?")
      .run(learner);
    const b = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    expect(a).toEqual(b);
    expect(again.length).toBeGreaterThan(0);
  });
});

describe("recordPracticeResult", () => {
  it("stores an answer and returns the new status, rung and comeback", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    const result = recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 1, productive: false, correct: true, usedHint: false },
      { db: temp.db, now: NOW },
    );
    expect(result.status).toBe("ready");
    expect(result.nextRung).toBe(2);
    expect(result.comesBackAt).toBe("2026-11-06T09:00:00.000Z");
    const row = temp.db.prepare("SELECT * FROM word_progress WHERE expression_id = 'expr'").get();
    expect(row).toMatchObject({ status: "ready", answers: 1, correct_answers: 1 });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ?").get(learner)).toEqual({ n: 1 });
  });

  it("resets the error streak after a step down, so a third error needs two fresh ones", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 2, productive: true, correct: true, usedHint: false },
      { db: temp.db, now: NOW },
    );
    const once = recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 2, productive: true, correct: false, usedHint: false },
      { db: temp.db, now: NOW },
    );
    expect(once.status).toBe("ready");
    const twice = recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 1, productive: false, correct: false, usedHint: false },
      { db: temp.db, now: NOW },
    );
    expect(twice.status).toBe("learning");
    expect(temp.db.prepare("SELECT consecutive_errors FROM word_progress WHERE expression_id = 'expr'").get()).toEqual({
      consecutive_errors: 0,
    });
  });

  it("hides a word on Not relevant and keeps it out of the next session", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    const result = recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 1, productive: false, correct: true, usedHint: false, reaction: "not_relevant" },
      { db: temp.db, now: NOW },
    );
    expect(result.status).toBe("hidden");
    expect(pickSessionWords(learner, 8, { db: temp.db, now: NOW })).toEqual([]);
    expect(temp.db.prepare("SELECT answers, correct_answers, productive_answers FROM word_progress WHERE expression_id = 'expr'").get())
      .toEqual({ answers: 0, correct_answers: 0, productive_answers: 0 });
  });

  it("annotates a prior answer event without recounting it or un-hiding a late word", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 4, productive: true, correct: true, usedHint: false, eventId: "prior-answer" },
      { db: temp.db, now: NOW },
    );
    recordPracticeResult(
      { learnerId: learner, expressionId: "expr", rung: 4, productive: false, correct: true, usedHint: true, reaction: "not_relevant", eventId: "hide-event" },
      { db: temp.db, now: NOW },
    );
    const lateReaction = recordPracticeReaction(
      { learnerId: learner, expressionId: "expr", eventId: "prior-answer", reaction: "too_easy", correct: true },
      { db: temp.db, now: NOW },
    );

    expect(lateReaction.status).toBe("hidden");
    expect(temp.db.prepare("SELECT status, answers, correct_answers, productive_answers, bland FROM word_progress WHERE expression_id = 'expr'").get())
      .toEqual({ status: "hidden", answers: 1, correct_answers: 1, productive_answers: 1, bland: 0 });
    expect(temp.db.prepare("SELECT reaction FROM word_practice_events WHERE id = 'prior-answer'").get())
      .toEqual({ reaction: "too_easy" });
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ?").get(learner))
      .toEqual({ n: 2 });
  });

  it("does not accept an expression id from another learner", () => {
    temp = createTempDb();
    const mine = insertLearner(temp.db, "pilot", "Mine");
    const other = insertLearner(temp.db, "pilot", "Other");
    addExpression(temp.db, other, "expr", "bottleneck");
    expect(() =>
      recordPracticeResult(
        { learnerId: mine, expressionId: "expr", rung: 1, productive: false, correct: true, usedHint: false },
        { db: temp!.db, now: NOW },
      ),
    ).toThrow();
  });
});

describe("real use", () => {
  it("reads existing independent-writing evidence and activates after two documents", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    for (const documentId of ["document-one", "document-two"]) {
      recordWriting(
        learnerRow(learner),
        { text: "The bottleneck slows us down.", documentId, assistedRanges: [] },
        { db: temp.db, now: NOW },
      );
    }
    // The first session after the writing is enough: no recordRealUse call.
    pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    expect(
      temp.db
        .prepare(
          "SELECT status, real_use_count, real_use_documents, real_use_days FROM word_progress WHERE expression_id = 'expr'",
        )
        .get(),
    ).toEqual({ status: "active", real_use_count: 2, real_use_documents: 2, real_use_days: 1 });
  });

  it("counts a document once even when the Learning tab reports it twice", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    for (let index = 0; index < 2; index++) {
      recordWriting(
        learnerRow(learner),
        { text: "The bottleneck slows us down.", documentId: "same-document", assistedRanges: [] },
        { db: temp.db, now: NOW },
      );
    }
    pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    expect(
      temp.db
        .prepare("SELECT real_use_count, real_use_documents FROM word_progress WHERE expression_id = 'expr'")
        .get(),
    ).toEqual({ real_use_count: 1, real_use_documents: 1 });
  });

  it("two uses from the learner's own writing make a word active", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    expect(recordRealUse(learner, "expr", { db: temp.db, now: NOW })).toEqual({ status: "ready", active: false });
    expect(recordRealUse(learner, "expr", { db: temp.db, now: NOW })).toEqual({ status: "active", active: true });
    const counts = wordEngineCounts(learner, { db: temp.db, now: NOW });
    expect(counts.active).toBe(1);
  });
});

describe("Word check answers", () => {
  it("keeps known words out of My words and stores the rest with the right status", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    const used = recordWordCheckAnswer(learner, "bottleneck", "use", { db: temp.db, now: NOW });
    expect(used).toEqual({ added: false, status: "active" });
    expect(wordEngineCounts(learner, { db: temp.db, now: NOW })).toMatchObject({ learning: 0, ready: 0 });
    expect(recordWordCheckAnswer(learner, "negotiate", "know_unused", { db: temp.db, now: NOW })).toEqual({
      added: true,
      status: "ready",
    });
    expect(recordWordCheckAnswer(learner, "meticulous", "new", { db: temp.db, now: NOW })).toEqual({
      added: true,
      status: "learning",
    });
    // Answering again does not duplicate a row.
    recordWordCheckAnswer(learner, "negotiate", "not_sure", { db: temp.db, now: NOW });
    expect(
      temp.db.prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ? AND normalized = 'negotiate'").get(learner),
    ).toEqual({ n: 1 });
    // A half-known word stays Ready to activate.
    expect(temp.db.prepare("SELECT status, deep_known FROM word_progress WHERE normalized = 'negotiate'").get()).toEqual({
      status: "ready",
      deep_known: 1,
    });
  });

  it("counts Word check new answers against the three brand-new places", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    for (let index = 0; index < 9; index++) {
      recordWordCheckAnswer(learner, `newword${index}`, "new", { db: temp.db, now: NOW });
    }
    const first = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    for (const word of first.filter((item) => item.slot === "learn")) {
      recordPracticeResult(
        { learnerId: learner, expressionId: word.expressionId, rung: 1, productive: false, correct: true, usedHint: false },
        { db: temp.db, now: NOW },
      );
    }
    const second = pickSessionWords(learner, 8, { db: temp.db, now: NOW });
    const met = new Set(
      [...first, ...second.filter((word) => word.status === "learning")].map((word) => word.expressionId),
    );
    expect(met.size).toBeLessThanOrEqual(3);
  });
});

describe("answers and the productive counter", () => {
  it("a demotion resets productive credit so the next wrong answer cannot reactivate the word", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    for (let index = 0; index < 3; index++) {
      recordPracticeResult(
        { learnerId: learner, expressionId: "expr", rung: 4, productive: true, correct: true, usedHint: false },
        { db: temp.db, now: NOW },
      );
    }
    expect(temp.db.prepare("SELECT status FROM word_progress WHERE expression_id = 'expr'").get()).toEqual({
      status: "active",
    });
    for (let index = 0; index < 3; index++) {
      recordPracticeResult(
        { learnerId: learner, expressionId: "expr", rung: 4, productive: false, correct: false, usedHint: false },
        { db: temp.db, now: NOW },
      );
    }
    const afterErrors = temp.db
      .prepare("SELECT status, productive_answers FROM word_progress WHERE expression_id = 'expr'")
      .get() as unknown as { status: string; productive_answers: number };
    expect(afterErrors.status).not.toBe("active");
    expect(afterErrors.productive_answers).toBe(0);
  });

  it("hinted correct answers are assisted work: no rung, no productive credit, not Active", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    addExpression(temp.db, learner, "expr", "bottleneck");
    for (let index = 0; index < 3; index++) {
      recordPracticeResult(
        { learnerId: learner, expressionId: "expr", rung: 1, productive: true, correct: true, usedHint: true },
        { db: temp.db, now: NOW },
      );
    }
    expect(
      temp.db.prepare("SELECT status, rung, productive_answers FROM word_progress WHERE expression_id = 'expr'").get(),
    ).toEqual({ status: "ready", rung: 1, productive_answers: 0 });
  });
});

describe("saved expressions that match a starter entry", () => {
  it("reuses the starter row instead of failing the unique key", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    seedStarterWords(learner, "A2", { db: temp.db, now: NOW });
    const entry = temp.db
      .prepare("SELECT text FROM word_progress WHERE learner_id = ? LIMIT 1")
      .get(learner) as unknown as { text: string };
    addExpression(temp.db, learner, "saved-after-starter", entry.text);
    const first = recordPracticeResult(
      { learnerId: learner, expressionId: "saved-after-starter", rung: 1, productive: false, correct: true, usedHint: false },
      { db: temp.db, now: NOW },
    );
    expect(first.status).toBe("ready");
    expect(
      temp.db
        .prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ? AND normalized = ?")
        .get(learner, normalizeWord(entry.text)),
    ).toEqual({ n: 1 });
    // A second answer through the same saved id also works.
    expect(() =>
      recordPracticeResult(
        { learnerId: learner, expressionId: "saved-after-starter", rung: 1, productive: false, correct: true, usedHint: false },
        { db: temp!.db, now: NOW },
      ),
    ).not.toThrow();
  });

  it("keeps a starter identity stable after a session reference exists and a saved alias appears", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    seedStarterWords(learner, "A2", { db: temp.db, now: NOW });
    const starter = temp.db.prepare("SELECT expression_id, text FROM word_progress WHERE learner_id = ? LIMIT 1")
      .get(learner) as unknown as { expression_id: string; text: string };
    const d = temp.db;
    temp.db.prepare(`INSERT INTO practice_sessions (id, learner_id, request_id, status, requested_size, total, created_at)
      VALUES ('session-ref', ?, 'request-ref', 'preparing', 1, 1, ?)`)
      .run(learner, NOW.toISOString());
    temp.db.prepare(`INSERT INTO practice_session_items
      (id, learner_id, session_id, ordinal, expression_id, word_text, meaning, slot, word_status,
       start_rung, frequency, why, status)
      VALUES ('item-ref', ?, 'session-ref', 0, ?, ?, 'A meaning.', 'learn', 'learning', 1, 'common', 'A reason.', 'pending')`)
      .run(learner, starter.expression_id, starter.text);
    addExpression(temp.db, learner, "saved-alias", starter.text);

    // No answer event exists yet: the prepared session alone must be enough
    // to keep the canonical identity stable when its saved alias is scored.
    expect(() => recordPracticeResult(
      { learnerId: learner, expressionId: "saved-alias", rung: 1, productive: false, correct: true, usedHint: false },
      { db: d, now: NOW },
    )).not.toThrow();
    expect(() => recordPracticeResult(
      { learnerId: learner, expressionId: starter.expression_id, rung: 2, productive: false, correct: true, usedHint: false },
      { db: d, now: NOW },
    )).not.toThrow();
    expect(temp.db.prepare("SELECT expression_id FROM practice_session_items WHERE id = 'item-ref'").get())
      .toEqual({ expression_id: starter.expression_id });
    expect(temp.db.prepare("SELECT expression_id FROM word_progress WHERE learner_id = ? AND normalized = ?")
      .get(learner, normalizeWord(starter.text))).toEqual({ expression_id: starter.expression_id });
  });
});

describe("saved text equal to a starter entry and real use", () => {
  // The Learning tab records writing evidence under the expression the matcher
  // found, which is the saved id. The word row keeps the starter id, because
  // the normalized text already has a row. Evidence under either id belongs to
  // the one word.
  function aliasSetup(practiceFirst: boolean) {
    const db = createTempDb();
    const learner = insertLearner(db.db);
    seedStarterWords(learner, "A2", { db: db.db, now: NOW });
    const starter = db.db
      .prepare("SELECT expression_id FROM word_progress WHERE learner_id = ? AND text = 'on time'")
      .get(learner) as unknown as { expression_id: string };
    if (practiceFirst) {
      recordPracticeResult(
        { learnerId: learner, expressionId: starter.expression_id, rung: 1, productive: false, correct: true, usedHint: false },
        { db: db.db, now: NOW },
      );
    }
    addExpression(db.db, learner, "saved-on-time", "on time");
    return { db, learner, starter: starter.expression_id };
  }

  function wordRow(db: DatabaseSync, learner: string) {
    return db
      .prepare(
        "SELECT status, real_use_count, real_use_documents FROM word_progress WHERE learner_id = ? AND normalized = 'on time'",
      )
      .get(learner);
  }

  for (const practiceFirst of [false, true]) {
    it(`counts writing evidence under the saved id (${practiceFirst ? "with" : "without"} practice events)`, () => {
      const { db, learner } = aliasSetup(practiceFirst);
      for (const documentId of ["writing-one", "writing-two", "writing-two"]) {
        recordWriting(
          learnerRow(learner),
          { text: "We arrived on time.", documentId, assistedRanges: [] },
          { db: db.db, now: NOW },
        );
      }
      pickSessionWords(learner, 8, { db: db.db, now: NOW });
      expect(wordRow(db.db, learner)).toEqual({ status: "active", real_use_count: 2, real_use_documents: 2 });
      // An answer through the saved id keeps the same counts.
      recordPracticeResult(
        { learnerId: learner, expressionId: "saved-on-time", rung: 1, productive: false, correct: false, usedHint: false },
        { db: db.db, now: NOW },
      );
      expect(wordRow(db.db, learner)).toEqual({ status: "active", real_use_count: 2, real_use_documents: 2 });
      db.cleanup();
    });
  }

  it("counts evidence under the starter id when it arrives before the saved expression", () => {
    const { db, learner } = aliasSetup(false);
    // Evidence rows point at an expression, so the starter text is also saved
    // as an expression row: the writing matcher only finds saved expressions.
    addExpression(db.db, learner, "saved-on-time-two", "on time");
    // The evidence arrives before the engine creates the word row, so it can
    // only point at the expression id.
    db.db
      .prepare(
        `INSERT INTO evidence_events (id, learner_id, expression_id, kind, created_at, document_id)
         VALUES ('ev-one', ?, 'saved-on-time-two', 'independent_writing', ?, 'starter-doc')`,
      )
      .run(learner, NOW.toISOString());
    recordWriting(
      learnerRow(learner),
      { text: "We arrived on time.", documentId: "saved-doc", assistedRanges: [] },
      { db: db.db, now: NOW },
    );
    pickSessionWords(learner, 8, { db: db.db, now: NOW });
    expect(wordRow(db.db, learner)).toEqual({ status: "active", real_use_count: 2, real_use_documents: 2 });
    db.cleanup();
  });

  it("does not double count one document reported under both ids", () => {
    const { db, learner } = aliasSetup(false);
    addExpression(db.db, learner, "starter-on-time", "On time");
    for (const expressionId of ["saved-on-time", "starter-on-time"]) {
      db.db
        .prepare(
          `INSERT INTO evidence_events (id, learner_id, expression_id, kind, created_at, document_id)
           VALUES (?, ?, ?, 'independent_writing', ?, 'one-document')`,
        )
        .run(`ev-${expressionId}`, learner, expressionId, NOW.toISOString());
    }
    pickSessionWords(learner, 8, { db: db.db, now: NOW });
    expect(wordRow(db.db, learner)).toEqual({ status: "ready", real_use_count: 1, real_use_documents: 1 });
    db.cleanup();
  });
});
