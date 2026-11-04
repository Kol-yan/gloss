import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getQuotaUsage, reserve } from "@/server/budget";
import { closeDb, defaultMigrationsDir, getDb, immediate, migrate, openDatabase } from "@/server/db";
import { createTempDb, testConfig, type TempDb } from "./helpers/db";

let temp: TempDb | undefined;
afterEach(() => {
  temp?.cleanup();
  temp = undefined;
});

const tableNames = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .sort();

describe("openDatabase", () => {
  it("creates the parent directory, sets pragmas and applies the schema", () => {
    temp = createTempDb();
    const nested = path.join(temp.dir, "a", "b", "nested.db");
    const db = openDatabase(nested);
    expect(existsSync(nested)).toBe(true);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
    expect(tableNames(db)).toEqual(
      [
        "attempts",
        "budget_dispatches",
        "check_runs",
        "detect_runs",
        "evaluations",
        "evidence_events",
        "expressions",
        "guest_enrollments",
        "invites",
        "invite_redemptions",
        "learners",
        "practice_task_requests",
        "practice_tasks",
        "practice_word_progress",
        "practice_exercise_pool",
        "practice_exercise_history",
        "practice_exercise_generation_leases",
        "practice_sessions",
        "practice_session_items",
        "schema_migrations",
        "sessions",
        "settings",
        "suggestions",
        "usage_reservations",
        "word_check_entries",
        "word_practice_events",
        "word_progress",
      ].sort(),
    );
    db.close();
  });

  it("applies migrations once and is idempotent on reopen", () => {
    temp = createTempDb();
    const applied = temp.db.prepare("SELECT name FROM schema_migrations ORDER BY rowid").all();
    const names = applied.map((row) => row.name);
    // The original schema is unchanged; later migrations only add to it.
    expect(names).toEqual([
      "0001_init.sql", "0002_practice.sql", "0003_stale_work.sql",
      "0004_task_generation_claims.sql", "0005_byok_funding.sql",
      "0006_word_pronunciation.sql", "0007_check_run_routing.sql",
      "0008_sentence_detection.sql",
      "0009_writing_evidence.sql",
      "0010_word_engine.sql",
      "0011_word_real_use.sql",
      "0012_onboarding_level.sql",
      "0013_practice_word_progress.sql",
      "0014_practice_exercise_pool.sql",
      "0015_practice_sessions.sql",
      "0016_guest_access.sql",
      "0017_budget_hardening.sql",
    ]);
    const again = openDatabase(temp.path);
    expect(migrate(again)).toEqual([]);
    again.close();
  });

  it("adds the routing audit columns on a fresh database", () => {
    temp = createTempDb();
    const columns = temp.db.prepare("PRAGMA table_info(check_runs)").all();
    const types = Object.fromEntries(columns.map((row) => [String(row.name), String(row.type)]));
    expect(types.serving_provider).toBe("TEXT");
    // Money stays in whole micro-dollars.
    expect(types.settled_cost_micros).toBe("INTEGER");
  });

  it("preserves existing evidence and its constraints when adding independent writing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-evidence-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    for (const file of readdirSync(source).filter((name) => /^000[1-8]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      migrate(db, oldMigrations);
      db.exec(`INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('writer', 'Writer', 'pilot', '2026-11-03');
        INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
          VALUES ('run', 'writer', 'request', 'h', 1, 'openrouter', 'model', 'ok', '2026-11-03');
        INSERT INTO suggestions (id, check_run_id, learner_id, start, end, original, replacement, category, reason, meaning_change, status)
          VALUES ('suggestion', 'run', 'writer', 0, 1, 'x', 'bottleneck', 'expression', 'A fit.', 0, 'accepted');
        INSERT INTO expressions (id, learner_id, suggestion_id, text, meaning, familiarity, created_at)
          VALUES ('expression', 'writer', 'suggestion', 'bottleneck', 'A delay.', 'new', '2026-11-03');
        INSERT INTO evidence_events (id, learner_id, expression_id, kind, hint_used, transcript_edited, created_at)
          VALUES ('old', 'writer', 'expression', 'assisted_use', 1, 1, '2026-11-03');`);
      const before = db.prepare("SELECT * FROM evidence_events WHERE id = 'old'").get();
      // The engine and practice tables arrive after the writing-evidence upgrade.
      expect(migrate(db, source)).toEqual([
        "0009_writing_evidence.sql",
        "0010_word_engine.sql",
        "0011_word_real_use.sql",
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
      ]);
      expect(db.prepare("SELECT * FROM evidence_events WHERE id = 'old'").get()).toEqual({ ...before, document_id: null });
      db.exec(`INSERT INTO evidence_events (id, learner_id, expression_id, kind, document_id, created_at)
        VALUES ('independent', 'writer', 'expression', 'independent_writing', 'document', '2026-11-03')`);
      expect(() => db.exec(`INSERT INTO evidence_events (id, learner_id, expression_id, kind, document_id, verdict, created_at)
        VALUES ('scored', 'writer', 'expression', 'independent_writing', 'document-2', 'used_well', '2026-11-03')`)).toThrow();
      expect(() => db.exec(`INSERT INTO evidence_events (id, learner_id, expression_id, kind, document_id, created_at)
        VALUES ('duplicate', 'writer', 'expression', 'independent_writing', 'document', '2026-11-03')`)).toThrow();
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves learner-owned rows while adding guest access to an existing database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-guest-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    for (const file of readdirSync(source).filter((name) => Number.parseInt(name.slice(0, 4), 10) <= 15)) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    db.exec("PRAGMA foreign_keys = ON");
    try {
      migrate(db, oldMigrations);
      const now = "2026-11-03T10:00:00.000Z";
      db.exec(`
        INSERT INTO learners (id, display_name, quota_profile, created_at, funding_source, level)
          VALUES ('preserved', 'Preserved', 'judge', '${now}', 'hosted', 'B2');
        INSERT INTO invites (token_hash, label, quota_profile, max_uses, uses, created_at)
          VALUES ('${"a".repeat(64)}', 'Stored invite', 'judge', 2, 1, '${now}');
        INSERT INTO sessions (token_hash, learner_id, created_at, expires_at)
          VALUES ('${"b".repeat(64)}', 'preserved', '${now}', '2027-11-03T10:00:00.000Z');
        INSERT INTO usage_reservations
          (id, learner_id, kind, request_id, units, max_cost_micros, status, created_at, funding_source)
          VALUES ('reservation', 'preserved', 'proofread', 'request', 1, 9000, 'reserved', '${now}', 'hosted');
        INSERT INTO word_progress
          (expression_id, learner_id, text, normalized, source, status, created_at, updated_at)
          VALUES ('word', 'preserved', 'bottleneck', 'bottleneck', 'added', 'learning', '${now}', '${now}');
        INSERT INTO practice_sessions
          (id, learner_id, request_id, status, requested_size, total, created_at)
          VALUES ('practice', 'preserved', 'practice-request', 'preparing', 1, 1, '${now}');
        INSERT INTO practice_session_items
          (id, learner_id, session_id, ordinal, expression_id, word_text, meaning, slot, word_status,
           start_rung, frequency, why, status)
          VALUES ('practice-item', 'preserved', 'practice', 0, 'word', 'bottleneck', 'a delay',
                  'learn', 'learning', 1, 'common', 'A new word', 'pending');
      `);
      const learnerColumnsBefore = db.prepare("PRAGMA table_info(learners)").all();
      const learnerBefore = db.prepare("SELECT * FROM learners WHERE id = 'preserved'").get();
      const inviteBefore = db.prepare("SELECT * FROM invites WHERE label = 'Stored invite'").get();
      const sessionBefore = db.prepare("SELECT * FROM sessions WHERE learner_id = 'preserved'").get();
      const reservationBefore = db.prepare("SELECT * FROM usage_reservations WHERE id = 'reservation'").get() as Record<string, unknown>;
      const wordBefore = db.prepare("SELECT * FROM word_progress WHERE expression_id = 'word'").get();
      const practiceBefore = db.prepare("SELECT * FROM practice_sessions WHERE id = 'practice'").get();
      const itemBefore = db.prepare("SELECT * FROM practice_session_items WHERE id = 'practice-item'").get();

      expect(migrate(db, source)).toEqual(["0016_guest_access.sql", "0017_budget_hardening.sql"]);
      expect(db.prepare("PRAGMA table_info(learners)").all()).toEqual(learnerColumnsBefore);
      expect(db.prepare("SELECT * FROM learners WHERE id = 'preserved'").get()).toEqual(learnerBefore);
      expect(db.prepare("SELECT * FROM invites WHERE label = 'Stored invite'").get()).toEqual(inviteBefore);
      expect(db.prepare("SELECT * FROM sessions WHERE learner_id = 'preserved'").get()).toEqual(sessionBefore);
      expect(db.prepare(`SELECT id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros,
          status, created_at, settled_at, funding_source FROM usage_reservations WHERE id = 'reservation'`).get())
        .toEqual(reservationBefore);
      expect(db.prepare("SELECT role FROM usage_reservations WHERE id = 'reservation'").get())
        .toEqual({ role: "unknown" });
      expect(db.prepare("SELECT * FROM word_progress WHERE expression_id = 'word'").get()).toEqual(wordBefore);
      expect(db.prepare("SELECT * FROM practice_sessions WHERE id = 'practice'").get()).toEqual(practiceBefore);
      expect(db.prepare("SELECT * FROM practice_session_items WHERE id = 'practice-item'").get()).toEqual(itemBefore);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 0 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all())
        .toEqual([{ name: "learners_funding_immutable" }, { name: "reservations_funding_immutable" }]);

      db.prepare("INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('guest', 'Guest', 'guest', ?)")
        .run(now);
      expect(db.prepare("UPDATE learners SET funding_source = 'byok' WHERE id = 'preserved'").run().changes).toBe(1);
      expect(() => db.prepare("UPDATE learners SET funding_source = 'hosted' WHERE id = 'preserved'").run()).toThrow();
      expect(() => db.prepare("UPDATE usage_reservations SET funding_source = 'byok' WHERE id = 'reservation'").run()).toThrow();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades a pre-detect database and preserves every funding and reservation field", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    // Build a database at migration 0007, before detection, with live ledger data.
    for (const file of readdirSync(source).filter((name) => /^000[1-7]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const file = path.join(dir, "existing.db");
    const db = new DatabaseSync(file);
    try {
      migrate(db, oldMigrations);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO learners (id, display_name, quota_profile, funding_source, created_at)
         VALUES ('legacy-hosted', 'Hosted', 'pilot', 'hosted', ?), ('legacy-byok', 'Visitor', 'pilot', 'byok', ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
         VALUES ('run-old', 'legacy-hosted', 'req-old', 'h', 5, 'openrouter', 'openai/gpt-oss-120b', 'ok', ?)`,
      ).run(now);

      const ledger = [
        { id: "hosted-settled", learner_id: "legacy-hosted", kind: "proofread", request_id: "same-request", units: 2, max_cost_micros: 5000, actual_cost_micros: 321, status: "settled", created_at: now, settled_at: now, funding_source: "hosted" },
        { id: "hosted-reserved", learner_id: "legacy-hosted", kind: "evaluate", request_id: "hosted-reserved-request", units: 1, max_cost_micros: 7000, actual_cost_micros: null, status: "reserved", created_at: now, settled_at: null, funding_source: "hosted" },
        { id: "hosted-unknown", learner_id: "legacy-hosted", kind: "asrSeconds", request_id: "hosted-unknown-request", units: 17, max_cost_micros: 9000, actual_cost_micros: null, status: "unknown", created_at: now, settled_at: null, funding_source: "hosted" },
        { id: "byok-settled", learner_id: "legacy-byok", kind: "proofread", request_id: "byok-settled-request", units: 3, max_cost_micros: 6000, actual_cost_micros: 456, status: "settled", created_at: now, settled_at: now, funding_source: "byok" },
        { id: "byok-reserved", learner_id: "legacy-byok", kind: "evaluate", request_id: "byok-reserved-request", units: 2, max_cost_micros: 8000, actual_cost_micros: null, status: "reserved", created_at: now, settled_at: null, funding_source: "byok" },
        { id: "byok-unknown", learner_id: "legacy-byok", kind: "asrSeconds", request_id: "byok-unknown-request", units: 9, max_cost_micros: 10_000, actual_cost_micros: null, status: "unknown", created_at: now, settled_at: null, funding_source: "byok" },
      ];
      const insertReservation = db.prepare(
        `INSERT INTO usage_reservations
         (id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros, status, created_at, settled_at, funding_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of ledger) {
        insertReservation.run(
          row.id, row.learner_id, row.kind, row.request_id, row.units, row.max_cost_micros,
          row.actual_cost_micros, row.status, row.created_at, row.settled_at, row.funding_source,
        );
      }

      const applied = migrate(db, source);
      expect(applied).toEqual([
        "0008_sentence_detection.sql",
        "0009_writing_evidence.sql",
        "0010_word_engine.sql",
        "0011_word_real_use.sql",
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
      ]);

      const row = db.prepare("SELECT * FROM check_runs WHERE id = 'run-old'").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        id: "run-old",
        learner_id: "legacy-hosted",
        request_id: "req-old",
        text_hash: "h",
        text_length: 5,
        provider: "openrouter",
        model: "openai/gpt-oss-120b",
        status: "ok",
        created_at: now,
      });
      // Auditing was not available when the row was written.
      expect(row.serving_provider).toBeNull();
      expect(row.settled_cost_micros).toBeNull();

      const actualLedger = db.prepare(
        `SELECT id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros,
                status, created_at, settled_at, funding_source
         FROM usage_reservations ORDER BY id`,
      ).all();
      expect(actualLedger).toEqual([...ledger].sort((a, b) => a.id.localeCompare(b.id)));

      expect(() => db.prepare("UPDATE learners SET funding_source = 'hosted' WHERE id = 'legacy-byok'").run())
        .toThrow(/Learner funding cannot change/);
      expect(() => db.prepare("UPDATE usage_reservations SET funding_source = 'byok' WHERE id = 'hosted-settled'").run())
        .toThrow(/Reservation funding cannot change/);
      expect(() => db.prepare("UPDATE usage_reservations SET funding_source = 'hosted' WHERE id = 'byok-settled'").run())
        .toThrow(/Reservation funding cannot change/);

      const indexes = db.prepare("PRAGMA index_list('usage_reservations')").all();
      const indexColumns = (name: string) =>
        db.prepare(`PRAGMA index_info('${name}')`).all().map((index) => String(index.name));
      expect(indexColumns("usage_reservations_created_idx")).toEqual(["created_at"]);
      expect(indexColumns("usage_reservations_learner_kind_idx")).toEqual([
        "learner_id", "kind", "created_at",
      ]);
      expect(indexColumns("usage_reservations_open_idx")).toEqual(["created_at"]);
      expect(indexes.find((index) => index.name === "usage_reservations_open_idx")).toMatchObject({ partial: 1 });
      const uniqueKeys = indexes
        .filter((index) => Number(index.unique) === 1)
        .map((index) => indexColumns(String(index.name)));
      expect(uniqueKeys).toContainEqual(["learner_id", "kind", "request_id"]);

      // The kind remains part of idempotency: a detector call may use the same
      // request id as a generator call without consuming the generator quota.
      reserve({ learnerId: "legacy-hosted", kind: "detect", requestId: "same-request", units: 1, maxCostMicros: 1000 },
        { db, now: new Date(now), config: testConfig() });
      expect(getQuotaUsage({ id: "legacy-hosted", quotaProfile: "pilot" }, { db, now: new Date(now) }))
        .toMatchObject({ proofread: { used: 2, limit: 20 }, detect: { used: 1, limit: 100 } });
      expect(db.prepare("SELECT kind, request_id FROM usage_reservations WHERE learner_id = 'legacy-hosted' AND request_id = 'same-request' ORDER BY kind").all())
        .toEqual([{ kind: "detect", request_id: "same-request" }, { kind: "proofread", request_id: "same-request" }]);
      expect(db.prepare("UPDATE learners SET funding_source = 'byok' WHERE id = 'legacy-hosted'").run().changes)
        .toBe(1);
      expect(() => db.prepare("UPDATE learners SET funding_source = 'hosted' WHERE id = 'legacy-hosted'").run())
        .toThrow(/Learner funding cannot change/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds routing and detection migrations to a pre-0007 database with check runs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-pre-routing-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    for (const file of readdirSync(source).filter((name) => /^000[1-6]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const db = new DatabaseSync(path.join(dir, "existing.db"));
    try {
      migrate(db, oldMigrations);
      const now = new Date("2026-11-02T10:00:00.000Z").toISOString();
      db.prepare(
        "INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('pre-routing', 'Old', 'pilot', ?)",
      ).run(now);
      db.prepare(
        `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
         VALUES ('pre-routing-run', 'pre-routing', 'pre-routing-request', 'legacy-hash', 12, 'openrouter', 'openai/gpt-oss-120b', 'ok', ?)`,
      ).run(now);

      expect(migrate(db, source)).toEqual([
        "0007_check_run_routing.sql",
        "0008_sentence_detection.sql",
        "0009_writing_evidence.sql",
        "0010_word_engine.sql",
        "0011_word_real_use.sql",
        "0012_onboarding_level.sql",
        "0013_practice_word_progress.sql",
        "0014_practice_exercise_pool.sql",
        "0015_practice_sessions.sql",
        "0016_guest_access.sql",
        "0017_budget_hardening.sql",
      ]);
      const row = db.prepare("SELECT * FROM check_runs WHERE id = 'pre-routing-run'").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        id: "pre-routing-run",
        learner_id: "pre-routing",
        request_id: "pre-routing-request",
        text_hash: "legacy-hash",
        text_length: 12,
        provider: "openrouter",
        model: "openai/gpt-oss-120b",
        status: "ok",
        created_at: now,
        serving_provider: null,
        settled_cost_micros: null,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrate", () => {
  it("rolls back a foreign-key-off migration and restores both pragma settings", () => {
    for (const [foreignKeys, legacyAlterTable] of [[1, 0], [0, 1]] as const) {
      const dir = mkdtempSync(path.join(tmpdir(), "glossy-mig-fk-rollback-"));
      const migrations = path.join(dir, "m");
      mkdirSync(migrations);
      writeFileSync(path.join(migrations, "0001_broken.sql"),
        "-- migrate:foreign-keys-off\nCREATE TABLE transient (id TEXT PRIMARY KEY); INSERT INTO missing VALUES ('x');");
      const db = new DatabaseSync(":memory:");
      db.exec(`PRAGMA foreign_keys = ${foreignKeys}; PRAGMA legacy_alter_table = ${legacyAlterTable};`);
      try {
        expect(() => migrate(db, migrations)).toThrow();
        expect(tableNames(db)).toEqual(["schema_migrations"]);
        expect(db.prepare("SELECT name FROM schema_migrations").all()).toEqual([]);
        expect(db.isTransaction).toBe(false);
        expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: foreignKeys });
        expect(db.prepare("PRAGMA legacy_alter_table").get())
          .toEqual({ legacy_alter_table: legacyAlterTable });
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("applies files in name order and rolls back a failing file completely", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-mig-"));
    const migrations = path.join(dir, "m");
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
    writeFileSync(path.join(migrations, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
    writeFileSync(
      path.join(migrations, "0003_bad.sql"),
      "CREATE TABLE c (id INTEGER); INSERT INTO nope VALUES (1);",
    );
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => migrate(db, migrations)).toThrow();
      expect(tableNames(db)).toEqual(["a", "b", "schema_migrations"]);
      expect(db.prepare("SELECT name FROM schema_migrations ORDER BY rowid").all()).toEqual([
        { name: "0001_a.sql" },
        { name: "0002_b.sql" },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate numeric prefixes before applying anything", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-mig-dup-"));
    const migrations = path.join(dir, "m");
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "0010_a.sql"), "CREATE TABLE a (id INTEGER);");
    writeFileSync(path.join(migrations, "0010_b.sql"), "CREATE TABLE b (id INTEGER);");
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => migrate(db, migrations)).toThrow(/Duplicate migration prefix 0010/);
      expect(tableNames(db)).toEqual(["schema_migrations"]);
      expect(db.prepare("SELECT name FROM schema_migrations").all()).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects migrations whose numeric order differs from sorted name order", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-mig-order-"));
    const migrations = path.join(dir, "m");
    mkdirSync(migrations);
    // Sorted by name "10_..." comes before "9_...", but numerically it is later.
    writeFileSync(path.join(migrations, "10_b.sql"), "CREATE TABLE b (id INTEGER);");
    writeFileSync(path.join(migrations, "9_a.sql"), "CREATE TABLE a (id INTEGER);");
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => migrate(db, migrations)).toThrow(/out of order/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("immediate", () => {
  it("commits on success and rolls back on error", () => {
    temp = createTempDb();
    const db = temp.db;
    immediate((tx) => tx.exec("INSERT INTO settings (key, value) VALUES ('a', '1')"), db);
    expect(() =>
      immediate((tx) => {
        tx.exec("INSERT INTO settings (key, value) VALUES ('b', '2')");
        throw new Error("boom");
      }, db),
    ).toThrow("boom");
    expect(db.prepare("SELECT key FROM settings").all()).toEqual([{ key: "a" }]);
    expect(db.isTransaction).toBe(false);
  });

  it("joins an open transaction instead of nesting", () => {
    temp = createTempDb();
    const db = temp.db;
    expect(() =>
      immediate(() => {
        immediate((tx) => tx.exec("INSERT INTO settings (key, value) VALUES ('x', '1')"), db);
        throw new Error("outer fails");
      }, db),
    ).toThrow("outer fails");
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });

  it("refuses an async callback and rolls back", () => {
    temp = createTempDb();
    const db = temp.db;
    expect(() =>
      immediate(async (tx) => {
        tx.exec("INSERT INTO settings (key, value) VALUES ('y', '1')");
      }, db),
    ).toThrow(TypeError);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
  });
});

describe("schema constraints", () => {
  it("rejects a suggestion whose learner differs from its check run's learner", () => {
    temp = createTempDb();
    const db = temp.db;
    const now = new Date().toISOString();
    for (const id of ["a", "b"]) {
      db.prepare(
        "INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES (?, ?, 'pilot', ?)",
      ).run(id, id, now);
    }
    db.prepare(
      `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
       VALUES ('run1', 'a', 'r1', 'h', 5, 'p', 'm', 'ok', ?)`,
    ).run(now);
    const insert = (learner: string) =>
      db
        .prepare(
          `INSERT INTO suggestions (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason)
           VALUES (?, 'run1', ?, 0, 3, 'teh', 'the', 'error', 'typo')`,
        )
        .run(`s-${learner}`, learner);
    expect(() => insert("b")).toThrow(/FOREIGN KEY/);
    expect(insert("a").changes).toBe(1);
  });
});

describe("lazy singleton", () => {
  it("does not touch the filesystem until getDb is called", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-lazy-"));
    const file = path.join(dir, "sub", "lazy.db");
    const previous = process.env.GLOSSY_DATABASE_PATH;
    process.env.GLOSSY_DATABASE_PATH = file;
    try {
      expect(existsSync(file)).toBe(false);
      const db = getDb();
      expect(getDb()).toBe(db);
      expect(existsSync(file)).toBe(true);
    } finally {
      closeDb();
      if (previous === undefined) delete process.env.GLOSSY_DATABASE_PATH;
      else process.env.GLOSSY_DATABASE_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
