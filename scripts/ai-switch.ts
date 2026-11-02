// Usage: npm run ai -- on|off|status
import { getBudgetStatus, setAiEnabled } from "../src/server/budget";
import { getConfig } from "../src/server/config";
import { closeDb } from "../src/server/db";
import { loadLocalEnv } from "./env";

function main() {
  loadLocalEnv();
  const command = process.argv[2];
  if (command !== "on" && command !== "off" && command !== "status") {
    console.error("Usage: npm run ai -- on|off|status");
    process.exit(1);
  }

  if (command === "on") setAiEnabled(true);
  if (command === "off") setAiEnabled(false);

  const config = getConfig();
  const status = getBudgetStatus();
  const word = (on: boolean) => (on ? "on" : "off");
  console.log(`AI_ENABLED (env, this shell): ${word(status.envSwitchOn)}`);
  console.log(`Runtime switch (database):    ${word(status.runtimeSwitchOn)}`);
  const spent = (status.spentMicros / 1e6).toFixed(4);
  console.log(`Spent today (UTC):            $${spent} of $${config.dailyBudgetUsd}`);
  console.log(`Cloud calls allowed:          ${status.aiAvailable ? "yes" : "no"}`);
  closeDb();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
