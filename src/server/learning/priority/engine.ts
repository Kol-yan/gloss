// The word engine functions of track B. They read and write the learner's
// `word_progress` table and keep the pure rules in `rules.ts` and
// `scheduler.ts` free of database code.
//
// Every query filters by the learner passed in; there is no default learner.
// A saved expression and a starter entry text are the same word: before the
// first answer the engine materialises one row per saved expression, and a
// starter entry whose text matches it joins that row.

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "../../db";
import { newId } from "../../ids";
import { starterSet } from "../starter";
import type { StarterEntry } from "../starter/entries";
import { entryRung, estimateBand, normalizeWord, wordCheckOutcome, type WordCheckAnswer } from "./intake";
import { recordAnswer, applyRealUse, productiveAfterAnswer } from "./rules";
import { isBrandNew, pickWords } from "./scheduler";
import {
  DEFAULT_RUNG,
  RARE_CHECK_DAYS,
  type FrequencyBand,
  type PracticeResult,
  type PracticeResultInput,
  type SessionWord,
  type StoredWord,
  type WordSource,
  type WordStatus,
} from "./types";

export type { SessionWord, WordStatus, FrequencyBand };

const DAY_MS = 86_400_000;
// Accuracy over the learner's last answers; a small sample is ignored.
const ACCURACY_WINDOW = 20;
const ACCURACY_MIN_ANSWERS = 4;

interface WordRow {
  expression_id: string;
  learner_id: string;
  text: string;
  normalized: string;
  source: string;
  status: string;
  band: string | null;
  rung: number;
  productive_answers: number;
  real_use_count: number;
  real_use_documents: number;
  real_use_days: number;
  real_use_last_at: string | null;
  word_check_answer: string | null;
  consecutive_errors: number;
  answers: number;
  correct_answers: number;
  deep_known: number;
  bland: number;
  last_practiced_at: string | null;
  next_at: string | null;
  introduced_on: string | null;
  created_at: string;
}

function toStored(row: WordRow): StoredWord {
  return {
    expressionId: row.expression_id,
    learnerId: row.learner_id,
    text: row.text,
    normalized: row.normalized,
    source: row.source as WordSource,
    status: row.status as WordStatus,
    band: (row.band as FrequencyBand | null) ?? estimateBand(row.text),
    rung: row.rung,
    productiveAnswers: row.productive_answers,
    realUseCount: row.real_use_count,
    realUseDocuments: row.real_use_documents,
    realUseDays: row.real_use_days,
    realUseLastAt: row.real_use_last_at,
    wordCheckAnswer: row.word_check_answer as StoredWord["wordCheckAnswer"],
    consecutiveErrors: row.consecutive_errors,
    answers: row.answers,
    correctAnswers: row.correct_answers,
    deepKnown: row.deep_known,
    bland: row.bland,
    lastPracticedAt: row.last_practiced_at,
    nextAt: row.next_at,
    introducedOn: row.introduced_on,
    createdAt: row.created_at,
  };
}

function readWords(db: DatabaseSync, learnerId: string): StoredWord[] {
  const rows = db
    .prepare("SELECT * FROM word_progress WHERE learner_id = ?")
    .all(learnerId) as unknown as WordRow[];
  return rows.map(toStored);
}

// The old real-use evidence can arrive before the engine is asked for a
// session, so the engine reads it directly. One document counts once even when
// the Learning tab reports it twice.
interface RealUseFact {
  documents: number;
  days: number;
}

