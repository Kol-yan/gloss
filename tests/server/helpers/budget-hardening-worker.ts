// Child process used by budget-hardening.test.ts to contend for the same
// database file from separate OS processes against the period cap.
// Args: dbPath learnerId attempts cost dailyBudgetUsd periodBudgetMicros
//   ownerFundedUntil tag timestamp [role]
// Prints {"ok": n, "budget": n}.
import { BudgetExhaustedError, QuotaExceededError } from "../../../src/server/errors";
import { reserve } from "../../../src/server/budget";
import { loadConfig } from "../../../src/server/config";
import { openDatabase } from "../../../src/server/db";

const [
  dbPath,
  learnerId,
  attempts,
  cost,
  dailyBudgetUsd,
  periodBudgetMicros,
  ownerFundedUntil,
  tag,
  timestamp,
  role,
] = process.argv.slice(2);

const db = openDatabase(dbPath);
const base = loadConfig({ DAILY_BUDGET_USD: dailyBudgetUsd });
const config = {
  ...base,
  periodBudgetMicros: Number(periodBudgetMicros),
  ownerFundedUntil,
} as typeof base;
const counts = { ok: 0, budget: 0, quota: 0 };

for (let i = 0; i < Number(attempts); i++) {
  try {
    reserve(
      {
        learnerId,
        kind: "proofread",
        requestId: `${tag}-${i}`,
        units: 1,
        maxCostMicros: Number(cost),
        ...(role ? { role } : {}),
      },
      { db, config, now: new Date(timestamp) },
    );
    counts.ok++;
  } catch (error) {
    if (error instanceof BudgetExhaustedError) counts.budget++;
    else if (error instanceof QuotaExceededError) counts.quota++;
    else throw error;
  }
}
db.close();
console.log(JSON.stringify(counts));
