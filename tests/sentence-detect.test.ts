import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETECT_PAUSE_MS,
  FLAG_THRESHOLD,
  SentenceDetector,
  bindToLearner,
  detectableSentences,
  flagCategories,
  locateSentence,
  makeBatches,
  nextPrefetch,
  offsetSuggestions,
  relativeRanges,
  sentenceTextsIn,
  type DetectBatchItem,
  type DetectInput,
  type DetectOutcome,
  type DetectScores,
  type DetectSentences,
} from "@/features/editor/sentence-detect";
import { createDoc, editorReducer, reportApplied, NO_APPLIED } from "@/features/editor/editor-reducer";
import { hashText, splitSentences } from "@/lib/text";
import type { Suggestion } from "@/shared/contracts";

// WebCrypto finishes on a later macrotask, which fake timers cannot advance; this
// resolves as a microtask and gives the same SHA-256.
const hash = async (text: string) => createHash("sha256").update(text).digest("hex");

const CLEAN: DetectScores = { correction: 0, clarity: 0, word_choice: 0 };

// Answers every sentence with the scores chosen by `scoresFor`, and records the batches.
function fakeDetect(scoresFor: (text: string) => DetectScores = () => CLEAN) {
  const calls: DetectBatchItem[][] = [];
  const detect: DetectSentences = vi.fn(async (batch: DetectBatchItem[]): Promise<DetectOutcome> => {
    calls.push(batch);
    return { ok: true, results: batch.map((item) => ({ hash: item.hash, scores: scoresFor(item.text) })) };
  });
  return { detect, calls };
}

function input(text: string, extra: Partial<DetectInput> = {}): () => DetectInput {
  return () => ({ text, localRanges: [], holdRanges: [], ...extra });
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("which sentences are sent", () => {
  it("keeps short sentences and sentences without end punctuation", () => {
    const text = "I went to the store yesterday. She go. Hello there. Dear Ms Carter,\n\nWe are still typing this one";
    expect(detectableSentences(text).map((s) => s.text)).toEqual([
      "I went to the store yesterday.",
      "She go.",
      "Hello there.",
      "Dear Ms Carter,",
      "We are still typing this one",
    ]);
    expect(detectableSentences("Hello")).toHaveLength(1);
  });

  it("skips only text that has no letter or digit in it", () => {
    expect(detectableSentences("... \n\n-- !")).toEqual([]);
    expect(detectableSentences("Room 5").map((s) => s.text)).toEqual(["Room 5"]);
  });

  it("accepts sentences that end in quotes or brackets after the full stop", () => {
    const text = 'She said "we should leave now." He agreed (reluctantly.)';
    expect(detectableSentences(text)).toHaveLength(2);
  });

  it("maps local ranges into the sentence and clips what sticks out", () => {
    const text = "First one is here. I has a book.";
    const sentence = splitSentences(text)[1];
    expect(relativeRanges(sentence, [{ start: 21, end: 24 }, { start: 0, end: 5 }, { start: 29, end: 40 }])).toEqual([
      { start: 2, end: 5 },
      { start: 10, end: 13 },
    ]);
  });

  it("builds batches of at most 8 sentences and 6,000 characters", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ hash: String(i).padStart(64, "0"), text: "x".repeat(10) }));
    expect(makeBatches(items).map((batch) => batch.length)).toEqual([8, 2]);
    const long = Array.from({ length: 3 }, (_, i) => ({ hash: String(i).padStart(64, "0"), text: "y".repeat(2500) }));
    expect(makeBatches(long).map((batch) => batch.length)).toEqual([2, 1]);
  });
});

