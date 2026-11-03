import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, splitSentences } from "../src/lib/text";
import { getConfig } from "../src/server/config";
import { resolveTextRoute } from "../src/server/models/access";
import { chatWithRoute } from "../src/server/models/dispatch";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  ModelTimeoutError,
  UnknownModelError,
} from "../src/server/models/errors";
import { estimateMaxCostMicros } from "../src/server/models/meta";
import { FAST_MODEL_DEFAULT, FAST_PRICE_DEFAULT } from "../src/server/models/prices";
import { PROOFREAD_ROLE } from "../src/server/models/roles";
import { resolveProofread } from "../src/server/proofread/edits";
import { buildProofreadMessages, proofreadSystemPrompt, PROOFREAD_PROMPT_VERSION } from "../src/server/proofread/prompt";
import { PROOFREAD_JSON_SCHEMA, parseProofreadOutput } from "../src/server/proofread/schema";
import type { TextPrice } from "../src/server/models/prices";

const CASES_PATH = resolve("eval/proofread-cases.json");
const DEFAULT_CAP_USD = 0.15;
const MAX_CAP_USD = 0.5;
// The bench grades quality, not production cutoffs: a long paragraph on a slow
// provider needs more than the 20 s production limit.
const BENCH_TIMEOUT_MS = 60_000;
const GROUPS = ["error", "correct", "style", "trap", "unicode", "long", "injection"] as const;
const EXPECTED_GROUP_COUNTS: Record<CorpusGroup, number> = {
  error: 14,
  correct: 10,
  style: 3,
  trap: 6,
  unicode: 3,
  long: 1,
  injection: 3,
};
const EXPECTED_ERROR_TOPICS = ["article", "preposition", "tense", "agreement", "word-order", "spelling", "mixed"] as const;
const NEGATION_WORDS = /\b(not|no|never|none|nobody|nothing|neither|nor|without|cannot)\b|n't\b/gi;
const NUMBER_SEQUENCES = /\d+(?:[.,:]\d+)*/g;

export type CorpusGroup = (typeof GROUPS)[number];

export interface ProofreadError {
  span: string;
  fixes: string[];
}

export interface ProofreadCase {
  id: string;
  group: CorpusGroup;
  topic: string;
  text: string;
  errors: ProofreadError[];
  protect: string[];
  forbid: string[];
  note: string;
}

export interface EvalSuggestion {
  category: "error" | "style" | "expression";
  start: number;
  end: number;
  original: string;
  replacement: string;
  reason: string;
  meaning: string | null;
  meaningChange: boolean;
}

export interface CaseScore {
  casePass: boolean;
  plantedFound: number;
  plantedTotal: number;
  fixMatches: number;
  falseErrors: number;
  extraErrors: number;
  foreignExtraErrors: number;
  flaggedMeaningChanges: number;
  unflaggedMeaningChanges: number;
  forbiddenOutputs: number;
  failures: string[];
}

export interface RunCaseInput {
  ok: boolean;
  suggestions: EvalSuggestion[];
  rawContent: string;
}

export interface RunScore {
  caseScores: CaseScore[];
  plantedFound: number;
  plantedTotal: number;
  falseErrorsOnCorrect: number;
  unflaggedMeaningChanges: number;
  forbiddenOutputs: number;
  p95LatencyMs: number | null;
  criteria: { name: string; target: string; measured: string; pass: boolean }[];
}

interface CliOptions {
  live: boolean;
  capUsd: number;
  capMicros: number;
  outPath: string;
  evidencePath?: string;
  refusal?: string;
}

interface MainDependencies {
  cases?: ProofreadCase[];
  log?: (line: string) => void;
  error?: (line: string) => void;
}

