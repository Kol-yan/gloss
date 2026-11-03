import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { normalizeText } from "../src/lib/text";
import type { ProofreadCase } from "./run-proofread";

const CORPUS = "eval/proofread-cases.json";
const STAGE2 = "eval/results/2026-11-03-proofread-v9.md";
const OUTPUT = "eval/results/2026-11-03-languagetool-bakeoff.md";
const DEFAULT_ENDPOINT = "http://127.0.0.1:18081/v2/check";
const GROUP_COUNTS = { error: 14, correct: 10, style: 3, trap: 6, unicode: 3, long: 1, injection: 3 };
const TIMEOUT_MS = 30_000;
const COMMAND = "node --conditions=import --import tsx eval/run-languagetool-bakeoff.ts";
type Engine = "LanguageTool" | "Harper" | "Stage 2";
export type Flag = { start: number; end: number; category: "error" | "style" | "expression" };
export type Score = { found: number; missed: number; falseFlags: number; errorFlags: number; optionalFlags: number };
export type Result = { engine: Engine; id: string; score: Score | null; latencyMs: number | null; provider: string | null; usageCost: number | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function ascii(value: string): string {
  return value.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function parseCorpus(raw: string): ProofreadCase[] {
  const data: unknown = JSON.parse(raw);
  if (/[^\x00-\x7f]/.test(raw) || !record(data) || data.corpus !== "gloss-proofread" || data.version !== 1 ||
    !Array.isArray(data.cases) || data.cases.length !== 40) throw new Error("Invalid S2 corpus");
  const ids = new Set<string>();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const entry of data.cases) {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.group !== "string" ||
      !Object.hasOwn(GROUP_COUNTS, entry.group) || !entry.id.startsWith(`${entry.group}-`) ||
      ids.has(entry.id) || !/^[a-z0-9-]+$/.test(entry.id) || typeof entry.topic !== "string" ||
      !/^[a-z0-9-]+$/.test(entry.topic) || typeof entry.text !== "string" || !entry.text.trim() ||
      !Array.isArray(entry.errors)) throw new Error("Invalid corpus case");
    const text = normalizeText(entry.text);
    for (const planted of entry.errors) {
      if (!record(planted) || typeof planted.span !== "string" || !planted.span ||
        !Array.isArray(planted.fixes) || !planted.fixes.length || planted.fixes.some((fix) => typeof fix !== "string") ||
        text.indexOf(planted.span) < 0 || text.indexOf(planted.span, text.indexOf(planted.span) + 1) >= 0) {
        throw new Error("Invalid or ambiguous planted span");
      }
      total++;
    }
    ids.add(entry.id);
    counts[entry.group] = (counts[entry.group] ?? 0) + 1;
  }
  if (total !== 29 || Object.entries(GROUP_COUNTS).some(([group, count]) => counts[group] !== count)) {
    throw new Error("Corpus must have the S2 group counts and 29 planted errors");
  }
  return data.cases as ProofreadCase[];
}

function touches(flag: Flag, start: number, end: number): boolean {
  // Match S2 scoring, including insertions on either boundary of a planted span.
  return flag.start === flag.end ? start <= flag.start && flag.start <= end : flag.start < end && start < flag.end;
}

export function scoreFlags(item: ProofreadCase, flags: Flag[]): Score {
  const text = normalizeText(item.text);
  for (const flag of flags) {
    if (!Number.isInteger(flag.start) || !Number.isInteger(flag.end) || flag.start < 0 || flag.end < flag.start || flag.end > text.length) {
      throw new Error("Invalid UTF-16 flag range");
    }
  }
  const spans = item.errors.map(({ span }) => ({ start: text.indexOf(span), end: text.indexOf(span) + span.length }));
  if (spans.some(({ start }) => start < 0)) throw new Error("Missing planted span");
  const errors = flags.filter((flag) => flag.category === "error");
  const found = spans.filter(({ start, end }) => errors.some((flag) => touches(flag, start, end))).length;
  return {
    found, missed: spans.length - found,
    falseFlags: errors.filter((flag) => !spans.some(({ start, end }) => touches(flag, start, end))).length,
    errorFlags: errors.length, optionalFlags: flags.length - errors.length,
  };
}

