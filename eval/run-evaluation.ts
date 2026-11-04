import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText } from "../src/lib/text";
import { getConfig } from "../src/server/config";
import { resolveTextRoute } from "../src/server/models/access";
import type { MetaChatResult } from "../src/server/models/meta";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
  type TokenUsage,
} from "../src/server/models/errors";
import { estimateMaxCostMicros } from "../src/server/models/meta";
import { settledTextCostMicros, textPrice, type TextPrice } from "../src/server/models/prices";
import { EVALUATE_ATTEMPT_ROLE } from "../src/server/models/roles";
import {
  buildEvaluationMessages,
  computeVerdict,
  EVALUATION_JSON_SCHEMA,
  EVALUATION_PROMPT_VERSION,
  EVALUATION_SYSTEM_PROMPT,
  parseEvaluation,
  type RawEvaluation,
} from "../src/server/practice/evaluation";
import { leaksExpression } from "../src/server/practice/situation";
import { isTranscriptEdited } from "../src/server/practice/text";

const CASES_PATH = resolve("eval/evaluation-cases.json");
const DEFAULT_CAP_USD = 0.15;
// The work package's whole live budget; a single run never reserves more.
const MAX_CAP_USD = 0.3;
// The bench grades quality, not production cutoffs.
const BENCH_TIMEOUT_MS = 60_000;
const MAX_ANSWER_LENGTH = 1000;
const CUES = ["shown", "hidden"] as const;
const VERDICTS = ["used_well", "almost", "not_yet"] as const;
const GROUPS = [
  "correct",
  "almost",
  "wrong-meaning",
  "error-outside-target",
  "synonym-without-target",
  "too-short",
  "injection",
  "edited-transcript",
] as const;
const EXPECTED_GROUP_COUNTS: Record<CorpusGroup, number> = {
  correct: 4,
  almost: 2,
  "wrong-meaning": 4,
  "error-outside-target": 3,
  "synonym-without-target": 3,
  "too-short": 2,
  injection: 4,
  "edited-transcript": 2,
};
const VERDICT_RANK: Record<EvalVerdict, number> = { not_yet: 0, almost: 1, used_well: 2 };

export type Cue = (typeof CUES)[number];
export type EvalVerdict = (typeof VERDICTS)[number];
export type CorpusGroup = (typeof GROUPS)[number];

export interface EvaluationCase {
  id: string;
  group: CorpusGroup;
  kind: "written" | "voice";
  expression: string;
  meaning: string;
  answer: string;
  raw_transcript: string | null;
  hint_used: boolean;
  situation: Record<Cue, string>;
  expected: EvalVerdict;
  acceptable: EvalVerdict[];
  hard: boolean;
  forbid: string[];
  expect_transcript_edited: boolean | null;
  note: string;
}

export type RowOutcome = "exact" | "tolerated" | "over" | "under" | "no_verdict";

export interface RowInput {
  ok: boolean;
  raw: RawEvaluation | null;
  rawContent: string;
}

export interface RowScore {
  verdict: EvalVerdict | null;
  outcome: RowOutcome;
  // A hard case (injection, wrong meaning) that got anything above not_yet.
  autoPass: boolean;
  forbiddenOutputs: string[];
  // Mirrors submitAttempt: a used_well first attempt with the expression
  // hidden and no hint earns the long recall gap.
  recallCredit: boolean;
  transcriptEdited: boolean | null;
  transcriptFlagOk: boolean | null;
}

export interface RunScore {
  rowScores: RowScore[];
  rows: number;
  hardRows: number;
  autoPasses: number;
  forbiddenOutputs: number;
  overCredit: number;
  acceptableRows: number;
  verdictRows: number;
  voiceRows: number;
  flagMatches: number;
  cuePairs: number;
  cueDisagreements: number;
  recallCredits: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  criteria: { name: string; target: string; measured: string; pass: boolean }[];
}

interface CliOptions {
  live: boolean;
  capUsd: number;
  capMicros: number;
  outPath: string;
  evidencePath?: string;
  only?: string[];
  cues: Cue[];
  refusal?: string;
}

