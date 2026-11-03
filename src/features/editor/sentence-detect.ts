// Stage 1 of the editor: after a typing pause, only the sentences whose text
// changed are sent to the detector. The detector answers with probabilities;
// nothing here creates a suggestion. A sentence is identified by the SHA-256 of
// its normalized text, so editing one sentence never invalidates the others and
// applying a fix re-checks exactly the sentence that changed.
//
// No React in here: the scheduler and the cache are driven by fake timers in tests.
import { hashText, normalizeText, splitSentences, type Sentence } from "@/lib/text";
import {
  MAX_DETECT_LOCAL_RANGES,
  MAX_DETECT_SENTENCES,
  MAX_DETECT_TOTAL_TEXT_LENGTH,
  type DetectSentenceRequest,
} from "@/shared/contracts";
import type { SentenceRange } from "./types";

// The three questions the detector answers, in the order badges are shown.
export type FlagCategory = "correction" | "clarity" | "word_choice";
export const FLAG_CATEGORIES: readonly FlagCategory[] = ["correction", "clarity", "word_choice"];

export const FLAG_LABEL: Record<FlagCategory, string> = {
  correction: "Correction",
  clarity: "Clarity",
  word_choice: "Word choice",
};

export type DetectScores = Record<FlagCategory, number>;

// A probability at or above this shows a badge.
export const FLAG_THRESHOLD = 0.5;
// A needs_correction probability at or above this may start the generator early.
export const PREFETCH_THRESHOLD = 0.9;
// How long the learner must stop typing before changed sentences are sent.
export const DETECT_PAUSE_MS = 800;
const MAX_CACHE_ENTRIES = 500;

export function flagCategories(scores: DetectScores): FlagCategory[] {
  return FLAG_CATEGORIES.filter((category) => scores[category] >= FLAG_THRESHOLD);
}

// A letter or a digit: text without one ("...", "-") is not a sentence.
const HAS_WORD = /[\p{L}\p{N}]/u;

// Sentences worth sending: every sentence the server accepts, whatever its length
// and whether or not it has its end punctuation yet. The cache sends a changed
// sentence once per pause, so a finished and an unfinished sentence cost the same.
export function detectableSentences(text: string): Sentence[] {
  return splitSentences(text).filter(
    (sentence) =>
      HAS_WORD.test(sentence.text) &&
      sentence.text.length <= MAX_DETECT_TOTAL_TEXT_LENGTH &&
      splitSentences(sentence.text).length === 1,
  );
}

function overlaps(a: SentenceRange, b: SentenceRange): boolean {
  return a.start < b.end && b.start < a.end;
}

// Local ranges as the server wants them: relative to the sentence, inside it.
export function relativeRanges(sentence: Sentence, absolute: SentenceRange[]): SentenceRange[] {
  const result: SentenceRange[] = [];
  for (const range of absolute) {
    const start = Math.max(range.start, sentence.start) - sentence.start;
    const end = Math.min(range.end, sentence.end) - sentence.start;
    if (end > start) result.push({ start, end });
    if (result.length >= MAX_DETECT_LOCAL_RANGES) break;
  }
  return result;
}

export type DetectBatchItem = DetectSentenceRequest;