// A word and every expression id that shares its normalized text. The engine
// keeps one row per normalized text, but the Learning tab records writing
// evidence under whichever expression the matcher found: the saved expression,
// a starter entry, or both when texts collide. Counting the evidence of the
// whole identity set means nothing is lost and nothing is counted twice.
// The empty set for a word that has no evidence rows.
function realUseFacts(db: DatabaseSync, learnerId: string, words: readonly StoredWord[]): Map<string, RealUseFact> {
  if (!words.length) return new Map();
  const byNormalized = new Map<string, StoredWord[]>();
  for (const word of words) {
    const group = byNormalized.get(word.normalized);
    if (group) group.push(word);
    else byNormalized.set(word.normalized, [word]);
  }
  const rows = db
    .prepare(
      `SELECT e.expression_id, e.document_id, substr(e.created_at, 1, 10) AS day,
              COALESCE(x.text, p.text) AS text
       FROM evidence_events e
       LEFT JOIN expressions x ON x.id = e.expression_id AND x.learner_id = e.learner_id
       LEFT JOIN word_progress p ON p.expression_id = e.expression_id AND p.learner_id = e.learner_id
       WHERE e.learner_id = ? AND e.kind = 'independent_writing'`,
    )
    .all(learnerId) as unknown as {
    expression_id: string;
    document_id: string | null;
    day: string;
    text: string | null;
  }[];
  // Evidence rows that share a document id count as one use, across the whole
  // identity set: the same sentence in the same document is one act of writing.
  const seen = new Map<string, { documents: Set<string>; days: Set<string> }>();
  for (const row of rows) {
    const word = row.text ? byNormalized.get(normalizeWord(row.text))?.[0] : undefined;
    const key = word?.expressionId ?? row.expression_id;
    const fact = seen.get(key) ?? { documents: new Set<string>(), days: new Set<string>() };
    fact.documents.add(row.document_id ?? "");
    fact.days.add(row.day);
    seen.set(key, fact);
  }
  if (!seen.size) return new Map();
  const facts = new Map<string, RealUseFact>();
  for (const [expressionId, fact] of seen) {
    facts.set(expressionId, { documents: fact.documents.size, days: fact.days.size });
  }
  return facts;
}

// Bring stored real-use counters in line with the evidence and apply the
// status rule. A stored row may already carry a direct real-use record, so the
// sync only advances the counts; it never lowers them.
function syncRealUse(
  db: DatabaseSync,
  learnerId: string,
  words: StoredWord[],
  now: Date,
): StoredWord[] {
  const facts = realUseFacts(db, learnerId, words);
  if (!facts.size) return words;
  const update = db.prepare(
    `UPDATE word_progress SET
       real_use_count = ?, real_use_documents = ?, real_use_days = ?,
       status = ?, next_at = ?, updated_at = ?
     WHERE learner_id = ? AND expression_id = ?`,
  );
  return words.map((word) => {
    const fact = facts.get(word.expressionId);
    if (!fact) return word;
    if (fact.documents <= word.realUseDocuments && fact.days <= word.realUseDays) return word;

    const documents = Math.max(word.realUseDocuments, fact.documents);
    const days = Math.max(word.realUseDays, fact.days);
    let status = word.status;
    let nextAt = word.nextAt;
    if (word.status !== "hidden") {
      if (documents >= 2 && (word.status === "learning" || word.status === "ready")) {
        status = "active";
      } else if (documents >= 1 && word.status === "learning") {
        status = "ready";
      }
      if (status === "active" && word.status !== "active") {
        nextAt = word.nextAt ?? new Date(now.getTime() + RARE_CHECK_DAYS * DAY_MS).toISOString();
      }
    }
    update.run(documents, documents, days, status, nextAt, now.toISOString(), learnerId, word.expressionId);
    return { ...word, realUseCount: documents, realUseDocuments: documents, realUseDays: days, status, nextAt };
  });
}

function starterIndex(): Map<string, StarterEntry> {
  return starterSet().byText;
}

// One row per saved expression. A saved row that matches a starter entry is
// stored with the curated band and starter source but no word row is created
// twice: the `normalized` unique key decides.
function materializeSavedWords(db: DatabaseSync, learnerId: string, now: Date): void {
  const saved = db
    .prepare("SELECT id, text, meaning, familiarity FROM expressions WHERE learner_id = ?")
    .all(learnerId) as unknown as {
    id: string;
    text: string;
    meaning: string;
    familiarity: string;
  }[];
  if (!saved.length) return;

  const insert = db.prepare(
    `INSERT INTO word_progress
       (expression_id, learner_id, text, normalized, source, status, band, rung,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (learner_id, normalized) DO NOTHING`,
  );
  const starter = starterIndex();
  const iso = now.toISOString();
  for (const expression of saved) {
    const matched = starter.get(normalizeWord(expression.text));
    // A saved word the learner marked "known but unused" starts on the edge.
    const status: WordStatus = expression.familiarity === "known_unused" ? "ready" : "learning";
    const source: WordSource = matched ? "starter" : "saved";
    const band = matched?.band ?? estimateBand(expression.text, matched?.tags);
    insert.run(
      expression.id,
      learnerId,
      expression.text,
      normalizeWord(expression.text),
      source,
      status,
      band,
      entryRung(status),
      iso,
      iso,
    );
  }
}

