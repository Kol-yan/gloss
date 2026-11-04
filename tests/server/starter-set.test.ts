import { describe, expect, it } from "vitest";
import { BATCH_A_EXPRESSIONS } from "@/server/learning/starter/batches/batch-a-expressions";
import { BATCH_B_EXPRESSIONS } from "@/server/learning/starter/batches/batch-b-expressions";
import { BATCH_C_WORDS } from "@/server/learning/starter/batches/batch-c-words";
import { BATCH_D_WORDS } from "@/server/learning/starter/batches/batch-d-words";
import { STARTER_ENTRIES } from "@/server/learning/starter/entries-data";
import { starterEntry, starterSet } from "@/server/learning/starter";
import {
  countWords,
  exampleContains,
  loadStarterSet,
  MAX_DEFINITION_WORDS,
  normalizeEntryText,
  StarterSetError,
} from "@/server/learning/starter/schema";

const valid = () => ({
  text: "make a decision",
  band: "core",
  level: "A2",
  definition: "choose one option after thinking",
  example: "We need to make a decision before Friday.",
  tags: ["work"],
});

describe("starter set data", () => {
  const loaded = starterSet();

  it("holds about 400 entries, single words and common expressions", () => {
    expect(loaded.entries).toHaveLength(STARTER_ENTRIES.length);
    expect(loaded.stats.total).toBeGreaterThanOrEqual(380);
    expect(loaded.stats.total).toBeLessThanOrEqual(420);
    expect(loaded.stats.words).toBeGreaterThanOrEqual(150);
    expect(loaded.stats.expressions).toBeGreaterThanOrEqual(150);
    for (const batch of [BATCH_A_EXPRESSIONS, BATCH_B_EXPRESSIONS, BATCH_C_WORDS, BATCH_D_WORDS]) {
      expect(batch).toHaveLength(100);
    }
  });

  it("spreads entries across every band and every level", () => {
    for (const band of ["core", "common", "uncommon", "rare"]) {
      expect(loaded.stats.byBand[band], band).toBeGreaterThanOrEqual(40);
    }
    for (const level of ["A2", "B1", "B2", "C1"]) {
      expect(loaded.stats.byLevel[level], level).toBeGreaterThanOrEqual(40);
    }
    expect(Object.values(loaded.stats.byBand).reduce((sum, n) => sum + n, 0)).toBe(loaded.stats.total);
    expect(Object.values(loaded.stats.byLevel).reduce((sum, n) => sum + n, 0)).toBe(loaded.stats.total);
  });

  it("keeps every definition within the word cap and outside the entry", () => {
    for (const entry of loaded.entries) {
      expect(countWords(entry.definition), entry.text).toBeLessThanOrEqual(MAX_DEFINITION_WORDS);
      expect(entry.definition.toLowerCase(), entry.text).not.toContain(entry.text.toLowerCase());
    }
  });

  it("gives every entry an example sentence containing the entry", () => {
    for (const entry of loaded.entries) {
      expect(exampleContains(entry.example, entry.text), `${entry.text}: ${entry.example}`).toBe(true);
      expect(entry.example, entry.text).toMatch(/[.!?]$/);
    }
  });

  it("has no expression or stem shared between two batches", () => {
    const batches = [BATCH_A_EXPRESSIONS, BATCH_B_EXPRESSIONS, BATCH_C_WORDS, BATCH_D_WORDS];
    const owners = new Map<string, number>();
    for (const [index, batch] of batches.entries()) {
      for (const entry of batch) {
        const key = normalizeEntryText(entry.text);
        expect(owners.get(key), `${entry.text} in batches ${owners.get(key)} and ${index}`).toBeUndefined();
        owners.set(key, index);
      }
    }
  });

  it("indexes entries by normalized text", () => {
    expect(starterEntry("  Make A   Decision ")?.text).toBe("make a decision");
    expect(starterEntry("not in the starter set")).toBeUndefined();
    expect(loaded.byText.size).toBe(loaded.entries.length);
  });
});

describe("loadStarterSet", () => {
  it("accepts a well-formed entry", () => {
    const loaded = loadStarterSet([valid()]);
    expect(loaded.byText.get("make a decision")?.level).toBe("A2");
    expect(loaded.stats).toMatchObject({ total: 1, words: 0, expressions: 1 });
  });

  it("rejects a definition over the word cap", () => {
    const entry = valid();
    entry.definition = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    expect(() => loadStarterSet([entry])).toThrow(StarterSetError);
  });

  it("rejects an example that does not contain the entry", () => {
    const entry = valid();
    entry.example = "We need to talk about the schedule.";
    expect(() => loadStarterSet([entry])).toThrow(/example must contain the entry/);
  });

  it("rejects a duplicated expression regardless of case", () => {
    const first = { ...valid(), text: "look into", example: "We will look into the report today." };
    const second = { ...valid(), text: "Look Into", example: "We will look into the report today." };
    expect(() => loadStarterSet([first, second])).toThrow(/duplicated expression/);
  });

  it("rejects two entries with the same stem", () => {
    const first = { ...valid(), text: "decide", example: "We decide together." };
    const second = { ...valid(), text: "deciding", level: "B1", example: "Deciding takes time." };
    expect(() => loadStarterSet([first, second])).toThrow(/shares its stem/);
  });

  it("rejects an unknown band, level or tag", () => {
    expect(() => loadStarterSet([{ ...valid(), band: "frequent" }])).toThrow(StarterSetError);
    expect(() => loadStarterSet([{ ...valid(), level: "A1" }])).toThrow(StarterSetError);
    expect(() => loadStarterSet([{ ...valid(), tags: ["sports"] }])).toThrow(StarterSetError);
  });

  it("rejects non-ASCII definitions and an empty tag list", () => {
    expect(() => loadStarterSet([{ ...valid(), definition: "\u0432\u044b\u0431\u0440\u0430\u0442\u044c \u0432\u0430\u0440\u0438\u0430\u043d\u0442" }])).toThrow(StarterSetError);
    expect(() => loadStarterSet([{ ...valid(), tags: [] }])).toThrow(StarterSetError);
  });
});

describe("exampleContains", () => {
  it("matches inflected forms of a single word", () => {
    expect(exampleContains("She suggested a new plan.", "suggest")).toBe(true);
    expect(exampleContains("We were planning the trip.", "plan")).toBe(true);
    expect(exampleContains("He bought a new laptop.", "buy")).toBe(true);
    expect(exampleContains("They carried the boxes upstairs.", "carry")).toBe(true);
    expect(exampleContains("She justified her choice clearly.", "justify")).toBe(true);
    expect(exampleContains("They study every evening.", "studies")).toBe(false);
  });

  it("matches an expression word by word in an inflected form", () => {
    expect(exampleContains("We made a decision quickly.", "make a decision")).toBe(true);
    expect(exampleContains("I am looking forward to the trip.", "look forward to")).toBe(true);
    expect(exampleContains("A decision was made quickly.", "make a decision")).toBe(false);
  });

  it("does not match a substring inside another word", () => {
    expect(exampleContains("The art fair is open.", "fair")).toBe(true);
    expect(exampleContains("The artfulness of the plan is clear.", "art")).toBe(false);
  });
});

describe("normalizeEntryText", () => {
  it("lower-cases and collapses whitespace", () => {
    expect(normalizeEntryText("  Keep   In Mind ")).toBe("keep in mind");
  });
});
