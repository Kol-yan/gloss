// Budget ledger hardening: period cap, funding expiry, zero-cost handling,
// roles, safe math and alert dedup. Uses the same temp-DB helpers as
// budget.test.ts; the 1000-reservation race runs in child processes against
// one persistent file like the existing ceiling test.
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBudgetStatus,
  markUnknown,
  reserve,
  settle,
  recordProviderReportedCost,
  DEFAULT_PERIOD_BUDGET_MICROS,
  type ReserveInput,
} from "@/server/budget";
import { sendOnceAlert, notifyGuestCreation } from "@/server/budget/alerts";
import { openDatabase } from "@/server/db";
import { BudgetExhaustedError } from "@/server/errors";
import { newId } from "@/server/ids";
import { createTempDb, insertLearner, testConfig, type TempDb } from "./helpers/db";

let temp: TempDb;
beforeEach(() => {
  temp = createTempDb();
});
afterEach(() => temp.cleanup());

const T0 = new Date("2026-11-02T10:00:00.000Z");
const TELEGRAM = { botToken: "123:test-token", chatId: "424242" };

type TestConfig = ReturnType<typeof testConfig> & {
  periodBudgetMicros?: number;
  ownerFundedUntil?: string;
  spendAlertTelegram?: { botToken: string; chatId: string };
};

function cfg(over: Record<string, unknown> = {}): TestConfig {
  return { ...testConfig({ DAILY_BUDGET_USD: "1000" }), ...over } as TestConfig;
}

function input(learnerId: string, requestId: string, over: Partial<ReserveInput> = {}): ReserveInput {
  return { learnerId, kind: "proofread", requestId, units: 1, maxCostMicros: 1000, ...over };
}

