import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, QUOTA_PROFILES, quotaLimits } from "@/server/config";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config.aiEnabled).toBe(true);
    expect(config.dailyBudgetUsd).toBe(5);
    expect(config.dailyBudgetMicros).toBe(5_000_000);
    expect(config.databasePath).toBe("./data/glossy.db");
    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(config.meta.apiKey).toBeUndefined();
    expect(config.periodBudgetMicros).toBe(25_000_000);
    expect(config.ownerFundedUntil).toBeUndefined();
    expect(config.modelMaxInputChars).toBe(100_000);
    expect(config.guestDailyIpLimit).toBe(3);
    expect(config.desktopGuestHourlyIpLimit).toBe(3);
    expect(config.guestDailyPracticeSessions).toBe(3);
  });

  it("allows guest daily limits through fifty and optional expiry", () => {
    expect(loadConfig({ GUEST_DAILY_IP_LIMIT: "50", OWNER_FUNDED_UNTIL: "" }).guestDailyIpLimit).toBe(50);
    expect(loadConfig({ OWNER_FUNDED_UNTIL: "" }).ownerFundedUntil).toBeUndefined();
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ META_API_KEY: "", AI_ENABLED: "", DAILY_BUDGET_USD: " " });
    expect(config.meta.apiKey).toBeUndefined();
    expect(config.aiEnabled).toBe(true);
    expect(config.dailyBudgetUsd).toBe(5);
  });

  it("parses flags, money and URLs", () => {
    const config = loadConfig({
      AI_ENABLED: "false",
      DAILY_BUDGET_USD: "0.1",
      GLOSSY_PUBLIC_URL: "https://glossy.example/",
      META_API_BASE_URL: "https://api.example/v1/",
    });
    expect(config.aiEnabled).toBe(false);
    // 0.1 * 1e6 is 100000.00000000001 in floating point; micros must be exact.
    expect(config.dailyBudgetMicros).toBe(100_000);
    expect(config.publicUrl).toBe("https://glossy.example");
    expect(config.meta.baseUrl).toBe("https://api.example/v1");
  });

  it("rejects bad values without echoing them", () => {
    expect(() => loadConfig({ DAILY_BUDGET_USD: "-1" })).toThrow(ConfigError);
    expect(() => loadConfig({ AI_ENABLED: "maybe" })).toThrow(/AI_ENABLED/);
    try {
      loadConfig({ GLOSSY_PUBLIC_URL: "not-a-secret-url" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("GLOSSY_PUBLIC_URL");
      expect((error as Error).message).not.toContain("not-a-secret-url");
    }
  });

  it("fails closed on malformed demo limits and expiry", () => {
    for (const env of [
      { PERIOD_BUDGET_USD: "-1" }, { OWNER_FUNDED_UNTIL: "tomorrow" },
      { MODEL_MAX_INPUT_CHARS: "100001" }, { GUEST_DAILY_IP_LIMIT: "51" },
      { GUEST_DAILY_PRACTICE_SESSIONS: "4" },
      { DESKTOP_GUEST_HOURLY_IP_LIMIT: "0" }, { DESKTOP_GUEST_HOURLY_IP_LIMIT: "1001" },
    ]) expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe("fast-tier configuration", () => {
  it("defaults to gpt-oss-120b without prices", () => {
    expect(loadConfig({}).openRouter).toEqual({
      apiKey: undefined,
      fastModel: "openai/gpt-oss-120b",
      fastPriceInUsdPerM: undefined,
      fastPriceOutUsdPerM: undefined,
    });
  });

  it("reads the model, its prices and the key", () => {
    const { openRouter } = loadConfig({
      OPENROUTER_API_KEY: "key",
      OPENROUTER_FAST_MODEL: "@preset/gpt-oss-120b-balanced",
      OPENROUTER_FAST_PRICE_IN_PER_M: "0.35",
      OPENROUTER_FAST_PRICE_OUT_PER_M: "0.95",
    });
    expect(openRouter).toEqual({
      apiKey: "key",
      fastModel: "@preset/gpt-oss-120b-balanced",
      fastPriceInUsdPerM: 0.35,
      fastPriceOutUsdPerM: 0.95,
    });
  });

  it("reads the legacy proofreading model name as an alias, and prefers the new name", () => {
    const alias = "@preset/gpt-oss-120b-balanced";
    expect(loadConfig({ OPENROUTER_PROOFREAD_MODEL: alias }).openRouter.fastModel).toBe(alias);
    expect(loadConfig({ OPENROUTER_PROOFREAD_MODEL: alias, OPENROUTER_FAST_MODEL: "vendor/model:floor" }).openRouter.fastModel)
      .toBe("vendor/model:floor");
    expect(loadConfig({ OPENROUTER_PROOFREAD_MODEL: alias, OPENROUTER_FAST_MODEL: " " }).openRouter.fastModel).toBe(alias);
    expect(loadConfig({ OPENROUTER_PROOFREAD_MODEL: "", OPENROUTER_FAST_MODEL: "" }).openRouter.fastModel).toBe("openai/gpt-oss-120b");
  });

  it("rejects prices that would remove the cost bound, and odd model ids, without echoing values", () => {
    for (const value of ["0", "-1", "abc", "Infinity", "1001"]) {
      expect(() => loadConfig({ OPENROUTER_FAST_PRICE_IN_PER_M: value })).toThrow(/OPENROUTER_FAST_PRICE_IN_PER_M/);
      expect(() => loadConfig({ OPENROUTER_FAST_PRICE_OUT_PER_M: value })).toThrow(/OPENROUTER_FAST_PRICE_OUT_PER_M/);
    }
    for (const value of ["has space", "x".repeat(201), "model\nname", "<script>"]) {
      expect(() => loadConfig({ OPENROUTER_FAST_MODEL: value })).toThrow(/OPENROUTER_FAST_MODEL/);
    }
    try {
      loadConfig({ OPENROUTER_FAST_PRICE_OUT_PER_M: "secret-looking-value" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-looking-value");
    }
  });
});

describe("quota profiles", () => {
  it("matches the documented limits", () => {
    expect(QUOTA_PROFILES.guest).toEqual({ proofread: 30, detect: 30, evaluate: 3, asrSeconds: 300 });
    expect(QUOTA_PROFILES.pilot).toEqual({ proofread: 20, detect: 100, evaluate: 12, asrSeconds: 180 });
    expect(QUOTA_PROFILES.judge).toEqual({ proofread: 30, detect: 30, evaluate: 30, asrSeconds: 300 });
    expect(quotaLimits("owner")).toEqual({ proofread: 200, detect: 200, evaluate: 100, asrSeconds: 1800 });
  });
});
