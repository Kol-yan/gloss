import { describe, expect, it } from "vitest";
import { splitSentences } from "@/lib/text";
import { loadDataset, parseDataset } from "../../eval/bench/lib/datasets";
import { ADAPTERS } from "../../eval/bench/lib/roles";
import type { CallOutcome } from "../../eval/bench/lib/target";
import { main, parseOptions, runItems } from "../../eval/bench/run";

describe("bench datasets", () => {
  it("load and pass validation", async () => {
    const proofread = await loadDataset("proofread");
    const dictation = await loadDataset("dictation");
    const evaluation = await loadDataset("evaluation");
    expect(proofread.length).toBeGreaterThanOrEqual(190);
    expect(proofread.filter((item) => item.group === "clean").length).toBeGreaterThanOrEqual(30);
    expect(dictation.length).toBeGreaterThanOrEqual(45);
    expect(evaluation.length).toBeGreaterThanOrEqual(55);
    expect(evaluation.filter((item) => item.group === "injection").length).toBeGreaterThanOrEqual(8);
    expect(evaluation.filter((item) => item.group === "wrong-meaning").length).toBeGreaterThanOrEqual(8);
  });

  it("score their own answer keys as fully right through the app's parsers", async () => {
    // A model that returns exactly the expected corrections must score
    // perfectly; otherwise the key and the app's diff disagree.
    for (const item of await loadDataset("proofread")) {
      const corrections = splitSentences(item.text).flatMap((sentence) => {
        let corrected = sentence.text;
        const inside = item.errors
          .map((error) => ({ error, at: item.text.indexOf(error.span) - sentence.start }))
          .filter(({ at }) => at >= 0 && at < sentence.text.length)
          .sort((a, b) => b.at - a.at);
        for (const { error, at } of inside) {
          corrected = corrected.slice(0, at) + error.fixes[0] + corrected.slice(at + error.span.length);
        }
        return corrected === sentence.text ? [] : [{ sentence_index: sentence.index, corrected, changes: [] }];
      });
      const result = ADAPTERS.proofread.judge(item, JSON.stringify({ corrections, improvements: [] }));
      expect(result.role === "proofread" && result.score?.itemCorrect, item.id).toBe(true);
    }
    for (const item of await loadDataset("dictation")) {
      const result = ADAPTERS.dictation.judge(item, JSON.stringify({ text: item.expected }));
      expect(result.role === "dictation" && result.appAccepted && result.score?.wordsPreserved && result.score.exact, item.id).toBe(true);
    }
  });

  it("rejects a span that does not occur exactly once", () => {
    const line = JSON.stringify({ id: "x-1", group: "error", register: "chat", text: "the cat and the dog",
      errors: [{ span: "the", fixes: ["a"], topic: "article" }] });
    expect(() => parseDataset("proofread", line)).toThrow(/exactly once/);
  });

  it("rejects duplicate ids and unknown fields", () => {
    const line = JSON.stringify({ id: "d-1", transcript: "um hi", expected: "Hi." });
    expect(() => parseDataset("dictation", `${line}\n${line}`)).toThrow(/duplicate id/);
    expect(() => parseDataset("dictation", JSON.stringify({ id: "d-1", transcript: "a", expected: "A", extra: 1 }))).toThrow();
  });
});

describe("parseOptions", () => {
  it("defaults to concurrency 1 and the production provider for the role", () => {
    const proofread = parseOptions(["--role", "proofread"], {});
    const evaluation = parseOptions(["--role", "evaluation"], {});
    expect(proofread).toMatchObject({ provider: "openrouter", model: "@preset/gpt-oss-120b-balanced", concurrency: 1, maxUsd: 1 });
    expect(evaluation).toMatchObject({ provider: "meta", model: "muse-spark-1.3" });
  });

  it("reads provider and model from the environment, flags win", () => {
    const env = { BENCH_PROVIDER: "openai", BENCH_MODEL: "deepseek-chat", BENCH_BASE_URL: "https://api.example.com/v1" };
    expect(parseOptions(["--role", "dictation"], env)).toMatchObject({ provider: "openai", model: "deepseek-chat" });
    expect(parseOptions(["--role", "dictation", "--model", "other"], env)).toMatchObject({ model: "other" });
  });

  it("refuses unsafe or unknown values", () => {
    expect(() => parseOptions(["--role", "proofread", "--max-usd", "0"], {})).toThrow();
    expect(() => parseOptions(["--role", "proofread", "--max-usd", "500"], {})).toThrow();
    expect(() => parseOptions(["--role", "proofread", "--concurrency", "100"], {})).toThrow();
    expect(() => parseOptions(["--role", "nope"], {})).toThrow();
    expect(() => parseOptions(["--role", "proofread", "--provider", "openai"], {})).toThrow(/--model/);
    expect(() => parseOptions(["--role", "proofread", "--unknown"], {})).toThrow();
  });
});

