import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getBudgetStatus,
  getQuotaUsage,
  isAiEnabled,
  markUnknown,
  reserve,
  settle,
  setAiEnabled,
  utcDayBounds,
  type ReserveInput,
} from "@/server/budget";
import { openDatabase } from "@/server/db";
import { AiDisabledError, BudgetExhaustedError, QuotaExceededError } from "@/server/errors";
import { createTempDb, insertLearner, testConfig, type TempDb } from "./helpers/db";

let temp: TempDb;
beforeEach(() => {
  temp = createTempDb();
});
afterEach(() => temp.cleanup());

const T0 = new Date("2026-11-02T10:00:00.000Z");
// $1 ceiling = 1,000,000 micro-dollars.
const config = testConfig({ DAILY_BUDGET_USD: "1" });

function input(learnerId: string, requestId: string, over: Partial<ReserveInput> = {}): ReserveInput {
  return { learnerId, kind: "proofread", requestId, units: 1, maxCostMicros: 1000, ...over };
}

const deps = (over: Record<string, unknown> = {}) => ({ db: temp.db, now: T0, config, ...over });

describe("reserve", () => {
  it("replays the same (learner, kind, requestId) without counting again", () => {
    const learner = insertLearner(temp.db);
    const first = reserve(input(learner, "req-1", { maxCostMicros: 300_000 }), deps());
    const again = reserve(input(learner, "req-1", { maxCostMicros: 300_000 }), deps());
    expect(first.replay).toBe(false);
    expect(again.replay).toBe(true);
    expect(again.id).toBe(first.id);
    expect(getQuotaUsage({ id: learner, quotaProfile: "pilot" }, deps()).proofread.used).toBe(1);
    expect(getBudgetStatus(deps()).spentMicros).toBe(300_000);
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM usage_reservations").get()).toEqual({ n: 1 });
  });

  it("keeps requestIds separate per kind and per learner", () => {
    const a = insertLearner(temp.db);
    const b = insertLearner(temp.db);
    expect(reserve(input(a, "same"), deps()).replay).toBe(false);
    expect(reserve(input(a, "same", { kind: "evaluate" }), deps()).replay).toBe(false);
    expect(reserve(input(b, "same"), deps()).replay).toBe(false);
  });

  it("enforces the learner quota per kind and resets on the next UTC day", () => {
    const learner = insertLearner(temp.db, "pilot");
    for (let i = 0; i < 20; i++) reserve(input(learner, `p-${i}`), deps());
    expect(() => reserve(input(learner, "p-20"), deps())).toThrowError(
      expect.objectContaining({ name: "QuotaExceededError", kind: "proofread", used: 20, limit: 20 }),
    );
    // Other kinds and other learners are unaffected.
    expect(reserve(input(learner, "e-0", { kind: "evaluate" }), deps()).replay).toBe(false);
    expect(reserve(input(insertLearner(temp.db), "p-0"), deps()).replay).toBe(false);
    // Next UTC day starts fresh.
    const tomorrow = new Date("2026-11-03T00:00:00.000Z");
    expect(reserve(input(learner, "p-21"), deps({ now: tomorrow })).replay).toBe(false);
    // The last millisecond of the day still belongs to the old day.
    const edge = new Date("2026-11-02T23:59:59.999Z");
    expect(() => reserve(input(learner, "p-22"), deps({ now: edge }))).toThrow(QuotaExceededError);
  });

  it("counts asrSeconds in seconds and uses the learner's profile", () => {
    const pilot = insertLearner(temp.db, "pilot");
    reserve(input(pilot, "a1", { kind: "asrSeconds", units: 120 }), deps());
    reserve(input(pilot, "a2", { kind: "asrSeconds", units: 60 }), deps());
    expect(() => reserve(input(pilot, "a3", { kind: "asrSeconds", units: 1 }), deps())).toThrow(
      QuotaExceededError,
    );
    const owner = insertLearner(temp.db, "owner");
    expect(reserve(input(owner, "a1", { kind: "asrSeconds", units: 1800 }), deps()).replay).toBe(false);
  });

  it("counts every status toward the quota", () => {
    const learner = insertLearner(temp.db, "pilot");
    const r1 = reserve(input(learner, "r1", { kind: "evaluate" }), deps());
    const r2 = reserve(input(learner, "r2", { kind: "evaluate" }), deps());
    settle(r1.id, 0, deps());
    markUnknown(r2.id, deps());
    expect(getQuotaUsage({ id: learner, quotaProfile: "pilot" }, deps()).evaluate.used).toBe(2);
  });

  it("never exceeds the ceiling across many reservations", () => {
    const learner = insertLearner(temp.db, "owner");
    let ok = 0;
    for (let i = 0; i < 150; i++) {
      try {
        reserve(input(learner, `c-${i}`, { maxCostMicros: 30_000 }), deps());
        ok++;
      } catch (error) {
        expect(error).toBeInstanceOf(BudgetExhaustedError);
      }
    }
    expect(ok).toBe(33); // 33 * 30,000 = 990,000 <= 1,000,000 < 34 * 30,000
    expect(getBudgetStatus(deps()).spentMicros).toBe(990_000);
  });

  it("allows an exact fit and rejects one micro-dollar more", () => {
    const learner = insertLearner(temp.db);
    reserve(input(learner, "fit", { maxCostMicros: 999_999 }), deps());
    expect(() => reserve(input(learner, "over", { maxCostMicros: 2 }), deps())).toThrow(
      BudgetExhaustedError,
    );
    expect(reserve(input(learner, "last", { maxCostMicros: 1 }), deps()).replay).toBe(false);
  });

  it("holds the ceiling across two connections to the same file", () => {
    const second = openDatabase(temp.path);
    try {
      const a = insertLearner(temp.db, "owner");
      const b = insertLearner(temp.db, "owner");
      let ok = 0;
      for (let i = 0; i < 100; i++) {
        const useSecond = i % 2 === 1;
        try {
          reserve(
            input(useSecond ? b : a, `x-${i}`, { maxCostMicros: 70_000 }),
            deps({ db: useSecond ? second : temp.db }),
          );
          ok++;
        } catch (error) {
          expect(error).toBeInstanceOf(BudgetExhaustedError);
        }
      }
      expect(ok).toBe(14); // 14 * 70,000 = 980,000
      expect(getBudgetStatus(deps({ db: second })).spentMicros).toBe(980_000);
      expect(getBudgetStatus(deps()).spentMicros).toBe(980_000);
    } finally {
      second.close();
    }
  });

  it("holds the ceiling across separate OS processes opening the file at once", async () => {
    const learner = insertLearner(temp.db, "owner");
    // No open connection left: the workers race to open (and reuse) the file.
    temp.db.close();
    const worker = path.resolve("tests/server/helpers/reserve-worker.ts");
    const run = (tag: string) =>
      new Promise<{ ok: number; budget: number; quota: number }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", worker, temp.path, learner, "40", "10000", "1", tag, T0.toISOString()],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("close", (code) =>
          code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}: ${err}`)),
        );
      });

    // 3 processes x 40 attempts x 10,000 micros = 1,200,000 wanted against a
    // 1,000,000 ceiling. 120 attempts stay under the owner quota (200), so
    // only the ceiling can bind: exactly 100 succeed.
    const results = await Promise.all([run("p1"), run("p2"), run("p3")]);
    const ok = results.reduce((sum, r) => sum + r.ok, 0);
    expect(ok).toBe(100);
    expect(results.reduce((sum, r) => sum + r.budget, 0)).toBe(20);
    const check = openDatabase(temp.path);
    try {
      expect(getBudgetStatus(deps({ db: check })).spentMicros).toBe(1_000_000);
    } finally {
      check.close();
    }
  }, 60_000);

  it("keeps an unknown outcome counted at max cost", () => {
    const learner = insertLearner(temp.db);
    const big = reserve(input(learner, "big", { maxCostMicros: 900_000 }), deps());
    const unknown = markUnknown(big.id, deps());
    expect(unknown.status).toBe("unknown");
    expect(unknown.actualCostMicros).toBeNull();
    expect(getBudgetStatus(deps()).spentMicros).toBe(900_000);
    expect(() => reserve(input(learner, "next", { maxCostMicros: 200_000 }), deps())).toThrow(
      BudgetExhaustedError,
    );
    // A later settle (usage reported after all) replaces the pessimistic count.
    settle(big.id, 50_000, deps());
    expect(getBudgetStatus(deps()).spentMicros).toBe(50_000);
  });

  it("settle replaces max cost with the actual cost and is idempotent", () => {
    const learner = insertLearner(temp.db);
    const r = reserve(input(learner, "s1", { maxCostMicros: 600_000 }), deps());
    const settled = settle(r.id, 12_345.2, deps());
    expect(settled).toMatchObject({ status: "settled", actualCostMicros: 12_346 });
    expect(settled.settledAt).toBe(T0.toISOString());
    expect(settle(r.id, 999_999, deps()).actualCostMicros).toBe(12_346);
    expect(getBudgetStatus(deps()).spentMicros).toBe(12_346);
    // markUnknown never downgrades a settled reservation.
    expect(markUnknown(r.id, deps()).status).toBe("settled");
  });

  it("books spend on the day of the reservation", () => {
    const learner = insertLearner(temp.db);
    reserve(input(learner, "d1", { maxCostMicros: 900_000 }), deps());
    const tomorrow = new Date("2026-11-03T00:00:00.000Z");
    expect(getBudgetStatus(deps({ now: tomorrow })).spentMicros).toBe(0);
    expect(reserve(input(learner, "d2", { maxCostMicros: 900_000 }), deps({ now: tomorrow })).replay)
      .toBe(false);
  });

  it("validates its input", () => {
    const learner = insertLearner(temp.db);
    expect(() => reserve(input(learner, "v", { units: 0 }), deps())).toThrow(RangeError);
    expect(() => reserve(input(learner, "v", { units: 1.5 }), deps())).toThrow(RangeError);
    expect(() => reserve(input(learner, "v", { maxCostMicros: -1 }), deps())).toThrow(RangeError);
    expect(() => reserve(input(learner, ""), deps())).toThrow(TypeError);
    expect(() => settle("missing", 1, deps())).toThrow(/Unknown reservation/);
    expect(() => settle(learner, Number.NaN, deps())).toThrow(RangeError);
  });

  it("rejects an unknown or deleted learner", () => {
    expect(() => reserve(input("ghost", "g"), deps())).toThrowError(
      expect.objectContaining({ name: "UnauthorizedError" }),
    );
    const learner = insertLearner(temp.db);
    temp.db.prepare("UPDATE learners SET deleted_at = ? WHERE id = ?").run(T0.toISOString(), learner);
    expect(() => reserve(input(learner, "g"), deps())).toThrowError(
      expect.objectContaining({ name: "UnauthorizedError" }),
    );
  });
});

describe("abandoned reservations", () => {
  it("become unknown after two minutes and keep counting at max cost", () => {
    const learner = insertLearner(temp.db);
    const stuck = reserve(input(learner, "stuck", { maxCostMicros: 300_000 }), deps());
    const fresh = reserve(input(learner, "fresh", { maxCostMicros: 100_000 }), deps({ now: new Date(T0.getTime() + 60_000) }));
    const status = (id: string) =>
      (temp.db.prepare("SELECT status FROM usage_reservations WHERE id = ?").get(id) as { status: string }).status;

    // The next reservation, 2 minutes and 1 ms later, sweeps the old one only.
    reserve(input(learner, "later", { maxCostMicros: 1 }), deps({ now: new Date(T0.getTime() + 120_001) }));
    expect(status(stuck.id)).toBe("unknown");
    expect(status(fresh.id)).toBe("reserved");
    expect(getBudgetStatus(deps({ now: new Date(T0.getTime() + 120_001) })).spentMicros).toBe(400_001);

    // Exactly two minutes is not yet stale.
    const other = reserve(input(learner, "edge", { maxCostMicros: 5 }), deps({ now: new Date(T0.getTime() + 125_000) }));
    reserve(input(learner, "after-edge", { maxCostMicros: 1 }), deps({ now: new Date(T0.getTime() + 125_000) }));
    expect(status(other.id)).toBe("reserved");

    // A call that is somehow still running can still settle its reservation.
    expect(settle(stuck.id, 10_000, deps()).status).toBe("settled");
  });
});

describe("kill switch", () => {
  it("blocks reservations when AI_ENABLED is false", () => {
    const learner = insertLearner(temp.db);
    const off = testConfig({ AI_ENABLED: "false" });
    expect(() => reserve(input(learner, "k1"), deps({ config: off }))).toThrow(AiDisabledError);
    expect(isAiEnabled(deps({ config: off }))).toBe(false);
    expect(temp.db.prepare("SELECT COUNT(*) AS n FROM usage_reservations").get()).toEqual({ n: 0 });
  });

  it("blocks reservations when the runtime setting is off and resumes when it is on", () => {
    const learner = insertLearner(temp.db);
    expect(isAiEnabled(deps())).toBe(true);
    setAiEnabled(false, deps());
    expect(isAiEnabled(deps())).toBe(false);
    expect(() => reserve(input(learner, "k2"), deps())).toThrow(AiDisabledError);
    expect(getBudgetStatus(deps())).toMatchObject({ runtimeSwitchOn: false, aiAvailable: false });
    setAiEnabled(true, deps());
    expect(reserve(input(learner, "k2"), deps()).replay).toBe(false);
  });

  it("fails closed on an unreadable setting value", () => {
    temp.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_enabled', 'banana')").run();
    expect(isAiEnabled(deps())).toBe(false);
  });
});

describe("getBudgetStatus", () => {
  it("reports unavailable once the ceiling is reached", () => {
    const learner = insertLearner(temp.db);
    expect(getBudgetStatus(deps()).aiAvailable).toBe(true);
    reserve(input(learner, "full", { maxCostMicros: 1_000_000 }), deps());
    expect(getBudgetStatus(deps())).toMatchObject({ ceilingReached: true, aiAvailable: false });
  });

  it("treats a zero budget as cloud features off from the start", () => {
    const zero = testConfig({ DAILY_BUDGET_USD: "0" });
    const learner = insertLearner(temp.db);
    expect(getBudgetStatus(deps({ config: zero }))).toMatchObject({
      spentMicros: 0,
      ceilingReached: true,
      aiAvailable: false,
    });
    expect(() => reserve(input(learner, "z"), deps({ config: zero }))).toThrow(BudgetExhaustedError);
  });
});

describe("utcDayBounds", () => {
  it("returns the [start, end) of the UTC day", () => {
    expect(utcDayBounds(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      start: "2026-12-31T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });
});
