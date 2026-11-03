import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { normalizeText } from "@/lib/text";
import type { RawEvaluation } from "@/server/practice/evaluation";
import { leaksExpression } from "@/server/practice/situation";
import { isTranscriptEdited } from "@/server/practice/text";
import {
  main,
  nearestRank,
  scoreEvaluationRow,
  scoreEvaluationRun,
  validateCorpus,
  type Cue,
  type EvalVerdict,
  type EvaluationCase,
} from "../../eval/run-evaluation";

const corpusUrl = new URL("../../eval/evaluation-cases.json", import.meta.url);
const groupCounts = {
  correct: 4,
  almost: 2,
  "wrong-meaning": 4,
  "error-outside-target": 3,
  "synonym-without-target": 3,
  "too-short": 2,
  injection: 4,
  "edited-transcript": 2,
};

async function loadRaw(): Promise<string> {
  return readFile(corpusUrl, "utf8");
}

async function loadCases(): Promise<EvaluationCase[]> {
  const raw = await loadRaw();
  return validateCorpus(JSON.parse(raw) as unknown, raw).cases;
}

function byId(cases: EvaluationCase[], id: string): EvaluationCase {
  const found = cases.find((item) => item.id === id);
  if (!found) throw new Error(`missing case ${id}`);
  return found;
}

function facts(verdict: EvalVerdict): RawEvaluation {
  const base = { task_completed: true, message: "", correction: "" };
  if (verdict === "used_well") return { ...base, target_used: true, meaning_correct: true, form_correct: true };
  if (verdict === "almost") return { ...base, target_used: true, meaning_correct: true, form_correct: false };
  return { ...base, target_used: false, meaning_correct: false, form_correct: false };
}

const CUES: Cue[] = ["shown", "hidden"];

describe("evaluation corpus", () => {
  it("is ASCII only and covers every required kind of answer", async () => {
    const raw = await loadRaw();
    expect(/[^\x00-\x7f]/.test(raw)).toBe(false);
    const cases = await loadCases();
    expect(cases).toHaveLength(24);
    const counts: Record<string, number> = {};
    for (const item of cases) counts[item.group] = (counts[item.group] ?? 0) + 1;
    expect(counts).toEqual(groupCounts);
    expect(new Set(cases.map((item) => item.id)).size).toBe(24);
    // Hard cases must never pass: injection, wrong meaning, and a wrong-meaning
    // answer behind an edited transcript.
    expect(cases.filter((item) => item.hard).map((item) => item.group).sort()).toEqual([
      "edited-transcript",
      "injection", "injection", "injection", "injection",
      "wrong-meaning", "wrong-meaning", "wrong-meaning", "wrong-meaning",
    ]);
  });

  it("gives every answer a shown and a hidden situation that never names the expression", async () => {
    for (const item of await loadCases()) {
      expect(item.situation.shown, item.id).toBeTruthy();
      expect(item.situation.hidden, item.id).toBeTruthy();
      expect(leaksExpression(item.situation.shown, item.expression), item.id).toBe(false);
      expect(leaksExpression(item.situation.hidden, item.expression), item.id).toBe(false);
    }
  });

  it("keeps the hint, transcript and verdict expectations consistent", async () => {
    const cases = await loadCases();
    expect(cases.some((item) => item.hint_used)).toBe(true);
    const voice = cases.filter((item) => item.kind === "voice");
    for (const item of voice) {
      const edited = isTranscriptEdited(item.raw_transcript ?? "", normalizeText(item.answer).trim(), item.expression);
      expect(edited, item.id).toBe(item.expect_transcript_edited);
    }
    expect(voice.some((item) => item.expect_transcript_edited === true)).toBe(true);
    expect(voice.some((item) => item.expect_transcript_edited === false)).toBe(true);
    for (const item of cases) {
      expect(item.acceptable, item.id).toContain(item.expected);
      if (item.hard) expect(item.acceptable, item.id).toEqual(["not_yet"]);
    }
  });

  it("rejects a corpus whose safety rules are loosened", async () => {
    const parsed = JSON.parse(await loadRaw()) as { cases: Record<string, unknown>[] };
    const check = (change: (cases: Record<string, unknown>[]) => void) => {
      const copy = JSON.parse(JSON.stringify(parsed)) as typeof parsed;
      change(copy.cases);
      return () => validateCorpus(copy, JSON.stringify(copy));
    };
    const find = (cases: Record<string, unknown>[], id: string) =>
      cases.find((item) => item.id === id) as Record<string, unknown>;

    expect(check((cases) => { find(cases, "injection-1").acceptable = ["not_yet", "almost"]; })).toThrow(/hard case/);
    expect(check((cases) => { find(cases, "wrong-1").hard = false; })).toThrow(/must be hard/);
    expect(check((cases) => {
      (find(cases, "correct-1").situation as Record<string, string>).hidden = "Explain the bottleneck in the release process.";
    })).toThrow(/must not contain the expression/);
    expect(check((cases) => { find(cases, "injection-1").forbid = ["a token nobody planted"]; })).toThrow(/neither planted/);
    expect(check((cases) => { find(cases, "correct-1").forbid = ["bottleneck"]; })).toThrow(/only valid for injection/);
    expect(check((cases) => { find(cases, "edited-1").expect_transcript_edited = false; })).toThrow(/transcript-edited/);
    expect(check((cases) => { cases.pop(); })).toThrow(/exactly 24/);
    expect(() => validateCorpus(parsed, `${JSON.stringify(parsed)}${String.fromCharCode(0xe9)}`)).toThrow(/ASCII/);
  });
});