function fakeTarget(outcome: (index: number) => Partial<CallOutcome>, boundMicros = 1000) {
  let index = 0;
  return {
    boundMicros: () => boundMicros,
    call: async (): Promise<CallOutcome> => ({
      status: "ok", errorCode: null, content: '{"text":"Hi."}', latencyMs: 10, wallMs: 11, inputTokens: 1,
      outputTokens: 1, reportedMicros: null, tableMicros: 100, boundMicros, accountedMicros: 100,
      servingProvider: null, ...outcome(index++),
    }),
  };
}

const items = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}`, transcript: "um hi", expected: "Hi." }));

describe("runItems", () => {
  it("stops before a call whose bound would cross the cap", async () => {
    const run = await runItems({
      adapter: ADAPTERS.dictation, target: fakeTarget(() => ({ accountedMicros: 400 })), items, tier: "fast",
      maxMicros: 2000, concurrency: 1, timeoutMs: 1000, maxConsecutiveFailures: 5,
    });
    // 400 per call, 1000 bound: calls run while spent + 1000 <= 2000.
    expect(run.records.filter((record) => record.status !== "not_run")).toHaveLength(3);
    expect(run.stopReason).toMatch(/cost cap/);
  });

  it("counts in-flight bounds when running in parallel", async () => {
    const run = await runItems({
      adapter: ADAPTERS.dictation, target: fakeTarget(() => ({ accountedMicros: 0 })), items, tier: "fast",
      maxMicros: 2500, concurrency: 4, timeoutMs: 1000, maxConsecutiveFailures: 5,
    });
    expect(run.stopReason).toMatch(/cost cap/);
  });

  it("stops after repeated failures", async () => {
    const run = await runItems({
      adapter: ADAPTERS.dictation,
      target: fakeTarget(() => ({ status: "http_error", errorCode: "http_400", content: null, accountedMicros: 0 })),
      items, tier: "fast", maxMicros: 1_000_000, concurrency: 1, timeoutMs: 1000, maxConsecutiveFailures: 3,
    });
    expect(run.records.filter((record) => record.status === "http_error")).toHaveLength(3);
    expect(run.stopReason).toMatch(/3 calls in a row failed/);
  });
});

describe("dry run", () => {
  it("runs each role through the app's mock provider without keys", async () => {
    for (const role of ["proofread", "dictation", "evaluation"]) {
      const written = new Map<string, string>();
      const logs: string[] = [];
      const code = await main(["--role", role, "--dry-run", "--limit", "3"], {
        env: {},
        log: (line) => logs.push(line),
        progress: () => undefined,
        write: async (path, content) => {
          written.set(path, content);
        },
      });
      expect(code).toBe(0);
      const report = [...written.entries()].find(([path]) => path.endsWith(".md"))?.[1] ?? "";
      expect(report).toContain("Dry run");
      expect(report).toContain("| Calls attempted / succeeded / not run | 3 / 3 / 0 |");
      const jsonl = [...written.entries()].find(([path]) => path.endsWith(".jsonl"))?.[1] ?? "";
      expect(jsonl.trim().split("\n")).toHaveLength(3);
    }
  });

  it("refuses a live run without a key and never prints a key", async () => {
    const logs: string[] = [];
    const code = await main(["--role", "proofread", "--limit", "1"], { env: {}, log: (line) => logs.push(line) });
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/OPENROUTER_API_KEY is not set/);
  });

  it("refuses an unpriced model before any call", async () => {
    const logs: string[] = [];
    const code = await main(
      ["--role", "dictation", "--provider", "openai", "--base-url", "https://api.example.com/v1", "--model", "unpriced-model", "--dry-run"],
      { env: {}, log: (line) => logs.push(line) },
    );
    expect(code).toBe(2);
    expect(logs.join("\n")).toMatch(/no price for unpriced-model/);
  });
});