interface MainDependencies {
  cases?: EvaluationCase[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

interface PreparedRow {
  item: EvaluationCase;
  cue: Cue;
  situation: string;
  answer: string;
  messages: ReturnType<typeof buildEvaluationMessages>;
  boundMicros: number;
}

interface RawResponseSummary {
  provider: unknown;
  model: unknown;
  id: unknown;
  usage: unknown;
  finish_reason: unknown;
  content: unknown;
}

interface FetchCapture {
  requestBody: string | null;
  responseStatus: number | null;
  responseText: string | null;
}

interface CallEvidence {
  case_id: string;
  cue: Cue;
  request_body: string | null;
  response_status: number | null;
  response_text: string | null;
  response: RawResponseSummary | null;
  adapter_latency_ms: number | null;
  wall_latency_ms: number;
  provider: string;
  usage_cost_usd: number | null;
  accounted_cost_usd: number;
  error_code: string | null;
}

interface RowRun {
  item: EvaluationCase;
  cue: Cue;
  situation: string;
  answer: string;
  status: "ok" | "failed" | "not_run";
  raw: RawEvaluation | null;
  rawContent: string;
  provider: string;
  latencyMs: number | null;
  tokens: TokenUsage | null;
  usageCostUsd: number | null;
  costBasis: "reported" | "tokens" | "bound" | "none";
  accountedCostMicros: number;
  errorCode: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerdict(value: unknown): value is EvalVerdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

export function validateCorpus(value: unknown, raw: string): { version: number; cases: EvaluationCase[] } {
  if (/[^\x00-\x7f]/.test(raw)) throw new Error("corpus JSON must contain ASCII characters only");
  if (!isRecord(value) || value.corpus !== "gloss-evaluation" || value.version !== 1 || !Array.isArray(value.cases)) {
    throw new Error("corpus must be gloss-evaluation version 1 with a cases array");
  }
  const total = Object.values(EXPECTED_GROUP_COUNTS).reduce((sum, count) => sum + count, 0);
  if (value.cases.length !== total) throw new Error(`corpus must contain exactly ${total} cases`);

  const counts = Object.fromEntries(GROUPS.map((group) => [group, 0])) as Record<CorpusGroup, number>;
  const ids = new Set<string>();
  const cases: EvaluationCase[] = [];
  for (const candidate of value.cases) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !GROUPS.includes(candidate.group as CorpusGroup) ||
      (candidate.kind !== "written" && candidate.kind !== "voice") ||
      typeof candidate.expression !== "string" || typeof candidate.meaning !== "string" ||
      typeof candidate.answer !== "string" || typeof candidate.hint_used !== "boolean" ||
      typeof candidate.hard !== "boolean" || typeof candidate.note !== "string" ||
      !isRecord(candidate.situation) || typeof candidate.situation.shown !== "string" ||
      typeof candidate.situation.hidden !== "string" || !isVerdict(candidate.expected) ||
      !Array.isArray(candidate.acceptable) || !candidate.acceptable.every(isVerdict) ||
      !Array.isArray(candidate.forbid) || !candidate.forbid.every((part) => typeof part === "string" && part) ||
      !(candidate.raw_transcript === null || typeof candidate.raw_transcript === "string") ||
      !(candidate.expect_transcript_edited === null || typeof candidate.expect_transcript_edited === "boolean")) {
      throw new Error("each corpus case must have valid scalar and array fields");
    }
    const item = candidate as unknown as EvaluationCase;
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (!/^[a-z]+-\d+$/.test(item.id)) throw new Error(`invalid case id: ${item.id}`);
    if (!item.expression.trim() || !item.meaning.trim() || !item.note.trim() || !item.answer.trim() ||
      item.answer.length > MAX_ANSWER_LENGTH) {
      throw new Error(`invalid expression, meaning, note or answer for ${item.id}`);
    }
    if (!item.acceptable.includes(item.expected)) throw new Error(`expected verdict must be acceptable: ${item.id}`);
    if (item.hard && (item.acceptable.length !== 1 || item.acceptable[0] !== "not_yet")) {
      throw new Error(`a hard case accepts only not_yet: ${item.id}`);
    }
    if ((item.group === "injection" || item.group === "wrong-meaning") && !item.hard) {
      throw new Error(`injection and wrong-meaning cases must be hard: ${item.id}`);
    }
    for (const cue of CUES) {
      const situation = item.situation[cue];
      if (!situation.trim() || leaksExpression(situation, item.expression)) {
        throw new Error(`the ${cue} situation must be set and must not contain the expression: ${item.id}`);
      }
    }
    // A forbid string must be either a token planted in the answer or a piece
    // of the system prompt, otherwise its check could never fail.
    if (item.group !== "injection" && item.forbid.length > 0) throw new Error(`forbid is only valid for injection cases: ${item.id}`);
    if (item.forbid.some((part) => !item.answer.includes(part) && !EVALUATION_SYSTEM_PROMPT.includes(part))) {
      throw new Error(`forbid string is neither planted in the answer nor in the prompt: ${item.id}`);
    }
    if (item.kind === "voice") {
      if (item.raw_transcript === null || item.expect_transcript_edited === null) {
        throw new Error(`a voice case needs a raw transcript and a transcript-edited expectation: ${item.id}`);
      }
      const edited = isTranscriptEdited(item.raw_transcript, normalizeText(item.answer).trim(), item.expression);
      if (edited !== item.expect_transcript_edited) throw new Error(`transcript-edited expectation is wrong for ${item.id}`);
    } else if (item.raw_transcript !== null || item.expect_transcript_edited !== null) {
      throw new Error(`a written case has no transcript: ${item.id}`);
    }
    counts[item.group] += 1;
    cases.push(item);
  }
  if (GROUPS.some((group) => counts[group] !== EXPECTED_GROUP_COUNTS[group])) {
    throw new Error("corpus group counts do not match the specification");
  }
  if (!cases.some((item) => item.group === "edited-transcript" && item.kind === "voice")) {
    throw new Error("corpus must include an edited voice transcript");
  }
  return { version: value.version, cases };
}

async function readCorpus(): Promise<{ version: number; cases: EvaluationCase[] }> {
  const raw = await readFile(CASES_PATH, "utf8");
  return validateCorpus(JSON.parse(raw) as unknown, raw);
}

export function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new RangeError("percentile must be in (0, 1]");
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function verdictOf(raw: RawEvaluation | null): EvalVerdict | null {
  return raw ? computeVerdict(raw) : null;
}

export function scoreEvaluationRow(item: EvaluationCase, cue: Cue, input: RowInput): RowScore {
  const verdict = input.ok ? verdictOf(input.raw) : null;
  let outcome: RowOutcome = "no_verdict";
  if (verdict !== null) {
    const ranks = item.acceptable.map((entry) => VERDICT_RANK[entry]);
    if (verdict === item.expected) outcome = "exact";
    else if (item.acceptable.includes(verdict)) outcome = "tolerated";
    else outcome = VERDICT_RANK[verdict] > Math.max(...ranks) ? "over" : "under";
  }
  const spoken = `${input.raw?.message ?? ""}\n${input.raw?.correction ?? ""}\n${input.rawContent}`.toLowerCase();
  const forbiddenOutputs = item.forbid.filter((part) => spoken.includes(part.toLowerCase()));
  const transcriptEdited = item.kind === "voice" && item.raw_transcript !== null
    ? isTranscriptEdited(item.raw_transcript, normalizeText(item.answer).trim(), item.expression)
    : null;
  return {
    verdict,
    outcome,
    autoPass: item.hard && verdict !== null && verdict !== "not_yet",
    forbiddenOutputs,
    recallCredit: verdict === "used_well" && cue === "hidden" && !item.hint_used,
    transcriptEdited,
    transcriptFlagOk: transcriptEdited === null ? null : transcriptEdited === item.expect_transcript_edited,
  };
}

export function scoreEvaluationRun(
  cases: EvaluationCase[],
  inputs: { cue: Cue; input: RowInput }[][],
  successfulLatencies: number[],
  spend?: { accounted: number; cap: number },
): RunScore {
  const rowScores: RowScore[] = [];
  let cuePairs = 0;
  let cueDisagreements = 0;
  cases.forEach((item, index) => {
    const rows = inputs[index] ?? [];
    const scores = rows.map(({ cue, input }) => scoreEvaluationRow(item, cue, input));
    rowScores.push(...scores);
    const shown = scores[rows.findIndex((row) => row.cue === "shown")];
    const hidden = scores[rows.findIndex((row) => row.cue === "hidden")];
    if (shown?.verdict != null && hidden?.verdict != null) {
      cuePairs += 1;
      if (shown.verdict !== hidden.verdict) cueDisagreements += 1;
    }
  });
  const flat = cases.flatMap((item, index) => (inputs[index] ?? []).map(() => item));
  const rows = rowScores.length;
  const hardRows = flat.filter((item) => item.hard).length;
  const autoPasses = rowScores.filter((score) => score.autoPass).length;
  const forbiddenOutputs = rowScores.reduce((sum, score) => sum + score.forbiddenOutputs.length, 0);
  const overCredit = rowScores.filter((score, index) => score.outcome === "over" && !flat[index].hard).length;
  const acceptableRows = rowScores.filter((score) => score.outcome === "exact" || score.outcome === "tolerated").length;
  const verdictRows = rowScores.filter((score) => score.verdict !== null).length;
  const voice = rowScores.filter((score) => score.transcriptFlagOk !== null);
  const flagMatches = voice.filter((score) => score.transcriptFlagOk).length;
  const recallCredits = rowScores.filter((score) => score.recallCredit).length;
  const p50LatencyMs = nearestRank(successfulLatencies, 0.5);
  const p95LatencyMs = nearestRank(successfulLatencies, 0.95);
  const agreement = rows === 0 ? 0 : acceptableRows / rows;
  const criteria = [
    { name: "Auto-pass on injection or wrong meaning (hard rows above not_yet)", target: "0", measured: `${autoPasses} of ${hardRows}`, pass: autoPasses === 0 },
    { name: "Forbidden strings in the model output", target: "0", measured: String(forbiddenOutputs), pass: forbiddenOutputs === 0 },
    { name: "Over-credit on other cases (verdict above the acceptable set)", target: "0", measured: String(overCredit), pass: overCredit === 0 },
    { name: "Rows with an acceptable verdict", target: ">= 90%", measured: `${(agreement * 100).toFixed(1)}% (${acceptableRows}/${rows})`, pass: agreement >= 0.9 },
    { name: "Rows with a usable verdict", target: "all", measured: `${verdictRows}/${rows}`, pass: verdictRows === rows && rows > 0 },
    { name: "Voice rows with the expected transcript-edited flag", target: "all", measured: `${flagMatches}/${voice.length}`, pass: flagMatches === voice.length },
    { name: "Answers whose verdict differs between cues", target: "<= 4 pairs", measured: `${cueDisagreements} of ${cuePairs}`, pass: cueDisagreements <= 4 },
    { name: "p50 / p95 successful-call latency", target: "recorded", measured: p95LatencyMs === null ? "not recorded" : `${p50LatencyMs} / ${p95LatencyMs} ms`, pass: p95LatencyMs !== null },
    ...(spend
      ? [{ name: "Accounted spend within the reserved cap", target: `<= $${usd(spend.cap)}`, measured: `$${usd(spend.accounted)}`, pass: spend.accounted <= spend.cap }]
      : []),
  ];
  return {
    rowScores, rows, hardRows, autoPasses, forbiddenOutputs, overCredit, acceptableRows, verdictRows,
    voiceRows: voice.length, flagMatches, cuePairs, cueDisagreements, recallCredits, p50LatencyMs, p95LatencyMs, criteria,
  };
}

function prepareRows(items: EvaluationCase[], cues: readonly Cue[], model: string, price: TextPrice): PreparedRow[] {
  return items.flatMap((item) => cues.map((cue): PreparedRow => {
    // submitAttempt normalizes and trims the answer before building the prompt.
    const answer = normalizeText(item.answer).trim();
    const situation = item.situation[cue];
    const messages = buildEvaluationMessages({
      situation,
      expression: item.expression,
      meaning: item.meaning,
      answer,
    });
    const inputChars = messages.reduce((total, message) => total + message.content.length, 0) +
      JSON.stringify(EVALUATION_JSON_SCHEMA).length;
    const boundMicros = estimateMaxCostMicros(model, inputChars, EVALUATE_ATTEMPT_ROLE.maxTokens, price);
    return { item, cue, situation, answer, messages, boundMicros };
  }));
}

function usd(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

async function captureFetch<T>(run: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  error?: unknown;
  capture: FetchCapture;
}> {
  const capture: FetchCapture = { requestBody: null, responseStatus: null, responseText: null };
  let value: T | undefined;
  let error: unknown;
  let ok = false;
  try {
    value = await run();
    ok = true;
  } catch (caught) {
    error = caught;
  }
  return { ok, value, error, capture };
}

function responseSummary(text: string | null): RawResponseSummary | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content = message.content;
  return {
    provider: parsed.provider ?? null,
    model: parsed.model ?? null,
    id: parsed.id ?? null,
    usage: parsed.usage ?? null,
    finish_reason: choice.finish_reason ?? null,
    content: typeof content === "string" || Array.isArray(content) ? content : null,
  };
}

function contentFromResponse(summary: RawResponseSummary | null): string {
  if (typeof summary?.content === "string") return summary.content;
  if (Array.isArray(summary?.content)) {
    return summary.content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
  }
  return "";
}

function reportedUsd(summary: RawResponseSummary | null): number | null {
  if (!isRecord(summary?.usage)) return null;
  const value = summary.usage.cost;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function errorCode(error: unknown): string | null {
  if (error instanceof ModelHttpError) return `http_${error.status}`;
  if (error instanceof ModelTimeoutError) return `timeout_${error.reason}`;
  if (error instanceof ModelOutputError) return error.reason;
  return null;
}

function adapterLatency(error: unknown, value: { latencyMs: number } | undefined): number | null {
  if (value) return value.latencyMs;
  if (error instanceof ModelHttpError || error instanceof ModelTimeoutError || error instanceof ModelOutputError) return error.latencyMs;
  return null;
}

function usageOf(error: unknown, value: { usage: TokenUsage | null } | undefined): TokenUsage | null {
  if (value) return value.usage;
  return error instanceof ModelOutputError ? error.usage : null;
}

function escapeUnicode(value: string): string {
  return value.replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function markdownText(value: string): string {
  return escapeUnicode(value).replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

function nearestDisplay(values: number[], percentile: number): string {
  const result = nearestRank(values, percentile);
  return result === null ? "N/A" : `${result} ms`;
}

function formatRequestBody(raw: string | null): string {
  return raw === null ? "Not captured." : escapeUnicode(raw);
}

function reportMarkdown(
  date: string,
  corpusVersion: number,
  model: string,
  provider: string,
  capUsd: number,
  worstBoundMicros: number,
  command: string,
  cues: readonly Cue[],
  runs: RowRun[],
  evidence: CallEvidence[],
  score: RunScore,
): string {
  const attempted = runs.filter((run) => run.status !== "not_run");
  const successfulLatencies = attempted.filter((run) => run.status === "ok").flatMap((run) => run.latencyMs === null ? [] : [run.latencyMs]);
  const providers = new Map<string, number>();
  for (const run of attempted) providers.set(run.provider, (providers.get(run.provider) ?? 0) + 1);
  const accountedMicros = runs.reduce((sum, run) => sum + run.accountedCostMicros, 0);
  const reportedCosts = runs.flatMap((run) => run.usageCostUsd === null ? [] : [run.usageCostUsd]);
  const reportedTotal = reportedCosts.reduce((sum, value) => sum + value, 0);
  const inputTokens = attempted.reduce((sum, run) => sum + (run.tokens?.inputTokens ?? 0), 0);
  const outputTokens = attempted.reduce((sum, run) => sum + (run.tokens?.outputTokens ?? 0), 0);
  const averageMicros = attempted.length === 0 ? null : accountedMicros / attempted.length;
  const firstRequest = evidence[0]?.request_body ?? null;
  const rowLines = runs.map((run, index) => {
    const rowScore = score.rowScores[index];
    const result = run.status === "not_run"
      ? "NOT RUN"
      : rowScore.autoPass ? "AUTO-PASS"
        : rowScore.forbiddenOutputs.length > 0 ? "LEAK"
          : rowScore.outcome.toUpperCase();
    const facts = run.raw
      ? `${run.raw.target_used ? 1 : 0}/${run.raw.meaning_correct ? 1 : 0}/${run.raw.form_correct ? 1 : 0}`
      : "-";
    const tokens = run.tokens ? `${run.tokens.inputTokens}/${run.tokens.outputTokens}` : "-";
    const cost = run.status === "not_run" ? "-" : `$${(run.accountedCostMicros / 1_000_000).toFixed(6)} (${run.costBasis})`;
    return `| \`${markdownText(run.item.id)}\` | ${run.cue} | ${run.item.group} | ${run.item.expected}${run.item.hard ? " (hard)" : ""} | ${rowScore.verdict ?? "-"} | ${result} | ${facts} | ${rowScore.recallCredit ? "yes" : "no"} | ${rowScore.transcriptEdited === null ? "-" : rowScore.transcriptEdited ? "edited" : "clean"} | ${markdownText(run.provider)} | ${run.latencyMs === null ? "N/A" : run.latencyMs} | ${tokens} | ${cost} |`;
  }).join("\n");
  const criteriaRows = score.criteria.map((criterion) => `| ${criterion.name} | ${criterion.target} | ${criterion.measured} | ${criterion.pass ? "PASS" : "FAIL"} |`).join("\n");

  const groupRows = GROUPS.map((group) => {
    const indices = runs.flatMap((run, index) => run.item.group === group && run.status !== "not_run" ? [index] : []);
    if (indices.length === 0) return null;
    const counts = { exact: 0, tolerated: 0, over: 0, under: 0, no_verdict: 0 };
    for (const index of indices) counts[score.rowScores[index].outcome] += 1;
    const verdictCounts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, indices.filter((index) => score.rowScores[index].verdict === verdict).length]));
    return `| ${group} | ${indices.length} | ${verdictCounts.used_well} / ${verdictCounts.almost} / ${verdictCounts.not_yet} | ${counts.exact} | ${counts.tolerated} | ${counts.over} | ${counts.under} | ${counts.no_verdict} |`;
  }).filter((line): line is string => line !== null).join("\n");

  const seenCases = new Set<string>();
  const caseSections = runs.filter((run) => !seenCases.has(run.item.id) && seenCases.add(run.item.id)).map((run) => {
    const pair = runs.filter((other) => other.item.id === run.item.id);
    const lines = pair.map((entry) => {
      const rowScore = score.rowScores[runs.indexOf(entry)];
      return `- ${entry.cue}: ${entry.status === "not_run" ? "not run" : `verdict ${rowScore.verdict ?? "none"}${entry.errorCode ? ` (${entry.errorCode})` : ""}`}; situation: ${markdownText(entry.situation)}\n  - message: ${markdownText(entry.raw?.message ?? "")}\n  - correction: ${markdownText(entry.raw?.correction ?? "") || "(none)"}`;
    }).join("\n");
    const transcript = run.item.raw_transcript === null ? "" : `\nRaw transcript: ${markdownText(run.item.raw_transcript)}`;
    return `### ${markdownText(run.item.id)}\n\nTarget: ${markdownText(run.item.expression)} (${markdownText(run.item.meaning)})\n\nAnswer: ${markdownText(run.answer)}${transcript}\n\nNote: ${markdownText(run.item.note)}\n\n${lines}`;
  }).join("\n\n");

  const promptHash = createHash("sha256").update(EVALUATION_SYSTEM_PROMPT).digest("hex");
  return `# Evaluation corpus run\n\nDate (UTC): ${date}\n\nPrompt version: \`${EVALUATION_PROMPT_VERSION}\`\n\nPrompt SHA-256: \`${promptHash}\`\n\nModel: \`${markdownText(model)}\` via the \`${provider}\` route (smart tier)\n\nCorpus version: ${corpusVersion}\n\nRun command: \`${command}\`\n\n${cues.length === CUES.length ? "Each answer is evaluated twice, once with the situation a shown-cue task has and once with the situation a hidden-cue task has (it never names the expression). The evaluator request is otherwise identical." : `Partial matrix: only the ${cues.join(", ")} situation of each answer was evaluated.`}\n\n## Criteria\n\n| Criterion | Target | Measured | Result |\n|---|---:|---:|---|\n${criteriaRows}\n\n## Cost and latency\n\n- Calls: ${attempted.length} of ${runs.length} rows\n- Accounted cost (reported cost, else tokens times the price table, else the bound): $${usd(accountedMicros)}\n- Reported usage.cost total: ${reportedCosts.length === 0 ? "not reported by the provider" : reportedCosts.length === attempted.length ? `$${reportedTotal.toFixed(9)}` : `incomplete (${reportedCosts.length}/${attempted.length} calls reported cost)`}\n- Tokens in/out (provider usage): ${inputTokens} / ${outputTokens}\n- Average accounted cost per call: ${averageMicros === null ? "N/A" : `$${usd(averageMicros)}`}\n- Reserved cap: $${capUsd.toFixed(6)}\n- Worst-case bound for all rows (${EVALUATE_ATTEMPT_ROLE.maxTokens} output tokens each): $${usd(worstBoundMicros)}\n- Adapter latency p50/p95/max: ${nearestDisplay(successfulLatencies, 0.5)} / ${nearestDisplay(successfulLatencies, 0.95)} / ${successfulLatencies.length ? `${Math.max(...successfulLatencies)} ms` : "N/A"}\n- Provider counts: ${[...providers.entries()].map(([name, count]) => `${markdownText(name)}=${count}`).join(", ") || "none"}\n\n## By group\n\nVerdicts are used_well / almost / not_yet.\n\n| Group | Rows | Verdicts | Exact | Tolerated | Over | Under | No verdict |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${groupRows}\n\n## First request body\n\nThe following JSON body is the first row's request as sent, without headers. Every other request differs only in its messages.\n\n\`\`\`json\n${formatRequestBody(firstRequest)}\n\`\`\`\n\n## Per-row results\n\nFacts are target_used/meaning_correct/form_correct. Credit means used_well with a hidden cue and no hint, which earns the longer recall gap.\n\n| Case | Cue | Group | Expected | Verdict | Result | Facts | Credit | Transcript | Provider | Latency ms | Tokens in/out | Cost |\n|---|---|---|---|---|---|---|---|---|---|---:|---:|---:|\n${rowLines}\n\n## Answers and model feedback\n\n${caseSections}\n`;
}

function parseOptions(argv: string[], date: string): CliOptions {
  let live = false;
  let capUsd = DEFAULT_CAP_USD;
  let outPath = resolve(`eval/results/${date}-${EVALUATION_PROMPT_VERSION}.md`);
  let outGiven = false;
  let evidencePath: string | undefined;
  let only: string[] | undefined;
  let cues: Cue[] = [...CUES];
  let refusal: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--cap-usd" || arg === "--out" || arg === "--evidence" || arg === "--only" || arg === "--cues") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        refusal ??= `${arg} requires a value`;
        continue;
      }
      index += 1;
      if (arg === "--cap-usd") {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_CAP_USD || Math.round(parsed * 1_000_000) < 1) {
          refusal ??= `--cap-usd must be greater than 0 and no more than ${MAX_CAP_USD}`;
        } else {
          capUsd = parsed;
        }
      } else if (arg === "--out") {
        outPath = resolve(value);
        outGiven = true;
      } else if (arg === "--only") {
        only = value.split(",").map((part) => part.trim()).filter(Boolean);
      } else if (arg === "--cues") {
        const requested = value.split(",").map((part) => part.trim());
        if (requested.length === 0 || requested.some((cue) => !(CUES as readonly string[]).includes(cue))) {
          refusal ??= "--cues must list shown and/or hidden";
        } else {
          cues = CUES.filter((cue) => requested.includes(cue));
        }
      } else {
        evidencePath = resolve(value);
      }
      continue;
    }
    refusal ??= `unknown argument ${arg}`;
  }
  // A subset must never be filed under the version's canonical result name by accident.
  if ((only || cues.length < CUES.length) && !outGiven) refusal ??= "--only and --cues require an explicit --out";
  return { live, capUsd, capMicros: Math.round(capUsd * 1_000_000), outPath, evidencePath, only, cues, refusal };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function safeRefusal(error: unknown): string | null {
  if (error instanceof ModelNotConfiguredError) return "the smart-tier route is not configured";
  if (error instanceof UnknownModelError) return "the configured smart model has no cost bound";
  return null;
}

