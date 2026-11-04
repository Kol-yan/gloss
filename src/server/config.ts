// Server configuration. Parsed lazily from the environment so that importing
// this module (for example while Next collects route modules at build time)
// never reads secrets and never throws.
import { z } from "zod";
import type { QuotaKind } from "@/shared/contracts";
import { FAST_MODEL_DEFAULT } from "./models/prices";

export const QUOTA_PROFILE_NAMES = ["pilot", "judge", "owner"] as const;
export type QuotaProfileName = (typeof QUOTA_PROFILE_NAMES)[number];
export const QuotaProfileNameSchema = z.enum(QUOTA_PROFILE_NAMES);

export type QuotaLimits = Record<QuotaKind, number>;

// Daily per-learner limits. proofread/detect/evaluate count operations;
// asrSeconds counts seconds of audio. Detector and generator quotas are separate.
export const QUOTA_PROFILES: Record<QuotaProfileName, QuotaLimits> = {
  pilot: { proofread: 20, detect: 100, evaluate: 12, asrSeconds: 180 },
  judge: { proofread: 30, detect: 30, evaluate: 30, asrSeconds: 300 },
  owner: { proofread: 200, detect: 200, evaluate: 100, asrSeconds: 1800 },
};

export function quotaLimits(profile: QuotaProfileName): QuotaLimits {
  return QUOTA_PROFILES[profile];
}

// `KEY=` in an env file means "unset", not "empty string".
const blankAsUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(blankAsUndefined, z.string().trim().optional());

// OpenRouter model ids and presets such as "@preset/name" or "vendor/model:floor".
const modelId = z.string().trim().regex(/^[A-Za-z0-9@._:~/+-]{1,200}$/, "invalid model id");
const optionalModelId = z.preprocess(blankAsUndefined, modelId.optional());

// USD per million tokens. Zero or negative would remove the cost bound.
const optionalPrice = z.preprocess(
  blankAsUndefined,
  z.coerce.number().finite().positive().max(1000).optional(),
);

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
  OPENROUTER_FAST_MODEL: optionalModelId,
  // Legacy name of OPENROUTER_FAST_MODEL, read only when the new one is unset.
  OPENROUTER_PROOFREAD_MODEL: optionalModelId,
  OPENROUTER_FAST_PRICE_IN_PER_M: optionalPrice,
  OPENROUTER_FAST_PRICE_OUT_PER_M: optionalPrice,
  BYOK_TRUST_PROXY_HEADERS: z.preprocess(blankAsUndefined, z.stringbool().default(false)),
  AI_ENABLED: z.preprocess(blankAsUndefined, z.stringbool().default(true)),
  PRACTICE_GENERATION_TIER: z.preprocess(blankAsUndefined, z.enum(["fast", "smart"]).default("fast")),
  PRACTICE_GENERATION_MAX_COST_MICROS: z.preprocess(
    blankAsUndefined,
    z.coerce.number().int().min(1).max(1_000_000).default(50_000),
  ),
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
  // The operator's OpenRouter account serves the fast tier. The prices are
  // USD per million tokens and bound the cost of the configured model or
  // preset; unset means the conservative default for gpt-oss-120b.
  openRouter: {
    apiKey?: string;
    fastModel: string;
    fastPriceInUsdPerM?: number;
    fastPriceOutUsdPerM?: number;
  };
  // Only enable behind a proxy that overwrites the client-IP header.
  byokTrustProxyHeaders: boolean;
  // Env-level kill switch. The runtime switch lives in the settings table.
  aiEnabled: boolean;
  practiceGenerationTier: "fast" | "smart";
  practiceGenerationMaxCostMicros: number;
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
    openRouter: {
      apiKey: v.OPENROUTER_API_KEY,
      fastModel: v.OPENROUTER_FAST_MODEL ?? v.OPENROUTER_PROOFREAD_MODEL ?? FAST_MODEL_DEFAULT,
      fastPriceInUsdPerM: v.OPENROUTER_FAST_PRICE_IN_PER_M,
      fastPriceOutUsdPerM: v.OPENROUTER_FAST_PRICE_OUT_PER_M,
    },
    byokTrustProxyHeaders: v.BYOK_TRUST_PROXY_HEADERS,
    aiEnabled: v.AI_ENABLED,
    practiceGenerationTier: v.PRACTICE_GENERATION_TIER,
    practiceGenerationMaxCostMicros: v.PRACTICE_GENERATION_MAX_COST_MICROS,
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