describe("typing pause", () => {
  it("sends nothing before the pause and one request after it", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day. She like apples very much."));

    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS - 1);
    expect(detect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(calls[0].map((item) => item.text)).toEqual(["I go to school every day.", "She like apples very much."]);
    for (const item of calls[0]) expect(item.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("identifies a sentence by the SHA-256 the server recomputes", async () => {
    // The default hash is the application's own WebCrypto helper.
    vi.useRealTimers();
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, pauseMs: 5 });
    detector.schedule(input("I go to school every day."));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0][0].hash).toBe(await hash("I go to school every day."));
    expect(calls[0][0].hash).toBe(await hashText("I go to school every day."));
  });

  it("restarts the pause while the learner keeps typing", async () => {
    const { detect } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(500);
    detector.schedule(input("I go to school every day. She like apples."));
    await vi.advanceTimersByTimeAsync(500);
    expect(detect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("reads the text when the pause ends, not when it started", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    let text = "I go to school every day.";
    detector.schedule(() => ({ text, localRanges: [], holdRanges: [] }));
    text = "I go to school each day.";
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[0].map((item) => item.text)).toEqual(["I go to school each day."]);
  });

  it("passes the Stage 0 ranges relative to each sentence", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    const text = "First sentence is fine here. I has a book at home.";
    detector.schedule(input(text, { localRanges: [{ start: 31, end: 34 }] }));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[0][0].localRanges).toBeUndefined();
    expect(calls[0][1].localRanges).toEqual([{ start: 2, end: 5 }]);
  });
});

