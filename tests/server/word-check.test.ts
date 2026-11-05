import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, migrate } from "@/server/db";
import {
  estimateLevel,
  pickWordCheckEntries,
  recordChosenLevel,
  recordWordCheckAnswers,
  roundLevels,
  WORD_CHECK_SIZE,
} from "@/server/learning/onboarding/word-check";
import { pickSessionWords, wordEngineCounts } from "@/server/learning/priority";
import { starterSet } from "@/server/learning/starter";
import { createTempDb, insertLearner, type TempDb } from "./helpers/db";

let temp: TempDb | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const NOW = new Date("2026-11-04T09:00:00.000Z");

function levelOfWord(learnerId: string, db: DatabaseSync, text: string) {
  return db
    .prepare("SELECT status, source, level, word_check_answer FROM word_progress WHERE learner_id = ? AND normalized = ?")
    .get(learnerId, text.toLowerCase());
}

describe("Word check migrations", () => {
  it("adds the onboarding columns and table to a fresh database", () => {
    temp = createTempDb();
    const learnerColumns = temp.db.prepare("PRAGMA table_info(learners)").all().map((row) => String(row.name));
    expect(learnerColumns).toContain("level");
    const wordColumns = temp.db.prepare("PRAGMA table_info(word_progress)").all().map((row) => String(row.name));
    for (const column of ["level", "word_check_entry"]) expect(wordColumns).toContain(column);
    const tables = temp.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'word_check_entries'")
      .all();
    expect(tables).toHaveLength(1);
    expect(temp.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("applies on a copy of the current schema and keeps existing data", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-word-check-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    // Everything that shipped before this task; the new file is applied later.
    for (const file of readdirSync(source).filter((name) => /^00(0[1-9]|1[01])_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      migrate(db, oldMigrations);
      const learner = insertLearner(db, "pilot", "Existing");
      const iso = NOW.toISOString();
      db.prepare(
        "INSERT INTO word_progress (expression_id, learner_id, text, normalized, source, status, band, created_at, updated_at) VALUES ('w1', ?, 'bottleneck', 'bottleneck', 'saved', 'ready', 'uncommon', ?, ?)",
      ).run(learner, iso, iso);

      expect(migrate(db, source)).toEqual([
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
        "0018_onboarding_completion.sql",
        "0019_guest_enrollment_source.sql",
      ]);
      expect(db.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: null });
      expect(
        db.prepare("SELECT status, level, word_check_entry FROM word_progress WHERE expression_id = 'w1'").get(),
      ).toEqual({ status: "ready", level: null, word_check_entry: null });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickWordCheckEntries", () => {
  it("serves 24 distinct starter entries in three bands around the default B1 level", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    const round = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    expect(round.level).toBeNull();
    expect(round.entries).toHaveLength(WORD_CHECK_SIZE);
    const byText = starterSet().byText;
    const texts = round.entries.map((entry) => entry.text);
    expect(new Set(texts).size).toBe(WORD_CHECK_SIZE);
    for (const entry of round.entries) {
      expect(byText.has(entry.text.toLowerCase())).toBe(true);
      expect(entry.definition.length).toBeGreaterThan(0);
      expect(["A2", "B1", "B2"]).toContain(entry.level);
    }
    const counts = round.entries.reduce<Record<string, number>>((all, entry) => {
      all[entry.level] = (all[entry.level] ?? 0) + 1;
      return all;
    }, {});
    expect(counts).toEqual({ A2: 8, B1: 8, B2: 8 });
  });

  it("moves the round with the stored level and clamps at the ends", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    temp.db.prepare("UPDATE learners SET level = 'C1' WHERE id = ?").run(learner);
    const top = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    expect(top.level).toBe("C1");
    expect(new Set(top.entries.map((entry) => entry.level))).toEqual(new Set(["B2", "C1"]));
    expect(top.entries.filter((entry) => entry.level === "C1")).toHaveLength(16);
  });

  it("is stable for the same day and never repeats an answered word", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    const first = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    const again = pickWordCheckEntries(learner, { db: temp.db, now: new Date("2026-11-04T20:00:00.000Z") });
    expect(again.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));

    recordWordCheckAnswers(
      learner,
      first.entries.slice(0, 8).map((entry) => ({ id: entry.id, answer: "use" as const })),
      { db: temp.db, now: NOW },
    );
    const next = pickWordCheckEntries(learner, { db: temp.db, now: new Date("2026-11-06T09:00:00.000Z") });
    expect(next.entries).toHaveLength(WORD_CHECK_SIZE);
    const answered = new Set(first.entries.slice(0, 8).map((entry) => entry.text));
    expect(next.entries.some((entry) => answered.has(entry.text))).toBe(false);
  });

  it("does not serve another learner's round", () => {
    temp = createTempDb();
    const first = insertLearner(temp.db, "pilot", "First");
    const second = insertLearner(temp.db, "pilot", "Second");
    pickWordCheckEntries(first, { db: temp.db, now: NOW });
    const round = pickWordCheckEntries(second, { db: temp.db, now: NOW });
    expect(
      temp.db.prepare("SELECT COUNT(*) AS n FROM word_check_entries WHERE learner_id = ?").get(second),
    ).toEqual({ n: WORD_CHECK_SIZE });
    expect(round.entries).toHaveLength(WORD_CHECK_SIZE);
    expect(
      temp.db
        .prepare(
          "SELECT COUNT(*) AS n FROM word_check_entries a JOIN word_check_entries b ON a.id = b.id WHERE a.learner_id <> b.learner_id",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("served round state", () => {
  function setup() {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    const round = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    return { learner, round, db: temp.db };
  }

  it("returns the round as open, with no answers, before the first POST", () => {
    const { round } = setup();
    expect(round.roundSize).toBe(WORD_CHECK_SIZE);
    expect(round.answered).toBe(0);
    expect(round.completed).toBe(false);
    expect(round.entries.every((entry) => entry.answer === null)).toBe(true);
  });

  it("marks a partial round with the answers given and keeps only open entries open", () => {
    const { learner, round, db } = setup();
    const answered = round.entries.slice(0, 10);
    recordWordCheckAnswers(
      learner,
      answered.map((entry, index): { id: string; answer: "use" | "new" } => ({
        id: entry.id,
        answer: index % 2 ? "use" : "new",
      })),
      { db, now: NOW },
    );

    const again = pickWordCheckEntries(learner, { db, now: new Date("2026-11-04T18:00:00.000Z") });
    expect(again.roundSize).toBe(WORD_CHECK_SIZE);
    expect(again.answered).toBe(10);
    expect(again.completed).toBe(false);
    // The same entries, in the same order, none re-opened.
    expect(again.entries.map((entry) => entry.id)).toEqual(round.entries.map((entry) => entry.id));
    for (const entry of again.entries.slice(0, 10)) {
      expect(entry.answer, entry.text).not.toBeNull();
    }
    // "use" answers stay recorded on the round instead of becoming word rows.
    const used = answered.filter((_, index) => index % 2 === 1);
    for (const entry of used) {
      expect(again.entries.find((candidate) => candidate.id === entry.id)?.answer).toBe("use");
      expect(levelOfWord(learner, db, entry.text)).toBeUndefined();
    }
  });

  it("marks the round completed after every entry is answered and re-serves it", () => {
    const { learner, round, db } = setup();
    recordWordCheckAnswers(
      learner,
      round.entries.map((entry, index) => ({
        id: entry.id,
        answer: (["use", "know_unused", "not_sure", "new"] as const)[index % 4],
      })),
      { db, now: NOW },
    );
    for (const sameDay of ["2026-11-04T10:00:00.000Z", "2026-11-04T23:59:00.000Z"]) {
      const again = pickWordCheckEntries(learner, { db, now: new Date(sameDay) });
      expect(again.completed).toBe(true);
      expect(again.answered).toBe(WORD_CHECK_SIZE);
      expect(again.entries.every((entry) => entry.answer !== null)).toBe(true);
    }
  });

  it("does not re-ask 'use' words the next day either", () => {
    const { learner, round, db } = setup();
    const used = round.entries.slice(0, 6);
    recordWordCheckAnswers(
      learner,
      used.map((entry) => ({ id: entry.id, answer: "use" as const })),
      { db, now: NOW },
    );
    const next = pickWordCheckEntries(learner, { db, now: new Date("2026-11-05T09:00:00.000Z") });
    expect(next.completed).toBe(false);
    const texts = new Set(next.entries.map((entry) => entry.text));
    for (const entry of used) expect(texts.has(entry.text), entry.text).toBe(false);
  });
});

describe("recordChosenLevel", () => {
  it("stores the choice on the learner and the first round follows it", () => {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    expect(recordChosenLevel(learner, "C1", { db: temp.db })).toBe("C1");
    expect(temp.db.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: "C1" });

    const round = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    expect(round.level).toBe("C1");
    expect(round.entries).toHaveLength(WORD_CHECK_SIZE);
    expect(new Set(round.entries.map((entry) => entry.level))).toEqual(new Set(["B2", "C1"]));
    expect(round.entries.filter((entry) => entry.level === "C1")).toHaveLength(16);
  });

  it("does not move a round already served, and Word check answers refine the level after it", () => {
    temp = createTempDb();
    const newDb = temp.db;
    const learner = insertLearner(newDb);
    recordChosenLevel(learner, "A2", { db: temp.db });
    const first = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    expect(first.entries.filter((entry) => entry.level === "A2")).toHaveLength(16);

    // A second visit to the Level step mid-round keeps the ids the page holds.
    recordChosenLevel(learner, "C1", { db: temp.db });
    const still = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    expect(still.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(still.level).toBe("C1");

    // Answers refine the estimate from their own evidence: the explicit C1 is
    // not the result once the learner has answered.
    const result = recordWordCheckAnswers(
      learner,
      first.entries.map((entry) => ({ id: entry.id, answer: "new" as const })),
      { db: temp.db, now: NOW },
    );
    expect(result.level).toBe("A2");
    expect(newDb.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: "A2" });
    // The next round is built around the refined estimate.
    const next = pickWordCheckEntries(learner, { db: newDb, now: new Date("2026-11-05T09:00:00.000Z") });
    expect(next.entries.filter((entry) => entry.level === "A2")).toHaveLength(16);
  });

  it("rejects a level outside the range and a learner that does not exist", () => {
    temp = createTempDb();
    const db = temp.db;
    const learner = insertLearner(db);
    expect(() => recordChosenLevel(learner, "C2" as never, { db })).toThrow();
    expect(() => recordChosenLevel("missing", "B2", { db })).toThrow();
    expect(db.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: null });
  });
});

describe("recordWordCheckAnswers", () => {
  function setup() {
    temp = createTempDb();
    const learner = insertLearner(temp.db);
    const round = pickWordCheckEntries(learner, { db: temp.db, now: NOW });
    return { learner, round, db: temp.db };
  }

  it("maps answers to My words statuses and keeps 'use' words out of My words", () => {
    const { learner, round, db } = setup();
    const [used, edge, unsure, fresh] = round.entries;
    const result = recordWordCheckAnswers(
      learner,
      [
        { id: used.id, answer: "use" },
        { id: edge.id, answer: "know_unused" },
        { id: unsure.id, answer: "not_sure" },
        { id: fresh.id, answer: "new" },
      ],
      { db, now: NOW },
    );
    expect(result.counts).toEqual({ active: 1, ready: 1, learning: 2 });
    expect(result.answered).toBe(4);
    // "I use it" is known vocabulary: no My words row at all, only the round
    // row keeps the answer for the estimate and for later rounds.
    expect(levelOfWord(learner, db, used.text)).toBeUndefined();
    expect(
      db
        .prepare("SELECT level, word_check_answer FROM word_check_entries WHERE learner_id = ? AND id = ?")
        .get(learner, used.id),
    ).toEqual({ level: used.level, word_check_answer: "use" });
    expect(levelOfWord(learner, db, edge.text)).toMatchObject({ status: "ready", word_check_answer: "know_unused" });
    expect(levelOfWord(learner, db, unsure.text)).toMatchObject({ status: "learning", word_check_answer: "not_sure" });
    expect(levelOfWord(learner, db, fresh.text)).toMatchObject({ status: "learning", word_check_answer: "new" });
    // Only the words that need work reach the session; the "use" word is not
    // ranked at all, and the edge word is what practice starts on.
    const session = pickSessionWords(learner, 8, { db, now: NOW });
    expect(session.map((word) => word.text)).not.toContain(used.text);
    expect(session.some((word) => word.text === edge.text)).toBe(true);
    expect(wordEngineCounts(learner, { db, now: NOW })).toMatchObject({ active: 0, ready: 1, learning: 2 });
  });

  it("stores the level estimate in the learner profile and refines it on a later round", () => {
    const { learner, round, db } = setup();
    // Eight "use" at B2 (level 2 + 1 = 3) and eight "know but don't use" at
    // B1 (1 + 0 = 1) average to 2.0: B2.
    const lower = round.entries.slice(8, 16);
    const upper = round.entries.slice(16);
    const result = recordWordCheckAnswers(
      learner,
      [
        ...lower.map((entry) => ({ id: entry.id, answer: "know_unused" as const })),
        ...upper.map((entry) => ({ id: entry.id, answer: "use" as const })),
      ],
      { db, now: NOW },
    );
    expect(result.level).toBe("B2");
    expect(db.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: "B2" });
    // The next GET reports the stored level, and a second learner has none.
    const nextDay = new Date("2026-11-05T09:00:00.000Z");
    expect(pickWordCheckEntries(learner, { db, now: nextDay }).level).toBe("B2");
    // A second round refines the estimate: "not sure" on every word of the
    // next round pulls the level down, and the profile follows.
    const next = pickWordCheckEntries(learner, { db, now: nextDay });
    const refined = recordWordCheckAnswers(
      learner,
      next.entries.map((entry) => ({ id: entry.id, answer: "not_sure" as const })),
      { db, now: nextDay },
    );
    expect(refined.level).toBe("B1");
    expect(db.prepare("SELECT level FROM learners WHERE id = ?").get(learner)).toEqual({ level: "B1" });
    const other = insertLearner(db, "pilot", "Other");
    expect(pickWordCheckEntries(other, { db, now: NOW }).level).toBeNull();
  });

  it("is idempotent: the same POST twice gives the same answer and no duplicates", () => {
    const { learner, round, db } = setup();
    const answers = round.entries.slice(0, 12).map((entry, index) => ({
      id: entry.id,
      answer: (["use", "know_unused", "not_sure", "new"] as const)[index % 4],
    }));
    const first = recordWordCheckAnswers(learner, answers, { db, now: NOW });
    const rowsAfterFirst = db
      .prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ?")
      .get(learner);
    const introduced = db
      .prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ? AND introduced_on IS NOT NULL")
      .get(learner);
    const second = recordWordCheckAnswers(learner, answers, {
      db,
      now: new Date("2026-11-04T09:30:00.000Z"),
    });
    expect(second).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ?").get(learner)).toEqual(
      rowsAfterFirst,
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ? AND introduced_on IS NOT NULL").get(learner),
    ).toEqual(introduced);
  });

  it("accepts a single answer and rejects ids this learner was not served", () => {
    const { learner, round, db } = setup();
    expect(recordWordCheckAnswers(learner, [{ id: round.entries[0].id, answer: "new" }], { db, now: NOW }).answered).toBe(1);

    const other = insertLearner(db, "pilot", "Other");
    const otherRound = pickWordCheckEntries(other, { db, now: NOW });
    expect(() =>
      recordWordCheckAnswers(learner, [{ id: otherRound.entries[0].id, answer: "use" }], { db, now: NOW }),
    ).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM word_progress WHERE learner_id = ?").get(other)).toEqual({ n: 0 });
    // A bad id rejects the whole request: the good id in the same body is not
    // written.
    expect(() =>
      recordWordCheckAnswers(
        learner,
        [
          { id: round.entries[1].id, answer: "use" },
          { id: "invented", answer: "new" },
        ],
        { db, now: NOW },
      ),
    ).toThrow();
    expect(levelOfWord(learner, db, round.entries[1].text)).toBeUndefined();
    // The same id twice is rejected rather than letting one answer overwrite.
    expect(() =>
      recordWordCheckAnswers(
        learner,
        [
          { id: round.entries[2].id, answer: "use" },
          { id: round.entries[2].id, answer: "new" },
        ],
        { db, now: NOW },
      ),
    ).toThrow();
  });
});

describe("estimateLevel", () => {
  it("records each answer as one line from the word's level", () => {
    expect(estimateLevel([])).toBe("B1");
    // "use" at B2 is C1 evidence, clamped at the top.
    expect(estimateLevel([{ level: "B2", answer: "use" }])).toBe("C1");
    expect(estimateLevel([{ level: "C1", answer: "use" }])).toBe("C1");
    expect(estimateLevel([{ level: "B1", answer: "know_unused" }])).toBe("B1");
    expect(estimateLevel([{ level: "B1", answer: "not_sure" }])).toBe("A2");
    // "new" at C1 is B1 evidence: one level below is still known ground.
    expect(estimateLevel([{ level: "C1", answer: "new" }])).toBe("B1");
    expect(estimateLevel([{ level: "B1", answer: "new" }])).toBe("A2");
  });

  it("clamps to the range and averages a mixed round", () => {
    const all = (level: "A2" | "B1" | "B2" | "C1", answer: "use" | "new") =>
      Array.from({ length: 8 }, () => ({ level, answer }));
    expect(estimateLevel(all("A2", "new"))).toBe("A2");
    expect(estimateLevel(all("C1", "use"))).toBe("C1");
    expect(estimateLevel(all("B2", "use"))).toBe("C1");
    // Eight "use" at C1 (4 each) and sixteen "new" at A2 (-2 each) average to
    // 0: A2. Sixteen "use" at C1 and eight "new" at A2 average to 2: B2.
    expect(estimateLevel([...all("C1", "use"), ...all("A2", "new"), ...all("A2", "new")])).toBe("A2");
    expect(estimateLevel([...all("C1", "use"), ...all("C1", "use"), ...all("A2", "new")])).toBe("B2");
    // A learner who uses the B1 words but does not use the A2 ones averages to
    // 0.5, which rounds down to A2: the estimate never flatters.
    expect(estimateLevel([...all("A2", "new"), ...all("B1", "use")])).toBe("A2");
    expect(estimateLevel([...all("A2", "use"), ...all("B1", "new")])).toBe("A2");
  });

  it("separates a stronger learner from a weaker one on the same words", () => {
    const words = [
      ...Array.from({ length: 8 }, () => ({ level: "A2" as const })),
      ...Array.from({ length: 8 }, () => ({ level: "B1" as const })),
      ...Array.from({ length: 8 }, () => ({ level: "B2" as const })),
    ];
    const stronger = estimateLevel(words.map((word, index) => ({ ...word, answer: index < 16 ? "use" as const : "know_unused" as const })));
    const weaker = estimateLevel(words.map((word) => ({ ...word, answer: "new" as const })));
    expect(["A2", "B1", "B2", "C1"]).toContain(stronger);
    expect(stronger).not.toBe(weaker);
    expect(weaker).toBe("A2");
  });
});

describe("roundLevels", () => {
  it("spreads 24 entries over three levels and doubles the end of the range", () => {
    expect(roundLevels("B1").reduce((sum, item) => sum + item.share, 0)).toBe(24);
    expect(roundLevels("B1").map((item) => item.level)).toEqual(["A2", "B1", "B2"]);
    expect(roundLevels("A2")).toEqual([
      { level: "A2", share: 16 },
      { level: "B1", share: 8 },
    ]);
    expect(roundLevels("C1")).toEqual([
      { level: "B2", share: 8 },
      { level: "C1", share: 16 },
    ]);
  });
});

