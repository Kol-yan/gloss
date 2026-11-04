import type { DatabaseSync } from "node:sqlite";
import { getDb, immediate } from "../../db";
import { InvalidRequestError } from "../../errors";

interface LearnerCompletionRow {
  onboarding_completed_at: string | null;
}

interface CompletedRoundRow {
  round_size: number;
  answered: number;
}

export function hasCompletedOnboarding(learnerId: string, db: DatabaseSync = getDb()): boolean {
  const row = db
    .prepare("SELECT onboarding_completed_at FROM learners WHERE id = ?")
    .get(learnerId) as LearnerCompletionRow | undefined;
  return Boolean(row?.onboarding_completed_at);
}

// Completion is durable and can only be recorded after a fully answered
// served round. A short final round is valid when fewer than 24 entries remain.
export function completeOnboarding(learnerId: string, db: DatabaseSync = getDb()): void {
  const completedAt = new Date().toISOString();

  immediate((tx) => {
    const learner = tx
      .prepare("SELECT onboarding_completed_at FROM learners WHERE id = ?")
      .get(learnerId) as LearnerCompletionRow | undefined;
    if (!learner) throw new InvalidRequestError();
    if (learner.onboarding_completed_at) return;

    const completedRound = tx
      .prepare(
        `SELECT COUNT(*) AS round_size,
                COUNT(word_check_answer) AS answered
         FROM word_check_entries
         WHERE learner_id = ?
         GROUP BY last_shown_on
         HAVING COUNT(*) BETWEEN 1 AND 24
            AND COUNT(word_check_answer) = COUNT(*)
         LIMIT 1`,
      )
      .get(learnerId) as CompletedRoundRow | undefined;
    if (!completedRound) throw new InvalidRequestError();

    tx.prepare(
      `UPDATE learners
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?)
       WHERE id = ?`,
    ).run(completedAt, learnerId);
  }, db);
}
