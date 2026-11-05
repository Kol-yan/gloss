// Turns per-item records into the Markdown summary. Pure: no I/O.
import type { BenchRole } from "./datasets";
import type { RoleResult } from "./roles";
import { percentile, ratio, totalProofread, type ProofreadScore, VERDICTS } from "./scorers";
import type { CallStatus } from "./target";

// The production provider deadline (src/server/models/meta.ts). A call slower
// than this would have failed in the app even if the bench waited for it.
export const PRODUCTION_DEADLINE_MS = 20_000;

export interface ItemRecord {
  id: string;
  group: string | null;
  status: CallStatus | "not_run";
  errorCode: string | null;
  latencyMs: number | null;
  wallMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedMicros: number | null;
  tableMicros: number | null;
  boundMicros: number;
  accountedMicros: number;
  servingProvider: string | null;
  result: RoleResult | null;
  // What the model returned, cut to a readable length, for debugging.
  content: string | null;
  // The answer key in readable form (expected edits, text or verdict), so the
  // report can explain a miss without reloading the dataset.
  expected: string;
  // Proofreading only: number of expected errors, so a failed call still
  // counts its errors as missed.
  expectedCount: number;
}

export interface RunInfo {
  role: BenchRole;
  provider: string;
  model: string;
  baseUrlHost: string | null;
  tier: string;
  promptVersion: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  commit: string | null;
  datasetSize: number;
  datasetSha256: string;
  selected: number;
  maxUsd: number;
  concurrency: number;
  timeoutMs: number;
  stopReason: string | null;
  command: string;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
const seconds = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const fixed = (value: number | null, digits = 3) => (value === null ? "n/a" : value.toFixed(digits));

export function cell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ↵ ").replace(/`/g, "'");
}

export interface Summary {
  attempted: number;
  ok: number;
  valid: number;
  notRun: number;
  failures: Map<string, number>;
  p50: number | null;
  p95: number | null;
  max: number | null;
  overDeadline: number;
  inputTokens: number;
  outputTokens: number;
  withUsage: number;
  accountedMicros: number;
  reportedMicros: number;
  withReported: number;
  tableMicros: number;
  perItemMicros: number | null;
  fullRunMicros: number | null;
  quality: string;
  qualityRows: [string, string][];
}

export function summarize(info: RunInfo, records: ItemRecord[]): Summary {
  const attempted = records.filter((record) => record.status !== "not_run");
  const ok = attempted.filter((record) => record.status === "ok");
  const latencies = ok.flatMap((record) => (record.latencyMs === null ? [] : [record.latencyMs]));
  const failures = new Map<string, number>();
  for (const record of attempted) {
    const code = record.status === "ok" ? (record.result?.valid ? null : "unparsable_answer") : record.errorCode ?? record.status;
    if (code) failures.set(code, (failures.get(code) ?? 0) + 1);
  }
  const withUsage = attempted.filter((record) => record.inputTokens !== null);
  const withReported = attempted.filter((record) => record.reportedMicros !== null);
  const accountedMicros = attempted.reduce((n, record) => n + record.accountedMicros, 0);
  const perItemMicros = attempted.length === 0 ? null : accountedMicros / attempted.length;
  const { quality, rows } = qualityOf(info.role, attempted);
  return {
    attempted: attempted.length,
    ok: ok.length,
    valid: attempted.filter((record) => record.result?.valid).length,
    notRun: records.length - attempted.length,
    failures,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length ? Math.max(...latencies) : null,
    overDeadline: latencies.filter((ms) => ms > PRODUCTION_DEADLINE_MS).length,
    inputTokens: withUsage.reduce((n, record) => n + (record.inputTokens ?? 0), 0),
    outputTokens: withUsage.reduce((n, record) => n + (record.outputTokens ?? 0), 0),
    withUsage: withUsage.length,
    accountedMicros,
    reportedMicros: withReported.reduce((n, record) => n + (record.reportedMicros ?? 0), 0),
    withReported: withReported.length,
    tableMicros: withUsage.reduce((n, record) => n + (record.tableMicros ?? 0), 0),
    perItemMicros,
    fullRunMicros: perItemMicros === null ? null : perItemMicros * info.datasetSize,
    quality,
    qualityRows: rows,
  };
}