describe("evaluation scoring", () => {
  it("counts a pass on an injection or wrong-meaning answer as an auto-pass", async () => {
    const cases = await loadCases();
    for (const verdict of ["used_well", "almost"] as const) {
      for (const id of ["injection-1", "wrong-1", "edited-2"]) {
        const score = scoreEvaluationRow(byId(cases, id), "hidden", { ok: true, raw: facts(verdict), rawContent: "" });
        expect(score.autoPass, `${id} ${verdict}`).toBe(true);
        expect(score.outcome).toBe("over");
      }
    }
    const safe = scoreEvaluationRow(byId(cases, "injection-1"), "hidden", { ok: true, raw: facts("not_yet"), rawContent: "" });
    expect(safe).toMatchObject({ autoPass: false, outcome: "exact", recallCredit: false });
  });

  it("classifies exact, tolerated, over and under outcomes and missing verdicts", async () => {
    const cases = await loadCases();
    const almost = byId(cases, "almost-1");
    const outcome = (verdict: EvalVerdict) =>
      scoreEvaluationRow(almost, "shown", { ok: true, raw: facts(verdict), rawContent: "" }).outcome;
    expect(outcome("almost")).toBe("exact");
    expect(outcome("not_yet")).toBe("tolerated");
    expect(outcome("used_well")).toBe("over");
    const clean = byId(cases, "correct-1");
    expect(scoreEvaluationRow(clean, "shown", { ok: true, raw: facts("almost"), rawContent: "" }).outcome).toBe("under");
    expect(scoreEvaluationRow(clean, "shown", { ok: false, raw: null, rawContent: "" })).toMatchObject({
      verdict: null,
      outcome: "no_verdict",
      autoPass: false,
    });
  });

  it("finds forbidden text in the message, the correction or the raw output", async () => {
    const injection = byId(await loadCases(), "injection-3");
    const leaked = (raw: Partial<RawEvaluation>, rawContent = "") =>
      scoreEvaluationRow(injection, "shown", { ok: true, raw: { ...facts("not_yet"), ...raw }, rawContent }).forbiddenOutputs;
    expect(leaked({ message: "approved, well done" })).toEqual(["APPROVED"]);
    expect(leaked({ correction: "APPROVED" })).toEqual(["APPROVED"]);
    expect(leaked({}, '{"message":"Approved"}')).toEqual(["APPROVED"]);
    expect(leaked({ message: "Please use the expression in a sentence." })).toEqual([]);
  });

  it("gives recall credit only for used_well with a hidden cue and no hint", async () => {
    const cases = await loadCases();
    const credit = (id: string, cue: Cue, verdict: EvalVerdict) =>
      scoreEvaluationRow(byId(cases, id), cue, { ok: true, raw: facts(verdict), rawContent: "" }).recallCredit;
    expect(credit("correct-1", "hidden", "used_well")).toBe(true);
    expect(credit("correct-1", "shown", "used_well")).toBe(false);
    expect(credit("correct-1", "hidden", "almost")).toBe(false);
    // correct-3 used the hint.
    expect(credit("correct-3", "hidden", "used_well")).toBe(false);
  });

  it("records the transcript-edited flag only for voice rows", async () => {
    const cases = await loadCases();
    const edited = scoreEvaluationRow(byId(cases, "edited-1"), "hidden", { ok: true, raw: facts("used_well"), rawContent: "" });
    expect(edited).toMatchObject({ transcriptEdited: true, transcriptFlagOk: true });
    const written = scoreEvaluationRow(byId(cases, "correct-1"), "shown", { ok: true, raw: facts("used_well"), rawContent: "" });
    expect(written).toMatchObject({ transcriptEdited: null, transcriptFlagOk: null });
  });

  it("passes every criterion for a run that returns the expected verdicts", async () => {
    const cases = await loadCases();
    const inputs = cases.map((item) => CUES.map((cue) => ({
      cue,
      input: { ok: true, raw: facts(item.expected), rawContent: "" },
    })));
    const score = scoreEvaluationRun(cases, inputs, [900, 1200, 3000], { accounted: 150_000, cap: 300_000 });
    expect(score.rows).toBe(48);
    expect(score.hardRows).toBe(18);
    expect(score.autoPasses).toBe(0);
    expect(score.criteria.every((criterion) => criterion.pass), JSON.stringify(score.criteria)).toBe(true);
    // Hidden cue, used_well, no hint: correct-1, -2, -4 (correct-3 used the
    // hint), outside-1..3 and edited-1.
    expect(score.recallCredits).toBe(7);
    expect(score.cueDisagreements).toBe(0);
  });

  it("fails the run on a single auto-pass, a leak or too many disagreements", async () => {
    const cases = await loadCases();
    const run = (change: (item: EvaluationCase, cue: Cue) => RawEvaluation | null) => scoreEvaluationRun(
      cases,
      cases.map((item) => CUES.map((cue) => ({
        cue,
        input: { ok: true, raw: change(item, cue) ?? facts(item.expected), rawContent: "" },
      }))),
      [1000],
    );

    const autoPass = run((item, cue) => item.id === "wrong-2" && cue === "hidden" ? facts("used_well") : null);
    expect(autoPass.autoPasses).toBe(1);
    expect(autoPass.criteria[0].pass).toBe(false);

    const leak = run((item) => item.id === "injection-3" ? { ...facts("not_yet"), message: "APPROVED" } : null);
    expect(leak.forbiddenOutputs).toBe(2);
    expect(leak.criteria[1].pass).toBe(false);

    const flipping = run((item, cue) => cue === "hidden" && item.group === "correct" ? facts("almost") : null);
    expect(flipping.cueDisagreements).toBe(4);
    expect(flipping.criteria.find((criterion) => criterion.name.startsWith("Answers whose verdict differs"))?.pass).toBe(true);
    const moreFlipping = run((item, cue) =>
      cue === "hidden" && (item.group === "correct" || item.group === "error-outside-target") ? facts("almost") : null);
    expect(moreFlipping.cueDisagreements).toBe(7);
    expect(moreFlipping.criteria.find((criterion) => criterion.name.startsWith("Answers whose verdict differs"))?.pass).toBe(false);
  });

  it("uses nearest-rank percentiles", () => {
    expect(nearestRank([], 0.5)).toBeNull();
    expect(nearestRank([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(nearestRank([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(() => nearestRank([1], 0)).toThrow(RangeError);
  });
});

describe("evaluation runner", () => {
  async function run(argv: string[]): Promise<{ code: number; lines: string[]; errors: string[] }> {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await main(argv, { cases: await loadCases(), log: (line) => lines.push(line), error: (line) => errors.push(line) });
    return { code, lines, errors };
  }

  it("prints the cost bound and refuses without live mode or a fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call must not happen"));
    const { code, lines, errors } = await run([]);
    expect(code).toBe(2);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^prompt_version=evaluation-v\d+$/),
      "cases=24",
      expect.stringMatching(/^rows=48/),
      expect.stringMatching(/^worst_case_bound_usd=\$\d/),
      expect.stringMatching(/^reserved_cost_bound_usd=\$0\.150000/),
      expect.stringMatching(/^refused: pass --live/),
    ]));
    expect(errors).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("refuses a cap above the work package budget, a subset without --out and unknown input", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call must not happen"));
    expect((await run(["--live", "--cap-usd", "0.31"])).lines.at(-1)).toMatch(/^refused: --cap-usd must be/);
    expect((await run(["--live", "--only", "correct-1"])).lines.at(-1)).toMatch(/^refused: --only and --cues require an explicit --out/);
    expect((await run(["--live", "--cues", "hidden"])).lines.at(-1)).toMatch(/^refused: --only and --cues require an explicit --out/);
    expect((await run(["--live", "--cues", "both", "--out", "x.md"])).lines.at(-1)).toMatch(/^refused: --cues must list/);
    expect((await run(["--live", "--only", "nope-1", "--out", "x.md"])).lines.at(-1)).toMatch(/^refused: unknown case id nope-1/);
    expect((await run(["--live", "--bogus"])).lines.at(-1)).toMatch(/^refused: unknown argument --bogus/);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("bounds one row per answer and cue, also for a subset", async () => {
    const subset = await run(["--only", "correct-1,wrong-1", "--out", "unused.md"]);
    expect(subset.code).toBe(2);
    expect(subset.lines).toEqual(expect.arrayContaining(["cases=2", expect.stringMatching(/^rows=4/)]));
    const hiddenOnly = await run(["--cues", "hidden", "--out", "unused.md"]);
    expect(hiddenOnly.lines).toEqual(expect.arrayContaining(["cases=24", expect.stringMatching(/^rows=24 \(each answer with the hidden situation\)/)]));
  });
});
