import type { QuotaState } from "@/shared/contracts";

// null hides the counter and keeps automatic checks enabled for BYOK.
export function checksRemaining(quota: QuotaState | undefined): number | null {
  return !quota || quota.unlimited ? null : Math.max(0, quota.limit - quota.used);
}