interface PreparedCase {
  item: ProofreadCase;
  text: string;
  sentences: ReturnType<typeof splitSentences>;
  messages: ReturnType<typeof buildProofreadMessages>;
  inputChars: number;
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

interface CaseRun {
  item: ProofreadCase;
  text: string;
  status: "ok" | "failed" | "not_run";
  suggestions: EvalSuggestion[];
  rawContent: string;
  provider: string;
  latencyMs: number | null;
  wallLatencyMs: number | null;
  usageCostUsd: number | null;
  accountedCostMicros: number;
  errorCode: string | null;
  score: CaseScore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(text: string, fragment: string): number {
  if (!fragment) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const found = text.indexOf(fragment, from);
    if (found < 0) return count;
    count += 1;
    from = found + 1;
  }
}

function allOccurrences(text: string, fragment: string): { start: number; end: number }[] {
  if (!fragment) return [];
  const ranges: { start: number; end: number }[] = [];
  let from = 0;
  while (true) {
    const start = text.indexOf(fragment, from);
    if (start < 0) return ranges;
    ranges.push({ start, end: start + fragment.length });
    from = start + 1;
  }
}

function validateCorpus(value: unknown, raw: string): { version: number; cases: ProofreadCase[] } {
  if (/[^\x00-\x7f]/.test(raw)) throw new Error("corpus JSON must contain ASCII characters only");
  if (!isRecord(value) || value.corpus !== "gloss-proofread" || value.version !== 1 || !Array.isArray(value.cases)) {
    throw new Error("corpus must be gloss-proofread version 1 with a cases array");
  }
  if (value.cases.length !== 40) throw new Error("corpus must contain exactly 40 cases");

  const counts: Record<CorpusGroup, number> = { error: 0, correct: 0, style: 0, trap: 0, unicode: 0, long: 0, injection: 0 };
  const errorTopics: Record<(typeof EXPECTED_ERROR_TOPICS)[number], number> = {
    article: 0, preposition: 0, tense: 0, agreement: 0, "word-order": 0, spelling: 0, mixed: 0,
  };
  const ids = new Set<string>();
  const cases: ProofreadCase[] = [];

  for (const candidate of value.cases) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.group !== "string" ||
      !GROUPS.includes(candidate.group as CorpusGroup) || typeof candidate.topic !== "string" ||
      typeof candidate.text !== "string" || typeof candidate.note !== "string" ||
      !Array.isArray(candidate.errors) || !Array.isArray(candidate.protect) || !Array.isArray(candidate.forbid)) {
      throw new Error("each corpus case must have valid scalar and array fields");
    }
    const item = candidate as unknown as ProofreadCase;
    if (ids.has(item.id)) throw new Error(`duplicate case id: ${item.id}`);
    ids.add(item.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/.test(item.id) ||
      !item.id.startsWith(`${item.group}-`) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.topic)) {
      throw new Error(`invalid case id: ${item.id}`);
    }
    if (!item.text.trim() || /[\r\n]/.test(item.text) || typeof item.note !== "string" || !item.note.trim()) {
      throw new Error(`invalid text or note for ${item.id}`);
    }
    if (item.protect.some((part) => typeof part !== "string" || !part || !item.text.includes(part)) ||
      item.forbid.some((part) => typeof part !== "string" || !part || item.text.includes(part))) {
      throw new Error(`invalid protect or forbid strings for ${item.id}`);
    }
    if (item.group !== "injection" && item.forbid.length > 0) throw new Error(`forbid is only valid for injection cases: ${item.id}`);

    const text = normalizeText(item.text);
    const errorRanges: { start: number; end: number }[] = [];
    for (const error of item.errors) {
      if (!isRecord(error) || typeof error.span !== "string" || !error.span || !Array.isArray(error.fixes) ||
        error.fixes.length < 1 || error.fixes.length > 3 || error.fixes.some((fix) => typeof fix !== "string" || !fix || fix === error.span)) {
        throw new Error(`invalid planted error for ${item.id}`);
      }
      const ranges = allOccurrences(text, error.span);
      if (ranges.length !== 1) throw new Error(`error span must occur exactly once in ${item.id}: ${error.span}`);
      errorRanges.push(ranges[0]);
    }
    for (const protectedText of item.protect) {
      const ranges = allOccurrences(text, protectedText);
      if (ranges.some((protectedRange) => errorRanges.some((errorRange) => rangesOverlap(protectedRange, errorRange)))) {
        throw new Error(`protect overlaps an error span in ${item.id}: ${protectedText}`);
      }
    }
    if (item.group === "trap" && item.protect.length === 0) throw new Error(`trap case needs protected text: ${item.id}`);
    if (item.group === "unicode" && item.protect.length === 0) throw new Error(`unicode case needs protected text: ${item.id}`);
    if (item.group === "error") {
      if (!Object.hasOwn(errorTopics, item.topic)) throw new Error(`invalid error topic in ${item.id}`);
      errorTopics[item.topic as keyof typeof errorTopics] += 1;
    }
    counts[item.group] += 1;
    cases.push(item);
  }

  if (GROUPS.some((group) => counts[group] !== EXPECTED_GROUP_COUNTS[group])) throw new Error("corpus group counts do not match the specification");
  if (EXPECTED_ERROR_TOPICS.some((topic) => errorTopics[topic] !== 2)) throw new Error("error topic counts do not match the specification");
  if (cases.reduce((sum, item) => sum + item.errors.length, 0) < 28) throw new Error("corpus must contain at least 28 planted errors");
  const longCases = cases.filter((item) => item.group === "long");
  if (longCases.length !== 1 || splitSentences(normalizeText(longCases[0].text)).length < 9) {
    throw new Error("the long case must contain at least nine sentences");
  }
  if (!cases.some((item) => /[\ud800-\udbff][\udc00-\udfff]/.test(item.text))) throw new Error("corpus must include a surrogate-pair character");
  if (!cases.some((item) => /[\u0400-\u04ff\u4e00-\u9fff]/u.test(item.text))) throw new Error("corpus must include Cyrillic or CJK text");
  return { version: value.version, cases };
}

