// Usage: npm run invite -- --label "Judges" --uses 5 --profile judge [--days 14]
import { parseArgs } from "node:util";
import { createInvite } from "../src/server/auth/invites";
import { getConfig, QuotaProfileNameSchema } from "../src/server/config";
import { closeDb } from "../src/server/db";
import { loadLocalEnv } from "./env";

const USAGE =
  "Usage: npm run invite -- --label <name> --uses <n> --profile <pilot|judge|owner> [--days <d>]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main() {
  loadLocalEnv();
  const { values } = parseArgs({
    options: {
      label: { type: "string" },
      uses: { type: "string" },
      profile: { type: "string" },
      days: { type: "string" },
    },
    strict: true,
  });

  const uses = Number(values.uses);
  const days = values.days === undefined ? undefined : Number(values.days);
  const profile = QuotaProfileNameSchema.safeParse(values.profile);
  if (!values.label || !Number.isInteger(uses) || uses < 1 || !profile.success) fail(USAGE);
  if (days !== undefined && !(Number.isFinite(days) && days > 0)) fail(USAGE);

  const invite = createInvite({
    label: values.label,
    maxUses: uses,
    quotaProfile: profile.data,
    expiresAt: days === undefined ? null : new Date(Date.now() + days * 86_400_000),
  });
  const publicUrl = getConfig().publicUrl;
  closeDb();

  // Details go to stderr so stdout is just the link.
  console.error(
    `Invite "${invite.label}": ${invite.maxUses} use(s), profile ${invite.quotaProfile}, ` +
      `expires ${invite.expiresAt ?? "never"}`,
  );
  console.log(`${publicUrl}/join/${invite.token}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
