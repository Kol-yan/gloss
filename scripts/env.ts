import { existsSync } from "node:fs";

// Scripts run outside Next, which loads .env.local on its own. Variables that
// are already set in the shell win over the file.
export function loadLocalEnv(): void {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
}