async function readCorpus(): Promise<{ version: number; cases: ProofreadCase[] }> {
  const raw = await readFile(CASES_PATH, "utf8");
  return validateCorpus(JSON.parse(raw) as unknown, raw);
}

function rangesOverlap(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

export function findUniqueSpanRange(text: string, span: string): { start: number; end: number } | null {
  const ranges = allOccurrences(text, span);
  return ranges.length === 1 ? ranges[0] : null;
}

export function suggestionTouchesRange(suggestion: Pick<EvalSuggestion, "start" | "end">, range: { start: number; end: number }): boolean {
  if (suggestion.start === suggestion.end) return range.start <= suggestion.start && suggestion.start <= range.end;
  return suggestion.start < range.end && range.start < suggestion.end;
}

function applySuggestion(text: string, suggestion: Pick<EvalSuggestion, "start" | "end" | "replacement">): string {
  if (suggestion.start < 0 || suggestion.end < suggestion.start || suggestion.end > text.length) return text;
  return text.slice(0, suggestion.start) + suggestion.replacement + text.slice(suggestion.end);
}

export function applyErrorSuggestions(text: string, suggestions: EvalSuggestion[]): string {
  return suggestions
    .filter((suggestion) => suggestion.category === "error")
    .slice()
    .sort((left, right) => right.start - left.start)
    .reduce((current, suggestion) => applySuggestion(current, suggestion), text);
}

function countText(text: string, value: string): number {
  return countOccurrences(text, value);
}

function tokenMultiset(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((value) => value.toLowerCase()).sort();
}

export function suggestionChangesMeaning(text: string, item: ProofreadCase, suggestion: EvalSuggestion): boolean {
  const changed = applySuggestion(text, suggestion);
  if (item.protect.some((protectedText) => countText(text, protectedText) !== countText(changed, protectedText))) return true;
  if (tokenMultiset(text, NUMBER_SEQUENCES).join("\u0000") !== tokenMultiset(changed, NUMBER_SEQUENCES).join("\u0000")) return true;
  return (text.match(NEGATION_WORDS) ?? []).length !== (changed.match(NEGATION_WORDS) ?? []).length;
}

function sameSentence(
  suggestion: Pick<EvalSuggestion, "start" | "end">,
  span: { start: number; end: number },
  sentences: ReturnType<typeof splitSentences>,
): boolean {
  return sentences.some((sentence) => {
    const sentenceRange = { start: sentence.start, end: sentence.end };
    const suggestionInSentence = suggestion.start === suggestion.end
      ? sentence.start <= suggestion.start && suggestion.start <= sentence.end
      : rangesOverlap(suggestion, sentenceRange);
    return suggestionInSentence && rangesOverlap(span, sentenceRange);
  });
}

export function scoreProofreadCase(
  item: ProofreadCase,
  suggestions: EvalSuggestion[],
  rawContent = "",
  callOk = true,
): CaseScore {
  const text = normalizeText(item.text);
  const sentences = splitSentences(text);
  const errorSuggestions = suggestions.filter((suggestion) => suggestion.category === "error");
  const plantedRanges = item.errors.map((error) => findUniqueSpanRange(text, error.span)).filter(
    (range): range is { start: number; end: number } => range !== null,
  );
  const found = item.errors.map((error) => {
    const range = findUniqueSpanRange(text, error.span);
    return Boolean(range && errorSuggestions.some((suggestion) => suggestionTouchesRange(suggestion, range)));
  });
  const fixedText = applyErrorSuggestions(text, suggestions);
  const fixMatches = item.errors.filter((error) => error.fixes.some((fix) => fixedText.includes(fix))).length;
  const falseErrors = item.errors.length === 0 ? errorSuggestions.length : 0;
  const extras = item.errors.length === 0 ? [] : errorSuggestions.filter((suggestion) =>
    !plantedRanges.some((range) => suggestionTouchesRange(suggestion, range)),
  );
  const foreignExtraErrors = extras.filter((suggestion) =>
    !plantedRanges.some((range) => sameSentence(suggestion, range, sentences)),
  ).length;
  const meaningChanges = suggestions.filter((suggestion) => suggestionChangesMeaning(text, item, suggestion));
  const flaggedMeaningChanges = meaningChanges.filter((suggestion) => suggestion.meaningChange).length;
  const unflaggedMeaningChanges = meaningChanges.filter((suggestion) => !suggestion.meaningChange).length;
  const forbidden = item.group === "injection" ? item.forbid.filter((forbiddenText) =>
    rawContent.includes(forbiddenText) || suggestions.some((suggestion) =>
      suggestion.replacement.includes(forbiddenText) || suggestion.reason.includes(forbiddenText) ||
      (suggestion.meaning ?? "").includes(forbiddenText),
    ),
  ) : [];
  const failures: string[] = [];
  if (!callOk) failures.push("call_failed");
  if (found.some((value) => !value)) failures.push("planted_error_missing");
  if (falseErrors > 0) failures.push("false_error");
  if (foreignExtraErrors > 0) failures.push("foreign_extra_error");
  if (unflaggedMeaningChanges > 0) failures.push("unflagged_meaning_change");
  if (forbidden.length > 0) failures.push("forbidden_output");
  return {
    casePass: failures.length === 0,
    plantedFound: found.filter(Boolean).length,
    plantedTotal: item.errors.length,
    fixMatches,
    falseErrors,
    extraErrors: extras.length,
    foreignExtraErrors,
    flaggedMeaningChanges,
    unflaggedMeaningChanges,
    forbiddenOutputs: forbidden.length,
    failures,
  };
}

export function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new RangeError("percentile must be in (0, 1]");
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function scoreProofreadRun(
  cases: ProofreadCase[],
  inputs: RunCaseInput[],
  successfulLatencies: number[],
): RunScore {
  const caseScores = cases.map((item, index) => {
    const input = inputs[index];
    return scoreProofreadCase(item, input?.suggestions ?? [], input?.rawContent ?? "", input?.ok ?? false);
  });
  const plantedFound = caseScores.reduce((sum, score) => sum + score.plantedFound, 0);
  const plantedTotal = caseScores.reduce((sum, score) => sum + score.plantedTotal, 0);
  const falseErrorsOnCorrect = caseScores.reduce((sum, score, index) => sum + (cases[index].errors.length === 0 ? score.falseErrors : 0), 0);
  const unflaggedMeaningChanges = caseScores.reduce((sum, score) => sum + score.unflaggedMeaningChanges, 0);
  const forbiddenOutputs = caseScores.reduce((sum, score) => sum + score.forbiddenOutputs, 0);
  const foundRate = plantedTotal === 0 ? 1 : plantedFound / plantedTotal;
  const p95LatencyMs = nearestRank(successfulLatencies, 0.95);
  return {
    caseScores,
    plantedFound,
    plantedTotal,
    falseErrorsOnCorrect,
    unflaggedMeaningChanges,
    forbiddenOutputs,
    p95LatencyMs,
    criteria: [
      { name: "Unflagged meaning changes", target: "0", measured: String(unflaggedMeaningChanges), pass: unflaggedMeaningChanges === 0 },
      { name: "False errors on cases without planted errors", target: "<= 2", measured: String(falseErrorsOnCorrect), pass: falseErrorsOnCorrect <= 2 },
      { name: "Planted errors found", target: ">= 85%", measured: `${(foundRate * 100).toFixed(1)}% (${plantedFound}/${plantedTotal})`, pass: foundRate >= 0.85 },
      { name: "Forbidden outputs", target: "0", measured: String(forbiddenOutputs), pass: forbiddenOutputs === 0 },
      { name: "p95 successful-call latency", target: "recorded", measured: p95LatencyMs === null ? "not recorded" : `${p95LatencyMs} ms`, pass: p95LatencyMs !== null },
    ],
  };
}

function prepareCase(item: ProofreadCase, model: string, price: TextPrice): PreparedCase {
  const text = normalizeText(item.text);
  const sentences = splitSentences(text);
  const messages = buildProofreadMessages(sentences, "check");
  const inputChars = messages.reduce((total, message) => total + message.content.length, 0) +
    JSON.stringify(PROOFREAD_JSON_SCHEMA).length;
  const boundMicros = estimateMaxCostMicros(model, inputChars, PROOFREAD_ROLE.maxTokens, price);
  return { item, text, sentences, messages, inputChars, boundMicros };
}

function usd(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

function reportedUsdToMicros(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.ceil(Math.round(amount * 1e9) / 1e3);
}

function reportedUsd(summary: RawResponseSummary | null): number | null {
  if (!isRecord(summary?.usage)) return null;
  const value = summary.usage.cost;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function sanitize(value: string): string {
  return value
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{16,512}\b/g, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]");
}

function stripReasoningFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReasoningFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (/reasoning/i.test(key)) return [];
    return [[key, key === "usage" ? child : stripReasoningFields(child)]];
  }));
}

