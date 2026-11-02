import { describe, expect, it } from "vitest";
import { computeVerdict, parseEvaluation, tidyMessage } from "@/server/practice/evaluation";
import { dayLabel, nextPracticeLabel } from "@/server/practice/labels";
import {
  buildHint,
  leaksExpression,
  parseSituation,
  templateSituation,
} from "@/server/practice/situation";
import {
  containsPhrase,
  isTranscriptEdited,
  normalizeForMatch,
  wordEditDistance,
} from "@/server/practice/text";
import { InvalidWavError, parseWav } from "@/server/practice/wav";
import { makeWav } from "./helpers/app";

const NOW = new Date("2026-11-02T15:00:00.000Z");

describe("labels", () => {
  it("labels past days", () => {
    expect(dayLabel(new Date("2026-11-02T00:00:01Z"), NOW)).toBe("Today");
    expect(dayLabel(new Date("2026-11-01T23:59:59Z"), NOW)).toBe("Yesterday");
    expect(dayLabel(new Date("2026-11-03T01:00:00Z"), new Date("2026-11-04T01:00:00Z"))).toBe("Yesterday");
    expect(dayLabel(new Date("2026-10-03T12:00:00Z"), NOW)).toBe("3 Oct");
    expect(dayLabel(new Date("2025-12-09T12:00:00Z"), NOW)).toBe("9 Dec 2025");
  });

  it("labels the next practice", () => {
    expect(nextPracticeLabel(new Date("2026-11-02T14:00:00Z"), NOW)).toBe("Now");
    expect(nextPracticeLabel(NOW, NOW)).toBe("Now");
    expect(nextPracticeLabel(new Date("2026-11-02T23:00:00Z"), NOW)).toBe("Today");
    expect(nextPracticeLabel(new Date("2026-11-03T15:00:00Z"), NOW)).toBe("Tomorrow");
    expect(nextPracticeLabel(new Date("2026-11-05T15:00:00Z"), NOW)).toBe("In 3 days");
  });
});