function insertByokLearner(db: TempDb["db"]): string {
  const id = newId();
  db.prepare(
    "INSERT INTO learners (id, display_name, quota_profile, funding_source, created_at) VALUES (?, ?, 'pilot', 'byok', ?)",
  ).run(id, "Visitor", T0.toISOString());
  return id;
}

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe("period cap and expiry", () => {
  it("reports period totals and expiry in status", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const before = getBudgetStatus({ db: temp.db, now: T0, config });
    expect(before.periodSpentMicros).toBe(0);
    expect(before.periodCeilingMicros).toBe(DEFAULT_PERIOD_BUDGET_MICROS);
    expect(before.expired).toBe(false);
    reserve(input(learner, "s-1", { maxCostMicros: 5000 }), { db: temp.db, now: T0, config });
    const after = getBudgetStatus({ db: temp.db, now: T0, config });
    expect(after.spentMicros).toBe(5000);
    expect(after.periodSpentMicros).toBe(5000);
  });

  it("refuses hosted calls at or after expiry but allows BYOK", () => {
    const hosted = insertLearner(temp.db);
    const visitor = insertByokLearner(temp.db);
    const expired = cfg({ ownerFundedUntil: "2026-11-01T00:00:00.000Z" });
    expect(getBudgetStatus({ db: temp.db, now: T0, config: expired }).expired).toBe(true);
    expect(() => reserve(input(hosted, "x-1"), { db: temp.db, now: T0, config: expired })).toThrow(
      BudgetExhaustedError,
    );
    // Exactly at expiry is also refused.
    const atEdge = cfg({ ownerFundedUntil: T0.toISOString() });
    expect(() => reserve(input(hosted, "x-2"), { db: temp.db, now: T0, config: atEdge })).toThrow(
      BudgetExhaustedError,
    );
    expect(
      reserve(input(visitor, "v-1"), { db: temp.db, now: T0, config: expired }).replay,
    ).toBe(false);
    // Before expiry hosted works again.
    const future = cfg({ ownerFundedUntil: "2026-12-01T00:00:00.000Z" });
    expect(
      reserve(input(hosted, "x-3"), { db: temp.db, now: T0, config: future }).replay,
    ).toBe(false);
  });

  it("enforces the period cap for hosted while the daily cap still applies", () => {
    const learner = insertLearner(temp.db, "owner");
    const config = cfg({ periodBudgetMicros: 100_000 });
    reserve(input(learner, "p-1", { maxCostMicros: 60_000 }), { db: temp.db, now: T0, config });
    reserve(input(learner, "p-2", { maxCostMicros: 40_000 }), { db: temp.db, now: T0, config });
    expect(() => reserve(input(learner, "p-3", { maxCostMicros: 1 }), { db: temp.db, now: T0, config })).toThrow(
      BudgetExhaustedError,
    );
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).periodSpentMicros).toBe(100_000);
    // Daily cap still binds even when the period has room.
    const tight = cfg({ dailyBudgetUsd: 0, dailyBudgetMicros: 0, periodBudgetMicros: 1_000_000_000 });
    expect(() => reserve(input(learner, "d-1"), { db: temp.db, now: T0, config: tight })).toThrow(
      BudgetExhaustedError,
    );
  });

  it("counts prior rows in the all-time total (no reset on restart)", () => {
    const learner = insertLearner(temp.db);
    const config = cfg({ periodBudgetMicros: 10_000 });
    temp.db
      .prepare(
        `INSERT INTO usage_reservations
           (id, learner_id, kind, request_id, units, max_cost_micros, actual_cost_micros,
            status, created_at, settled_at, funding_source)
         VALUES (?, ?, 'proofread', ?, 1, ?, ?, 'settled', ?, ?, 'hosted')`,
      )
      .run(newId(), learner, "old-row", 9000, 9000, "2026-01-05T00:00:00.000Z", T0.toISOString());
    // Daily total ignores January; period total keeps it.
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).spentMicros).toBe(0);
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).periodSpentMicros).toBe(9000);
    expect(() => reserve(input(learner, "new", { maxCostMicros: 2000 }), { db: temp.db, now: T0, config })).toThrow(
      BudgetExhaustedError,
    );
  });

  it("resets the daily total on UTC rollover while the period total persists", () => {
    const learner = insertLearner(temp.db);
    const config = cfg({ dailyBudgetUsd: 1, dailyBudgetMicros: 1_000_000, periodBudgetMicros: 50_000_000 });
    reserve(input(learner, "day1", { maxCostMicros: 900_000 }), { db: temp.db, now: T0, config });
    const tomorrow = new Date("2026-11-03T00:00:00.000Z");
    expect(getBudgetStatus({ db: temp.db, now: tomorrow, config }).spentMicros).toBe(0);
    expect(getBudgetStatus({ db: temp.db, now: tomorrow, config }).periodSpentMicros).toBe(900_000);
    expect(
      reserve(input(learner, "day2", { maxCostMicros: 900_000 }), { db: temp.db, now: tomorrow, config }).replay,
    ).toBe(false);
    expect(getBudgetStatus({ db: temp.db, now: tomorrow, config }).periodSpentMicros).toBe(1_800_000);
  });
});

describe("zero and unknown costs", () => {
  it("keeps an unexpected higher bill visible and trips the kill switch", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const deps = { db: temp.db, now: T0, config };
    const r = reserve(input(learner, "unexpected-price", { maxCostMicros: 5000 }), deps);
    temp.db.prepare("INSERT INTO budget_dispatches (reservation_id, dispatched_at) VALUES (?, ?)").run(r.id, T0.toISOString());
    recordProviderReportedCost(r.id, 6000, deps);
    expect(getBudgetStatus(deps)).toMatchObject({ spentMicros: 6000, switchOn: false });
    expect(() => reserve(input(learner, "after-unexpected-price"), deps)).toThrow(/disabled/);
  });
  it("never lowers the bound for an unproven positive caller estimate", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const deps = { db: temp.db, now: T0, config };
    const r = reserve(input(learner, "unproven", { maxCostMicros: 5000 }), deps);
    expect(() => recordProviderReportedCost(r.id, 1, deps)).toThrow(/dispatch/);
    settle(r.id, 1, deps);
    expect(getBudgetStatus(deps).spentMicros).toBe(5000);
  });
  it("keeps a zero settlement counted at max cost", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const r = reserve(input(learner, "z-1", { maxCostMicros: 5000 }), { db: temp.db, now: T0, config });
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).spentMicros).toBe(5000);
    const settled = settle(r.id, 0, { db: temp.db, now: T0 });
    expect(settled.status).toBe("settled");
    // The row keeps the reported zero for audit, but spend still counts max.
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).spentMicros).toBe(5000);
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).periodSpentMicros).toBe(5000);
  });

  it("never erases a positive settlement with a later zero", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const r = reserve(input(learner, "z-2", { maxCostMicros: 5000 }), { db: temp.db, now: T0, config });
    temp.db.prepare("INSERT INTO budget_dispatches (reservation_id, dispatched_at) VALUES (?, ?)").run(r.id, T0.toISOString());
    recordProviderReportedCost(r.id, 1200, { db: temp.db, now: T0 });
    expect(settle(r.id, 0, { db: temp.db, now: T0 }).actualCostMicros).toBe(1200);
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).spentMicros).toBe(1200);
  });

  it("keeps unknown outcomes counted", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const r = reserve(input(learner, "u-1", { maxCostMicros: 7000 }), { db: temp.db, now: T0, config });
    expect(markUnknown(r.id, { db: temp.db, now: T0 }).status).toBe("unknown");
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).spentMicros).toBe(7000);
    expect(getBudgetStatus({ db: temp.db, now: T0, config }).periodSpentMicros).toBe(7000);
  });
});

