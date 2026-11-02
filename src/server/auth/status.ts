import { MeResponse } from "@/shared/contracts";
import { getBudgetStatus, getQuotaUsage, isAiEnabled, type BudgetDeps } from "../budget";
import { fundingSource } from "../models/access";
import type { Learner } from "./sessions";

export function learnerStatus(learner: Learner, deps: BudgetDeps = {}): MeResponse {
  const accessMode = fundingSource(learner.id, deps.db);
  return MeResponse.parse({
    learner: { id: learner.id, displayName: learner.displayName },
    accessMode,
    aiEnabled: accessMode === "byok" ? isAiEnabled(deps) : getBudgetStatus(deps).aiAvailable,
    quotas: getQuotaUsage(learner, deps),
  });
}