// Splits sentences into requests of at most 8 sentences and 6,000 characters.
export function makeBatches(items: DetectBatchItem[]): DetectBatchItem[][] {
  const batches: DetectBatchItem[][] = [];
  let current: DetectBatchItem[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length >= MAX_DETECT_SENTENCES || size + item.text.length > MAX_DETECT_TOTAL_TEXT_LENGTH) {
      if (current.length > 0) batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type DetectOutcome =
  | { ok: true; results: { hash: string; scores: DetectScores }[]; checksLeft?: number }
  // "busy": refused before any work (rate limit), so the same sentences may be asked again later.
  // "cancelled": the request was withheld because its text no longer belongs to
  // the current session. Nothing was sent; the detector stops its queue.
  | { ok: false; reason: "quota" | "unavailable" | "busy" | "failed" | "cancelled" };

// One request to the detector. Wired to the API by whoever builds the editor.
export type DetectSentences = (sentences: DetectBatchItem[]) => Promise<DetectOutcome>;

// Ties requests to the learner who wrote the text. The request function reads the
// browser's current session when it runs, so a queue that outlives an account
// switch would send one learner's sentences under the next one. Checked right
// before every request, this refuses them.
export function bindToLearner(
  detect: DetectSentences,
  learnerId: string | null,
  currentLearnerId: () => string | null,
): DetectSentences {
  return async (sentences) => {
    if (learnerId === null || currentLearnerId() !== learnerId) return { ok: false, reason: "cancelled" };
    return detect(sentences);
  };
}

export type DetectInput = {
  // Normalized text, exactly as the editor holds it.
  text: string;
  // Stage 0 suggestions in `text`; the detector is told to leave those spans alone.
  localRanges: SentenceRange[];
  // Sentences overlapping these ranges are skipped: cloud suggestions are still
  // pending there, so the suggestion cards already answer the question.
  holdRanges: SentenceRange[];
};

// The sentences of `text` that the given ranges cover, as sentence texts.
export function sentenceTextsIn(text: string, ranges: SentenceRange[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end)).filter((sentence) => sentence !== "");
}

// "scanning" is true only while a request is really in flight.
export type DetectorStatus = "idle" | "scanning" | "quota" | "unavailable";

type Entry = { state: "pending" } | { state: "ready"; scores: DetectScores } | { state: "failed" };

export type SentenceFlag = {
  // The sentence's hash: stable while its text is unchanged.
  id: string;
  start: number;
  end: number;
  text: string;
  categories: FlagCategory[];
  scores: DetectScores;
};

export type DetectorOptions = {
  // Can be replaced later with setDetect; without one, requests report "unavailable".
  detect?: DetectSentences;
  pauseMs?: number;
  // Replaceable so tests need no WebCrypto.
  hash?: (text: string) => Promise<string>;
};

export class SentenceDetector {
  private detect: DetectSentences;
  private readonly pauseMs: number;
  private readonly hash: (text: string) => Promise<string>;
  private readonly cache = new Map<string, Entry>();
  private readonly hashes = new Map<string, string>();
  private readonly handled = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private again: (() => DetectInput) | null = null;
  // Sentences to check at the next pass even though cloud suggestions are pending in them.
  private readonly forced = new Set<string>();
  // Bumped by every schedule/flush/stop so a running pass notices newer text.
  private generation = 0;
  private status: DetectorStatus = "idle";
  private inFlight = 0;
  private version = 0;
  // Set when the browser cannot hash (insecure origin): detection stays off.
  private unsupported = false;

  constructor(options: DetectorOptions) {
    this.detect = options.detect ?? (async () => ({ ok: false, reason: "unavailable" }));
    this.pauseMs = options.pauseMs ?? DETECT_PAUSE_MS;
    this.hash = options.hash ?? hashText;
  }

  // The latest request function; an editor re-renders with new callbacks.
  setDetect(detect: DetectSentences | undefined) {
    this.detect = detect ?? (async () => ({ ok: false, reason: "unavailable" }));
  }

  // ---- store interface for useSyncExternalStore ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  getStatus = (): DetectorStatus => this.status;

  private emit() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // ---- scheduling ----

  // Restarts the pause. `read` is called when the pause ends, so it sees the
  // latest text and local suggestions rather than what they were at the keystroke.
  schedule(read: () => DetectInput) {
    this.generation += 1;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run(read);
    }, this.pauseMs);
  }

  // No pause: used right after a fix is applied, when nothing is being typed.
  // `force` lists sentences that are checked even when cloud suggestions are still
  // pending in them: the fix just changed their text, so the old answer is gone.
  flush(read: () => DetectInput, force: readonly string[] = []) {
    for (const sentence of force) this.forced.add(sentence);
    this.generation += 1;
    this.cancel();
    void this.run(read);
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // The owner is going away (page left, learner changed): nothing more is sent.
  // A request already on its way cannot be recalled, but no queued batch follows it
  // and no later pass starts. Safe to call and then use again.
  stop() {
    this.generation += 1;
    this.cancel();
    this.again = null;
    this.forced.clear();
  }

  private async run(read: () => DetectInput) {
    if (this.running) {
      this.again = read;
      return;
    }
    this.running = true;
    try {
      let next: (() => DetectInput) | null = read;
      while (next) {
        this.again = null;
        await this.pass(next());
        next = this.again;
      }
    } finally {
      this.running = false;
    }
  }

  private async pass(input: DetectInput) {
    if (this.unsupported || this.blocked()) return;
    const started = this.generation;
    const forced = new Set(this.forced);
    this.forced.clear();

    const candidates = detectableSentences(input.text).filter(
      (sentence) => forced.has(sentence.text) || !input.holdRanges.some((range) => overlaps(range, sentence)),
    );
    const items: DetectBatchItem[] = [];
    const queued = new Set<string>();
    for (const sentence of candidates) {
      let hash: string;
      try {
        hash = await this.hashOf(sentence.text);
      } catch {
        this.unsupported = true;
        return;
      }
      // Changed sentences only: anything already asked about, or being asked, is skipped.
      if (this.cache.has(hash) || queued.has(hash)) continue;
      queued.add(hash);
      const localRanges = relativeRanges(sentence, input.localRanges);
      items.push({ hash, text: sentence.text, ...(localRanges.length > 0 ? { localRanges } : {}) });
    }

    for (const batch of makeBatches(items)) {
      // The learner kept typing: the next pause sends whatever is still unknown.
      if (this.generation !== started) return;
      await this.send(batch);
      if (this.blocked()) return;
    }
  }

  private async send(batch: DetectBatchItem[]) {
    for (const item of batch) this.cache.set(item.hash, { state: "pending" });
    this.inFlight += 1;
    this.setStatus();

    let outcome: DetectOutcome;
    try {
      outcome = await this.detect(batch);
    } catch {
      outcome = { ok: false, reason: "failed" };
    }
    this.inFlight -= 1;

    if (outcome.ok) {
      const answered = new Map(outcome.results.map((result) => [result.hash, result.scores]));
      for (const item of batch) {
        const scores = answered.get(item.hash);
        this.cache.set(item.hash, scores ? { state: "ready", scores } : { state: "failed" });
      }
      this.trim();
    } else if (outcome.reason === "failed") {
      // A paid call may have happened; it is not repeated for the same sentence.
      for (const item of batch) this.cache.set(item.hash, { state: "failed" });
    } else if (outcome.reason === "busy") {
      for (const item of batch) this.cache.delete(item.hash);
    } else if (outcome.reason === "cancelled") {
      for (const item of batch) this.cache.delete(item.hash);
      this.stop();
    } else {
      for (const item of batch) this.cache.delete(item.hash);
      this.status = outcome.reason;
      this.emit();
      return;
    }
    this.setStatus();
  }

  // Quota or availability ended automatic scanning for this session.
  private blocked(): boolean {
    return this.status === "quota" || this.status === "unavailable";
  }

  private setStatus() {
    if (this.blocked()) return;
    this.status = this.inFlight > 0 ? "scanning" : "idle";
    this.emit();
  }

  private trim() {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    for (const [hash, entry] of this.cache) {
      if (this.cache.size <= MAX_CACHE_ENTRIES) break;
      if (entry.state !== "pending") this.cache.delete(hash);
    }
  }

  private async hashOf(text: string): Promise<string> {
    const known = this.hashes.get(text);
    if (known) return known;
    const hash = await this.hash(normalizeText(text));
    if (this.hashes.size >= MAX_CACHE_ENTRIES * 2) this.hashes.clear();
    this.hashes.set(text, hash);
    return hash;
  }

  // ---- reading ----

  // Marks a sentence as dealt with (reviewed by the generator or dismissed), so
  // its badges stay away until its text changes.
  markHandled(id: string) {
    if (this.handled.has(id)) return;
    this.handled.add(id);
    this.emit();
  }

  // Badges for the sentences of `text`. Synchronous: only sentences whose hash
  // is already known can carry one.
  flagsFor(text: string, holdRanges: SentenceRange[] = []): SentenceFlag[] {
    const flags: SentenceFlag[] = [];
    for (const sentence of splitSentences(text)) {
      const id = this.hashes.get(sentence.text);
      if (!id || this.handled.has(id)) continue;
      const entry = this.cache.get(id);
      if (entry?.state !== "ready") continue;
      const categories = flagCategories(entry.scores);
      if (categories.length === 0) continue;
      if (holdRanges.some((range) => overlaps(range, sentence))) continue;
      flags.push({ id, start: sentence.start, end: sentence.end, text: sentence.text, categories, scores: entry.scores });
    }
    return flags;
  }

  // Test and debugging aid: how many sentences the detector holds an answer for.
  knownCount(): number {
    return this.cache.size;
  }
}