describe("parseWav", () => {
  it("accepts mono 16-bit PCM at 16 and 24 kHz and reports the duration", () => {
    expect(parseWav(makeWav({ seconds: 2 })).seconds).toBe(2);
    expect(parseWav(makeWav({ seconds: 1.5, sampleRate: 24_000 }))).toMatchObject({
      seconds: 1.5,
      sampleRate: 24_000,
    });
    expect(parseWav(makeWav({ seconds: 0.5 })).seconds).toBe(0.5);
    expect(parseWav(makeWav({ seconds: 60, sampleRate: 24_000 })).seconds).toBe(60);
  });

  it("rejects everything else", () => {
    const reasons = (bytes: Uint8Array) => {
      try {
        parseWav(bytes);
        return "accepted";
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidWavError);
        return (error as InvalidWavError).reason;
      }
    };
    expect(reasons(makeWav({ channels: 2 }))).toBe("not_mono");
    expect(reasons(makeWav({ sampleRate: 44_100 }))).toBe("bad_sample_rate");
    expect(reasons(makeWav({ sampleRate: 8_000 }))).toBe("bad_sample_rate");
    expect(reasons(makeWav({ bits: 8 }))).toBe("not_16_bit");
    expect(reasons(makeWav({ format: 3 }))).toBe("not_pcm");
    expect(reasons(makeWav({ seconds: 0.4 }))).toBe("too_short");
    expect(reasons(makeWav({ seconds: 61 }))).toBe("too_long");
    expect(reasons(makeWav({ seconds: 80, sampleRate: 24_000 }))).toBe("too_large");
    expect(reasons(new Uint8Array(0))).toBe("too_short");
    expect(reasons(new TextEncoder().encode("this is definitely not a wav file at all, honest"))).toBe("not_wav");
    expect(reasons(crypto.getRandomValues(new Uint8Array(4000)))).toBe("not_wav");
    const noData = makeWav().slice(0, 36);
    expect(reasons(noData)).toBe("too_short");
  });

  it("rejects trailing bytes, a second data chunk and a second fmt chunk", () => {
    const reason = (bytes: Uint8Array) => {
      try {
        parseWav(bytes);
        return "accepted";
      } catch (error) {
        return (error as InvalidWavError).reason;
      }
    };
    const base = makeWav({ seconds: 1 });
    const extend = (extra: Uint8Array) => {
      const out = new Uint8Array(base.length + extra.length);
      out.set(base);
      out.set(extra, base.length);
      return out;
    };
    // One padding byte is tolerated; two are not.
    expect(reason(extend(new Uint8Array(1)))).toBe("accepted");
    expect(reason(extend(new Uint8Array(2)))).toBe("trailing_bytes");
    expect(reason(extend(new Uint8Array(16_000)))).toBe("trailing_bytes");
    const second = new Uint8Array(8 + 2000);
    second.set([0x64, 0x61, 0x74, 0x61]);
    new DataView(second.buffer).setUint32(4, 2000, true);
    expect(reason(extend(second))).toBe("multiple_data");
    // A LIST chunk after the data is trailing metadata, also refused.
    expect(reason(extend(new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4])))).toBe("trailing_bytes");

    // fmt twice before the data chunk.
    const fmt = base.slice(12, 36);
    const doubled = new Uint8Array(base.length + fmt.length);
    doubled.set(base.slice(0, 36));
    doubled.set(fmt, 36);
    doubled.set(base.slice(36), 36 + fmt.length);
    expect(reason(doubled)).toBe("multiple_fmt");
  });

  it("builds a canonical file from the validated samples only", () => {
    const upload = makeWav({ seconds: 1.5, sampleRate: 24_000 });
    // Distinct sample bytes, a placeholder size and one padding byte.
    for (let i = 44; i < upload.length; i++) upload[i] = i % 251;
    new DataView(upload.buffer).setUint32(40, 0xffffffff, true);
    const padded = new Uint8Array(upload.length + 1);
    padded.set(upload);

    const info = parseWav(padded);
    expect(info.seconds).toBe(1.5);
    expect(info.canonical.length).toBe(44 + 36_000 * 2);
    expect(Array.from(info.canonical.subarray(44, 60))).toEqual(Array.from(upload.subarray(44, 60)));
    // The canonical file is itself a valid upload with the same duration.
    const again = parseWav(info.canonical);
    expect(again.seconds).toBe(1.5);
    expect(again.canonical).toEqual(info.canonical);

    // An odd byte count loses the half sample.
    const odd = makeWav({ dataBytes: 32_001 });
    expect(parseWav(odd).canonical.length).toBe(44 + 32_000);
  });

  it("skips extra chunks before data and tolerates a placeholder data size", () => {
    const plain = makeWav({ seconds: 1 });
    // Insert a LIST chunk between fmt and data.
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4]);
    const withList = new Uint8Array(plain.length + list.length);
    withList.set(plain.slice(0, 36));
    withList.set(list, 36);
    withList.set(plain.slice(36), 36 + list.length);
    expect(parseWav(withList).seconds).toBe(1);

    const streaming = makeWav({ seconds: 1 });
    new DataView(streaming.buffer).setUint32(40, 0xffffffff, true);
    expect(parseWav(streaming).seconds).toBe(1);
  });
});

