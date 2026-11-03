import { describe, expect, it } from "vitest";
import { diffHunks, tokenize, type Hunk } from "@/server/proofread/diff";

// Applies hunks one by one in the given order. Each hunk's offsets refer to
// the original, so earlier replacements shift later ranges by their length change.
export function applyInOrder(text: string, hunks: Hunk[], order: number[]): string {
  const applied: Hunk[] = [];
  let current = text;
  for (const index of order) {
    const hunk = hunks[index];
    const shift = applied
      .filter((other) => other.end <= hunk.start)
      .reduce((total, other) => total + other.replacement.length - (other.end - other.start), 0);
    const start = hunk.start + shift;
    expect(current.slice(start, start + hunk.original.length)).toBe(hunk.original);
    current = current.slice(0, start) + hunk.replacement + current.slice(start + hunk.original.length);
    applied.push(hunk);
  }
  return current;
}

// A small deterministic generator, so a failure can be reproduced.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const show = (hunks: Hunk[]) => hunks.map((h) => [h.original, h.replacement]);

describe("tokenize", () => {
  it("splits words, numbers, spaces and punctuation, and always joins back", () => {
    expect(tokenize("Don't go, 3.5 km!")).toEqual(["Don't", " ", "go", ",", " ", "3.5", " ", "km", "!"]);
    for (const text of ["", "  a\n b ", "café 😀 mother-in-law", "x‑y 1,000.5", "<\/text>"]) {
      expect(tokenize(text).join("")).toBe(text);
    }
  });
});

describe("diffHunks", () => {
  it("finds no difference in identical text", () => {
    expect(diffHunks("Same text.", "Same text.")).toEqual([]);
  });

  it("reports a replaced word as one hunk with exact offsets", () => {
    const original = "She go to school every days.";
    expect(diffHunks(original, "She goes to school every day.")).toEqual([
      { start: 4, end: 6, original: "go", replacement: "goes" },
      { start: 23, end: 27, original: "days", replacement: "day" },
    ]);
  });

  it("keeps UTF-16 offsets right after an emoji", () => {
    const original = "😀 she go home";
    const [hunk] = diffHunks(original, "😀 she goes home");
    expect(original.slice(hunk.start, hunk.end)).toBe("go");
  });

  it("shows a missing word together with its neighbour, never as an empty original", () => {
    expect(show(diffHunks("I saw dog.", "I saw a dog."))).toEqual([["dog", "a dog"]]);
    expect(show(diffHunks("dog is cute", "A dog is cute"))).toEqual([["dog", "A dog"]]);
    expect(show(diffHunks("Walk quickly", "Walk quickly now"))).toEqual([["quickly", "quickly now"]]);
  });

  it("attaches a missing or extra comma to the word before it", () => {
    expect(show(diffHunks("Hello world", "Hello, world"))).toEqual([["Hello", "Hello,"]]);
    expect(show(diffHunks("Hello, world", "Hello world"))).toEqual([["Hello,", "Hello"]]);
  });

  it("deletes a word without leaving a hunk edge on whitespace", () => {
    expect(show(diffHunks("It is very very good", "It is very good"))).toEqual([["very good", "good"]]);
  });

  it("merges changes with at most one word between them, and no more", () => {
    // Adjacent: both depend on each other.
    expect(show(diffHunks("He don't likes it.", "He doesn't like it."))).toEqual([["don't likes", "doesn't like"]]);
    expect(show(diffHunks("I has a apple.", "I have an apple."))).toEqual([["has a", "have an"]]);
    // One word between.
    expect(show(diffHunks("Yesterday I go to shop", "Yesterday I went to the shop"))).toEqual([
      ["go to", "went to the"],
    ]);
    // Two words between: separate suggestions.
    expect(show(diffHunks("She go to the school every days", "She goes to the school every day"))).toEqual([
      ["go", "goes"],
      ["days", "day"],
    ]);
  });

  it("never starts or ends a hunk with whitespace, or leaves a side empty", () => {
    const pairs: [string, string][] = [
      ["a  b", "a b"],
      ["Wait,what", "Wait, what"],
      ["I like it .", "I like it."],
      ["go home", "go to home"],
      ["very big dog", "dog"],
      ["x", "x y z"],
    ];
    for (const [original, corrected] of pairs) {
      const hunks = diffHunks(original, corrected);
      expect(hunks.length, original).toBeGreaterThan(0);
      for (const h of hunks) {
        expect(h.original, original).not.toBe("");
        expect(h.replacement, original).not.toBe("");
        expect(h.original, original).toBe(h.original.trim());
        expect(h.replacement, original).toBe(h.replacement.trim());
      }
    }
  });

  it("falls back to one hunk for huge unrelated text and still reproduces the correction", () => {
    const original = Array.from({ length: 1500 }, (_, i) => `a${i}`).join(" ");
    const corrected = Array.from({ length: 1500 }, (_, i) => `b${i}`).join(" ");
    const hunks = diffHunks(original, corrected);
    expect(hunks).toHaveLength(1);
    expect(applyInOrder(original, hunks, [0])).toBe(corrected);
  });

  it("reproduces the corrected sentence when every hunk is applied in any order", () => {
    const rand = random(20261102);
    const words = ["the", "a", "an", "dog", "dogs", "go", "goes", "went", "to", "school", "house", "is", "are", "not", "very",
      "good", "bad", "I", "She", "he", "don't", "doesn't", "3", "4", "Anna", "café", "😀", ",", ".", "-", "'s"];
    const pick = () => words[Math.floor(rand() * words.length)];
    for (let round = 0; round < 400; round++) {
      const original = Array.from({ length: 1 + Math.floor(rand() * 14) }, pick).join(" ");
      const pieces = original.split(" ");
      for (let k = Math.floor(rand() * 4); k > 0; k--) {
        const at = Math.floor(rand() * (pieces.length + 1));
        const kind = rand();
        if (kind < 0.35) pieces.splice(at, 0, pick());
        else if (kind < 0.7) pieces.splice(at, 1);
        else pieces.splice(at, 1, pick());
      }
      const corrected = pieces.join(" ").replace(/ +/g, rand() < 0.2 ? "  " : " ");
      const hunks = diffHunks(original, corrected);

      let previousEnd = 0;
      for (const h of hunks) {
        expect(h.start, original).toBeGreaterThanOrEqual(previousEnd);
        expect(original.slice(h.start, h.end)).toBe(h.original);
        previousEnd = h.end;
      }
      const order = hunks.map((_, i) => i);
      expect(applyInOrder(original, hunks, order), `${original} -> ${corrected}`).toBe(corrected);
      expect(applyInOrder(original, hunks, [...order].reverse()), original).toBe(corrected);
      const shuffled = [...order].sort(() => rand() - 0.5);
      expect(applyInOrder(original, hunks, shuffled), original).toBe(corrected);
    }
  });
});
