// Model benchmark: runs one role's dataset against one provider and model
// through the app's own model code, and writes a Markdown summary plus a
// JSONL file with one record per item. See eval/bench/README.md.
//
//   npx tsx eval/bench/run.ts --role proofread --dry-run --limit 5
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DATASET_FILES, loadDataset, ROLES, type BenchRole, type ItemFor } from "./lib/datasets";
import { renderReport, summarize, comparisonRow, COMPARISON_HEADER, type ItemRecord, type RunInfo } from "./lib/report";
import { ADAPTERS, type RoleAdapter } from "./lib/roles";
import { createTarget, DEFAULT_MODELS, PROVIDERS, TargetError, type ProviderKind, type Target } from "./lib/target";
import type { ModelTier } from "@/server/models/access";

export const DEFAULT_MAX_USD = 1;
export const MAX_MAX_USD = 50;
const MAX_CONCURRENCY = 8;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const CONTENT_LIMIT = 4000;

export const USAGE = `Usage: npx tsx eval/bench/run.ts --role <proofread|dictation|evaluation> [options]

  --role <name>              Role to benchmark (required).
  --provider <name>          openrouter | meta | openai   (env BENCH_PROVIDER; default openrouter,
                             or meta for --role evaluation, as in production)
  --model <id>               Model id or OpenRouter preset (env BENCH_MODEL).
                             Defaults: openrouter @preset/gpt-oss-120b-balanced, meta muse-spark-1.3.
  --base-url <url>           Endpoint for meta/openai (env BENCH_BASE_URL), e.g. https://api.deepseek.com/v1
  --tier <fast|smart>        Override the role's tier (changes reasoning and OpenRouter routing settings).
  --price-in <usd>           OpenRouter only: price per 1M input tokens (not below the table price).
  --price-out <usd>          OpenRouter only: price per 1M output tokens (not below the table price).
  --max-usd <usd>            Hard spend stop (env BENCH_MAX_USD, default ${DEFAULT_MAX_USD}, at most ${MAX_MAX_USD}).
  --limit <n>                Run only the first n items (after --offset).
  --offset <n>               Skip the first n items.
  --concurrency <n>          Parallel calls (default 1, at most ${MAX_CONCURRENCY}). Latency is cleanest at 1.
  --timeout-ms <ms>          Per-call deadline (default ${DEFAULT_TIMEOUT_MS}; the app uses 20000).
  --max-consecutive-failures <n>  Stop after n failed calls in a row (default ${DEFAULT_MAX_CONSECUTIVE_FAILURES}).
  --out <dir>                Output directory (default eval/bench/results).
  --dry-run                  Use the app's mock provider: no network, no key, no cost.
  --help                     Show this text.

Keys come from the environment only: OPENROUTER_API_KEY, META_API_KEY, BENCH_API_KEY (openai).`;

export interface CliOptions {
  role: BenchRole;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  tier?: ModelTier;
  priceIn?: number;
  priceOut?: number;
  maxUsd: number;
  limit?: number;
  offset: number;
  concurrency: number;
  timeoutMs: number;
  maxConsecutiveFailures: number;
  outDir: string;
  dryRun: boolean;
}

export class UsageError extends Error {}

function positiveNumber(name: string, value: string | undefined, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) throw new UsageError(`${name} must be a number above 0 and at most ${max}`);
  return parsed;
}

function wholeNumber(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  return parsed;
}

