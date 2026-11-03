import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

import { GET } from "@/app/api/health/route";
import { closeDb, getDb } from "@/server/db";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "glossy-health-"));
  previous = process.env.GLOSSY_DATABASE_PATH;
});

afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.GLOSSY_DATABASE_PATH;
  else process.env.GLOSSY_DATABASE_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("opens the database, applies migrations and reports only ok", async () => {
    process.env.GLOSSY_DATABASE_PATH = path.join(dir, "sub", "health.db");
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
    const applied = getDb().prepare("SELECT name FROM schema_migrations ORDER BY name").all();
    expect(applied.map((row) => row.name)).toEqual([
      "0001_init.sql",
      "0002_practice.sql",
      "0003_stale_work.sql",
      "0004_task_generation_claims.sql",
      "0005_byok_funding.sql",
      "0006_word_pronunciation.sql",
    ]);
  });

  it("answers 503 without details when the database cannot be opened", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const blocker = path.join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    process.env.GLOSSY_DATABASE_PATH = path.join(blocker, "health.db");

    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain(blocker);
  });
});
