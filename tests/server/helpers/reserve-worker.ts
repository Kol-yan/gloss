// Child process used by budget.test.ts to contend for the same database file
// from a separate OS process. Prints {"ok": n, "budget": n, "quota": n}.
import { BudgetExhaustedError, QuotaExceededError } from "../../../src/server/errors";
import { reserve } from "../../../src/server/budget";
import { loadConfig } from "../../../src/server/config";
import { openDatabase } from "../../../src/server/db";

const [dbPath, learnerId, attempts, cost, budgetUsd, tag, timestamp] = process.argv.slice(2);

const db = openDatabase(dbPath);
const config = loadConfig({ DAILY_BUDGET_USD: budgetUsd });
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