describe("hash cache: changed sentences only", () => {
  it("does not ask again about sentences it already knows", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day. She like apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);

    // Nothing changed: no request at all.
    detector.schedule(input("I go to school every day. She like apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);

    // One sentence edited: only that one is sent.
    detector.schedule(input("I go to school every day. She likes apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(2);
    expect(calls[1].map((item) => item.text)).toEqual(["She likes apples very much."]);
  });

  it("recognises a sentence that moved or came back", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day. She like apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);

    detector.schedule(input("She like apples very much. I go to school every day. We eat lunch at noon."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[1].map((item) => item.text)).toEqual(["We eat lunch at noon."]);
  });

  it("does not resend a sentence whose request is still running", async () => {
    let release: (outcome: DetectOutcome) => void = () => {};
    const detect = vi.fn(
      () =>
        new Promise<DetectOutcome>((resolve) => {
          release = resolve;
        }),
    ) as unknown as DetectSentences;
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detector.getStatus()).toBe("scanning");

    detector.schedule(input("I go to school every day. She like apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detect).toHaveBeenCalledTimes(1);

    release({ ok: true, results: [{ hash: await hashText("I go to school every day."), scores: CLEAN }] });
    await settle();
    await settle();
    // The second sentence follows once the first request is done.
    expect(detect).toHaveBeenCalledTimes(2);
    expect((detect as unknown as { mock: { calls: DetectBatchItem[][][] } }).mock.calls[1][0].map((i) => i.text)).toEqual([
      "She like apples very much.",
    ]);
  });

  it("re-checks only the fixed sentence at once with flush, without a pause", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day. She like apples very much."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);

    detector.flush(input("I go to school every day. She likes apples very much."));
    await settle();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1].map((item) => item.text)).toEqual(["She likes apples very much."]);
  });

  it("skips sentences held back by pending cloud suggestions", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    const text = "I go to school every day. She like apples very much.";
    detector.schedule(input(text, { holdRanges: [{ start: 30, end: 34 }] }));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[0].map((item) => item.text)).toEqual(["I go to school every day."]);
  });

  it("sends a short complete sentence and a last sentence without punctuation after a pause", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });

    detector.schedule(input("She go."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls.map((batch) => batch.map((item) => item.text))).toEqual([["She go."]]);

    detector.schedule(input("She go. Yesterday I go to the store and buy some milk"));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[1].map((item) => item.text)).toEqual(["Yesterday I go to the store and buy some milk"]);

    // Typing on changes the sentence, so it is asked about again; the finished one is not.
    detector.schedule(input("She go. Yesterday I go to the store and buy some milk."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[2].map((item) => item.text)).toEqual(["Yesterday I go to the store and buy some milk."]);
    expect(calls).toHaveLength(3);
  });

  it("sends long texts as sequential batches of 8", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} is short.`).join(" ");
    detector.schedule(input(text));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    await settle();
    expect(calls.map((batch) => batch.length)).toEqual([8, 2]);
  });

  it("does not hammer a sentence that failed, but asks again after a rate limit", async () => {
    const failing = vi.fn(async (): Promise<DetectOutcome> => ({ ok: false, reason: "failed" }));
    const detector = new SentenceDetector({ detect: failing, hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(failing).toHaveBeenCalledTimes(1);

    const busy = vi.fn(async (): Promise<DetectOutcome> => ({ ok: false, reason: "busy" }));
    const patient = new SentenceDetector({ detect: busy, hash });
    patient.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    patient.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("stops for the session when the quota is used up or AI is off", async () => {
    for (const reason of ["quota", "unavailable"] as const) {
      const detect = vi.fn(async (): Promise<DetectOutcome> => ({ ok: false, reason }));
      const detector = new SentenceDetector({ detect, hash });
      detector.schedule(input("I go to school every day."));
      await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
      expect(detector.getStatus()).toBe(reason);
      detector.schedule(input("I go to school every day. She like apples very much."));
      await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
      expect(detect).toHaveBeenCalledTimes(1);
    }
  });

  it("stays quiet when hashing is not available", async () => {
    const { detect } = fakeDetect();
    const detector = new SentenceDetector({
      detect,
      hash: async () => {
        throw new Error("no subtle crypto");
      },
    });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detect).not.toHaveBeenCalled();
    expect(detector.getStatus()).toBe("idle");
  });
});

describe("an applied fix", () => {
  const sentence = "Yesterday I go to the store and buy some milk.";
  const other = "The weather is nice today.";
  const text = `${sentence} ${other}`;

  function suggestion(source: string, fragment: string, replacement: string, from = text): Suggestion {
    const start = from.indexOf(fragment);
    return {
      id: `fix-${fragment}`,
      source: "ai",
      category: "error",
      start,
      end: start + fragment.length,
      original: fragment,
      replacement,
      reason: source,
      meaningChange: false,
      meaning: null,
    };
  }

  // What EditorScreen does when the learner presses Apply: reduce, then pass the
  // changed sentences and the suggestions that are still waiting to the detector.
  function applyFirstFix(detector: SentenceDetector) {
    const doc = createDoc(text, [suggestion("tense", "go", "went"), suggestion("tense", "buy", "bought")]);
    const next = editorReducer(doc, { type: "apply", id: "fix-go" });
    reportApplied(NO_APPLIED, next.applied, (ranges, newText) => {
      detector.flush(
        () => ({
          text: newText,
          localRanges: [],
          holdRanges: next.suggestions.filter((s) => s.source === "ai").map(({ start, end }) => ({ start, end })),
        }),
        sentenceTextsIn(newText, ranges),
      );
    });
    return next;
  }

  it("re-checks the changed sentence at the first Apply although another fix is still waiting in it", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input(text));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);

    const next = applyFirstFix(detector);
    expect(next.suggestions).toHaveLength(1);
    await settle();
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[1].map((item) => item.text)).toEqual(["Yesterday I went to the store and buy some milk."]);
  });

  it("keeps other held sentences out when it forces one, and needs no pause", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    // The second sentence is held by its own pending suggestion and was never asked about.
    const held = [{ start: text.indexOf("weather"), end: text.indexOf("weather") + 7 }];
    detector.schedule(input(text, { holdRanges: held }));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls[0].map((item) => item.text)).toEqual([sentence]);

    detector.flush(input(text.replace("go", "went"), { holdRanges: held }), [sentence.replace("go", "went")]);
    await settle();
    await settle();
    expect(calls[1].map((item) => item.text)).toEqual([sentence.replace("go", "went")]);
  });

  it("forces a held sentence only once", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    const held = [{ start: 0, end: 9 }];
    detector.flush(input(sentence, { holdRanges: held }), [sentence]);
    await settle();
    await settle();
    expect(calls).toHaveLength(1);

    // Later, with the same suggestion still pending, an edit of that sentence is not forced.
    const edited = sentence.replace("milk", "bread");
    detector.schedule(input(edited, { holdRanges: held }));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);
  });

  it("maps applied ranges to the sentence texts", () => {
    const next = "Yesterday I went to the store. The weather is nice today.";
    expect(sentenceTextsIn(next, [{ start: 0, end: 30 }])).toEqual(["Yesterday I went to the store."]);
    expect(sentenceTextsIn(next, [{ start: 5, end: 5 }])).toEqual([]);
  });
});

describe("queue ends with its owner", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `This is private sentence number ${i}.`).join(" ");

  // Holds the first request open so the second batch is still queued.
  function heldFirstBatch() {
    const sent: DetectBatchItem[][] = [];
    let release: (outcome: DetectOutcome) => void = () => {};
    const detect: DetectSentences = vi.fn((batch: DetectBatchItem[]) => {
      sent.push(batch);
      if (sent.length > 1) return Promise.resolve<DetectOutcome>({ ok: true, results: batch.map((item) => ({ hash: item.hash, scores: CLEAN })) });
      return new Promise<DetectOutcome>((resolve) => {
        release = resolve;
      });
    });
    return {
      detect,
      sent,
      answerFirst: () => release({ ok: true, results: sent[0].map((item) => ({ hash: item.hash, scores: CLEAN })) }),
    };
  }

  it("sends no queued batch after stop", async () => {
    const { detect, sent, answerFirst } = heldFirstBatch();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input(nine));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(sent.map((batch) => batch.length)).toEqual([8]);

    detector.stop();
    answerFirst();
    await settle();
    await settle();
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS * 2);
    expect(sent).toHaveLength(1);
  });

  it("drops a pause that has not fired yet and a pending flush after stop", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day."));
    detector.stop();
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS * 2);
    expect(calls).toHaveLength(0);
  });

  it("can be used again after stop (a remount keeps the same detector)", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect, hash });
    detector.stop();
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);
  });

  it("sends the next batch under another account never: the learner is checked before every request", async () => {
    const { detect, sent, answerFirst } = heldFirstBatch();
    let signedIn: string | null = "learner-a";
    const detector = new SentenceDetector({ detect: bindToLearner(detect, "learner-a", () => signedIn), hash });
    detector.schedule(input(nine));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(8);

    // The account changes while the second batch is still queued.
    signedIn = "learner-b";
    answerFirst();
    await settle();
    await settle();
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS * 2);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(sent.flat().some((item) => item.text.endsWith("number 8."))).toBe(false);

    // Nothing was spent for the refused batch, and it is not remembered as failed.
    expect(detector.knownCount()).toBe(8);
    expect(detector.getStatus()).toBe("idle");
  });

  it("refuses to send before any session is known", async () => {
    const detect = vi.fn(async (): Promise<DetectOutcome> => ({ ok: true, results: [] }));
    const detector = new SentenceDetector({ detect: bindToLearner(detect, null, () => "learner-a"), hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detect).not.toHaveBeenCalled();
  });

  it("passes requests through for the learner who wrote the text", async () => {
    const { detect, calls } = fakeDetect();
    const detector = new SentenceDetector({ detect: bindToLearner(detect, "learner-a", () => "learner-a"), hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(calls).toHaveLength(1);
  });
});

describe("badges", () => {
  const text = "I go to school every day. She like apples very much. The weather is nice today.";

  it("maps probabilities at or above the threshold to badges, in a fixed order", () => {
    expect(flagCategories({ correction: FLAG_THRESHOLD, clarity: 0.49, word_choice: 0.9 })).toEqual(["correction", "word_choice"]);
    expect(flagCategories({ correction: 0.1, clarity: 0.6, word_choice: 0.2 })).toEqual(["clarity"]);
    expect(flagCategories(CLEAN)).toEqual([]);
  });

  it("flags only sentences the detector scored, with their position in the text", async () => {
    const { detect } = fakeDetect((sentence) =>
      sentence.startsWith("She") ? { correction: 0.9, clarity: 0.2, word_choice: 0.7 } : sentence.startsWith("I go") ? { correction: 0.1, clarity: 0.8, word_choice: 0 } : CLEAN,
    );
    const detector = new SentenceDetector({ detect, hash });
    expect(detector.flagsFor(text)).toEqual([]);

    detector.schedule(input(text));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);

    const flags = detector.flagsFor(text);
    expect(flags.map((flag) => [flag.text, flag.categories])).toEqual([
      ["I go to school every day.", ["clarity"]],
      ["She like apples very much.", ["correction", "word_choice"]],
    ]);
    expect(flags[1]).toMatchObject({ start: text.indexOf("She"), end: text.indexOf("She") + "She like apples very much.".length });
    expect(flags[1].id).toBe(await hashText("She like apples very much."));
  });

  it("keeps the other badges when one sentence is edited, and drops the edited one until it is re-checked", async () => {
    const { detect } = fakeDetect((sentence) => (sentence.includes("like") || sentence.includes("go") ? { ...CLEAN, correction: 0.9 } : CLEAN));
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input(text));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detector.flagsFor(text)).toHaveLength(2);

    const edited = text.replace("She like apples", "She likes apples");
    const flags = detector.flagsFor(edited);
    expect(flags.map((flag) => flag.text)).toEqual(["I go to school every day."]);
    // The offsets belong to the edited text.
    expect(flags[0].start).toBe(0);
  });

  it("hides a handled sentence until its text changes", async () => {
    const { detect } = fakeDetect(() => ({ ...CLEAN, correction: 0.9 }));
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    const [flag] = detector.flagsFor("I go to school every day.");

    const seen = vi.fn();
    detector.subscribe(seen);
    detector.markHandled(flag.id);
    expect(seen).toHaveBeenCalled();
    expect(detector.flagsFor("I go to school every day.")).toEqual([]);
    expect(detector.flagsFor("I went to school every day.")).toEqual([]);
  });

  it("does not badge a sentence that still has pending cloud suggestions", async () => {
    const { detect } = fakeDetect(() => ({ ...CLEAN, correction: 0.9 }));
    const detector = new SentenceDetector({ detect, hash });
    detector.schedule(input("I go to school every day."));
    await vi.advanceTimersByTimeAsync(DETECT_PAUSE_MS);
    expect(detector.flagsFor("I go to school every day.", [{ start: 2, end: 4 }])).toEqual([]);
  });
});

describe("placing generator output", () => {
  it("finds the sentence even after text was added before it", () => {
    const text = "Intro goes here today. I go to school every day.";
    expect(locateSentence(text, "I go to school every day.", 0)).toMatchObject({ start: 23, end: 48 });
    expect(locateSentence(text, "I go to school each day.", 0)).toBeNull();
  });

  it("picks the occurrence closest to where the sentence was", () => {
    const text = "We like it here. We like it here.";
    expect(locateSentence(text, "We like it here.", 17)?.start).toBe(17);
    expect(locateSentence(text, "We like it here.", 1)?.start).toBe(0);
  });

  it("moves sentence-relative ranges into the document", () => {
    expect(offsetSuggestions([{ start: 2, end: 4, id: "a" }], 23)).toEqual([{ start: 25, end: 27, id: "a" }]);
  });
});

describe("prefetch", () => {
  const flag = (id: string, correction: number) => ({
    id,
    start: 0,
    end: 10,
    text: "x",
    categories: ["correction" as const],
    scores: { correction, clarity: 0, word_choice: 0 },
  });

  it("picks only sentences the detector is almost sure about, once, and one at a time", () => {
    const flags = [flag("low", 0.7), flag("a", 0.95), flag("b", 0.91)];
    expect(nextPrefetch(flags, new Set(), {})?.id).toBe("a");
    expect(nextPrefetch(flags, new Set(["a"]), {})?.id).toBe("b");
    expect(nextPrefetch(flags, new Set(["a", "b"]), {})).toBeNull();
    expect(nextPrefetch(flags, new Set(), { a: "analyzing" })).toBeNull();
    expect(nextPrefetch(flags, new Set(), { a: "failed" })?.id).toBe("b");
  });
});
