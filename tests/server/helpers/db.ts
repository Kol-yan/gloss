import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig, type QuotaProfileName } from "@/server/config";
import { openDatabase } from "@/server/db";
import { newId } from "@/server/ids";

export interface TempDb {
  dir: string;
  path: string;
  db: DatabaseSync;
  cleanup(): void;
}

// A fresh, migrated database in its own temporary directory. Tests that need
// a second connection to the same file call openDatabase(temp.path).
export function createTempDb(): TempDb {
  const dir = mkdtempSync(path.join(tmpdir(), "glossy-test-"));
  const file = path.join(dir, "test.db");
  const db = openDatabase(file);
  return {
    dir,
    path: file,
    db,
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed by the test
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertLearner(
  db: DatabaseSync,
  profile: QuotaProfileName = "pilot",
  name = "Test learner",
): string {
  const id = newId();
  db.prepare(
    "INSERT INTO learners (id, display_name, quota_profile, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, name, profile, new Date().toISOString());
  return id;
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ DAILY_BUDGET_USD: "5", AI_ENABLED: "true", ...overrides });
}
