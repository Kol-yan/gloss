// Settings shared by the Playwright config, the global setup and the tests.
// Playwright loads the config in its runner and again in every worker. Workers
// inherit the runner's environment, so the database directory is made once.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "../..");

const PORT = Number(process.env.GLOSS_E2E_PORT ?? 3210);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

function dataDir(): string {
  const existing = process.env.GLOSS_E2E_DATA_DIR;
  if (existing) return existing;
  const dir = mkdtempSync(path.join(os.tmpdir(), "gloss-e2e-"));
  process.env.GLOSS_E2E_DATA_DIR = dir;
  // "exit" comes after the web server has stopped, when nothing holds the database open.
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Every setting the server reads is spelled out. Next never lets a local .env
// file override a variable that is already set, even to an empty string, so
// a developer's own keys and limits cannot leak into a run. Empty means the
// built-in default.
export function serverEnv(): Record<string, string> {
  return {
    GLOSSY_MODEL_MOCK: "true",
    GLOSSY_DATABASE_PATH: path.join(dataDir(), "gloss.db"),
    GLOSSY_PUBLIC_URL: BASE_URL,
    AI_ENABLED: "true",
    DAILY_BUDGET_USD: "5",
    // Placeholders in the shape the server expects, so hosted access counts as
    // configured. Nothing is sent with them: the mock answers instead.
    META_API_KEY: "e2e-placeholder",
    // Unreachable on purpose, should a run ever start without the mock.
    META_API_BASE_URL: "http://127.0.0.1:9/v1",
    META_TEXT_MODEL: "",
    META_ASR_MODEL: "",
    // Key-shaped placeholder built at runtime; it is not a credential and never leaves the test process.
    OPENROUTER_API_KEY: ["sk", "or", "v1", "e2e-placeholder-key"].join("-"),
    OPENROUTER_FAST_MODEL: "",
    OPENROUTER_PROOFREAD_MODEL: "",
    OPENROUTER_FAST_PRICE_IN_PER_M: "",
    OPENROUTER_FAST_PRICE_OUT_PER_M: "",
    BYOK_TRUST_PROXY_HEADERS: "false",
    NEXT_TELEMETRY_DISABLED: "1",
  };
}

// Written by the global setup, read by the tests.
export function inviteUrl(): string {
  const url = process.env.GLOSS_E2E_INVITE_URL;
  if (!url) throw new Error("No invite link: the global setup did not run.");
  return url;
}