// Finds the sentence in `text` that reads exactly `sentenceText`. When it occurs
// more than once, the occurrence closest to `nearStart` wins.
export function locateSentence(text: string, sentenceText: string, nearStart: number): Sentence | null {
  let best: Sentence | null = null;
  for (const sentence of splitSentences(text)) {
    if (sentence.text !== sentenceText) continue;
    if (!best || Math.abs(sentence.start - nearStart) < Math.abs(best.start - nearStart)) best = sentence;
  }
  return best;
}

// Suggestions the generator computed for one sentence, moved from the sentence's
// own coordinates into the document's.
export function offsetSuggestions<T extends { start: number; end: number }>(suggestions: T[], by: number): T[] {
  return suggestions.map((suggestion) => ({ ...suggestion, start: suggestion.start + by, end: suggestion.end + by }));
}

// The next sentence the generator may start on its own: its correction
// probability is high, it was not tried before and nothing is running. One at a time.
export function nextPrefetch(
  flags: SentenceFlag[],
  tried: ReadonlySet<string>,
  jobs: Record<string, string>,
): SentenceFlag | null {
  if (Object.values(jobs).includes("analyzing")) return null;
  return flags.find((flag) => flag.scores.correction >= PREFETCH_THRESHOLD && !tried.has(flag.id) && !jobs[flag.id]) ?? null;
}
