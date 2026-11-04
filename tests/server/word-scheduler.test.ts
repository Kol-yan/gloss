import { describe, expect, it } from "vitest";
import {
  dailyLearnAllowance,
  isBrandNew,
  pickWords,
  priorityScore,
  reasonFor,
  slotFor,
} from "@/server/learning/priority/scheduler";
import type { StoredWord } from "@/server/learning/priority/types";

const NOW = new Date("2026-11-04T09:00:00.000Z");

function word(overrides: Partial<StoredWord> & { expressionId: string }): StoredWord {
  return {
    learnerId: "learner",
    text: overrides.expressionId,
    normalized: overrides.expressionId,
    source: "saved",
    status: "learning",
    band: "common",
    rung: 1,
    productiveAnswers: 0,
    realUseCount: 0,
    realUseDocuments: 0,
    realUseDays: 0,
    realUseLastAt: null,
    wordCheckAnswer: null,
    consecutiveErrors: 0,
    answers: 0,
    correctAnswers: 0,
    deepKnown: 0,
    bland: 0,
    lastPracticedAt: null,
    nextAt: null,
    introducedOn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function fresh(id: string, overrides: Partial<StoredWord> = {}): StoredWord {
  return word({ expressionId: id, source: "starter", answers: 0, ...overrides });
}

// A starter word first shown today.
function newToday(id: string, overrides: Partial<StoredWord> = {}): StoredWord {
  return fresh(id, { createdAt: NOW.toISOString(), introducedOn: NOW.toISOString().slice(0, 10), ...overrides });
}

describe("slot mix", () => {
  it("fills a session of 8 as 3 activate, 3 learn and 2 keep", () => {
    const words = [
      ...["r1", "r2", "r3", "r4", "r5"].map((id) => word({ expressionId: id, status: "ready", rung: 2 })),
      // Three learning words started in earlier sessions: they fill the
      // learn seats, so the day's brand-new words wait for another day.
      ...["s1", "s2", "s3"].map((id) => word({ expressionId: id, status: "learning", answers: 1 })),
      ...["n1", "n2", "n3"].map((id) => newToday(id)),
      ...["k1", "k2", "k3", "k4"].map((id) =>
        word({ expressionId: id, status: "active", rung: 4, productiveAnswers: 3, realUseCount: 2 }),
      ),
    ];
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    const counts = { activate: 0, learn: 0, keep: 0 };
    for (const item of picked) counts[item.slot] += 1;
    expect(picked).toHaveLength(8);
    expect(counts).toEqual({ activate: 3, learn: 3, keep: 2 });
    // Started reviews fill the learn seats; no new word starts when the
    // learner already has started work waiting.
    const learn = picked.filter((item) => item.slot === "learn");
    expect(learn).toHaveLength(3);
    expect(learn.map((item) => item.expressionId)).toContain("s1");
    expect(learn.map((item) => item.expressionId)).toContain("s2");
  });

  it("fills a learn seat from started learning words when the day's places are used", () => {
    const words = [
      ...["r1", "r2", "r3"].map((id) => word({ expressionId: id, status: "ready", rung: 2 })),
      ...["s1", "s2"].map((id) => word({ expressionId: id, status: "learning", answers: 2 })),
      word({ expressionId: "n1", source: "starter" }),
    ];
    const picked = pickWords({ words, brandNewToday: 3, accuracy: null, now: NOW });
    const learn = picked.filter((item) => item.slot === "learn");
    expect(learn).toHaveLength(2);
    expect(learn.map((item) => item.expressionId)).toContain("s1");
    expect(learn.map((item) => item.expressionId)).toContain("s2");
    expect(picked.map((item) => item.expressionId)).not.toContain("n1");
  });

  it("puts three words on the edge first", () => {
    const words = [
      ...["r1", "r2", "r3"].map((id) => word({ expressionId: id, status: "ready", rung: 2, band: "rare" })),
      ...["c1", "c2", "c3"].map((id) => word({ expressionId: id, status: "learning", band: "core", nextAt: "2026-01-01T00:00:00.000Z" })),
    ];
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    expect(picked.slice(0, 3).map((item) => item.expressionId).sort()).toEqual(["r1", "r2", "r3"]);
    expect(picked.every((item) => item.slot === "activate" || item.expressionId === "c1" || item.expressionId === "c2" || item.expressionId === "c3")).toBe(true);
  });

  const brandNew = (id: string) => newToday(id, { normalized: `${id}-new` });
  const countNew = (picked: { expressionId: string }[]) =>
    picked.filter((item) => item.expressionId.startsWith("n")).length;

  it("starts three brand-new words a day and no more, even on a thin day", () => {
    // Brand-new words are not started for the activation seats: those exist to
    // push known-but-unused words to active use. The day's three places are
    // for the learn seats.
    const words = ["r1", "r2", "r3"].map((id) => word({ expressionId: id, status: "ready", rung: 2 }));
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    expect(countNew(picked)).toBe(0);
    expect(picked).toHaveLength(3);
  });

  it("counts the words already started today", () => {
    // Two places are used in the database; the candidates are the three that
    // were offered and not yet answered.
    const words = ["n1", "n2", "n3"].map(brandNew);
    const picked = pickWords({ words, brandNewToday: 2, accuracy: null, now: NOW });
    expect(countNew(picked)).toBe(1);
  });

  it("does not count a seeded word from an earlier day", () => {
    const words = ["n1", "n2", "n3"].map((id) => fresh(id, { createdAt: "2026-10-30T00:00:00.000Z" }));
    expect(countNew(pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW }))).toBe(3);
  });

  it("holds new words back to one when reviews pile up", () => {
    const words = [
      ...Array.from({ length: 8 }, (_, index) =>
        word({ expressionId: `d${index}`, status: "learning", answers: 2 }),
      ),
      ...["n1", "n2", "n3"].map(brandNew),
    ];
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    expect(countNew(picked)).toBe(1);
  });

  it("holds new words back to one when answers go badly", () => {
    const words = ["n1", "n2", "n3"].map(brandNew);
    const picked = pickWords({ words, brandNewToday: 0, accuracy: 0.2, now: NOW });
    expect(countNew(picked)).toBe(1);
  });

  it("takes no new words when the day's places are used", () => {
    const words = ["n1", "n2"].map(brandNew);
    expect(pickWords({ words, brandNewToday: 3, accuracy: null, now: NOW })).toHaveLength(0);
  });

  it("keeps active words out until their check is due", () => {
    const words = [
      word({ expressionId: "k1", status: "active", rung: 4, productiveAnswers: 3, nextAt: "2026-12-01T00:00:00.000Z" }),
      word({ expressionId: "k2", status: "active", rung: 4, productiveAnswers: 3, nextAt: "2026-11-01T00:00:00.000Z" }),
    ];
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    expect(picked.map((item) => item.expressionId)).toEqual(["k2"]);
  });

  it("never includes hidden words", () => {
    const words = [word({ expressionId: "h1", status: "hidden" }), word({ expressionId: "r1", status: "ready", rung: 2 })];
    const picked = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    expect(picked.map((item) => item.expressionId)).toEqual(["r1"]);
  });

  it("is deterministic for the same input", () => {
    const words = ["a", "b", "c", "d"].map((id) => word({ expressionId: id, status: "ready", rung: 2 }));
    const first = pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW });
    const second = pickWords({ words: [...words].reverse(), brandNewToday: 0, accuracy: null, now: NOW });
    expect(first).toEqual(second);
  });

  it("supports a smaller session for a short day", () => {
    const words = ["r1", "r2", "r3", "n1", "n2", "n3", "k1", "k2"].map((id) =>
      id.startsWith("r")
        ? word({ expressionId: id, status: "ready", rung: 2 })
        : id.startsWith("n")
          ? fresh(id)
          : word({ expressionId: id, status: "active", rung: 4, productiveAnswers: 3 }),
    );
    expect(pickWords({ words, brandNewToday: 0, accuracy: null, now: NOW, size: 5 })).toHaveLength(5);
  });
});

