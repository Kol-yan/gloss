// Word check: the onboarding step that finds where the learner's passive
// vocabulary ends and the edge to active use begins.
//
// One round is 24 curated starter entries picked around the learner's level:
// eight at the level below, eight at the level and eight above, so the answers
// reveal both the words the learner already uses and the words they have not
// met. The rounds are persisted per learner, which lets the POST map the ids
// the page sends back to entry texts, keeps "I use it" words out of later
// rounds and makes a repeated POST idempotent.
//
// Nothing here calls a model and nothing is shared between learners.

import type { DatabaseSync } from "node:sqlite";
import { OnboardingLevelInput, resolveOnboardingEngineLevel } from "@/shared/contracts";
import { getDb, immediate } from "../../db";
import { newId } from "../../ids";
import { InvalidRequestError } from "../../errors";
import { starterSet } from "../starter";
import type { StarterEntry } from "../starter/entries";
import { entryRung, estimateBand, normalizeWord, wordCheckOutcome } from "../priority/intake";
import type { CefrLevel as StarterLevel } from "../starter/entries";

// The Word check answers, from the shared contract.
export type WordCheckAnswer = "use" | "know_unused" | "not_sure" | "new";
export type CefrLevel = StarterLevel;

// The default when the learner has no estimate yet: the middle of the starter
// range, so a round covers one level below and one above from the start.
export const DEFAULT_LEVEL: CefrLevel = "B1";
export const WORD_CHECK_SIZE = 24;
// Eight entries at each level of a three-level round.
const PER_LEVEL = 8;

// Lowest to highest. Written out rather than imported so the level order the
// estimate depends on is visible where it is used.
const LEVELS = ["A2", "B1", "B2", "C1"] as const satisfies readonly CefrLevel[];

export interface WordCheckEntryView {
  id: string;
  text: string;
  level: CefrLevel;
  definition: string;
  example: string;
  answer: WordCheckAnswer | null;
}

export interface WordCheckRound {
  entries: WordCheckEntryView[];
  // Entries in the round, answered or not.
  roundSize: number;
  answered: number;
  completed: boolean;
  level: CefrLevel | null;
}

export interface WordCheckResult {
  level: CefrLevel;
  answered: number;
  counts: { active: number; ready: number; learning: number };
}

// Zero for A2 up to three for C1. Written as a switch rather than a list
// lookup so a level string from data always maps to its rank.
export function levelRank(level: CefrLevel): number {
  switch (level) {
    case "A2":
      return 0;
    case "B1":
      return 1;
    case "B2":
      return 2;
    case "C1":
      return 3;
    default:
      return -1;
  }
}

export function isCefrLevel(value: unknown): value is CefrLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

// The stored level, or DEFAULT_LEVEL when the learner has none yet.
export function learnerLevel(learnerId: string, db: DatabaseSync = getDb()): CefrLevel {
  const row = db.prepare("SELECT level FROM learners WHERE id = ?").get(learnerId) as
    | { level: string | null }
    | undefined;
  if (!row) throw new InvalidRequestError();
  return isCefrLevel(row.level) ? row.level : DEFAULT_LEVEL;
}

// One level below, the learner's own and one above, clamped at the ends of the
// range. At A2 the round takes A2 and B1; at C1 it takes B2 and C1.
export function roundLevels(level: CefrLevel): { level: CefrLevel; share: number }[] {
  const index = levelRank(level);
  const below = LEVELS[Math.max(0, index - 1)];
  const above = LEVELS[Math.min(LEVELS.length - 1, index + 1)];
  if (below === above) return [{ level, share: WORD_CHECK_SIZE }];
  if (below === level) return [{ level, share: PER_LEVEL * 2 }, { level: above, share: PER_LEVEL }];
  if (above === level) return [{ level: below, share: PER_LEVEL }, { level, share: PER_LEVEL * 2 }];
  return [
    { level: below, share: PER_LEVEL },
    { level, share: PER_LEVEL },
    { level: above, share: PER_LEVEL },
  ];
}

interface History {
  shows: number;
  lastShown: string | null;
}

// Fewest shows first, then the longest not shown, then alphabetical for a
// stable order.
function orderCandidates(entries: StarterEntry[], history: Map<string, History>): StarterEntry[] {
  return [...entries].sort((a, b) => {
    const first = history.get(normalizeWord(a.text)) ?? { shows: 0, lastShown: null };
    const second = history.get(normalizeWord(b.text)) ?? { shows: 0, lastShown: null };
    if (first.shows !== second.shows) return first.shows - second.shows;
    if (first.lastShown !== second.lastShown) {
      return (first.lastShown ?? "") < (second.lastShown ?? "") ? -1 : 1;
    }
    return a.text < b.text ? -1 : 1;
  });
}