export function parseOptions(argv: string[], env: Record<string, string | undefined>): CliOptions | "help" {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        role: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
        "base-url": { type: "string" },
        tier: { type: "string" },
        "price-in": { type: "string" },
        "price-out": { type: "string" },
        "max-usd": { type: "string" },
        limit: { type: "string" },
        offset: { type: "string" },
        concurrency: { type: "string" },
        "timeout-ms": { type: "string" },
        "max-consecutive-failures": { type: "string" },
        out: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
  if (values.help) return "help";

  const role = values.role;
  if (!role || !(ROLES as readonly string[]).includes(role)) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);
  // Defaults mirror production: the fast roles run on the OpenRouter preset,
  // answer evaluation on Meta Muse Spark.
  const provider = values.provider ?? (env.BENCH_PROVIDER?.trim() || (role === "evaluation" ? "meta" : "openrouter"));
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new UsageError(`--provider must be one of ${PROVIDERS.join(", ")}`);
  const model = values.model ?? (env.BENCH_MODEL?.trim() || DEFAULT_MODELS[provider as ProviderKind]);
  if (!model) throw new UsageError(`--model is required for --provider ${provider}`);
  const tier = values.tier;
  if (tier !== undefined && tier !== "fast" && tier !== "smart") throw new UsageError("--tier must be fast or smart");
  const baseUrl = values["base-url"] ?? (env.BENCH_BASE_URL?.trim() || undefined);
  if (baseUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(baseUrl)) throw new UsageError("--base-url must be an http(s) URL");

  return {
    role: role as BenchRole,
    provider: provider as ProviderKind,
    model,
    baseUrl,
    tier,
    priceIn: positiveNumber("--price-in", values["price-in"], 1000),
    priceOut: positiveNumber("--price-out", values["price-out"], 1000),
    maxUsd: positiveNumber("--max-usd", values["max-usd"] ?? (env.BENCH_MAX_USD?.trim() || undefined), MAX_MAX_USD) ?? DEFAULT_MAX_USD,
    limit: wholeNumber("--limit", values.limit, 1, 100_000),
    offset: wholeNumber("--offset", values.offset, 0, 100_000) ?? 0,
    concurrency: wholeNumber("--concurrency", values.concurrency, 1, MAX_CONCURRENCY) ?? 1,
    timeoutMs: wholeNumber("--timeout-ms", values["timeout-ms"], 1000, 600_000) ?? DEFAULT_TIMEOUT_MS,
    maxConsecutiveFailures: wholeNumber("--max-consecutive-failures", values["max-consecutive-failures"], 1, 100_000) ??
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    outDir: resolve(values.out ?? "eval/bench/results"),
    dryRun: values["dry-run"] ?? false,
  };
}

export interface RunDeps {
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  progress?: (line: string) => void;
  // Lets tests skip writing files.
  write?: (path: string, content: string) => Promise<void>;
}

function itemGroup(role: BenchRole, item: ItemFor<BenchRole>): string | null {
  if (role === "dictation") return null;
  return (item as ItemFor<"proofread" | "evaluation">).group;
}

