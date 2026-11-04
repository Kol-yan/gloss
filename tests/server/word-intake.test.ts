import { describe, expect, it } from "vitest";
import { estimateBand, entryRung, normalizeWord, wordCheckOutcome } from "@/server/learning/priority/intake";

describe("Word check mapping", () => {
  it('"I use it" is known vocabulary, not a My words entry', () => {
    expect(wordCheckOutcome("use")).toEqual({ add: false, status: "active", source: null });
  });

  it('"I know it but do not use it" makes the word ready to activate', () => {
    expect(wordCheckOutcome("know_unused")).toEqual({ add: true, status: "ready", source: "word_check" });
  });

  it('"not sure" and "new" both start at Learning', () => {
    expect(wordCheckOutcome("not_sure")).toMatchObject({ add: true, status: "learning" });
    expect(wordCheckOutcome("new")).toMatchObject({ add: true, status: "learning" });
  });

  it("starts a half-known word on the ladder at productive work", () => {
    expect(entryRung("ready")).toBe(2);
    expect(entryRung("learning")).toBe(1);
    expect(entryRung("active")).toBe(1);
  });
});

describe("normalisation", () => {
  it("lower-cases, trims and collapses spacing", () => {
    expect(normalizeWord("  Look   INTO ")).toBe("look into");
  });
});

describe("band estimate for added words", () => {
  it("recognises the documented core list exactly", () => {
    // Not on the closed list: three letters and no daily tag score 3.
    expect(estimateBand("the")).toBe("common");
    expect(estimateBand("look")).toBe("core");
    expect(estimateBand("IN THE END")).toBe("core");
    expect(estimateBand("on time")).toBe("core");
  });

  it("reproduces the worked examples of the documented rule", () => {
    expect(estimateBand("back")).toBe("common");
    expect(estimateBand("ok")).toBe("common");
    expect(estimateBand("time", ["time"])).toBe("core");
    expect(estimateBand("deadline")).toBe("uncommon");
    expect(estimateBand("talk it over", ["daily"])).toBe("common");
    expect(estimateBand("talk it over")).toBe("uncommon");
  });

  it("never returns rare and is not affected by tags on list hits", () => {
    expect(estimateBand("meticulous")).toBe("uncommon");
    expect(estimateBand("look", ["work"])).toBe("core");
    expect(estimateBand("look for")).toBe("uncommon");
  });

  it("uses letter count, not length, for short forms", () => {
    expect(estimateBand("go-")).toBe("common");
    expect(estimateBand("goal-plan")).toBe("uncommon");
  });
});