describe("daily allowance", () => {
  it("is three on a calm day, one on a busy or weak day", () => {
    expect(dailyLearnAllowance({ brandNewToday: 0, reviewBacklog: 0, accuracy: null })).toBe(3);
    expect(dailyLearnAllowance({ brandNewToday: 0, reviewBacklog: 6, accuracy: null })).toBe(1);
    expect(dailyLearnAllowance({ brandNewToday: 0, reviewBacklog: 0, accuracy: 0.4 })).toBe(1);
    expect(dailyLearnAllowance({ brandNewToday: 2, reviewBacklog: 0, accuracy: 0.9 })).toBe(1);
    expect(dailyLearnAllowance({ brandNewToday: 3, reviewBacklog: 0, accuracy: 0.9 })).toBe(0);
  });
});

describe("priority", () => {
  const ctx = { now: NOW, brandNewToday: 0, reviewBacklog: 0, accuracy: null };

  it("ranks frequent words above rare ones in the same state", () => {
    const core = priorityScore(word({ expressionId: "a", band: "core" }), ctx);
    const rare = priorityScore(word({ expressionId: "b", band: "rare" }), ctx);
    expect(core).toBeGreaterThan(rare);
  });

  it("values what the learner did over a generic starter word", () => {
    const saved = priorityScore(word({ expressionId: "a", source: "saved" }), ctx);
    const starter = priorityScore(word({ expressionId: "b", source: "starter" }), ctx);
    expect(saved).toBeGreaterThan(starter);
  });

  it("puts edge words first even when they are rare", () => {
    const edge = priorityScore(word({ expressionId: "a", status: "ready", band: "rare" }), ctx);
    const core = priorityScore(word({ expressionId: "b", band: "core" }), ctx);
    expect(edge).toBeGreaterThan(core);
  });

  it("values words that came back after an error and half-known answers", () => {
    const plain = priorityScore(word({ expressionId: "a" }), ctx);
    const error = priorityScore(word({ expressionId: "a", consecutiveErrors: 1 }), ctx);
    const half = priorityScore(word({ expressionId: "a", deepKnown: 1 }), ctx);
    expect(error).toBeGreaterThan(plain);
    expect(half).toBeGreaterThan(plain);
  });

  it("ranks a word that is already well used lower", () => {
    const fresh1 = priorityScore(word({ expressionId: "a" }), ctx);
    const used = priorityScore(word({ expressionId: "a", productiveAnswers: 2, realUseCount: 2 }), ctx);
    expect(used).toBeLessThan(fresh1);
  });

  it("gives overdue words a lift", () => {
    const due = priorityScore(word({ expressionId: "a", nextAt: "2026-10-30T00:00:00.000Z" }), ctx);
    const notDue = priorityScore(word({ expressionId: "a", nextAt: "2026-11-20T00:00:00.000Z" }), ctx);
    expect(due).toBeGreaterThan(notDue);
  });
});