export function parseStage2(markdown: string, cases: ProofreadCase[]): Result[] {
  if (!markdown.includes("Prompt version: `proofread-v9`")) throw new Error("Expected historical proofread-v9");
  const section = markdown.split("## Per-case results\n");
  if (section.length !== 2) throw new Error("Missing or duplicated Stage 2 table");
  const lines = section[1].split(/\n## /, 1)[0].trim().split("\n");
  const header = "| Case | Group | Result | Planted found | False/extra errors | Meaning changes flagged/unflagged | Suggestions e/s/x | Provider | Adapter latency ms | usage.cost |";
  if (lines[0] !== header || !/^\|[-:|]+\|$/.test(lines[1])) throw new Error("Unexpected Stage 2 table schema");
  const seen = new Set<string>();
  const results = lines.slice(2).map((line): Result => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!line.startsWith("|") || !line.endsWith("|") || cells.length !== 10) throw new Error("Malformed Stage 2 row");
    const id = /^`([a-z0-9-]+)`$/.exec(cells[0])?.[1];
    const item = cases.find((candidate) => candidate.id === id);
    const planted = /^(\d+)\/(\d+)$/.exec(cells[3]);
    const extras = /^(\d+)\/(\d+) \((\d+) foreign\)$/.exec(cells[4]);
    const suggestions = /^(\d+)\/(\d+)\/(\d+)$/.exec(cells[6]);
    if (!id || !item || seen.has(id) || cells[1] !== item.group || !/^(PASS|FAIL)$/.test(cells[2]) ||
      !planted || !extras || !suggestions || !/^\d+\/\d+$/.test(cells[5]) ||
      !/^[A-Za-z0-9 ._-]+$/.test(cells[7]) || !/^\d+$/.test(cells[8]) || !/^\$\d+\.\d+$/.test(cells[9])) {
      throw new Error("Invalid Stage 2 case, group or metrics");
    }
    const found = Number(planted[1]);
    const total = Number(planted[2]);
    const falseFlags = Number(extras[1]) + Number(extras[2]);
    const errorFlags = Number(suggestions[1]);
    if (total !== item.errors.length || found > total || falseFlags > errorFlags || Number(extras[3]) > Number(extras[2]) ||
      (total === 0 ? Number(extras[2]) !== 0 || Number(extras[1]) !== errorFlags : Number(extras[1]) !== 0)) {
      throw new Error("Inconsistent Stage 2 scoring totals");
    }
    seen.add(id);
    return { engine: "Stage 2", id, score: { found, missed: total - found, falseFlags, errorFlags,
      optionalFlags: Number(suggestions[2]) + Number(suggestions[3]) },
    latencyMs: Number(cells[8]), provider: cells[7], usageCost: Number(cells[9].slice(1)) };
  });
  if (cases.length !== 40 || seen.size !== 40 || results.reduce((sum, row) => sum + row.score!.found + row.score!.missed, 0) !== 29) {
    throw new Error("Stage 2 must contain exactly all 40 corpus IDs and 29 planted errors");
  }
  return cases.map((item) => results.find((result) => result.id === item.id)!);
}

export function validateLoopbackEndpoint(raw: string): string {
  // Literal IPs avoid DNS/proxy-host ambiguity; reject URL normalization tricks.
  if (!/^http:\/\/(?:127(?:\.(?:0|[1-9]\d{0,2})){3}|\[::1\])(?::\d{1,5})?\/v2\/check$/.test(raw)) {
    throw new Error("Endpoint must be an HTTP loopback IP /v2/check URL without credentials, query or fragment");
  }
  const url = new URL(raw);
  if (url.hostname !== "[::1]" && url.hostname.split(".").some((part) => Number(part) > 255)) throw new Error("Invalid loopback IP");
  return url.href;
}