describe("transcript editing", () => {
  const target = "unlikely to happen";
  const raw = "I think the delay is quite unlikely to happen again this month";

  it("normalizes for matching", () => {
    expect(normalizeForMatch("  Hello,  WORLD!! ")).toBe("hello world");
    expect(containsPhrase("It is UNLIKELY to happen.", target)).toBe(true);
    expect(containsPhrase("It is unlikely to happening", target)).toBe(false);
    expect(containsPhrase("anything", "")).toBe(false);
  });

  it("measures word-level edit distance", () => {
    expect(wordEditDistance("a b c", "a b c")).toBe(0);
    expect(wordEditDistance("a b c", "a x c")).toBe(1);
    expect(wordEditDistance("a b c", "a c")).toBe(1);
    expect(wordEditDistance("", "a b")).toBe(2);
  });

  it("is not edited when unchanged or when only punctuation and case differ", () => {
    expect(isTranscriptEdited(raw, raw, target)).toBe(false);
    expect(isTranscriptEdited(raw, `${raw}.`.toUpperCase(), target)).toBe(false);
  });

  it("allows small fixes up to 20% of the raw words", () => {
    // 12 raw words: 2 edits is 16.7%, 3 edits is 25%.
    expect(isTranscriptEdited(raw, raw.replace("delay", "setback"), target)).toBe(false);
    expect(isTranscriptEdited(raw, raw.replace("delay", "setback").replace("month", "week"), target)).toBe(false);
    expect(
      isTranscriptEdited(raw, raw.replace("delay", "setback").replace("month", "week").replace("think", "believe"), target),
    ).toBe(true);
  });

  it("is edited when the target appears only in the confirmed text", () => {
    const heard = "I think the delay is quite on the cards again this month";
    expect(isTranscriptEdited(heard, heard.replace("on the cards", target), target)).toBe(true);
    expect(isTranscriptEdited(heard, heard.replace("again", "soon"), target)).toBe(false);
  });

  it("treats typing over an empty transcript as an edit", () => {
    expect(isTranscriptEdited("", "I typed everything myself", target)).toBe(true);
    expect(isTranscriptEdited("", "", target)).toBe(false);
  });
});

describe("evaluation helpers", () => {
  it("maps the three target facts to a verdict", () => {
    const verdict = (target_used: boolean, meaning_correct: boolean, form_correct: boolean) =>
      computeVerdict({ target_used, meaning_correct, form_correct });
    expect(verdict(true, true, true)).toBe("used_well");
    expect(verdict(true, true, false)).toBe("almost");
    expect(verdict(true, false, true)).toBe("not_yet");
    expect(verdict(true, false, false)).toBe("not_yet");
    // A fluent answer that avoids the target never scores.
    expect(verdict(false, true, true)).toBe("not_yet");
    expect(verdict(false, false, false)).toBe("not_yet");
  });

  it("parses evaluation output strictly for booleans and leniently for text", () => {
    const ok = { task_completed: true, target_used: true, meaning_correct: true, form_correct: true };
    expect(parseEvaluation(JSON.stringify({ ...ok, message: "Nice.", correction: "" }))).toMatchObject(ok);
    expect(parseEvaluation(JSON.stringify(ok))).toMatchObject({ message: "", correction: "" });
    expect(parseEvaluation(JSON.stringify({ ...ok, target_used: "yes" }))).toBeNull();
    expect(parseEvaluation(JSON.stringify({ target_used: true }))).toBeNull();
    expect(parseEvaluation("nope")).toBeNull();
  });

  it("limits the message to 200 characters and supplies a default", () => {
    expect(tidyMessage("word ".repeat(100), "almost").length).toBeLessThanOrEqual(200);
    expect(tidyMessage("", "used_well")).toMatch(/Well done/);
    expect(tidyMessage("  Short   and  kind. ", "almost")).toBe("Short and kind.");
  });
});

describe("situation helpers", () => {
  it("detects an expression in a situation regardless of case and punctuation", () => {
    const expression = "unlikely to happen";
    expect(leaksExpression("You say it is UNLIKELY to happen!", expression)).toBe(true);
    expect(leaksExpression("You say it is unlikely, to happen.", expression)).toBe(true);
    expect(leaksExpression("You say it will probably not occur.", expression)).toBe(false);
    expect(leaksExpression("This is unlikely.", expression)).toBe(false);
  });

  it("builds a hint from the first letter and the meaning", () => {
    expect(buildHint("unlikely to happen", "not likely to happen")).toBe(
      "Starts with “u…”: not likely to happen",
    );
  });

  it("never returns a template that contains the expression", () => {
    for (const expression of ["reply in one or two sentences", "a colleague asks", "hello", "x"]) {
      expect(leaksExpression(templateSituation(expression), expression)).toBe(false);
    }
  });

  it("accepts only a reasonable situation", () => {
    expect(parseSituation(JSON.stringify({ situation: "You are in a meeting and a client asks about the delay." }))).toMatch(/meeting/);
    expect(parseSituation(JSON.stringify({ situation: "Too short." }))).toBeNull();
    expect(parseSituation(JSON.stringify({ situation: "x".repeat(400) }))).toBeNull();
    expect(parseSituation("{}")).toBeNull();
  });
});