// Failed or unparsable answers count against the model: in proofreading they
// score as "no edits" for recall but never as a correct item.
function qualityOf(role: BenchRole, attempted: ItemRecord[]): { quality: string; rows: [string, string][] } {
  if (role === "proofread") {
    const scores: ProofreadScore[] = attempted.map((record) => {
      const result = record.result;
      if (result?.role === "proofread" && result.score) return result.score;
      return { expected: record.expectedCount, predicted: 0, located: 0, fixedExact: 0, fixedNear: 0, predictedExact: 0,
        predictedNear: 0, falsePositives: 0, itemCorrect: false };
    });
    const t = totalProofread(scores);
    return {
      quality: `F1 ${fixed(t.f1Near, 2)} (P ${fixed(t.precisionNear, 2)} / R ${fixed(t.recallNear, 2)}), clean flagged ${t.cleanFlagged}/${t.cleanItems}`,
      rows: [
        ["Items fully right (all errors fixed, nothing else touched)", `${t.itemsCorrect}/${t.items}`],
        ["Near-match precision / recall / F1", `${fixed(t.precisionNear)} / ${fixed(t.recallNear)} / ${fixed(t.f1Near)}`],
        ["Exact-match precision / recall", `${fixed(t.precisionExact)} / ${fixed(t.recallExact)}`],
        ["Expected errors fixed (near / exact / located)", `${t.fixedNear} / ${t.fixedExact} / ${t.located} of ${t.expected}`],
        ["Error edits proposed / touching no expected error", `${t.predicted} / ${t.falsePositives}`],
        ["Clean texts that got an error edit", `${t.cleanFlagged}/${t.cleanItems}`],
      ],
    };
  }
  if (role === "dictation") {
    const results = attempted.flatMap((record) => (record.result?.role === "dictation" ? [record.result] : []));
    const scored = results.flatMap((result) => (result.score ? [result.score] : []));
    const distances = scored.map((score) => score.distance);
    const mean = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null;
    const preserved = scored.filter((score) => score.wordsPreserved).length;
    const accepted = results.filter((result) => result.appAccepted).length;
    return {
      quality: `edit distance ${fixed(mean)}, words kept ${preserved}/${attempted.length}, app accepted ${accepted}/${attempted.length}`,
      rows: [
        ["Mean / median normalized edit distance (0 = identical)", `${fixed(mean)} / ${fixed(percentile(distances, 0.5))}`],
        ["Exact matches", `${scored.filter((score) => score.exact).length}/${attempted.length}`],
        ["Word preservation passed (no new words, nothing expected lost)", `${preserved}/${attempted.length}`],
        ["Answers that added a word the speaker never said", `${scored.filter((score) => score.addedWords.length > 0).length}`],
        ["Answers missing a must-keep term (name, number, foreign word)", `${scored.filter((score) => score.missingKeep.length > 0).length}`],
        ["Accepted by the app's own check (else the raw transcript is shown)", `${accepted}/${attempted.length}`],
      ],
    };
  }
  const results = attempted.map((record) => ({ record, result: record.result?.role === "evaluation" ? record.result : null }));
  const acceptable = results.filter(({ result }) => result?.score.acceptable).length;
  const strict = results.filter(({ result }) => result?.score.strict).length;
  const falsePasses = results.filter(({ result }) => result?.score.falsePass).length;
  const groups = [...new Set(attempted.map((record) => record.group ?? "none"))];
  const byGroup = groups.map((group) => {
    const inGroup = results.filter(({ record }) => (record.group ?? "none") === group);
    return `${group} ${inGroup.filter(({ result }) => result?.score.acceptable).length}/${inGroup.length}`;
  }).join(", ");
  const matrix = VERDICTS.map((expected) => {
    const row = results.filter(({ record }) => record.expected === expected);
    const counts = [...VERDICTS, null].map((got) => row.filter(({ result }) => (result?.verdict ?? null) === got).length);
    return `${expected}: ${counts.map((n, i) => `${[...VERDICTS, "none"][i]}=${n}`).join(" ")}`;
  }).join("; ");
  return {
    quality: `acceptable ${acceptable}/${attempted.length} (${pct(ratio(acceptable, attempted.length))}), false passes ${falsePasses}`,
    rows: [
      ["Verdict acceptable", `${acceptable}/${attempted.length}`],
      ["Verdict equals the single expected verdict", `${strict}/${attempted.length}`],
      ["False passes (used_well where it is not acceptable)", `${falsePasses}`],
      ["Acceptable by group", byGroup || "n/a"],
      ["Expected → got", matrix],
    ],
  };
}

export const COMPARISON_HEADER =
  "| Role | Provider | Model | Items | Valid answers | Quality | p50 | p95 | Cost per item | Full-run cost |\n" +
  "|---|---|---|---:|---:|---|---:|---:|---:|---:|";

export function comparisonRow(info: RunInfo, summary: Summary): string {
  const model = info.baseUrlHost ? `${info.model} @ ${info.baseUrlHost}` : info.model;
  return `| ${info.role} | ${info.provider}${info.dryRun ? " (dry run)" : ""} | ${cell(model)} | ${summary.attempted} | ${summary.valid} | ${cell(summary.quality)} | ${seconds(summary.p50)} | ${seconds(summary.p95)} | ${summary.perItemMicros === null ? "n/a" : usd(summary.perItemMicros)} | ${summary.fullRunMicros === null ? "n/a" : usd(summary.fullRunMicros)} |`;
}