export function parseOptions(argv: string[]): { live: boolean; skipReason: string | null; endpoint: string; out: string; evidence?: string } {
  let live = false;
  let skip = false;
  let reason: string | null = null;
  let endpoint = DEFAULT_ENDPOINT;
  let out = OUTPUT;
  let evidence: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (seen.has(option)) throw new Error("Duplicate option");
    seen.add(option);
    if (option === "--live") live = true;
    else if (option === "--skip-languagetool") skip = true;
    else if (["--skip-reason", "--endpoint", "--out", "--evidence"].includes(option)) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error("Missing option value");
      if (option === "--skip-reason") reason = value.trim();
      else if (option === "--endpoint") endpoint = value;
      else if (option === "--out") out = value;
      else evidence = value;
    } else throw new Error("Unknown option");
  }
  if (live === skip) throw new Error("Choose exactly one of --live or --skip-languagetool; network is refused by default");
  if (skip !== (reason !== null)) throw new Error("--skip-languagetool requires nonempty --skip-reason, and the reason requires skip mode");
  if (reason && /(?:\/Users\/|\/Volumes\/|\/home\/)/.test(reason)) throw new Error("Skip reason must not contain private paths");
  endpoint = validateLoopbackEndpoint(endpoint);
  if (evidence && resolve(out) === resolve(evidence)) throw new Error("Output and evidence must differ");
  if ([CORPUS, STAGE2].some((path) => [out, evidence].some((target) => target && resolve(target) === resolve(path)))) {
    throw new Error("Inputs cannot be outputs");
  }
  return { live, skipReason: reason, endpoint, out, evidence };
}

// These are hints, not definite errors. Unknown issue types stay visibly optional.
const OPTIONAL_TYPES = new Set(["style", "register", "locale", "characters", "inconsistency", "non-conformance", "other"]);
const ERROR_TYPES = new Set(["misspelling", "grammar", "typographical", "duplication"]);
export function languageToolFlags(response: unknown, text: string): Flag[] {
  if (!record(response) || !Array.isArray(response.matches) || !record(response.software) || typeof response.software.version !== "string" ||
    !record(response.language) || response.language.code !== "en-US") {
    throw new Error("Invalid LanguageTool response");
  }
  if (record(response.warnings) && response.warnings.incompleteResults === true) throw new Error("LanguageTool returned incomplete results");
  return response.matches.map((match): Flag => {
    if (!record(match) || !Number.isInteger(match.offset) || !Number.isInteger(match.length) ||
      typeof match.message !== "string" || !record(match.rule) || typeof match.rule.id !== "string" ||
      typeof match.rule.issueType !== "string" || !record(match.rule.category) || typeof match.rule.category.id !== "string" ||
      !Array.isArray(match.replacements) || match.replacements.some((part) => !record(part) || typeof part.value !== "string")) {
      throw new Error("Invalid LanguageTool match");
    }
    const start = match.offset as number;
    const end = start + (match.length as number);
    if (start < 0 || end < start || end > text.length) throw new Error("Invalid LanguageTool UTF-16 range");
    const issueType = match.rule.issueType.toLowerCase();
    const optional = OPTIONAL_TYPES.has(issueType) || ["STYLE", "REDUNDANCY", "PLAIN_ENGLISH", "COLLOQUIALISMS"].includes(match.rule.category.id);
    return { start, end, category: !optional && ERROR_TYPES.has(issueType) ? "error" : "style" };
  });
}

export async function checkLanguageTool(endpoint: string, text: string): Promise<{ flags: Flag[]; evidence: Record<string, unknown>; latencyMs: number }> {
  const url = validateLoopbackEndpoint(endpoint);
  const request = { text, language: "en-US", level: "default" };
  const body = new URLSearchParams(request).toString();
  const start = performance.now();
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const responseText = await response.text();
  const latencyMs = performance.now() - start;
  if (response.status !== 200) throw new Error("LanguageTool returned non-200 status");
  const json: unknown = JSON.parse(responseText);
  const flags = languageToolFlags(json, text);
  return { flags, latencyMs, evidence: { request, request_body: body, response_status: response.status,
    response_text: responseText, response: json, latency_ms: latencyMs, provider: null, usage: { cost: null }, local_api_spend_usd: 0, flags } };
}

