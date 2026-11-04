// Schema and quality rules for the starter set (src/server/learning/starter/entries.ts).
//
// The loader is deliberately strict: a mistyped band, an example that does not
// contain the entry or a duplicated expression would surface later as a broken
// exercise, so it is caught here at test time and on first use.

import { z } from "zod";
import {
  CEFR_LEVELS,
  FREQUENCY_BANDS,
  STARTER_TAGS,
  type StarterEntry,
} from "./entries";

export const MAX_DEFINITION_WORDS = 12;
export const MIN_DEFINITION_WORDS = 2;
export const MIN_EXAMPLE_WORDS = 4;
export const MAX_WORDS_PER_ENTRY = 5;

const Text = z
  .string()
  .min(1)
  .max(60)
  .refine((value) => value === value.trim(), "leading or trailing whitespace")
  .refine((value) => !value.includes("  "), "repeated whitespace")
  .refine((value) => /^[\x20-\x7e]+$/.test(value), "printable ASCII only");

const Definition = z
  .string()
  .max(120)
  .refine((value) => value === value.trim(), "leading or trailing whitespace")
  .refine((value) => !value.includes("  "), "repeated whitespace")
  .refine((value) => /^[\x20-\x7e]+$/.test(value), "printable ASCII only")
  .refine((value) => !value.endsWith("."), "no trailing full stop")
  .refine((value) => {
    const words = countWords(value);
    return words >= MIN_DEFINITION_WORDS && words <= MAX_DEFINITION_WORDS;
  }, `definition must be ${MIN_DEFINITION_WORDS}-${MAX_DEFINITION_WORDS} words`);

