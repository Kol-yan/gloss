// How long started work may stay unfinished before it counts as abandoned. A
// model call times out after 20 to 30 seconds, so two minutes means the
// process that started the work is gone.
export const STALE_AFTER_MS = 2 * 60 * 1000;

// Rows created or started before this instant (ISO, UTC) are stale.
export function staleBefore(now: Date): string {
  return new Date(now.getTime() - STALE_AFTER_MS).toISOString();
}
