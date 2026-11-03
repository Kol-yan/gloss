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
        "check_runs",
        "detect_runs",
        "evaluations",
        "evidence_events",
        "expressions",
        "invites",
        "learners",
        "practice_task_requests",
        "practice_tasks",
        "schema_migrations",
        "sessions",
        "settings",
        "suggestions",
        "usage_reservations",
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
      expect(applied).toEqual(["0008_sentence_detection.sql"]);

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

      expect(() => db.prepare("UPDATE learners SET funding_source = 'byok' WHERE id = 'legacy-hosted'").run())
        .toThrow(/Learner funding cannot change/);
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
