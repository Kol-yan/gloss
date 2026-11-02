import type { DatabaseSync } from "node:sqlite";
import type { Learner } from "../auth/sessions";
import type { AppConfig } from "../config";
import { getDb } from "../db";
import { AiDisabledError, UnauthorizedError } from "../errors";
import { ModelNotConfiguredError } from "./errors";

export type FundingSource = "hosted" | "byok";
export type ProviderAccess = { provider: "meta" } | { provider: "openrouter"; apiKey: string };

export const PROVIDER_KEY_HEADER = "X-Gloss-Provider-Key";
export const OPENROUTER_TEXT_MODEL = "meta/muse-spark-1.3";
export const OPENROUTER_ASR_MODEL = "meta/muse-voice-transcribe-1.0";

export function fundingSource(learnerId: string, db: DatabaseSync = getDb()): FundingSource {
  const row = db.prepare("SELECT funding_source FROM learners WHERE id = ? AND deleted_at IS NULL").get(learnerId);
  if (!row) throw new UnauthorizedError();
  if (row.funding_source !== "hosted" && row.funding_source !== "byok") throw new AiDisabledError();
  return row.funding_source;
}

export function providerKey(value: string | null | undefined): string {
  const key = value?.trim() ?? "";
  if (!/^sk-or-v1-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new AiDisabledError();
  return key;
}

// Database funding wins over caller objects and request headers. In particular,
// a BYOK learner can never fall through to the operator's configured Meta key.
export function resolveProviderAccess(
  learnerId: string,
  supplied: ProviderAccess | undefined,
  db: DatabaseSync = getDb(),
): ProviderAccess {
  if (fundingSource(learnerId, db) === "hosted") return { provider: "meta" };
  if (supplied?.provider !== "openrouter") throw new AiDisabledError();
  return { provider: "openrouter", apiKey: providerKey(supplied.apiKey) };
}

export function providerAccessFromRequest(request: Request, learner: Learner): ProviderAccess {
  if (fundingSource(learner.id) === "hosted") return { provider: "meta" };
  return { provider: "openrouter", apiKey: providerKey(request.headers.get(PROVIDER_KEY_HEADER)) };
}

export function textModel(access: ProviderAccess, config: AppConfig): string {
  if (access.provider === "openrouter") return OPENROUTER_TEXT_MODEL;
  if (!config.meta.apiKey) throw new ModelNotConfiguredError();
  return config.meta.textModel;
}

export function speechModel(access: ProviderAccess, config: AppConfig): string {
  if (access.provider === "openrouter") return OPENROUTER_ASR_MODEL;
  if (!config.meta.apiKey) throw new ModelNotConfiguredError();
  return config.meta.asrModel;
}