function aggregate(results: Result[]): Score | null {
  if (results.some((row) => row.score === null)) return null;
  return results.reduce((sum, { score }) => ({ found: sum.found + score!.found, missed: sum.missed + score!.missed,
    falseFlags: sum.falseFlags + score!.falseFlags, errorFlags: sum.errorFlags + score!.errorFlags,
    optionalFlags: sum.optionalFlags + score!.optionalFlags }), { found: 0, missed: 0, falseFlags: 0, errorFlags: 0, optionalFlags: 0 });
}

function metricCells(score: Score | null): string {
  return score ? `${score.found} | ${score.missed} | ${score.falseFlags} | ${score.optionalFlags}` : "N/A | N/A | N/A | N/A";
}

export function renderReport(cases: ProofreadCase[], results: Result[], evidence: Record<string, unknown>, evidenceHash?: string): string {
  const engines: Engine[] = ["LanguageTool", "Harper", "Stage 2"];
  const skipReason = evidence.languagetool_skip_reason;
  const lines = ["# LanguageTool, Harper and historical Stage 2 bakeoff", "", `Date (UTC): ${new Date().toISOString()}`, "",
    "## Methodology", "",
    "Hard bound for new API spend: $0.00. No new model calls. Corpus: `eval/proofread-cases.json`, version 1, 40 cases, 29 planted errors.",
    `Corpus SHA-256: \`${evidence.corpus_sha256}\`. Historical source: \`${STAGE2}\`, SHA-256: \`${evidence.stage2_source_sha256}\`.`,
    "",
    "All engines use NFC-normalized text and UTF-16 indices. Found means an error-category suggestion overlaps a planted span; zero-width insertions on either boundary count. Each planted error counts once. Missed = planted - found. False flags means error-category suggestions outside every planted span, including extra flags in erroneous cases. It does not prove that an unplanted flag is linguistically wrong. Optional rules are counted separately and cannot earn error-category coverage.",
    "",
    "LanguageTool uses standard en-US, level=default, no explicit rule overrides, no credentials, no redirects, and sequential checks with a 30-second timeout each. No n-gram data is requested by the runner; server image/data configuration must be established separately. Misspelling, grammar, typographical and duplication issue types count as errors; style, register, locale, characters, inconsistency, non-conformance, other and unknown types are optional. STYLE, REDUNDANCY, PLAIN_ENGLISH and COLLOQUIALISMS categories are also optional.",
    "",
    "Harper 3.0.0 uses the exact production createLinter/collectLints/mapLints path: American dialect, dictionary SpellCheck OFF, opinionated rules OFF. The recorded full effective config is authoritative. Production mapLints verifies spans against problem text (UTF-16 first, code-point fallback), filters unmappable/no-fix lints and maps error versus optional categories. Raw lints and mapped suggestions are retained, so filtered and optional rule flags remain inspectable.",
    "",
    "Stage 2 is parsed from the existing proofread-v9 per-case table only, including its provider, adapter latency and usage.cost. Historical false + extra errors map to false flags. No provider adapter/config is loaded and no model is rerun. Its raw historical evidence stays in the source report. Deterministic provider and usage.cost fields are absent and represented as null; local API spend=0 is an accounting fact, not provider-reported zero cost or a hosting-cost claim.",
    "", "## Execution", "",
    skipReason ? `LanguageTool: SKIPPED. ${skipReason}` : "LanguageTool: 40 successful sequential loopback checks; full requests/responses are in the evidence.",
    "", "Reproduce the selected mode:", "", "```sh",
    skipReason ? `${COMMAND} --skip-languagetool --skip-reason ${shellQuote(String(skipReason))} --out eval/results/languagetool-bakeoff-rerun.md` : `${COMMAND} --live --endpoint ${evidence.endpoint} --out eval/results/languagetool-bakeoff-rerun.md`,
    "```", "", "The import condition is needed by the installed ESM-only Harper package in this checkout. Existing output/evidence files are never overwritten. Errors and unavailable services return nonzero; an explicit skip is not a service failure.",
    "", "## Overall", "", "| Engine | Found | Missed | False flags | Optional flags |", "|---|---:|---:|---:|---:|"];
  for (const engine of engines) lines.push(`| ${engine} | ${metricCells(aggregate(results.filter((row) => row.engine === engine)))} |`);
  for (const key of ["group", "topic"] as const) {
    lines.push("", `## Per-${key} results`, "", `| ${key === "group" ? "Group" : "Topic"} | Engine | Cases | Planted | Found | Missed | False flags | Optional flags |`, "|---|---|---:|---:|---:|---:|---:|---:|");
    for (const value of [...new Set(cases.map((item) => item[key]))]) {
      const subset = cases.filter((item) => item[key] === value);
      for (const engine of engines) lines.push(`| ${value} | ${engine} | ${subset.length} | ${subset.reduce((sum, item) => sum + item.errors.length, 0)} | ${metricCells(aggregate(results.filter((row) => row.engine === engine && subset.some((item) => item.id === row.id))))} |`);
    }
  }
  lines.push("", "## Case-level results", "", "| Case | Group | Topic | Engine | Found | Missed | False flags | Optional flags | Latency ms | Provider | usage.cost USD |", "|---|---|---|---|---:|---:|---:|---:|---:|---|---:|");
  for (const item of cases) for (const engine of engines) {
    const row = results.find((candidate) => candidate.id === item.id && candidate.engine === engine)!;
    lines.push(`| ${item.id} | ${item.group} | ${item.topic} | ${engine} | ${metricCells(row.score)} | ${row.latencyMs === null ? "N/A" : row.latencyMs.toFixed(3)} | ${row.provider ?? "null"} | ${row.usageCost ?? "null"} |`);
  }
  lines.push("", "## Limitations and recommendation", "",
    "Span overlap is detection, not an exact-fix score: a broad/wrong suggestion can touch a planted span. Style cases have no gold errors, and optional hints are not graded as correct or incorrect. The tuned S2 corpus is not held-out. This report does not establish meaning preservation or real-user quality.",
    "",
    "Production Harper categories can label a useful correction as optional. The evidence includes supplemental coverage using ALL mapped suggestions as candidate flags; this is not the main error-category score and does not establish exact fixes. Raw flags are not independently verified errors.",
    `Supplemental Harper all-suggestion overlap: ${evidence.harper_all_suggestions_found}/29 planted spans (${29 - Number(evidence.harper_all_suggestions_found)} missed), from ${evidence.harper_all_suggestions_total} mapped suggestions. ${evidence.harper_all_suggestions_outside_planted} suggestions lie outside planted spans; these optional/unplanted flags have no independent correctness label.`,
    "",
    "US-versus-GB bias: LanguageTool en-US enables US spelling while the corpus accepts British spelling, including a dedicated correct-british-spelling case and British words elsewhere. Such flags remain counted and inspectable, rather than silently removed. Harper spelling is OFF and Stage 2 accepts both variants. This is the requested production comparison, not equivalent spelling configurations.",
    "",
    "Harper timings exclude initial WASM setup; LanguageTool timings include local HTTP/forwarding and response-body time; Stage 2 timings are historical adapter timings from a different run. These are not equivalent latency benchmarks. Local API spend excludes infrastructure. No server configuration, RAM or deployment acceptance is established by this runner.",
    "",
    skipReason ? "Defer the rules-tier decision pending a valid live LanguageTool corpus run. LanguageTool quality and latency are N/A, not zero found or 29 missed. No application integration is proposed from a skipped run." : "Treat these results as a small diagnostic comparison. A server-side rules-tier decision needs review of individual flags, spelling policy, operational RAM and deployment evidence; this runner does not integrate any engine.",
    "", "## Evidence", "");
  if (evidenceHash) lines.push(`Full evidence is in a separate JSON artifact (private location omitted), SHA-256: \`${evidenceHash}\`. Retain it alongside this report to reproduce deterministic scores.`);
  else lines.push("Complete deterministic requests/responses and Harper config/lints/mapped suggestions follow. Historical Stage 2 raw evidence remains in the linked source report.", "", "```json", JSON.stringify(evidence, null, 2), "```");
  return ascii(lines.join("\n") + "\n");
}

