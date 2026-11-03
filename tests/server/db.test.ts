import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, defaultMigrationsDir, getDb, immediate, migrate, openDatabase } from "@/server/db";
import { createTempDb, type TempDb } from "./helpers/db";

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
    expect(names.slice(0, 6)).toEqual([
      "0001_init.sql", "0002_practice.sql", "0003_stale_work.sql",
      "0004_task_generation_claims.sql", "0005_byok_funding.sql",
      "0006_word_pronunciation.sql",
    ]);
    expect(names.length).toBeGreaterThan(6);
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

  it("upgrades a pre-existing database and keeps its check runs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "glossy-upgrade-"));
    const oldMigrations = path.join(dir, "m");
    mkdirSync(oldMigrations);
    const source = defaultMigrationsDir();
    // Build a database that predates the routing audit migration, with data.
    for (const file of readdirSync(source).filter((name) => /^000[1-6]_.*\.sql$/.test(name))) {
      copyFileSync(path.join(source, file), path.join(oldMigrations, file));
    }
    const file = path.join(dir, "existing.db");
    const db = new DatabaseSync(file);
    try {
      migrate(db, oldMigrations);
      const now = new Date().toISOString();
      db.prepare("INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES ('old', 'Old', 'pilot', ?)").run(now);
      db.prepare(
        `INSERT INTO check_runs (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
         VALUES ('run-old', 'old', 'req-old', 'h', 5, 'openrouter', 'openai/gpt-oss-120b', 'ok', ?)`,
      ).run(now);

      const applied = migrate(db, source);
      expect(applied.length).toBeGreaterThan(0);

      const row = db.prepare("SELECT * FROM check_runs WHERE id = 'run-old'").get() as Record<string, unknown>;
      expect(row).toMatchObject({
        id: "run-old",
        provider: "openrouter",
        model: "openai/gpt-oss-120b",
        status: "ok",
      });
      // Auditing was not available when the row was written.
      expect(row.serving_provider).toBeNull();
      expect(row.settled_cost_micros).toBeNull();
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
