// Server configuration. Parsed lazily from the environment so that importing
// this module (for example while Next collects route modules at build time)
// never reads secrets and never throws.
import { z } from "zod";
import type { QuotaKind } from "@/shared/contracts";

export const QUOTA_PROFILE_NAMES = ["pilot", "judge", "owner"] as const;
export type QuotaProfileName = (typeof QUOTA_PROFILE_NAMES)[number];
export const QuotaProfileNameSchema = z.enum(QUOTA_PROFILE_NAMES);

export type QuotaLimits = Record<QuotaKind, number>;

// Daily per-learner limits. proofread/evaluate count operations, asrSeconds
// counts seconds of audio.
export const QUOTA_PROFILES: Record<QuotaProfileName, QuotaLimits> = {
  pilot: { proofread: 20, evaluate: 12, asrSeconds: 180 },
  judge: { proofread: 30, evaluate: 30, asrSeconds: 300 },
  owner: { proofread: 200, evaluate: 100, asrSeconds: 1800 },
};

export function quotaLimits(profile: QuotaProfileName): QuotaLimits {
  return QUOTA_PROFILES[profile];
}

// `KEY=` in an env file means "unset", not "empty string".
const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(blankAsUndefined, z.string().trim().optional());

const EnvSchema = z.object({
  META_API_KEY: optionalText,
  META_API_BASE_URL: z.preprocess(
    blankAsUndefined,
    z.url({ protocol: /^https?$/ }).default("https://api.meta.ai/v1"),
  ),
  META_TEXT_MODEL: z.preprocess(blankAsUndefined, z.string().trim().default("muse-spark-1.3")),
  META_ASR_MODEL: z.preprocess(
    blankAsUndefined,
    z.string().trim().default("muse-voice-transcribe-1.0"),
  ),
  OPENROUTER_API_KEY: optionalText,
  OPENROUTER_PROOFREAD_MODEL: optionalText,
  AI_ENABLED: z.preprocess(blankAsUndefined, z.stringbool().default(true)),
  DAILY_BUDGET_USD: z.preprocess(
    blankAsUndefined,
    z.coerce.number().finite().min(0).max(100_000).default(5),
  ),
  GLOSSY_DATABASE_PATH: z.preprocess(
    blankAsUndefined,
    z.string().trim().default("./data/glossy.db"),
  ),
  GLOSSY_PUBLIC_URL: z.preprocess(
    blankAsUndefined,
    z.url({ protocol: /^https?$/ }).default("http://localhost:3000"),
  ),
});

export interface AppConfig {
  meta: { apiKey?: string; baseUrl: string; textModel: string; asrModel: string };
  openRouter: { apiKey?: string; proofreadModel?: string };
  // Env-level kill switch. The runtime switch lives in the settings table.
  aiEnabled: boolean;
  dailyBudgetUsd: number;
  // Integer micro-dollars; the unit all budget arithmetic uses.
  dailyBudgetMicros: number;
  databasePath: string;
  // Base URL without a trailing slash.
  publicUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Name the variables only: values may be secrets.
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "env"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration. ${problems.join("; ")}`);
  }
  const v = parsed.data;
  return {
    meta: {
      apiKey: v.META_API_KEY,
      baseUrl: v.META_API_BASE_URL.replace(/\/+$/, ""),
      textModel: v.META_TEXT_MODEL,
      asrModel: v.META_ASR_MODEL,
    },
    openRouter: { apiKey: v.OPENROUTER_API_KEY, proofreadModel: v.OPENROUTER_PROOFREAD_MODEL },
    aiEnabled: v.AI_ENABLED,
    dailyBudgetUsd: v.DAILY_BUDGET_USD,
    dailyBudgetMicros: Math.round(v.DAILY_BUDGET_USD * 1_000_000),
    databasePath: v.GLOSSY_DATABASE_PATH,
    publicUrl: v.GLOSSY_PUBLIC_URL.replace(/\/+$/, ""),
  };
}

// Reads process.env on every call (cheap) so tests and scripts can change it.
export function getConfig(): AppConfig {
  return loadConfig(process.env);
}
