// Usage: npm run spend:report. Reads the same persistent ledger as the server.
import { getBudgetStatus, utcDayBounds } from "../src/server/budget";
import { closeDb, getDb } from "../src/server/db";
import { loadLocalEnv } from "./env";

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
const charged = `CASE WHEN status = 'settled' AND actual_cost_micros > 0
  THEN actual_cost_micros ELSE max_cost_micros END`;

try {
  loadLocalEnv();
  const db = getDb();
  const now = new Date();
  const { start, end } = utcDayBounds(now);
  const status = getBudgetStatus({ db, now });
  console.log(`Spend report (UTC day ${start.slice(0, 10)})`);
  console.log(`Today hosted charged: ${dollars(status.spentMicros)} of ${dollars(status.ceilingMicros)}`);
  console.log(`Period hosted charged: ${dollars(status.periodSpentMicros)} of ${dollars(status.periodCeilingMicros)}`);
  console.log(`Owner funding expired: ${status.expired}`);
  for (const window of ["today", "period"] as const) {
    const rows = db.prepare(`SELECT role, COUNT(*) AS n, SUM(${charged}) AS micros
      FROM usage_reservations WHERE funding_source = 'hosted'
      ${window === "today" ? "AND created_at >= ? AND created_at < ?" : ""}
      GROUP BY role ORDER BY role`).all(...(window === "today" ? [start, end] : []));
    for (const row of rows) console.log(`  ${window} role=${row.role} reservations=${row.n} spend=${dollars(Number(row.micros))}`);
  }
  const guests = db.prepare(`SELECT COUNT(*) AS period,
    COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS today
    FROM guest_enrollments`).get(start, end);
  console.log(`Guests today: ${guests?.today ?? 0}; period: ${guests?.period ?? 0}`);
} catch {
  console.error("Spend report unavailable: check the database and configuration.");
  process.exitCode = 1;
} finally {
  closeDb();
}
