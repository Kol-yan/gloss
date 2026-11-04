import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runImmediate } from "./transaction";

const FOREIGN_KEYS_OFF_MARKER = "-- migrate:foreign-keys-off";

// Resolved against the working directory: the Docker image keeps `db/` next
// to the app, and tests and scripts run from the repository root.
export function defaultMigrationsDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "db/migrations");
}

// Numeric prefixes must be unique and strictly increasing in sorted name
// order, so two branches adding the same number (for example two 0010 files)
// fail loudly instead of applying in an accidental order.
export function validateMigrationFiles(files: string[]): void {
  const seen = new Map<number, string>();
  let last = -1;
  for (const file of files) {
    const match = /^(\d+)_.*\.sql$/.exec(file);
    if (!match) throw new Error(`Invalid migration file name: ${file}`);
    const prefix = Number.parseInt(match[1], 10);
    const previous = seen.get(prefix);
    if (previous !== undefined) {
      throw new Error(`Duplicate migration prefix ${match[1]}: ${previous} and ${file}`);
    }
    if (prefix <= last) {
      throw new Error(`Migrations out of order: ${file} follows prefix ${last}`);
    }
    seen.set(prefix, file);
    last = prefix;
  }
}

// Applies db/migrations/*.sql in name order, each file in its own transaction,
// and records it in schema_migrations. Returns the names applied by this call.
export function migrate(db: DatabaseSync, dir: string = defaultMigrationsDir()): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     ) STRICT`,
  );

  const files = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  validateMigrationFiles(files);

  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(/*turbopackIgnore: true*/ path.join(dir, file), "utf8");
    const disableForeignKeys = sql.startsWith(FOREIGN_KEYS_OFF_MARKER);
    const migration = () => runImmediate(db, () => {
      // Re-check under the write lock: another process may have just applied it.
      const done = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(file);
      if (done) return;
      db.exec(sql);
      if (disableForeignKeys) {
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`Migration ${file} left ${violations.length} foreign-key violations`);
        }
      }
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
      applied.push(file);
    });

    if (!disableForeignKeys) {
      migration();
      continue;
    }

    if (db.isTransaction) {
      throw new Error(`Migration ${file} requires foreign keys to be disabled before its transaction`);
    }
    const originalForeignKeys = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0);
    const originalLegacyAlterTable = Number(db.prepare("PRAGMA legacy_alter_table").get()?.legacy_alter_table ?? 0);
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      if (Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 1) !== 0) {
        throw new Error(`Could not disable foreign keys for migration ${file}`);
      }
      db.exec("PRAGMA legacy_alter_table = ON");
      migration();
    } finally {
      db.exec(`PRAGMA legacy_alter_table = ${originalLegacyAlterTable === 0 ? "OFF" : "ON"}`);
      db.exec(`PRAGMA foreign_keys = ${originalForeignKeys === 0 ? "OFF" : "ON"}`);
    }
  }
  return applied;
}
