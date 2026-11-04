import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { reserve, settle, markUnknown, recordProviderReportedCost } from "@/server/budget";
import { createTempDb, insertLearner, testConfig, type TempDb } from "./helpers/db";

let temp: TempDb;
beforeEach(() => { temp = createTempDb(); });
afterEach(() => temp.cleanup());

it("prints charged daily and period spend by role and guest counts from the persistent ledger", () => {
  const learnerId = insertLearner(temp.db);
  const now = new Date();
  const deps = { db: temp.db, now, config: testConfig({ OWNER_FUNDED_UNTIL: "2099-01-01T00:00:00Z" }) };
  const reserveRole = (role: string, amount: number) => reserve({
    learnerId, role, kind: "proofread", requestId: crypto.randomUUID(), units: 1, maxCostMicros: amount,
  }, deps);
  const paid = reserveRole("proofread", 100_000);
  temp.db.prepare("INSERT INTO budget_dispatches (reservation_id, dispatched_at) VALUES (?, ?)").run(paid.id, now.toISOString());
  recordProviderReportedCost(paid.id, 20_000, deps);
  settle(reserveRole("proofread", 100_000).id, 0, deps);
  markUnknown(reserveRole("detect", 200_000).id, deps);
  temp.db.prepare("INSERT INTO guest_enrollments (id, ip_hash, created_at) VALUES (?, ?, ?)")
    .run(crypto.randomUUID(), "test-ip", now.toISOString());
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/spend-report.ts"], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GLOSSY_DATABASE_PATH: temp.path },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Today hosted charged: $0.320000");
  expect(result.stdout).toContain("Period hosted charged: $0.320000");
  expect(result.stdout).toContain("today role=proofread reservations=2 spend=$0.120000");
  expect(result.stdout).toContain("period role=detect reservations=1 spend=$0.200000");
  expect(result.stdout).toContain("Guests today: 1; period: 1");
});
