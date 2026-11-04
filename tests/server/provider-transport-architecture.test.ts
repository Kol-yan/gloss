import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const serverRoot = path.join(root, "src/server");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

describe("provider budget architecture", () => {
  it("keeps provider fetch and provider-reported cost behind the budget transport", () => {
    const files = sourceFiles(serverRoot);
    const directFetch = files.filter((file) => {
      const name = relative(file);
      return !["src/server/budget/provider-request.ts", "src/server/budget/alerts.ts", "src/server/auth/turnstile.ts"].includes(name) &&
        /\bfetch\s*\(/.test(readFileSync(file, "utf8"));
    });
    expect(directFetch).toEqual([]);

    const costEvidenceImports = files.filter((file) => !["src/server/budget/provider-request.ts", "src/server/budget/index.ts"].includes(relative(file)) &&
      /\brecordProviderReportedCost\b/.test(readFileSync(file, "utf8")));
    expect(costEvidenceImports).toEqual([]);

    const transportImports = files.filter((file) =>
      /import\s*\{[^}]*\bsendProviderRequest\b[^}]*\}\s*from/.test(readFileSync(file, "utf8")) &&
      relative(file) !== "src/server/budget/provider-request.ts");
    expect(transportImports.map(relative).sort()).toEqual([
      "src/server/models/meta-asr.ts",
      "src/server/models/meta.ts",
      "src/server/models/openrouter.ts",
    ]);
  });

  it("allows budget/model-call.ts alone to call the low-level provider clients", () => {
    const files = sourceFiles(serverRoot);
    const adapters = ["src/server/models/meta.ts", "src/server/models/meta-asr.ts", "src/server/models/openrouter.ts"];
    const clientImports = files.filter((file) => {
      const name = relative(file);
      if (name === "src/server/budget/model-call.ts" || adapters.includes(name)) return false;
      return /\b(?:metaChat|metaTranscribe|openRouterChat|openRouterTranscribe)\b/.test(readFileSync(file, "utf8"));
    });
    expect(clientImports).toEqual([]);
    expect(readFileSync(path.join(serverRoot, "models/dispatch.ts"), "utf8"))
      .toContain('export { chatWithRoute, transcribeWithAccess } from "../budget/model-call";');
  });

  it("removes the custom detect benchmark's direct OpenRouter bypass", () => {
    const benchmark = readFileSync(path.join(root, "eval/run-detect-bench.ts"), "utf8");
    expect(benchmark).not.toMatch(/\bfetch\s*\(/);
    expect(benchmark).not.toContain("OPENROUTER_API_KEY");
    expect(benchmark).toContain("live model calls are disabled until this benchmark uses the application budget ledger");
  });
});