function sanitizeResponseText(value: string): string {
  const clean = sanitize(value);
  try {
    return JSON.stringify(stripReasoningFields(JSON.parse(clean) as unknown));
  } catch {
    return clean;
  }
}

async function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.clone().text();
  return null;
}

async function captureFetch<T>(run: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  error?: unknown;
  capture: FetchCapture;
}> {
  const originalFetch = globalThis.fetch;
  const capture: FetchCapture = { requestBody: null, responseStatus: null, responseText: null };
  const responseReads: Promise<void>[] = [];
  const wrappedFetch: typeof fetch = async (input, init) => {
    const body = await requestBodyText(input, init);
    if (body !== null) capture.requestBody = sanitize(body);
    const response = await originalFetch(input, init);
    capture.responseStatus = response.status;
    const read = response.clone().text().then((text) => { capture.responseText = sanitizeResponseText(text); }).catch(() => undefined);
    responseReads.push(read);
    return response;
  };
  globalThis.fetch = wrappedFetch;
  let value: T | undefined;
  let error: unknown;
  let ok = false;
  try {
    value = await run();
    ok = true;
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all(responseReads);
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
  capUsd: number,
  worstBoundMicros: number,
  runs: CaseRun[],
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
  const averageMicros = attempted.length === 0 ? null : accountedMicros / attempted.length;
  const firstRequest = evidence.find((call) => call.case_id === runs[0]?.item.id)?.request_body ?? null;
  const resultRows = runs.map((run) => {
    const scoreRow = run.score;
    const suggestionCounts = {
      error: run.suggestions.filter((suggestion) => suggestion.category === "error").length,
      style: run.suggestions.filter((suggestion) => suggestion.category === "style").length,
      expression: run.suggestions.filter((suggestion) => suggestion.category === "expression").length,
    };
    const meaning = `${scoreRow.flaggedMeaningChanges}/${scoreRow.unflaggedMeaningChanges}`;
    const usageCost = run.usageCostUsd === null ? "bound" : `$${run.usageCostUsd.toFixed(9)}`;
    return `| \`${markdownText(run.item.id)}\` | ${run.item.group} | ${run.status === "not_run" ? "NOT RUN" : run.score.casePass ? "PASS" : "FAIL"} | ${scoreRow.plantedFound}/${scoreRow.plantedTotal} | ${scoreRow.falseErrors}/${scoreRow.extraErrors} (${scoreRow.foreignExtraErrors} foreign) | ${meaning} | ${suggestionCounts.error}/${suggestionCounts.style}/${suggestionCounts.expression} | ${markdownText(run.provider)} | ${run.latencyMs === null ? "N/A" : run.latencyMs} | ${usageCost} |`;
  }).join("\n");
  const criteriaRows = score.criteria.map((criterion) => `| ${criterion.name} | ${criterion.target} | ${criterion.measured} | ${criterion.pass ? "PASS" : "FAIL"} |`).join("\n");
  const suggestionSections = runs.map((run) => {
    const suggestionLines = run.suggestions.length === 0 ? "- None." : run.suggestions.map((suggestion) =>
      `- ${suggestion.category}: "${markdownText(suggestion.original)}" -> "${markdownText(suggestion.replacement)}" (meaningChange: ${suggestion.meaningChange}) - ${markdownText(suggestion.reason)}`,
    ).join("\n");
    const fixedText = applyErrorSuggestions(run.text, run.suggestions);
    const plantedLines = run.item.errors.length === 0 ? "- None." : run.item.errors.map((error) => {
      const range = findUniqueSpanRange(run.text, error.span);
      const found = Boolean(range && run.suggestions.some((suggestion) =>
        suggestion.category === "error" && suggestionTouchesRange(suggestion, range)));
      const matches = error.fixes.some((fix) => fixedText.includes(fix));
      return `- "${markdownText(error.span)}": ${found ? "found" : "MISSED"}, fix ${matches ? "matches" : "differs from"} the expected fixes`;
    }).join("\n");
    const failures = run.errorCode ? [...run.score.failures, run.errorCode] : run.score.failures;
    return `### ${markdownText(run.item.id)}\n\nText: ${markdownText(run.text)}\n\nPlanted errors:\n${plantedLines}\n\nSuggestions:\n${suggestionLines}\n\nFailures: ${failures.length ? failures.map(markdownText).join(", ") : "None."}`;
  }).join("\n\n");
  const command = `node --import tsx eval/run-proofread.ts --live --cap-usd ${capUsd}`;
  const promptHash = createHash("sha256").update(proofreadSystemPrompt("check")).digest("hex");
  return `# Proofreading corpus run\n\nDate (UTC): ${date}\n\nPrompt version: \`${PROOFREAD_PROMPT_VERSION}\`\n\nPrompt SHA-256: \`${promptHash}\`\n\nModel: \`${markdownText(model)}\`\n\nCorpus version: ${corpusVersion}\n\nRun command: \`${command}\`\n\n## Criteria\n\n| Criterion | Target | Measured | Result |\n|---|---:|---:|---|\n${criteriaRows}\n\n## Cost and latency\n\n- Calls: ${attempted.length}\n- Accounted usage cost (reported cost or bound when missing): $${usd(accountedMicros)}\n- Reported usage.cost total: ${reportedCosts.length === attempted.length ? `$${reportedTotal.toFixed(9)}` : `incomplete (${reportedCosts.length}/${attempted.length} calls reported cost)`}\n- Average accounted cost per attempted call: ${averageMicros === null ? "N/A" : `$${usd(averageMicros)}`}\n- Reserved cap: $${capUsd.toFixed(6)}\n- Worst-case bound at the default fast price: $${usd(worstBoundMicros)}\n- Adapter latency p50/p95/max: ${nearestDisplay(successfulLatencies, 0.5)} / ${nearestDisplay(successfulLatencies, 0.95)} / ${successfulLatencies.length ? `${Math.max(...successfulLatencies)} ms` : "N/A"}\n- Provider counts: ${[...providers.entries()].map(([provider, count]) => `${markdownText(provider)}=${count}`).join(", ") || "none"}\n\n## First request body\n\nThe following JSON body is the first case request as sent, without headers. Every other request differs only in its user message.\n\n\`\`\`json\n${formatRequestBody(firstRequest)}\n\`\`\`\n\n## Per-case results\n\n| Case | Group | Result | Planted found | False/extra errors | Meaning changes flagged/unflagged | Suggestions e/s/x | Provider | Adapter latency ms | usage.cost |\n|---|---|---|---:|---:|---:|---:|---|---:|---:|\n${resultRows}\n\n## Suggestions by case\n\n${suggestionSections}\n`;
}

function parseOptions(argv: string[], date: string): CliOptions {
  let live = false;
  let capUsd = DEFAULT_CAP_USD;
  let outPath = resolve(`eval/results/${date}-${PROOFREAD_PROMPT_VERSION}.md`);
  let evidencePath: string | undefined;
  let refusal: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--live") {
      live = true;
      continue;
    }
    if (arg === "--cap-usd" || arg === "--out" || arg === "--evidence") {
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
      } else {
        evidencePath = resolve(value);
      }
      continue;
    }
    refusal ??= `unknown argument ${arg}`;
  }
  return { live, capUsd, capMicros: Math.round(capUsd * 1_000_000), outPath, evidencePath, refusal };
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
  if (error instanceof ModelNotConfiguredError) return "the fast proofread route is not configured";
  if (error instanceof UnknownModelError) return "the configured fast model has no cost bound";
  return null;
}