async function refuseOverwrite(path: string): Promise<void> {
  try { await access(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Refusing to overwrite an existing output/evidence file");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  console.log("Hard bound for new API spend: $0.00 (local rules only; no new model calls).");
  try {
    const options = parseOptions(argv);
    await refuseOverwrite(options.out);
    if (options.evidence) await refuseOverwrite(options.evidence);
    const corpusRaw = await readFile(CORPUS, "utf8");
    const cases = parseCorpus(corpusRaw);
    const historical = await readFile(STAGE2, "utf8");
    const results = parseStage2(historical, cases);
    const { createLinter, collectLints } = await import("../src/features/editor/harper-lint");
    const { mapLints, resolveSpan } = await import("../src/features/editor/local-lint");
    const { binaryInlined } = await import("harper.js/binaryInlined");
    const linter = await createLinter(binaryInlined);
    const harper = [];
    const languageTool = [];
    let allFound = 0;
    let allOutside = 0;
    let allSuggestions = 0;
    let config;
    try {
      config = await linter.getLintConfig();
      if (config.SpellCheck !== false) throw new Error("Production Harper spelling must be OFF");
      for (const item of cases) {
        const text = normalizeText(item.text);
        const start = performance.now();
        const rawLints = await collectLints(linter, text);
        const suggestions = mapLints(text, rawLints);
        const latencyMs = performance.now() - start;
        const score = scoreFlags(item, suggestions);
        const all = scoreFlags(item, suggestions.map((suggestion) => ({ ...suggestion, category: "error" })));
        allFound += all.found;
        allOutside += all.falseFlags;
        allSuggestions += suggestions.length;
        harper.push({ case_id: item.id, request: { text, language: "plaintext", dedup: true },
          raw_lints: rawLints.map((lint) => ({ ...lint, resolved_utf16_span: resolveSpan(text, lint) })),
          suggestions, score, all_suggestions_overlap: { found: all.found, missed: all.missed, outside_planted_spans: all.falseFlags },
          latency_ms: latencyMs, provider: null, usage: { cost: null }, local_api_spend_usd: 0 });
        results.push({ engine: "Harper", id: item.id, score, latencyMs, provider: null, usageCost: null });
        if (options.live) {
          const checked = await checkLanguageTool(options.endpoint, text);
          const ltScore = scoreFlags(item, checked.flags);
          languageTool.push({ case_id: item.id, ...checked.evidence, score: ltScore });
          results.push({ engine: "LanguageTool", id: item.id, score: ltScore, latencyMs: checked.latencyMs, provider: null, usageCost: null });
        } else results.push({ engine: "LanguageTool", id: item.id, score: null, latencyMs: null, provider: null, usageCost: null });
      }
    } finally {
      await linter.dispose();
    }
    const evidence = { corpus_sha256: sha(corpusRaw), stage2_source: STAGE2, stage2_source_sha256: sha(historical),
      endpoint: options.live ? options.endpoint : null, languagetool_skip_reason: options.skipReason,
      local_api_spend_usd: 0, new_model_calls: 0, harper_version: "3.0.0", harper_config: config,
      harper_all_suggestions_found: allFound, harper_all_suggestions_total: allSuggestions, harper_all_suggestions_outside_planted: allOutside,
      harper, languagetool: languageTool, stage2_table: results.filter((row) => row.engine === "Stage 2") };
    const evidenceJson = ascii(JSON.stringify(evidence, null, 2) + "\n");
    const report = renderReport(cases, results, evidence, options.evidence ? sha(evidenceJson) : undefined);
    if (options.evidence) {
      await mkdir(dirname(options.evidence), { recursive: true });
      await writeFile(options.evidence, evidenceJson, { flag: "wx" });
    }
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, report, { flag: "wx" });
    console.log(`Completed ${cases.length} cases; LanguageTool ${options.live ? "live" : "SKIPPED"}; new API spend $0.00; deterministic usage.cost null (absent).`);
    return 0;
  } catch (error) {
    // Do not log URLs, response bodies, local paths or error objects on failure.
    const safe = error instanceof Error && /^(Choose exactly|--skip-languagetool|Endpoint must|Refusing to overwrite)/.test(error.message);
    console.error(safe ? error.message : "Bakeoff failed: invalid input, local checker, service or output; no complete report written.");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then((code) => { process.exitCode = code; });
}