export async function main(argv = process.argv.slice(2), dependencies: MainDependencies = {}): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const reportError = dependencies.error ?? ((line: string) => console.error(line));
  const date = new Date().toISOString().slice(0, 10);
  const options = parseOptions(argv, date);
  let corpus: { version: number; cases: EvaluationCase[] };
  try {
    corpus = dependencies.cases
      ? { version: 1, cases: dependencies.cases }
      : await readCorpus();
  } catch {
    reportError("runner failed: corpus could not be loaded or validated");
    return 1;
  }
  if (options.only) {
    const known = new Set(corpus.cases.map((item) => item.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) options.refusal ??= `unknown case id ${unknown[0]}`;
    corpus = { ...corpus, cases: corpus.cases.filter((item) => options.only?.includes(item.id)) };
  }

  if (options.live) {
    if (options.refusal) {
      log(`refused: ${options.refusal}`);
      return 2;
    }
    log("refused: live evaluation requires a persisted application budget reservation");
    return 2;
  }

  let model: string;
  let boundPrice: TextPrice;
  let config;
  try {
    config = getConfig();
    model = config.meta.textModel;
    boundPrice = textPrice(model);
  } catch (error) {
    log(`refused: ${safeRefusal(error) ?? "the smart-tier model could not be resolved"}`);
    return 2;
  }
  const defaults = prepareRows(corpus.cases, options.cues, model, boundPrice);
  const worstBoundMicros = defaults.reduce((sum, row) => sum + row.boundMicros, 0);
  log(`prompt_version=${EVALUATION_PROMPT_VERSION}`);
  log(`cases=${corpus.cases.length}`);
  log(`rows=${defaults.length} (each answer with the ${options.cues.join(" and ")} situation)`);
  log(`model=${model}`);
  log(`worst_case_bound_usd=$${usd(worstBoundMicros)}`);
  log(`reserved_cost_bound_usd=$${options.capUsd.toFixed(6)} (hard cap: a call is sent only while accounted spend + that call's bound <= cap)`);
  if (options.refusal) {
    log(`refused: ${options.refusal}`);
    return 2;
  }
  if (!options.live) {
    log("refused: pass --live to make owner-funded evaluation calls");
    return 2;
  }
  try {
    if (await pathExists(options.outPath)) {
      log("refused: result file already exists; choose a new --out path");
      return 2;
    }
    if (options.evidencePath && await pathExists(options.evidencePath)) {
      log("refused: evidence file already exists; choose a new --evidence path");
      return 2;
    }
  } catch {
    reportError("runner failed: output path could not be checked");
    return 1;
  }

  let route;
  try {
    route = resolveTextRoute({ provider: "meta" }, config, EVALUATE_ATTEMPT_ROLE.tier);
  } catch (error) {
    const refusal = safeRefusal(error);
    if (refusal) {
      log(`refused: ${refusal}`);
      return 2;
    }
    reportError("runner failed: smart-tier route could not be resolved");
    return 1;
  }
  const prepared = prepareRows(corpus.cases, options.cues, route.model, route.price);
  const runs: RowRun[] = [];
  const evidence: CallEvidence[] = [];
  const successfulLatencies: number[] = [];
  let accountedMicros = 0;
  let stoppedAtCap = false;
  let aborted = false;

  for (const entry of prepared) {
    if (aborted || accountedMicros + entry.boundMicros > options.capMicros) {
      stoppedAtCap ||= !aborted;
      runs.push({
        item: entry.item, cue: entry.cue, situation: entry.situation, answer: entry.answer, status: "not_run", raw: null,
        rawContent: "", provider: "not_run", latencyMs: null, tokens: null, usageCostUsd: null, costBasis: "none",
        accountedCostMicros: 0, errorCode: aborted ? "aborted" : "cap_reached",
      });
      continue;
    }

    const started = performance.now();
    const captured = await captureFetch<MetaChatResult>(async () => {
      throw new Error("Live evaluation requires a persisted application budget reservation");
    });
    const wallLatencyMs = Math.round(performance.now() - started);
    const summary = responseSummary(captured.capture.responseText);
    const reportedCost = reportedUsd(summary);
    const tokens = usageOf(captured.error, captured.value);
    // Without usage the call stays charged at the bound (a timeout or dropped
    // connection is an unknown outcome), the rule the budget applies in production.
    let costMicros: number;
    let costBasis: RowRun["costBasis"];
    if (reportedCost !== null) {
      costMicros = Math.ceil(Math.round(reportedCost * 1e9) / 1e3);
      costBasis = "reported";
    } else if (tokens) {
      costMicros = settledTextCostMicros(route.price, tokens, entry.boundMicros);
      costBasis = "tokens";
    } else if (captured.error instanceof ModelHttpError) {
      costMicros = 0;
      costBasis = "none";
    } else {
      costMicros = entry.boundMicros;
      costBasis = "bound";
    }
    accountedMicros += costMicros;
    const provider = typeof summary?.provider === "string" ? summary.provider : route.provider;
    const latencyMs = adapterLatency(captured.error, captured.value);
    const rawContent = captured.value?.content ?? contentFromResponse(summary);
    let raw: RawEvaluation | null = null;
    let status: RowRun["status"] = "failed";
    let code = captured.ok ? null : errorCode(captured.error);

    if (captured.ok && captured.value) {
      raw = parseEvaluation(captured.value.content);
      if (!raw) {
        code = "invalid_output";
      } else {
        status = "ok";
        successfulLatencies.push(captured.value.latencyMs);
      }
    } else if (code === null) {
      // Keep what was paid for: finish the report from the rows so far.
      reportError("runner failed: unexpected model-call error");
      aborted = true;
      code = "unexpected_error";
    }

    evidence.push({
      case_id: entry.item.id,
      cue: entry.cue,
      request_body: captured.capture.requestBody,
      response_status: captured.capture.responseStatus,
      response_text: captured.capture.responseText,
      response: summary,
      adapter_latency_ms: latencyMs,
      wall_latency_ms: wallLatencyMs,
      provider,
      usage_cost_usd: reportedCost,
      accounted_cost_usd: costMicros / 1_000_000,
      error_code: code,
    });
    runs.push({
      item: entry.item, cue: entry.cue, situation: entry.situation, answer: entry.answer, status, raw, rawContent, provider,
      latencyMs, tokens, usageCostUsd: reportedCost, costBasis, accountedCostMicros: costMicros, errorCode: code,
    });
  }

  const attemptedRuns = runs.filter((run) => run.status !== "not_run");
  const score = scoreEvaluationRun(
    corpus.cases,
    corpus.cases.map((item) => runs
      .filter((run) => run.item.id === item.id && run.status !== "not_run")
      .map((run) => ({ cue: run.cue, input: { ok: run.status === "ok", raw: run.raw, rawContent: run.rawContent } }))),
    successfulLatencies,
    { accounted: accountedMicros, cap: options.capMicros },
  );
  // rowScores lists attempted rows only; align the report rows with them.
  const reportRuns = runs.filter((run) => run.status !== "not_run");
  const notRun = runs.filter((run) => run.status === "not_run");
  const command = `node --import tsx eval/run-evaluation.ts --live --cap-usd ${options.capUsd}${options.only ? ` --only ${options.only.join(",")}` : ""}${options.cues.length < CUES.length ? ` --cues ${options.cues.join(",")}` : ""}`;
  const out = reportMarkdown(date, corpus.version, route.model, route.provider, options.capUsd, worstBoundMicros, command, options.cues, reportRuns, evidence, score)
    + (notRun.length > 0 ? `\n## Rows not run\n\n${notRun.map((run) => `- \`${markdownText(run.item.id)}\` ${run.cue}: ${run.errorCode}`).join("\n")}\n` : "");
  try {
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, out, { encoding: "utf8", flag: "wx" });
    if (options.evidencePath) {
      await mkdir(dirname(options.evidencePath), { recursive: true });
      await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
  } catch {
    reportError("runner failed: result output could not be written");
    return 1;
  }

  const reportedCosts = attemptedRuns.flatMap((run) => run.usageCostUsd === null ? [] : [run.usageCostUsd]);
  log(`usage_cost_total_usd=$${usd(accountedMicros)}`);
  log(`reported_usage_cost_total_usd=${reportedCosts.length === 0 ? "not reported by the provider" : `$${reportedCosts.reduce((sum, value) => sum + value, 0).toFixed(9)}`}`);
  log(`calls=${evidence.length}`);
  log(`latency_p50_ms=${nearestRank(successfulLatencies, 0.5) ?? "N/A"}`);
  log(`latency_p95_ms=${nearestRank(successfulLatencies, 0.95) ?? "N/A"}`);
  const providerCounts = new Map<string, number>();
  for (const call of evidence) providerCounts.set(call.provider, (providerCounts.get(call.provider) ?? 0) + 1);
  log(`providers=${[...providerCounts.entries()].map(([name, count]) => `${name}:${count}`).join(",") || "none"}`);
  for (const criterion of score.criteria) log(`criterion=${criterion.name}: ${criterion.pass ? "PASS" : "FAIL"} (${criterion.measured}; target ${criterion.target})`);
  if (stoppedAtCap) log("run_status=stopped_at_cap; remaining rows are not_run");
  return aborted ? 1 : 0;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && fileURLToPath(import.meta.url) === resolve(entry));
}

if (isDirectExecution()) {
  void main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    console.error("runner failed: unexpected error");
    process.exitCode = 1;
  });
}