function readAccuracy(db: DatabaseSync, learnerId: string): number | null {
  const rows = db
    .prepare(
      `SELECT correct FROM word_practice_events
       WHERE learner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(learnerId, ACCURACY_WINDOW) as unknown as { correct: number }[];
  if (rows.length < ACCURACY_MIN_ANSWERS) return null;
  return rows.filter((row) => row.correct === 1).length / rows.length;
}

// The session for this learner. Deterministic for a given database state and
// clock.
export function pickSessionWords(learnerId: string, size: number = 8, deps: { db?: DatabaseSync; now?: Date } = {}): SessionWord[] {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  materializeSavedWords(db, learnerId, now);
  const words = syncRealUse(db, learnerId, readWords(db, learnerId), now);
  const today = now.toISOString().slice(0, 10);
  const picked = pickWords({
    words,
    brandNewToday: words.filter((word) => word.introducedOn === today).length,
    accuracy: readAccuracy(db, learnerId),
    now,
    size,
  });
  // A brand-new word takes one of the day's places when it is first shown, so
  // a second session on the same day sees the places used. Only words with no
  // answer yet are brand-new; a word the learner already worked on is not.
  const brandNew = new Set(words.filter(isBrandNew).map((word) => word.expressionId));
  const mark = db.prepare(
    `UPDATE word_progress SET introduced_on = ?
     WHERE learner_id = ? AND expression_id = ? AND introduced_on IS NULL`,
  );
  for (const word of picked) {
    if (word.slot === "learn" && brandNew.has(word.expressionId)) mark.run(today, learnerId, word.expressionId);
  }
  return picked;
}

function findWord(
  db: DatabaseSync,
  learnerId: string,
  expressionId: string,
  now: Date = new Date(),
): StoredWord {
  const row = db
    .prepare("SELECT * FROM word_progress WHERE learner_id = ? AND expression_id = ?")
    .get(learnerId, expressionId) as unknown as WordRow | undefined;
  if (row) return syncRealUse(db, learnerId, [toStored(row)], now)[0];
  // A saved expression whose row was not materialised yet (the first answer
  // can arrive before the first session).
  const saved = db
    .prepare("SELECT id, text, familiarity FROM expressions WHERE learner_id = ? AND id = ?")
    .get(learnerId, expressionId) as unknown as { id: string; text: string; familiarity: string } | undefined;
  if (!saved) throw new Error("Unknown word");
  const normalized = normalizeWord(saved.text);
  // A saved expression and a starter entry with the same text are one word.
  // Reuse the existing row instead of inserting a second row for the same
  // normalized text: the unique key would reject it.
  const existing = db
    .prepare("SELECT * FROM word_progress WHERE learner_id = ? AND normalized = ?")
    .get(learnerId, normalized) as unknown as WordRow | undefined;
  if (existing) {
    const events = db
      .prepare("SELECT COUNT(*) AS n FROM word_practice_events WHERE learner_id = ? AND expression_id = ?")
      .get(learnerId, existing.expression_id) as unknown as { n: number };
    // Before the first answer the row can adopt the saved expression id, so
    // later answers find it directly. Its band, status and source stay as the
    // starter row set them.
    if (events.n === 0) {
      db.prepare(
        "UPDATE word_progress SET expression_id = ?, updated_at = ? WHERE learner_id = ? AND expression_id = ?",
      ).run(expressionId, now.toISOString(), learnerId, existing.expression_id);
      const adopted = db
        .prepare("SELECT * FROM word_progress WHERE learner_id = ? AND expression_id = ?")
        .get(learnerId, expressionId) as unknown as WordRow;
      return syncRealUse(db, learnerId, [toStored(adopted)], now)[0];
    }
    // The row already has answers; keep them on their own expression id.
    return syncRealUse(db, learnerId, [toStored(existing)], now)[0];
  }
  const status: WordStatus = saved.familiarity === "known_unused" ? "ready" : "learning";
  const band = estimateBand(saved.text);
  const iso = now.toISOString();
  db.prepare(
    `INSERT INTO word_progress
       (expression_id, learner_id, text, normalized, source, status, band, rung, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'saved', ?, ?, ?, ?, ?)
     ON CONFLICT (learner_id, normalized) DO NOTHING`,
  ).run(expressionId, learnerId, saved.text, normalized, status, band, entryRung(status), iso, iso);
  const row2 = db
    .prepare(
      "SELECT * FROM word_progress WHERE learner_id = ? AND (expression_id = ? OR normalized = ?) LIMIT 1",
    )
    .get(learnerId, expressionId, normalized) as unknown as WordRow;
  return syncRealUse(db, learnerId, [toStored(row2)], now)[0];
}

// Store one practice answer and return where the word goes next. Two errors in
// a row also reset the streak, so a third failure does not move the word again.
export function recordPracticeResult(
  input: PracticeResultInput,
  deps: { db?: DatabaseSync; now?: Date } = {},
): PracticeResult {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const word = findWord(db, input.learnerId, input.expressionId, now);
  const errorsAfter = input.correct ? 0 : word.consecutiveErrors + 1;

  if (input.reaction === "not_relevant") {
    const result = recordAnswer(input, word, now, errorsAfter);
    persist(db, word, result, input, now, { answers: word.answers, correct: word.correctAnswers, errors: 0, productive: word.productiveAnswers, bland: word.bland, realUse: word.realUseCount });
    return result;
  }

  const result = recordAnswer(input, word, now, errorsAfter);
  const steppedDown = errorsAfter >= 2 && !input.correct;
  const productiveAnswers = productiveAfterAnswer(word, input, errorsAfter);
  persist(db, word, result, input, now, {
    answers: word.answers + 1,
    correct: word.correctAnswers + (input.correct ? 1 : 0),
    errors: steppedDown || input.correct ? 0 : errorsAfter,
    productive: productiveAnswers,
    bland: word.bland + (input.reaction === "too_easy" ? 1 : 0),
    realUse: word.realUseCount,
  });
  return result;
}

interface Counters {
  answers: number;
  correct: number;
  errors: number;
  productive: number;
  bland: number;
  realUse: number;
}

function persist(
  db: DatabaseSync,
  word: StoredWord,
  result: PracticeResult,
  input: PracticeResultInput,
  now: Date,
  counters: Counters,
): void {
  // The step down for good is recorded inside one transaction: the event and
  // the counters can never disagree.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE word_progress SET
         status = ?, rung = ?, productive_answers = ?, consecutive_errors = ?,
         answers = ?, correct_answers = ?, bland = ?, last_practiced_at = ?,
         next_at = ?, updated_at = ?
       WHERE learner_id = ? AND expression_id = ?`,
    ).run(
      result.status,
      result.nextRung,
      counters.productive,
      counters.errors,
      counters.answers,
      counters.correct,
      counters.bland,
      now.toISOString(),
      result.comesBackAt,
      now.toISOString(),
      word.learnerId,
      word.expressionId,
    );
    db.prepare(
      `INSERT INTO word_practice_events
         (id, learner_id, expression_id, rung, productive, correct, used_hint, reaction, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      word.learnerId,
      word.expressionId,
      Math.min(6, Math.max(1, Math.round(input.rung))) || DEFAULT_RUNG,
      input.productive ? 1 : 0,
      input.correct ? 1 : 0,
      input.usedHint ? 1 : 0,
      input.reaction ?? null,
      now.toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Real use from the learner's own writing ("Used on your own in real writing").
// It is recorded by the Learning tab and counts toward Active.
export function recordRealUse(
  learnerId: string,
  expressionId: string,
  deps: { db?: DatabaseSync; now?: Date } = {},
): { status: WordStatus; active: boolean } {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const word = findWord(db, learnerId, expressionId, now);
  const result = applyRealUse(word);
  const hidden = result.status === "hidden";
  const realUseCount = hidden ? word.realUseCount : word.realUseCount + 1;
  const today = now.toISOString().slice(0, 10);
  const newDay = word.realUseLastAt?.slice(0, 10) !== today;
  const documents = hidden ? word.realUseDocuments : word.realUseDocuments + 1;
  const days = hidden ? word.realUseDays : word.realUseDays + (newDay ? 1 : 0);
  db.prepare(
    `UPDATE word_progress SET
       status = ?, real_use_count = ?, real_use_documents = ?, real_use_days = ?,
       real_use_last_at = ?, updated_at = ?
     WHERE learner_id = ? AND expression_id = ?`,
  ).run(
    result.status,
    realUseCount,
    documents,
    days,
    hidden ? word.realUseLastAt : now.toISOString(),
    now.toISOString(),
    learnerId,
    word.expressionId,
  );
  return result;
}

// Seed this learner's starter words at or below their level. Written once per
// learner; later calls are a no-op. Words the learner already keeps (a Word
// check row with the same text) are not duplicated.
export function seedStarterWords(
  learnerId: string,
  level: "A2" | "B1" | "B2" | "C1" = "B1",
  deps: { db?: DatabaseSync; now?: Date } = {},
): number {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const exists = db
    .prepare("SELECT 1 FROM word_progress WHERE learner_id = ? AND source = 'starter' LIMIT 1")
    .get(learnerId);
  if (exists) return 0;
  const iso = now.toISOString();
  const insert = db.prepare(
    `INSERT INTO word_progress
       (expression_id, learner_id, text, normalized, source, status, band, rung, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'starter', 'learning', ?, 1, ?, ?)
     ON CONFLICT (learner_id, normalized) DO NOTHING`,
  );
  let inserted = 0;
  for (const entry of starterSet().entries) {
    if (levelRank(entry.level) > levelRank(level)) continue;
    const result = insert.run(newId(), learnerId, entry.text, normalizeWord(entry.text), entry.band, iso, iso);
    inserted += Number(result.changes);
  }
  return inserted;
}

function levelRank(level: string): number {
  return { A2: 0, B1: 1, B2: 2, C1: 3 }[level] ?? 1;
}

// Word check answers. "I use it" is known vocabulary, not a My words row.
export function recordWordCheckAnswer(
  learnerId: string,
  text: string,
  answer: WordCheckAnswer,
  deps: { db?: DatabaseSync; now?: Date } = {},
): { added: boolean; status: WordStatus } {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const outcome = wordCheckOutcome(answer);
  if (!outcome.add) return { added: false, status: outcome.status };

  const normalized = normalizeWord(text);
  const iso = now.toISOString();
  const previous = db
    .prepare("SELECT deep_known FROM word_progress WHERE learner_id = ? AND normalized = ?")
    .get(learnerId, normalized) as unknown as { deep_known: number } | undefined;
  // A second "not sure" is a deep first meeting, not a second state.
  const repeatedHalfKnown = answer === "not_sure" && (previous?.deep_known ?? 0) >= 1;
  // The first "not sure" is a half-known word; a repeated one or "new" is a
  // deep first meeting that takes a brand-new place.
  const isDeep = answer === "new" || repeatedHalfKnown;
  db.prepare(
    `INSERT INTO word_progress
       (expression_id, learner_id, text, normalized, source, status, band, rung,
        deep_known, introduced_on, word_check_answer, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (learner_id, normalized) DO UPDATE SET
       -- A later "not sure" upgrades a half-known word; "confirmed" is kept.
       deep_known = excluded.deep_known,
       word_check_answer = excluded.word_check_answer,
       status = CASE
         WHEN word_progress.status = 'active' THEN 'active'
         WHEN word_progress.status = 'ready' AND excluded.status = 'learning' THEN 'ready'
         ELSE excluded.status END,
       updated_at = excluded.updated_at`,
  ).run(
    newId(),
    learnerId,
    text.trim(),
    normalized,
    outcome.source,
    outcome.status,
    estimateBand(text),
    entryRung(outcome.status),
    answer === "not_sure" ? 1 : isDeep ? 1 : 0,
    isDeep ? iso.slice(0, 10) : null,
    answer,
    iso,
    iso,
  );
  const row = db
    .prepare("SELECT status FROM word_progress WHERE learner_id = ? AND normalized = ?")
    .get(learnerId, normalized) as unknown as { status: string };
  return { added: true, status: row.status as WordStatus };
}

// Which words need attention today, for a simple Today screen.
export function wordEngineCounts(
  learnerId: string,
  deps: { db?: DatabaseSync; now?: Date } = {},
): Record<WordStatus | "due", number> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const rows = db
    .prepare("SELECT status, next_at FROM word_progress WHERE learner_id = ?")
    .all(learnerId) as unknown as { status: WordStatus; next_at: string | null }[];
  const counts = { learning: 0, ready: 0, active: 0, hidden: 0, due: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status !== "hidden" && (!row.next_at || Date.parse(row.next_at) - now.getTime() <= DAY_MS)) {
      counts.due += 1;
    }
  }
  return counts;
}