// The 24 entries for this learner. Deterministic for a given database state so
// the same page load sees the same list, and stable across reloads on the same
// day through the persisted round. Words the learner has already answered in
// any round, or already keeps, are not offered again.
//
// The round belongs to the learner, not to the session: a reload returns the
// same round, each entry carries the answer already given (or null), and an
// entry answered in the round is never open again. `completed` is true once
// every entry of the round has an answer.
export function pickWordCheckEntries(
  learnerId: string,
  deps: { db?: DatabaseSync; now?: Date } = {},
): WordCheckRound {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const level = readLevel(db, learnerId);

  // The round the learner is in today. It is frozen once served: a level
  // chosen after the first GET moves the next round, never this one, so the
  // ids the page already holds keep answering the same words.
  const served = readRoundForDay(db, learnerId, today);
  if (served.length) return roundView(served, level);

  // Already answered in an earlier round, or already a word this learner
  // keeps (for example from the editor): do not ask again.
  const taken = new Set<string>();
  for (const row of db
    .prepare("SELECT text FROM word_check_entries WHERE learner_id = ?")
    .all(learnerId) as unknown as { text: string }[]) {
    taken.add(normalizeWord(row.text));
  }
  for (const row of db
    .prepare("SELECT normalized FROM word_progress WHERE learner_id = ?")
    .all(learnerId) as unknown as { normalized: string }[]) {
    taken.add(row.normalized);
  }
  const history = readHistory(db, learnerId);
  const picked: StarterEntry[] = [];
  const pool = starterSet().entries;
  // An explicit choice from the Level step is the starting point: the round is
  // built around it. No choice yet reads the stored estimate, which with no
  // answers is DEFAULT_LEVEL.
  for (const { level: rung, share } of roundLevels(level ?? DEFAULT_LEVEL)) {
    const candidates = orderCandidates(
      pool.filter((entry) => entry.level === rung && !taken.has(normalizeWord(entry.text))),
      history,
    );
    for (const entry of candidates.slice(0, share)) {
      picked.push(entry);
      taken.add(normalizeWord(entry.text));
    }
  }
  // A level can run short after a long history; fill from every remaining
  // entry in the learned order so a round is still 24 entries when the set
  // allows it.
  if (picked.length < WORD_CHECK_SIZE) {
    const rest = orderCandidates(pool.filter((entry) => !taken.has(normalizeWord(entry.text))), history);
    for (const entry of rest) {
      if (picked.length >= WORD_CHECK_SIZE) break;
      picked.push(entry);
      taken.add(normalizeWord(entry.text));
    }
  }

  const iso = now.toISOString();
  const rows = immediate((tx) => {
    const insert = tx.prepare(
      `INSERT INTO word_check_entries (id, learner_id, text, level, last_shown_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const views: ServedRow[] = [];
    for (const entry of picked) {
      const id = newId();
      insert.run(id, learnerId, entry.text, entry.level, today, iso);
      views.push({ id, text: entry.text, level: entry.level, word_check_answer: null });
    }
    return views;
  }, db);
  return roundView(rows, level);
}

interface ServedRow {
  id: string;
  text: string;
  level: string;
  word_check_answer: string | null;
}

// The round in the order it was served, each entry resolved against the
// curated set (a word that has since left the set is skipped).
function roundView(served: ServedRow[], level: CefrLevel | null): WordCheckRound {
  const byText = starterSet().byText;
  const entries: WordCheckEntryView[] = [];
  for (const row of served) {
    const entry = byText.get(normalizeWord(row.text));
    if (entry) entries.push(toView(row.id, entry, asAnswer(row.word_check_answer)));
  }
  const answered = entries.filter((entry) => entry.answer !== null).length;
  return {
    entries,
    roundSize: entries.length,
    answered,
    completed: entries.length > 0 && answered === entries.length,
    level,
  };
}

function asAnswer(value: string | null): WordCheckAnswer | null {
  if (value === "use" || value === "know_unused" || value === "not_sure" || value === "new") return value;
  return null;
}

function toView(id: string, entry: StarterEntry, answer: WordCheckAnswer | null): WordCheckEntryView {
  return { id, text: entry.text, level: entry.level, definition: entry.definition, example: entry.example, answer };
}

// The round this learner was served today, in the order it was served.
function readRoundForDay(db: DatabaseSync, learnerId: string, day: string): ServedRow[] {
  return db
    .prepare(
      `SELECT id, text, level, word_check_answer FROM word_check_entries
       WHERE learner_id = ? AND last_shown_on = ?
       ORDER BY rowid`,
    )
    .all(learnerId, day) as unknown as ServedRow[];
}

function readLevel(db: DatabaseSync, learnerId: string): CefrLevel | null {
  const row = db.prepare("SELECT level FROM learners WHERE id = ?").get(learnerId) as
    | { level: string | null }
    | undefined;
  if (!row) throw new InvalidRequestError();
  return isCefrLevel(row.level) ? row.level : null;
}

function readHistory(db: DatabaseSync, learnerId: string): Map<string, History> {
  const rows = db
    .prepare(
      `SELECT text, COUNT(*) AS shows, MAX(last_shown_on) AS last_shown
       FROM word_check_entries WHERE learner_id = ? GROUP BY text`,
    )
    .all(learnerId) as unknown as { text: string; shows: number; last_shown: string | null }[];
  const map = new Map<string, History>();
  for (const row of rows) map.set(normalizeWord(row.text), { shows: row.shows, lastShown: row.last_shown });
  return map;
}

// Store the level chosen on the Level step. It is the starting point for the
// next Word check round; Word check answers then refine `learners.level` from
// their own evidence (see estimateLevel). Accepts a legacy CEFR level or a
// named group; the stored value is always the canonical A2/B1/B2/C1 level.
export function recordChosenLevel(
  learnerId: string,
  level: OnboardingLevelInput,
  deps: { db?: DatabaseSync } = {},
): CefrLevel {
  const db = deps.db ?? getDb();
  const parsed = OnboardingLevelInput.safeParse(level);
  if (!parsed.success) throw new InvalidRequestError();
  const canonical = resolveOnboardingEngineLevel(parsed.data);
  const result = db.prepare("UPDATE learners SET level = ? WHERE id = ?").run(canonical, learnerId);
  if (result.changes === 0) throw new InvalidRequestError();
  return canonical;
}

// The level estimate from Word check answers.
//
// Every answer is one line drawn from the curated level of its word:
//
//   "use"          -> level + 1 (this word is already active for the learner)
//   "know_unused"  -> level     (known, on the edge)
//   "not_sure"     -> level - 1 (met, not known)
//   "new"          -> level - 2 (not met)
//
// The mean of all answered words, rounded down and clamped to A2..C1, is
// the estimate. It is cumulative: a second round averages over both rounds, so
// the estimate refines itself without a stored history. No answers yet means
// DEFAULT_LEVEL. The rule is deliberately coarse - it separates adjacent
// levels and nothing more - and is documented in ARCHITECTURE.md.
export function estimateLevel(
  answers: readonly { level: CefrLevel; answer: WordCheckAnswer }[],
): CefrLevel {
  if (!answers.length) return DEFAULT_LEVEL;
  let total = 0;
  let count = 0;
  for (const item of answers) {
    if (!isCefrLevel(item.level)) continue;
    const weight = answerWeight(item.answer);
    if (weight === null) continue;
    total += levelRank(item.level) + weight;
    count += 1;
  }
  if (!count) return DEFAULT_LEVEL;
  const mean = total / count;
  // Rounded down: a mean of 2.99 is B2, not C1. Clamped to the range.
  const index = Math.max(0, Math.min(3, Math.floor(mean)));
  return LEVELS[index];
}

// The stored answers, one per word, read back from the round rows and the
// word rows, so a second POST continues from what the first one saved instead
// of starting over. The round row is authoritative: it still holds the answer
// of a word the learner already keeps, which has no word row of its own for
// that answer.
function readAnswered(db: DatabaseSync, learnerId: string): { level: CefrLevel; answer: WordCheckAnswer }[] {
  const byText = new Map<string, WordCheckAnswer>();
  for (const row of db
    .prepare("SELECT text, word_check_answer AS answer FROM word_progress WHERE learner_id = ? AND word_check_answer IS NOT NULL")
    .all(learnerId) as unknown as { text: string; answer: string }[]) {
    byText.set(normalizeWord(row.text), row.answer as WordCheckAnswer);
  }
  const out: { level: CefrLevel; answer: WordCheckAnswer }[] = [];
  const seen = new Set<string>();
  // The word rows first: they hold the answer that became the word's state,
  // including the earliest round of a word answered again later.
  const levelOf = new Map(
    (
      db
        .prepare("SELECT text, level FROM word_progress WHERE learner_id = ? AND level IS NOT NULL")
        .all(learnerId) as unknown as { text: string; level: string }[]
    ).map((row) => [normalizeWord(row.text), row.level]),
  );
  for (const [text, answer] of byText) {
    const level = levelOf.get(text);
    if (!isCefrLevel(level)) continue;
    seen.add(text);
    out.push({ level, answer });
  }
  // Then the round rows whose word has no row of its own ("I use it"), latest
  // answer per word first, so one word is never counted twice.
  for (const row of db
    .prepare(
      `SELECT text, level, word_check_answer AS answer FROM word_check_entries
       WHERE learner_id = ? AND word_check_answer IS NOT NULL
       ORDER BY last_shown_on DESC, rowid DESC`,
    )
    .all(learnerId) as unknown as { text: string; level: string; answer: string }[]) {
    const key = normalizeWord(row.text);
    if (seen.has(key) || !isCefrLevel(row.level)) continue;
    seen.add(key);
    out.push({ level: row.level, answer: row.answer as WordCheckAnswer });
  }
  return out;
}

// Each answer's distance from its word's level. A word the learner uses lifts
// the line by one level; a word they have not met drops it by two.
function answerWeight(answer: WordCheckAnswer): number | null {
  if (answer === "use") return 1;
  if (answer === "know_unused") return 0;
  if (answer === "not_sure") return -1;
  if (answer === "new") return -2;
  return null;
}

interface ServedRow {
  id: string;
  text: string;
}

// Store Word check answers. Every id must be one this learner was served; an
// unknown id rejects the whole request, so a page bug cannot write part of a
// round against the wrong words. A repeated POST rewrites the same word rows
// with the same result: rows are keyed by the learner's normalized text, so no
// duplicate word or duplicate brand-new place is created.
export function recordWordCheckAnswers(
  learnerId: string,
  answers: readonly { id: string; answer: WordCheckAnswer }[],
  deps: { db?: DatabaseSync; now?: Date } = {},
): WordCheckResult {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const iso = now.toISOString();

  const served = new Map<string, { id: string; text: string }>();
  for (const row of db
    .prepare("SELECT id, text FROM word_check_entries WHERE learner_id = ?")
    .all(learnerId) as unknown as { id: string; text: string }[]) {
    served.set(row.id, row);
  }
  const seen = new Set<string>();
  for (const item of answers) {
    if (!served.has(item.id)) throw new InvalidRequestError();
    // The same id twice would let one answer silently overwrite another.
    if (seen.has(item.id)) throw new InvalidRequestError();
    seen.add(item.id);
  }

  return immediate((tx): WordCheckResult => {
    const counts = { active: 0, ready: 0, learning: 0 };
    for (const item of answers) {
      const entry = served.get(item.id);
      if (!entry) throw new InvalidRequestError();
      writeAnswer(tx, learnerId, entry.text, item.answer, iso);
      tx.prepare("UPDATE word_check_entries SET word_check_answer = ? WHERE learner_id = ? AND id = ?").run(
        item.answer,
        learnerId,
        item.id,
      );
      // The counts describe this request's answers.
      const outcome = wordCheckOutcome(item.answer);
      counts[outcome.add ? (outcome.status === "ready" ? "ready" : "learning") : "active"] += 1;
    }
    const level = estimateLevel(readAnswered(tx, learnerId));
    tx.prepare("UPDATE learners SET level = ? WHERE id = ?").run(level, learnerId);
    return { level, answered: answers.length, counts };
  }, db);
}

// One Word check answer.
//
// "I use it" is known vocabulary and nothing more: the round row already
// records that the learner was asked and answered, so the level estimate and
// future rounds read the answer from `word_check_answer` there. No word row is
// written, the word never enters My words and the practice session never ranks
// it.
//
// The other answers create (or reuse) the learner's word row, with the starter
// level kept on it for the estimate. A word the learner already keeps keeps
// its own state: the answer is not allowed to demote it back to learning.
function writeAnswer(
  db: DatabaseSync,
  learnerId: string,
  text: string,
  answer: WordCheckAnswer,
  iso: string,
): void {
  const outcome = wordCheckOutcome(answer);
  const normalized = normalizeWord(text);
  const entry = starterSet().byText.get(normalized);
  const level = entry?.level ?? null;

  if (!outcome.add) return;

  const previous = db
    .prepare("SELECT deep_known, word_check_answer FROM word_progress WHERE learner_id = ? AND normalized = ?")
    .get(learnerId, normalized) as unknown as { deep_known: number; word_check_answer: string | null } | undefined;
  // "New to me" is a deep first meeting. "Not sure" is not: the word is met.
  // A repeated POST of the same answer changes nothing (see the conflict
  // branch), so it cannot turn a "not sure" word into a deep one either.
  const isDeep = answer === "new";
  const knownBefore = previous !== undefined && previous.word_check_answer !== null;
  db.prepare(
    `INSERT INTO word_progress
       (expression_id, learner_id, text, normalized, source, status, band, rung,
        deep_known, introduced_on, word_check_answer, level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'word_check', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (learner_id, normalized) DO UPDATE SET
       -- The first answer is kept: a repeated POST of the same body changes
       -- nothing, and a later round does not re-ask an answered word anyway.
       updated_at = word_progress.updated_at`,
  ).run(
    newId(),
    learnerId,
    text.trim(),
    normalized,
    outcome.status,
    entry?.band ?? estimateBand(text, entry?.tags),
    entryRung(outcome.status),
    isDeep ? 1 : 0,
    !knownBefore && isDeep ? iso.slice(0, 10) : null,
    answer,
    level,
    iso,
    iso,
  );
}
