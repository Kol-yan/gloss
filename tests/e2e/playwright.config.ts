import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, ROOT, serverEnv } from "./env";

// Smoke tests against a production build with a fresh temporary database and
// simulated model providers (GLOSSY_MODEL_MOCK). No test reaches a real provider.
export default defineConfig({
  testDir: ".",
  outputDir: path.join(ROOT, "test-results", "e2e"),
  globalSetup: "./global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A failure should be looked at, not retried away.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `next start` warns that standalone output should run server.js, but it
    // serves the same build and needs no copy of the static files.
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${new URL(BASE_URL).port}`,
    cwd: ROOT,
    url: `${BASE_URL}/api/health`,
    env: serverEnv(),
    // A server already on the port would use another database.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
