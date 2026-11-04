// Alerts claim a durable daily key, then send without awaiting the Telegram call.
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config";
import { immediate } from "../db";

export const SPEND_ALERT_THRESHOLDS = [50, 80, 100] as const;
export interface SpendTotals { periodSpent: number; dailySpent: number }
export interface SpendAlertTarget { botToken: string; chatId: string }

// The bot token is part of the Bot API URL, so the URL is built here and never
// logged or attached to an error.
export function sendOnceAlert(db: DatabaseSync, key: string, target: SpendAlertTarget | undefined, message: string): void {
  if (!target) return;
  try {
    const claimed = immediate((tx) => tx.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
    ).run(key, new Date().toISOString()).changes > 0, db);
    if (!claimed) return;
    queueMicrotask(() => {
      try {
        void fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: target.chatId, text: message, disable_notification: true }),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        }).catch(() => undefined);
      } catch { /* Notification failures must not affect learner requests. */ }
    });
  } catch { /* Notification failures must not affect ledger operations. */ }
}

export function queueSpendAlertCheck(db: DatabaseSync, now: Date, config: AppConfig, totals: SpendTotals): void {
  if (!config.spendAlertTelegram || config.dailyBudgetMicros <= 0) return;
  const day = now.toISOString().slice(0, 10);
  for (const threshold of SPEND_ALERT_THRESHOLDS) {
    if (totals.dailySpent * 100 >= config.dailyBudgetMicros * threshold) {
      sendOnceAlert(db, `spend_alert_daily_${threshold}_${day}`, config.spendAlertTelegram,
        `gloss demo spend reached ${threshold}% of the daily budget.`);
    }
  }
}

export function notifyGuestCreation(db: DatabaseSync, now: Date, config: AppConfig): void {
  if (!config.spendAlertTelegram) return;
  queueMicrotask(() => {
    try {
      const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const count = Number(db.prepare(
        "SELECT COUNT(*) AS n FROM guest_enrollments WHERE created_at > ? AND created_at <= ?",
      ).get(since, now.toISOString())?.n ?? 0);
      if (count > 20) sendOnceAlert(db, `guest_alert_${now.toISOString().slice(0, 10)}`,
        config.spendAlertTelegram, `gloss created ${count} guests in the last hour.`);
    } catch { /* Enrollment remains independent of alert delivery. */ }
  });
}