const Example = z
  .string()
  .min(10)
  .max(200)
  .refine((value) => value === value.trim(), "leading or trailing whitespace")
  .refine((value) => !value.includes("  "), "repeated whitespace")
  .refine((value) => /^[\x20-\x7e]+$/.test(value), "printable ASCII only")
  .refine((value) => /^[A-Z0-9"']/.test(value), "example starts with a capital letter")
  .refine((value) => /[.!?]$/.test(value), "example ends with a sentence mark");

export const StarterEntrySchema = z
  .object({
    text: Text,
    band: z.enum(FREQUENCY_BANDS),
    level: z.enum(CEFR_LEVELS),
    definition: Definition,
    example: Example,
    tags: z.array(z.enum(STARTER_TAGS)).min(1).max(3),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const words = countWords(entry.text);
    if (words > MAX_WORDS_PER_ENTRY) {
      ctx.addIssue({ code: "custom", path: ["text"], message: `at most ${MAX_WORDS_PER_ENTRY} words` });
    }
    if (!exampleContains(entry.example, entry.text)) {
      ctx.addIssue({ code: "custom", path: ["example"], message: "example must contain the entry, inflected or not" });
    }
    if (entry.definition.toLowerCase().includes(entry.text.toLowerCase())) {
      ctx.addIssue({ code: "custom", path: ["definition"], message: "definition must not repeat the entry" });
    }
    if (new Set(entry.tags).size !== entry.tags.length) {
      ctx.addIssue({ code: "custom", path: ["tags"], message: "duplicate tag" });
    }
  });

export const StarterSetSchema = z.array(StarterEntrySchema);

export function countWords(value: string): number {
  const matches = value.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return matches ? matches.length : 0;
}

// The example may use the entry in another form ("decide" -> "decided"), so a
// single word matches its stem and an expression matches word by word.
export function exampleContains(example: string, text: string): boolean {
  const haystack = example.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  const parts = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  for (let start = 0; start + parts.length <= haystack.length; start += 1) {
    if (parts.every((part, offset) => inflected(haystack[start + offset], part))) return true;
  }
  return false;
}

function inflected(word: string, base: string): boolean {
  if (word === base) return true;
  const stems = new Set([base, stripE(base), doubleConsonant(base), stripY(base), yToI(base)]);
  const endings = ["s", "es", "ed", "d", "ing", "'s", "'"];
  for (const stem of stems) {
    if (!stem) continue;
    for (const ending of endings) {
      if (word === stem + ending) return true;
    }
  }
  // Irregular past forms worth covering for the entries that have one.
  return IRREGULAR[base]?.includes(word) ?? false;
}

const IRREGULAR: Record<string, string[]> = {
  buy: ["bought"],
  choose: ["chose", "chosen"],
  deal: ["dealt"],
  find: ["found"],
  get: ["got", "gotten"],
  give: ["gave", "given"],
  go: ["went", "gone"],
  hold: ["held"],
  keep: ["kept"],
  lead: ["led"],
  make: ["made"],
  leave: ["left"],
  meet: ["met"],
  pay: ["paid"],
  run: ["ran"],
  say: ["said"],
  see: ["saw", "seen"],
  sell: ["sold"],
  send: ["sent"],
  set: ["set"],
  speak: ["spoke", "spoken"],
  spend: ["spent"],
  take: ["took", "taken"],
  tell: ["told"],
  think: ["thought"],
  understand: ["understood"],
  write: ["wrote", "written"],
};

function stripE(base: string): string {
  return base.endsWith("e") ? base.slice(0, -1) : base;
}

function doubleConsonant(base: string): string {
  return /[^aeiou][aeiou][bdgklmnprt]$/.test(base) ? base + base.slice(-1) : base;
}

// "carry" -> "carried", "justify" -> "justified".
function stripY(base: string): string {
  return base.endsWith("y") && !/[aeiou]y$/.test(base) ? base.slice(0, -1) : base;
}

function yToI(base: string): string {
  return stripY(base) + "i";
}

export interface StarterSetStats {
  total: number;
  byBand: Record<string, number>;
  byLevel: Record<string, number>;
  words: number;
  expressions: number;
}

export interface LoadedStarterSet {
  entries: StarterEntry[];
  byText: Map<string, StarterEntry>;
  stats: StarterSetStats;
}

export class StarterSetError extends Error {
  constructor(readonly issues: string[]) {
    super(`starter set is invalid: ${issues.slice(0, 5).join("; ")}`);
    this.name = "StarterSetError";
  }
}

export function normalizeEntryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Validates the whole set and indexes it by lower-cased text.
export function loadStarterSet(input: unknown): LoadedStarterSet {
  const parsed = StarterSetSchema.safeParse(input);
  if (!parsed.success) {
    throw new StarterSetError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "set"}: ${issue.message}`),
    );
  }
  const issues: string[] = [];
  const byText = new Map<string, StarterEntry>();
  const sorted: StarterEntry[] = [];
  for (const entry of parsed.data) {
    const key = normalizeEntryText(entry.text);
    if (byText.has(key)) issues.push(`${entry.text}: duplicated expression`);
    else byText.set(key, entry);
    sorted.push(entry);
  }
  const roots = new Map<string, string>();
  for (const entry of parsed.data) {
    const root = rootOf(entry.text);
    const other = roots.get(root);
    if (other) issues.push(`${entry.text}: shares its stem with ${other}`);
    else roots.set(root, entry.text);
  }
  if (issues.length > 0) throw new StarterSetError(issues);
  return { entries: sorted, byText, stats: starterSetStats(sorted) };
}

// "decided" and "decide" would be two cards for one word.
export function rootOf(text: string): string {
  return normalizeEntryText(text)
    .split(" ")
    .map((word) => {
      if (word.endsWith("ing")) {
        const stem = word.slice(0, -3);
        return stripE(stem) === stem ? stem : stripE(stem);
      }
      if (word.endsWith("ed")) return word.slice(0, -2);
      return word.replace(/(?:es|s)$/, "");
    })
    .map(stripE)
    .join(" ");
}

export function starterSetStats(entries: readonly StarterEntry[]): StarterSetStats {
  const byBand: Record<string, number> = Object.fromEntries(FREQUENCY_BANDS.map((band) => [band, 0]));
  const byLevel: Record<string, number> = Object.fromEntries(CEFR_LEVELS.map((level) => [level, 0]));
  let words = 0;
  let expressions = 0;
  for (const entry of entries) {
    byBand[entry.band] += 1;
    byLevel[entry.level] += 1;
    if (entry.text.includes(" ")) expressions += 1;
    else words += 1;
  }
  return { total: entries.length, byBand, byLevel, words, expressions };
}