function expectedOf(role: BenchRole, item: ItemFor<BenchRole>): { expected: string; expectedCount: number } {
  if (role === "proofread") {
    const errors = (item as ItemFor<"proofread">).errors;
    return { expected: errors.map((error) => `${error.span} → ${error.fixes[0]}`).join("; "), expectedCount: errors.length };
  }
  if (role === "dictation") return { expected: (item as ItemFor<"dictation">).expected, expectedCount: 0 };
  return { expected: (item as ItemFor<"evaluation">).expected, expectedCount: 0 };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "model";
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;

// Runs the selected items. The cost guard is checked synchronously before
// each call, counting the reserved bound of every call still in flight, so a
// call is sent only while spent + in-flight bounds + its own bound <= cap.
export async function runItems<R extends BenchRole>(input: {
  adapter: RoleAdapter<R>;
  target: Pick<Target, "call" | "boundMicros">;
  items: ItemFor<R>[];
  tier: ModelTier;
  maxMicros: number;
  concurrency: number;
  timeoutMs: number;
  maxConsecutiveFailures: number;
  progress?: (line: string) => void;
}): Promise<{ records: ItemRecord[]; stopReason: string | null }> {
  const { adapter, target, items, tier } = input;
  const records: ItemRecord[] = items.map((item) => ({
    id: item.id, group: itemGroup(adapter.role, item), status: "not_run", errorCode: null, latencyMs: null, wallMs: null,
    inputTokens: null, outputTokens: null, reportedMicros: null, tableMicros: null, boundMicros: 0, accountedMicros: 0,
    servingProvider: null, result: null, content: null, ...expectedOf(adapter.role, item),
  }));
  let next = 0;
  let spent = 0;
  let inFlight = 0;
  let consecutiveFailures = 0;
  let done = 0;
  let stopReason: string | null = null;

  const worker = async () => {
    while (stopReason === null && next < items.length) {
      const index = next++;
      const item = items[index];
      const call = adapter.request(item, tier);
      const bound = target.boundMicros(call);
      records[index].boundMicros = bound;
      if (spent + inFlight + bound > input.maxMicros) {
        stopReason = `cost cap: ${usd(spent)} spent + ${usd(inFlight)} in flight + next call bound ${usd(bound)} would exceed ${usd(input.maxMicros)}`;
        break;
      }
      inFlight += bound;
      const outcome = await target.call(call, input.timeoutMs);
      inFlight -= bound;
      spent += outcome.accountedMicros;
      const result = adapter.judge(item, outcome.status === "ok" ? outcome.content : null);
      records[index] = {
        ...records[index],
        ...outcome,
        content: outcome.content === null ? null : outcome.content.slice(0, CONTENT_LIMIT),
        result,
      };
      done++;
      input.progress?.(
        `[${done}/${items.length}] ${item.id} ${outcome.status}${outcome.errorCode ? `:${outcome.errorCode}` : ""}` +
        ` ${outcome.latencyMs === null ? "-" : `${(outcome.latencyMs / 1000).toFixed(2)}s`} ${usd(outcome.accountedMicros)} (total ${usd(spent)})`,
      );
      if (outcome.status === "refused") {
        stopReason ??= `the app refused the call (${outcome.errorCode}); check the provider, model and price settings`;
      }
      consecutiveFailures = outcome.status === "ok" ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= input.maxConsecutiveFailures) {
        stopReason ??= `${consecutiveFailures} calls in a row failed (last: ${outcome.errorCode ?? outcome.status})`;
      }
      if (spent > input.maxMicros) stopReason ??= `cost cap exceeded by a provider-reported cost: ${usd(spent)}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency, items.length) }, worker));
  return { records, stopReason };
}

export async function main(argv = process.argv.slice(2), deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const progress = deps.progress ?? ((line: string) => console.error(line));
  const write = deps.write ?? (async (path: string, content: string) => {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  });

  let options;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      log(`refused: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options === "help") {
    log(USAGE);
    return 0;
  }

  const role = options.role;
  const adapter = ADAPTERS[role] as RoleAdapter<BenchRole>;
  const datasetText = await readFile(DATASET_FILES[role], "utf8");
  const dataset = await loadDataset(role);
  const items = dataset.slice(options.offset, options.limit === undefined ? undefined : options.offset + options.limit);
  if (items.length === 0) {
    log("refused: --offset/--limit select no items");
    return 2;
  }

  let target: Target;
  try {
    target = createTarget({ ...options, env });
  } catch (error) {
    if (error instanceof TargetError) {
      log(`refused: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const tier = options.tier ?? adapter.defaultTier;
  const maxMicros = Math.floor(options.maxUsd * 1_000_000);
  const worstCase = items.reduce((total, item) => total + target.boundMicros(adapter.request(item, tier)), 0);
  log(`role=${role} provider=${target.provider} model=${target.model} tier=${tier} items=${items.length}${options.dryRun ? " dry-run" : ""}`);
  log(`worst-case bound for these items ${usd(worstCase)}; hard stop at ${usd(maxMicros)}`);

  const startedAt = new Date();
  let run;
  try {
    run = await runItems({
      adapter, target, items, tier, maxMicros,
      concurrency: options.concurrency, timeoutMs: options.timeoutMs,
      maxConsecutiveFailures: options.maxConsecutiveFailures, progress,
    });
  } finally {
    target.close();
  }

  const stamp = startedAt.toISOString().replace(/[:]/g, "").replace(/\.\d+Z$/, "Z");
  const base = resolve(options.outDir, `${stamp}-${role}-${slug(target.model)}${options.dryRun ? "-dry-run" : ""}`);
  const command = ["npx tsx eval/bench/run.ts", ...argv].join(" ");
  const info: RunInfo = {
    role,
    provider: target.provider,
    model: target.model,
    baseUrlHost: target.baseUrl ? new URL(target.baseUrl).host : null,
    tier,
    promptVersion: adapter.promptVersion,
    dryRun: options.dryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    commit: gitCommit(),
    datasetSize: dataset.length,
    datasetSha256: createHash("sha256").update(datasetText).digest("hex"),
    selected: items.length,
    maxUsd: options.maxUsd,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    stopReason: run.stopReason,
    command,
  };
  const report = renderReport(info, run.records);
  await write(`${base}.md`, report);
  await write(`${base}.jsonl`, run.records.map((record) => JSON.stringify(record)).join("\n") + "\n");

  const summary = summarize(info, run.records);
  log("");
  log(COMPARISON_HEADER);
  log(comparisonRow(info, summary));
  log("");
  if (run.stopReason) log(`stopped early: ${run.stopReason}`);
  log(`report: ${base}.md`);
  log(`items:  ${base}.jsonl`);
  return run.stopReason ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    // Never print provider bodies or keys; the error name and message are ours.
    console.error(`bench failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`);
    process.exitCode = 1;
  });
}