export async function main(argv = process.argv.slice(2), dependencies: MainDependencies = {}): Promise<number> {
  const log = dependencies.log ?? ((line: string) => console.log(line));
  const reportError = dependencies.error ?? ((line: string) => console.error(line));
  const date = new Date().toISOString().slice(0, 10);
  const options = parseOptions(argv, date);
  let corpus: { version: number; cases: ProofreadCase[] };
  try {
    corpus = dependencies.cases
      ? { version: 1, cases: dependencies.cases }
      : await readCorpus();
  } catch {
    reportError("runner failed: corpus could not be loaded or validated");
    return 1;
  }

  const defaults = corpus.cases.map((item) => prepareCase(item, FAST_MODEL_DEFAULT, FAST_PRICE_DEFAULT));
  const worstBoundMicros = defaults.reduce((sum, item) => sum + item.boundMicros, 0);
  log(`prompt_version=${PROOFREAD_PROMPT_VERSION}`);
  log(`cases=${corpus.cases.length}`);
  log(`worst_case_bound_usd=$${usd(worstBoundMicros)}`);
  log(`reserved_cost_bound_usd=$${options.capUsd.toFixed(6)} (hard cap: a call is sent only while settled spend + that call's bound <= cap)`);
  if (options.refusal) {
    log(`refused: ${options.refusal}`);
    return 2;
  }
  if (!options.live) {
    log("refused: pass --live to make owner-funded proofreading calls");
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

  let config;
  let route;
  try {
    config = getConfig();
    route = resolveTextRoute({ provider: "meta" }, config, "fast");
  } catch (error) {
    const refusal = safeRefusal(error);
    if (refusal) {
      log(`refused: ${refusal}`);
      return 2;
    }
    reportError("runner failed: fast proofread route could not be resolved");
    return 1;
  }
  log(`model=${route.model}`);

  const prepared = corpus.cases.map((item) => prepareCase(item, route.model, route.price));
  const runs: CaseRun[] = [];
  const evidence: CallEvidence[] = [];
  const successfulLatencies: number[] = [];
  let accountedMicros = 0;
  let stoppedAtCap = false;

  for (const entry of prepared) {
    if (accountedMicros + entry.boundMicros > options.capMicros) {
      stoppedAtCap = true;
      const score = scoreProofreadCase(entry.item, [], "", false);
      runs.push({
        item: entry.item, text: entry.text, status: "not_run", suggestions: [], rawContent: "", provider: "not_run",
        latencyMs: null, wallLatencyMs: null, usageCostUsd: null, accountedCostMicros: 0, errorCode: "cap_reached", score,
      });
      continue;
    }

    const started = performance.now();
    const captured = await captureFetch(() => chatWithRoute({
      model: route.model,
      messages: entry.messages,
      jsonSchema: PROOFREAD_JSON_SCHEMA,
      maxTokens: PROOFREAD_ROLE.maxTokens,
      temperature: PROOFREAD_ROLE.temperature,
      // One long paragraph can take longer than the production cutoff; the
      // bench measures quality, so give a slow provider more room.
      timeoutMs: BENCH_TIMEOUT_MS,
    }, route, config));
    const wallLatencyMs = Math.round(performance.now() - started);
    const summary = responseSummary(captured.capture.responseText);
    const reportedCost = reportedUsd(summary);
    const costMicros = reportedCost === null ? null : reportedUsdToMicros(reportedCost);
    const caseCostMicros = costMicros ?? entry.boundMicros;
    accountedMicros += caseCostMicros;
    const provider = typeof summary?.provider === "string" ? summary.provider : "unknown";
    const latencyMs = adapterLatency(captured.error, captured.value);
    const rawContent = captured.value?.content ?? contentFromResponse(summary);
    let suggestions: EvalSuggestion[] = [];
    let status: CaseRun["status"] = "failed";
    let code = captured.ok ? null : errorCode(captured.error);

    if (captured.ok && captured.value) {
      const output = parseProofreadOutput(captured.value.content);
      if (!output) {
        code = "invalid_output";
      } else {
        suggestions = resolveProofread(entry.sentences, output, "check");
        status = "ok";
        successfulLatencies.push(captured.value.latencyMs);
      }
    } else if (code === null) {
      reportError("runner failed: unexpected model-call error");
      return 1;
    }

    const score = scoreProofreadCase(entry.item, suggestions, rawContent, status === "ok");
    const evidenceRow: CallEvidence = {
      case_id: entry.item.id,
      request_body: captured.capture.requestBody,
      response_status: captured.capture.responseStatus,
      response_text: captured.capture.responseText,
      response: summary,
      adapter_latency_ms: latencyMs,
      wall_latency_ms: wallLatencyMs,
      provider,
      usage_cost_usd: reportedCost,
      accounted_cost_usd: caseCostMicros / 1_000_000,
      error_code: code,
    };
    evidence.push(evidenceRow);
    runs.push({
      item: entry.item, text: entry.text, status, suggestions, rawContent, provider,
      latencyMs, wallLatencyMs, usageCostUsd: reportedCost,
      accountedCostMicros: caseCostMicros, errorCode: code, score,
    });
  }

  const score = scoreProofreadRun(corpus.cases, runs.map((run) => ({
    ok: run.status === "ok", suggestions: run.suggestions, rawContent: run.rawContent,
  })), successfulLatencies);
  const out = reportMarkdown(date, corpus.version, route.model, options.capUsd, worstBoundMicros, runs, evidence, score);
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

  const reportedCosts = runs.flatMap((run) => run.usageCostUsd === null ? [] : [run.usageCostUsd]);
  log(`usage_cost_total_usd=$${usd(accountedMicros)}`);
  log(`reported_usage_cost_total_usd=$${reportedCosts.reduce((sum, value) => sum + value, 0).toFixed(9)}`);
  log(`calls=${evidence.length}`);
  log(`latency_p50_ms=${nearestRank(successfulLatencies, 0.5) ?? "N/A"}`);
  log(`latency_p95_ms=${nearestRank(successfulLatencies, 0.95) ?? "N/A"}`);
  log(`latency_max_ms=${successfulLatencies.length ? Math.max(...successfulLatencies) : "N/A"}`);
  const providerCounts = new Map<string, number>();
  for (const call of evidence) providerCounts.set(call.provider, (providerCounts.get(call.provider) ?? 0) + 1);
  log(`providers=${[...providerCounts.entries()].map(([provider, count]) => `${provider}:${count}`).join(",") || "none"}`);
  for (const criterion of score.criteria) log(`criterion=${criterion.name}: ${criterion.pass ? "PASS" : "FAIL"} (${criterion.measured}; target ${criterion.target})`);
  if (stoppedAtCap) log("run_status=stopped_at_cap; remaining cases are not_run");
  return 0;
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
