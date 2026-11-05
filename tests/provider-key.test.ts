import { describe, expect, it } from "vitest";
import { isProviderKey as browserValid } from "@/features/api/access-store";
import { providerKey } from "@/server/models/access";

describe("shared OpenRouter key format", () => {
  it("accepts and rejects the same values in the browser and server", () => {
    for (const value of ["", "a".repeat(32), "sk-or-v1-" + "a".repeat(15), "sk-or-v1-" + "a".repeat(16),
      " sk-or-v1-" + "a".repeat(512) + " ", "sk-or-v1-" + "a".repeat(513), "sk-or-v1-has spaces here now"]) {
      if (browserValid(value)) expect(providerKey(value)).toBe(value.trim());
      else expect(() => providerKey(value)).toThrow();
    }
  });
});
