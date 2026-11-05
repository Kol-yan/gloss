// Loads and validates the benchmark datasets (JSONL, one item per line).
// Validation is strict so that a typo in a dataset fails loudly instead of
// silently scoring a model against a wrong answer key.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normalizeText } from "@/lib/text";
import { containsWords, uniqueRange } from "./scorers";

export const ROLES = ["proofread", "dictation", "evaluation"] as const;
export type BenchRole = (typeof ROLES)[number];

export const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));
export const DATASET_FILES: Record<BenchRole, string> = {
  proofread: resolve(DATA_DIR, "proofread.jsonl"),
  dictation: resolve(DATA_DIR, "dictation.jsonl"),
  evaluation: resolve(DATA_DIR, "evaluation.jsonl"),
};

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().min(1).max(2000);

export const ProofreadItem = z.object({
  id,
  group: z.enum(["error", "clean"]),
  register: z.enum(["email", "chat", "note"]),
  text,
  errors: z.array(z.object({
    span: z.string().min(1),
    fixes: z.array(z.string().min(1)).min(1),
    topic: z.enum([
      "article", "tense", "preposition", "word-order", "false-friend", "collocation",
      "agreement", "plural", "verb-form", "pronoun", "comparison", "spelling", "punctuation",
    ]),
  }).strict()),
  note: z.string().optional(),
}).strict();
export type ProofreadItem = z.infer<typeof ProofreadItem>;

export const DictationItem = z.object({
  id,
  transcript: text,
  expected: text,
  accept: z.array(text).optional(),
  // Names, numbers and non-English words that must survive verbatim.
  keep: z.array(z.string().min(1)).optional(),
  note: z.string().optional(),
}).strict();
export type DictationItem = z.infer<typeof DictationItem>;

const verdict = z.enum(["used_well", "almost", "not_yet"]);
export const EvaluationItem = z.object({
  id,
  group: z.enum(["correct", "form", "wrong-meaning", "not-used", "mention", "off-task", "injection"]),
  expression: z.string().min(1),
  meaning: z.string().min(1),
  situation: z.string().min(1),
  answer: text,
  expected: verdict,
  acceptable: z.array(verdict).min(1),
  note: z.string().optional(),
}).strict();
export type EvaluationItem = z.infer<typeof EvaluationItem>;

export type ItemFor<R extends BenchRole> = R extends "proofread"
  ? ProofreadItem
  : R extends "dictation"
    ? DictationItem
    : EvaluationItem;

const SCHEMAS = { proofread: ProofreadItem, dictation: DictationItem, evaluation: EvaluationItem } as const;

// Checks that go beyond the shape: positions must be addressable exactly the
// way the app addresses them, and the answer key must be self-consistent.
export function itemProblems(role: BenchRole, item: unknown): string[] {
  const problems: string[] = [];
  if (role === "proofread") {
    const entry = item as ProofreadItem;
    if (normalizeText(entry.text) !== entry.text) problems.push("text is not normalized");
    if (entry.group === "clean" && entry.errors.length > 0) problems.push("clean item has errors");
    if (entry.group === "error" && entry.errors.length === 0) problems.push("error item has no errors");
    const ranges = [];
    for (const error of entry.errors) {
      const range = uniqueRange(entry.text, error.span);
      if (!range) problems.push(`span not found exactly once: ${error.span}`);
      else ranges.push(range);
      if (error.fixes.includes(error.span)) problems.push(`a fix equals its span: ${error.span}`);
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) problems.push("error spans overlap");
    }
  } else if (role === "dictation") {
    const entry = item as DictationItem;
    for (const term of entry.keep ?? []) {
      if (!containsWords(entry.transcript, term)) problems.push(`keep term not spoken: ${term}`);
      if (!containsWords(entry.expected, term)) problems.push(`keep term not expected: ${term}`);
    }
  } else {
    const entry = item as EvaluationItem;
    if (!entry.acceptable.includes(entry.expected)) problems.push("expected verdict is not acceptable");
  }
  return problems;
}

export function parseDataset<R extends BenchRole>(role: R, content: string): ItemFor<R>[] {
  const items: ItemFor<R>[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const where = `${role} line ${index + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const parsed = SCHEMAS[role].safeParse(json);
    if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const problems = itemProblems(role, parsed.data);
    if (problems.length > 0) throw new Error(`${where} (${parsed.data.id}): ${problems.join("; ")}`);
    if (seen.has(parsed.data.id)) throw new Error(`${where}: duplicate id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    items.push(parsed.data as ItemFor<R>);
  });
  return items;
}

export async function loadDataset<R extends BenchRole>(role: R, path = DATASET_FILES[role]): Promise<ItemFor<R>[]> {
  return parseDataset(role, await readFile(path, "utf8"));
}
