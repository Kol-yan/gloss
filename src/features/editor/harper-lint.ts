// The Harper-specific half of the local checker. Used by the worker and by the
// Node integration test, so it only touches the `LocalLinter` interface.
import { Dialect, LocalLinter, SuggestionKind } from "harper.js";
import type { RawFix, RawLint } from "./local-lint";

// Rules that push personal style choices or fight each other. A learner should
// not be told that a correct sentence is "too long" or lacks an Oxford comma.
const OPINIONATED_RULES = [
  "LongSentences",
  "AvoidContractions",
  "Hedging",
  "FillerWords",
  "BoringWords",
  "UseTitleCase",
  "OxfordComma",
  "NoOxfordComma",
  "SpelledNumbers",
  "Regionalisms",
];

export async function createLinter(binary: ConstructorParameters<typeof LocalLinter>[0]["binary"]): Promise<LocalLinter> {
  const linter = new LocalLinter({ binary, dialect: Dialect.American });
  await linter.setup();
  const defaults = await linter.getDefaultLintConfig();
  const off: Record<string, boolean> = {};
  for (const rule of OPINIONATED_RULES) if (rule in defaults) off[rule] = false;
  await linter.setLintConfig({ ...defaults, ...off });
  return linter;
}

export async function collectLints(linter: LocalLinter, text: string): Promise<RawLint[]> {
  const groups = await linter.organizedLints(text, { language: "plaintext", dedup: true });
  const result: RawLint[] = [];
  for (const [rule, lints] of Object.entries(groups)) {
    for (const lint of lints) {
      const span = lint.span();
      const first = lint.suggestions()[0];
      let fix: RawFix | null = null;
      if (first) {
        const kind = first.kind();
        fix =
          kind === SuggestionKind.Remove
            ? { type: "remove" }
            : kind === SuggestionKind.InsertAfter
              ? { type: "insert_after", text: first.get_replacement_text() }
              : { type: "replace", text: first.get_replacement_text() };
      }
      result.push({
        rule,
        kind: lint.lint_kind(),
        start: span.start,
        end: span.end,
        problem: lint.get_problem_text(),
        message: lint.message(),
        fix,
      });
    }
  }
  return result;
}