describe("roles and integer safety", () => {
  it("defaults role to kind and persists an explicit role in the ledger", () => {
    const learner = insertLearner(temp.db);
    const config = cfg();
    const a = reserve(input(learner, "r-1"), { db: temp.db, now: T0, config });
    expect(a.role).toBe("proofread");
    const b = reserve(input(learner, "r-2", { role: "detect" }), { db: temp.db, now: T0, config });
    expect(b.role).toBe("detect");
    // Roles survive a new read of the reservation.
    const cols = temp.db.prepare("PRAGMA table_info(usage_reservations)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "role")).toBe(true);
    expect(temp.db.prepare("SELECT role FROM usage_reservations WHERE id = ?").get(b.id)?.role).toBe("detect");
  });

  it("rejects invalid integers and unsafe sums", () => {
    const learner = insertLearner(temp.db, "owner");
    const config = cfg({ periodBudgetMicros: 1_000_000_000 });
    const deps = { db: temp.db, now: T0, config };
    expect(() => reserve(input(learner, "bad-units", { units: 0 }), deps)).toThrow(RangeError);
    expect(() => reserve(input(learner, "bad-float", { units: 1.5 }), deps)).toThrow(RangeError);
    expect(() => reserve(input(learner, "bad-max", { maxCostMicros: -1 }), deps)).toThrow(RangeError);
    expect(() => reserve(input(learner, "bad-role", { role: "x".repeat(65) }), deps)).toThrow(RangeError);
    expect(() => settle("missing", Number.NaN, deps)).toThrow(RangeError);
    expect(() => settle("missing", Number.POSITIVE_INFINITY, deps)).toThrow(RangeError);
    // Unsafe ledger total: a near-max row plus any new reservation overflows.
    temp.db
      .prepare(
        `INSERT INTO usage_reservations
           (id, learner_id, kind, request_id, units, max_cost_micros, status, created_at, funding_source)
         VALUES (?, ?, 'proofread', ?, 1, ?, 'reserved', ?, 'hosted')`,
      )
      .run(newId(), learner, "huge", Number.MAX_SAFE_INTEGER - 5, T0.toISOString());
    expect(() => reserve(input(learner, "overflow", { maxCostMicros: 100 }), deps)).toThrow(RangeError);
  });
});

describe("spend alerts", () => {
  it("alerts only after more than twenty guests in one hour, once per UTC day", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const config = cfg({ spendAlertTelegram: TELEGRAM });
      const insert = temp.db.prepare("INSERT INTO guest_enrollments (id, ip_hash, created_at) VALUES (?, ?, ?)");
      for (let i = 0; i < 20; i++) insert.run(newId(), `ip-${i}`, T0.toISOString());
      notifyGuestCreation(temp.db, T0, config);
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      insert.run(newId(), "ip-21", T0.toISOString());
      notifyGuestCreation(temp.db, T0, config);
      notifyGuestCreation(temp.db, T0, config);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/bot123:test-token/sendMessage");
      const burst = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(burst).toMatchObject({ chat_id: "424242" });
      expect(burst.text).toContain("21 guests");
      expect(fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
    } finally { vi.unstubAllGlobals(); }
  });
  it("fires once per threshold per UTC day and never awaits fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const learner = insertLearner(temp.db, "owner");
      const config = cfg({
        dailyBudgetUsd: 1,
        dailyBudgetMicros: 1_000_000,
        periodBudgetMicros: 500_000_000,
        spendAlertTelegram: TELEGRAM,
      });
      const deps = { db: temp.db, now: T0, config };
      reserve(input(learner, "a-1", { maxCostMicros: 600_000 }), deps);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.telegram.org/bot123:test-token/sendMessage");
      expect(payload).toMatchObject({ chat_id: "424242", text: expect.stringContaining("50%") });
      // Same day, same threshold: deduped.
      reserve(input(learner, "a-2", { maxCostMicros: 10_000 }), deps);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      reserve(input(learner, "a-80", { maxCostMicros: 190_000 }), deps);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      reserve(input(learner, "a-100", { maxCostMicros: 200_000 }), deps);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Next UTC day: the day key changes, so the threshold fires again.
      const tomorrow = new Date("2026-11-03T01:00:00.000Z");
      reserve(input(learner, "a-3", { maxCostMicros: 600_000 }), { db: temp.db, now: tomorrow, config });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sendOnceAlert dedups by key and swallow fetch failures without webhook details", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      sendOnceAlert(temp.db, "test-key-dedup", TELEGRAM, "hello");
      sendOnceAlert(temp.db, "test-key-dedup", TELEGRAM, "hello");
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // No webhook content leaks through thrown errors: nothing throws.
      notifyGuestCreation(temp.db, T0, { ...testConfig(), spendAlertTelegram: TELEGRAM } as TestConfig);
      await flush();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("cap race across processes", () => {
  it.each(["daily", "period"] as const)("holds the %s cap across 1000 racing reservations and survives restart", async (cap) => {
    const learners: string[] = [];
    for (let i = 0; i < 10; i++) learners.push(insertLearner(temp.db, "owner"));
    // Workers open their own connections; keep ours open too (WAL allows it).
    const worker = path.resolve("tests/server/helpers/budget-hardening-worker.ts");
    const periodMicros = cap === "period" ? 1_000_000 : 25_000_000;
    const dailyUsd = cap === "daily" ? "1" : "1000";
    const run = (index: number) =>
      new Promise<{ ok: number; budget: number; quota: number }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            worker,
            temp.path,
            learners[index],
            "100",
            "10000",
            dailyUsd,
            String(periodMicros),
            "2026-12-01T00:00:00.000Z",
            `race-${index}`,
            T0.toISOString(),
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("close", (code) =>
          code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker ${index} exited ${code}: ${err}`)),
        );
      });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => run(i)));
    const ok = results.reduce((sum, r) => sum + r.ok, 0);
    // 1000 wanted x 10,000 micros against a 1,000,000 period cap: exactly 100 fit.
    expect(ok).toBe(100);
    expect(results.reduce((sum, r) => sum + r.budget, 0)).toBe(900);
    expect(results.reduce((sum, r) => sum + r.quota, 0)).toBe(0);
    const config = cfg({ dailyBudgetUsd: Number(dailyUsd), dailyBudgetMicros: Number(dailyUsd) * 1_000_000, periodBudgetMicros: periodMicros });
    const status = getBudgetStatus({ db: temp.db, now: T0, config });
    expect(status.periodSpentMicros).toBe(1_000_000);
    expect(status.periodSpentMicros).toBeLessThanOrEqual(periodMicros);
    expect(status.spentMicros).toBeLessThanOrEqual(config.dailyBudgetMicros);
    // Restart: close and reopen the same file; the all-time total persists.
    temp.db.close();
    const reopened = openDatabase(temp.path);
    try {
      expect(getBudgetStatus({ db: reopened, now: T0, config }).periodSpentMicros).toBe(1_000_000);
    } finally {
      reopened.close();
    }
    // Reopen for cleanup.
    temp.db = openDatabase(temp.path);
  }, 120_000);
});
