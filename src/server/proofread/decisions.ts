import type { SuggestionDecision } from "@/shared/contracts";
import type { Learner } from "../auth/sessions";
import { getDb, immediate, learnerScope } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, NotFoundError } from "../errors";

export interface DecisionResult {
  id: string;
  // The stored status after this call.
  status: SuggestionDecision;
}

// Records the learner's decision on one suggestion. pending moves to the
// decision once; repeating the same decision is a no-op; a different decision
// after a final one is a conflict. The learner filter makes another learner's
// suggestion indistinguishable from a missing one.
export function decideSuggestion(
  learner: Learner,
  suggestionId: string,
  decision: SuggestionDecision,
  deps: ServerDeps = {},
): DecisionResult {
  const now = deps.now ?? new Date();

  return immediate((db) => {
    const row = learnerScope(learner.id, db).selectOne("suggestions", {
      where: "id = :id",
      params: { id: suggestionId },
    });
    if (!row) throw new NotFoundError();

    const current = String(row.status);
    if (current === "pending") {
      db.prepare(
        `UPDATE suggestions SET status = ?, decided_at = ?
         WHERE id = ? AND learner_id = ? AND status = 'pending'`,
      ).run(decision, now.toISOString(), suggestionId, learner.id);
      return { id: suggestionId, status: decision };
    }
    if (current === decision) return { id: suggestionId, status: decision };
    throw new ConflictError();
  }, deps.db ?? getDb());
}