describe("learner-facing reasons", () => {
  it("are short, English and never show a score", () => {
    const samples = [
      reasonFor(word({ expressionId: "a", status: "ready", band: "common" })),
      reasonFor(word({ expressionId: "a", status: "learning", band: "core" })),
      reasonFor(word({ expressionId: "a", status: "active", band: "rare" })),
      reasonFor(word({ expressionId: "a", status: "hidden" })),
    ];
    for (const text of samples) {
      expect(text.length).toBeLessThanOrEqual(60);
      expect(text).toMatch(/^[A-Z][a-z]+ word - /);
      expect(text).not.toMatch(/\d/);
    }
    expect(samples[0]).toBe("Common word - you know it but don't use it yet");
  });

  it("says a word was used once and that it slipped after an error", () => {
    expect(reasonFor(word({ expressionId: "a", realUseCount: 1 }))).toContain("you used it once");
    expect(reasonFor(word({ expressionId: "a", consecutiveErrors: 1 }))).toContain("it slipped last time");
  });
});

describe("slot assignment and brand-new words", () => {
  it("maps statuses to slots", () => {
    expect(slotFor(word({ expressionId: "a", status: "ready" }))).toBe("activate");
    expect(slotFor(word({ expressionId: "a", status: "active" }))).toBe("keep");
    expect(slotFor(fresh("a"))).toBe("learn");
    expect(slotFor(word({ expressionId: "a", answers: 1 }))).toBe("learn");
    expect(slotFor(word({ expressionId: "a", source: "starter" }))).toBe("learn");
  });

  it("treats an unanswered Learning word as brand-new, including Word check new answers", () => {
    expect(isBrandNew(fresh("a"))).toBe(true);
    expect(isBrandNew(word({ expressionId: "a" }))).toBe(true);
    // Word check rows are brand-new whatever their source: "new" and "not sure"
    // are first meetings and take one of the day's places.
    expect(isBrandNew(fresh("a", { source: "word_check", wordCheckAnswer: "new" }))).toBe(true);
    expect(isBrandNew(fresh("a", { wordCheckAnswer: "not_sure" }))).toBe(true);
    expect(isBrandNew(fresh("a", { deepKnown: 1 }))).toBe(true);
    expect(isBrandNew(fresh("a", { answers: 1 }))).toBe(false);
    expect(isBrandNew(fresh("a", { productiveAnswers: 1 }))).toBe(false);
    expect(isBrandNew(fresh("a", { realUseCount: 1 }))).toBe(false);
    // A known-but-unused answer is known vocabulary, not a first meeting.
    expect(isBrandNew(word({ expressionId: "a", status: "ready", wordCheckAnswer: "know_unused" }))).toBe(false);
    expect(isBrandNew(fresh("a", { wordCheckAnswer: "know_unused" }))).toBe(false);
    expect(isBrandNew(word({ expressionId: "a", status: "ready" }))).toBe(false);
  });
});
