import { MeResponse } from "@/shared/contracts";
import { getBudgetStatus, getQuotaUsage, isAiEnabled, type BudgetDeps } from "../budget";
import { getConfig } from "../config";
import { fundingSource, providerKey } from "../models/access";
import type { Learner } from "./sessions";

export function learnerStatus(learner: Learner, deps: BudgetDeps = {}): MeResponse {
  const accessMode = fundingSource(learner.id, deps.db);
  const config = deps.config ?? getConfig();
  const statusDeps = { ...deps, config };
  return MeResponse.parse({
    learner: { id: learner.id, displayName: learner.displayName },
    accessMode,
    aiEnabled: accessMode === "byok"
      ? isAiEnabled(statusDeps)
      : getBudgetStatus(statusDeps).aiAvailable && hasValidHostedKey(config.openRouter.apiKey),
    quotas: getQuotaUsage(learner, deps),
  });
}

function hasValidHostedKey(value: string | undefined): boolean {
  try {
    providerKey(value);
    return true;
  } catch {
    return false;
  }
}
