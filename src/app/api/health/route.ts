import { connection } from "next/server";
import { getDb } from "@/server/db";
import { jsonOk } from "@/server/http";

// Liveness for the container healthcheck: the process is up and the database
// opens (which applies pending migrations). It reveals nothing else.
export async function GET() {
  // Never prerendered: it must reflect the running server, not the build.
  await connection();
  try {
    getDb().prepare("SELECT 1").get();
    return jsonOk({ ok: true });
  } catch (error) {
    console.error(`[gloss] health check failed: ${error instanceof Error ? error.name : "error"}`);
    return jsonOk({ ok: false }, 503);
  }
}
