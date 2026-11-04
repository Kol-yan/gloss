import { execFileSync } from "node:child_process";
import { ROOT, serverEnv } from "./env";

// Runs after the web server is up. Makes one invite link with the same command
// an operator uses; every test redeems it once and becomes a new learner.
export default function globalSetup(): void {
  const link = execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/invite.ts", "--label", "E2E", "--uses", "1000", "--profile", "pilot"],
    { cwd: ROOT, env: { ...process.env, ...serverEnv() }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  process.env.GLOSS_E2E_INVITE_URL = link;
}
