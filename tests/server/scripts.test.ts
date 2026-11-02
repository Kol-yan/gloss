// The Docker image has no tsx, so the invite and kill-switch commands ship as
// bundled Node scripts (see the Dockerfile). This builds them the same way and
// checks that what they write is what the server reads.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redeemInvite } from "@/server/auth/invites";
import { isAiEnabled } from "@/server/budget";
import { openDatabase } from "@/server/db";
import { testConfig } from "./helpers/db";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "glossy-scripts-"));
  dbPath = path.join(dir, "data", "glossy.db");
  execFileSync(
    path.resolve("node_modules/.bin/esbuild"),
    [
      "scripts/invite.ts",
      "scripts/ai-switch.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node26",
      `--outdir=${dir}/bundle`,
      "--out-extension:.js=.mjs",
      "--log-level=warning",
    ],
    { stdio: "pipe" },
  );
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, args: string[]): string {
  return execFileSync(process.execPath, [path.join(dir, "bundle", script), ...args], {
    // Run from the repository root, where db/migrations lives, like the image's /app.
    cwd: process.cwd(),
    env: { ...process.env, GLOSSY_DATABASE_PATH: dbPath, GLOSSY_PUBLIC_URL: "https://glossy.example/" },
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

describe("bundled scripts", () => {
  it("invite.mjs prints a link whose token the server accepts", () => {
    const link = run("invite.mjs", ["--label", "Judges", "--uses", "1", "--profile", "judge"]).trim();
    expect(link).toMatch(/^https:\/\/glossy\.example\/join\/[A-Za-z0-9_-]{43}$/);

    const db = openDatabase(dbPath);
    try {
      const redemption = redeemInvite(link.split("/").pop(), { db });
      expect(redemption.learner).toMatchObject({ displayName: "Judges 1", quotaProfile: "judge" });
    } finally {
      db.close();
    }
  });

  it("invite.mjs rejects bad arguments", () => {
    expect(() => run("invite.mjs", ["--label", "x", "--uses", "0", "--profile", "judge"])).toThrow();
    expect(() => run("invite.mjs", ["--label", "x", "--uses", "1", "--profile", "boss"])).toThrow();
  });

  it("ai-switch.mjs flips the runtime switch the server reads", () => {
    const read = () => {
      const db = openDatabase(dbPath);
      try {
        return isAiEnabled({ db, config: testConfig() });
      } finally {
        db.close();
      }
    };
    run("ai-switch.mjs", ["off"]);
    expect(read()).toBe(false);
    expect(run("ai-switch.mjs", ["status"])).toMatch(/Runtime switch \(database\):\s+off/);
    run("ai-switch.mjs", ["on"]);
    expect(read()).toBe(true);
  });
});
