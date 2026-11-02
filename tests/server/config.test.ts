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
});

describe("quota profiles", () => {
  it("matches the documented limits", () => {
    expect(QUOTA_PROFILES.pilot).toEqual({ proofread: 20, evaluate: 12, asrSeconds: 180 });
    expect(QUOTA_PROFILES.judge).toEqual({ proofread: 30, evaluate: 30, asrSeconds: 300 });
    expect(quotaLimits("owner")).toEqual({ proofread: 200, evaluate: 100, asrSeconds: 1800 });
  });
});