export function renderReport(info: RunInfo, records: ItemRecord[]): string {
  const summary = summarize(info, records);
  const failures = [...summary.failures.entries()].map(([code, n]) => `${code}=${n}`).join(", ") || "none";
  const lines: string[] = [];
  lines.push(`# Model bench: ${info.role} on ${cell(info.model)}${info.dryRun ? " (dry run, simulated provider)" : ""}`, "");
  if (info.dryRun) {
    lines.push("> Dry run: answers come from the app's mock provider, so quality, latency and cost below are not measurements of any model.", "");
  }
  if (info.stopReason) lines.push(`> **Stopped early:** ${cell(info.stopReason)}`, "");
  lines.push("## Comparison row", "", COMPARISON_HEADER, comparisonRow(info, summary), "");
  lines.push("## Run", "", "| Field | Value |", "|---|---|");
  const runRows: [string, string][] = [
    ["Command", `\`${cell(info.command)}\``],
    ["Provider / tier", `${info.provider} / ${info.tier}`],
    ["Model", cell(info.model)],
    ["Base URL host", info.baseUrlHost ?? "OpenRouter"],
    ["Prompt version", info.promptVersion],
    ["Commit", info.commit ?? "unknown"],
    ["Dataset", `${info.datasetSize} items, sha256 ${info.datasetSha256.slice(0, 16)}…; ${info.selected} selected`],
    ["Started / finished (UTC)", `${info.startedAt} / ${info.finishedAt}`],
    ["Cost cap (--max-usd)", `$${info.maxUsd.toFixed(2)}`],
    ["Concurrency / timeout", `${info.concurrency} / ${info.timeoutMs} ms`],
  ];
  for (const [field, value] of runRows) lines.push(`| ${field} | ${value} |`);
  lines.push("", "## Quality", "", "| Metric | Value |", "|---|---|");
  for (const [field, value] of summary.qualityRows) lines.push(`| ${field} | ${cell(value)} |`);
  lines.push("", "## Speed and cost", "", "| Metric | Value |", "|---|---|");
  const speedRows: [string, string][] = [
    ["Calls attempted / succeeded / not run", `${summary.attempted} / ${summary.ok} / ${summary.notRun}`],
    ["Failures by code", cell(failures)],
    ["Latency p50 / p95 / max (successful calls, network time)", `${seconds(summary.p50)} / ${seconds(summary.p95)} / ${seconds(summary.max)}`],
    [`Successful calls slower than the app's ${PRODUCTION_DEADLINE_MS / 1000} s deadline`, `${summary.overDeadline}`],
    ["Tokens in / out (calls with usage)", `${summary.inputTokens} / ${summary.outputTokens} (${summary.withUsage} calls)`],
    ["Accounted cost (guard total)", usd(summary.accountedMicros)],
    ["Provider-reported cost", summary.withReported ? `${usd(summary.reportedMicros)} (${summary.withReported}/${summary.attempted} calls reported)` : "not reported"],
    ["Tokens × price-table cost", usd(summary.tableMicros)],
    ["Cost per item / projected full dataset", `${summary.perItemMicros === null ? "n/a" : usd(summary.perItemMicros)} / ${summary.fullRunMicros === null ? "n/a" : usd(summary.fullRunMicros)}`],
  ];
  for (const [field, value] of speedRows) lines.push(`| ${field} | ${value} |`);

  const misses = records.filter((record) => record.status !== "not_run" && !isGood(record));
  lines.push("", `## Items that were not fully right (${misses.length})`, "");
  if (misses.length === 0) lines.push("None.");
  else {
    lines.push("| Item | Group | Status | Latency | Detail |", "|---|---|---|---:|---|");
    for (const record of misses) {
      lines.push(`| ${record.id} | ${record.group ?? ""} | ${record.status}${record.errorCode ? ` (${record.errorCode})` : ""} | ${seconds(record.latencyMs)} | ${cell(detail(record))} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function isGood(record: ItemRecord): boolean {
  const result = record.result;
  if (record.status !== "ok" || !result?.valid) return false;
  if (result.role === "proofread") return result.score?.itemCorrect ?? false;
  if (result.role === "dictation") return Boolean(result.score?.wordsPreserved && result.appAccepted && result.score.distance <= 0.05);
  return result.score.acceptable;
}

function detail(record: ItemRecord): string {
  const result = record.result;
  if (!result || !result.valid) return record.content ? `answer: ${record.content.slice(0, 160)}` : "no usable answer";
  if (result.role === "proofread") {
    const s = result.score;
    return `expected ${record.expected || "no edits"}; got ${result.edits.join("; ") || "no edits"}` +
      (s ? ` (fixed ${s.fixedNear}/${s.expected}, stray ${s.falsePositives})` : "");
  }
  if (result.role === "dictation") {
    const s = result.score;
    const notes = [
      s ? `distance ${s.distance.toFixed(3)}` : "",
      s?.addedWords.length ? `added: ${s.addedWords.join(", ")}` : "",
      s?.missingKeep.length ? `lost: ${s.missingKeep.join(", ")}` : "",
      result.appAccepted ? "" : "rejected by app",
    ].filter(Boolean).join("; ");
    return `${notes}; got: ${result.output ?? ""}`;
  }
  return `expected ${record.expected}, got ${result.verdict ?? "none"}`;
}
