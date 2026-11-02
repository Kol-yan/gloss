import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { runImmediate } from "./transaction";

// Resolved against the working directory: the Docker image keeps `db/` next
// to the app, and tests and scripts run from the repository root.
export function defaultMigrationsDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "db/migrations");
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

  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(/*turbopackIgnore: true*/ path.join(dir, file), "utf8");
    runImmediate(db, () => {
      // Re-check under the write lock: another process may have just applied it.
      const done = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(file);
      if (done) return;
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
      applied.push(file);
    });
  }
  return applied;
}
