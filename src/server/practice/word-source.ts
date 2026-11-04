import { getDb, immediate } from "../db";
import { NotFoundError } from "../errors";

export type WordStatus = "learning" | "ready" | "active" | "hidden";
export type SessionSlot = "activate" | "learn" | "keep";
export type FrequencyBand = "core" | "common" | "uncommon" | "rare";
export interface SessionWord {
  expressionId: string;
  text: string;
  slot: SessionSlot;
  status: WordStatus;
  startRung: 1 | 2 | 3 | 4 | 5 | 6;
  frequency: FrequencyBand;
  why: string;
}
export function pickSessionWords(learnerId: string, size?: number): SessionWord[] {
  if (!learnerId) throw new TypeError("A learner id is required");
  const limit = size === undefined || !Number.isFinite(size) ? 8 : Math.max(1, Math.min(8, Math.trunc(size)));
  const now = new Date().toISOString();
  const rows = getDb()
    .prepare(
      `SELECT e.id, e.text, e.familiarity, e.next_practice_at,
              p.status AS progress_status, p.next_rung
       FROM expressions AS e
       LEFT JOIN practice_word_progress AS p
         ON p.learner_id = e.learner_id AND p.expression_id = e.id
       WHERE e.learner_id = ?
         AND COALESCE(p.status, CASE e.familiarity
           WHEN 'known_unused' THEN 'ready'
           WHEN 'used' THEN 'active'
           ELSE 'learning' END) != 'hidden'
       ORDER BY CASE WHEN e.next_practice_at IS NULL OR e.next_practice_at <= ? THEN 0 ELSE 1 END,
         CASE e.familiarity WHEN 'known_unused' THEN 0 WHEN 'new' THEN 1 ELSE 2 END,
         e.next_practice_at, e.created_at, e.id
       LIMIT ?`,
    )
    .all(learnerId, now, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const familiarity = String(row.familiarity);
    const status = (row.progress_status ?? statusForFamiliarity(familiarity)) as WordStatus;
    const startRung = row.next_rung === null || row.next_rung === undefined
      ? rungForFamiliarity(familiarity)
      : clampRung(Number(row.next_rung));
    const frequency = frequencyFor(String(row.text));
    return {
      expressionId: String(row.id),
      text: String(row.text),
      slot: status === "ready" ? "activate" : status === "active" ? "keep" : "learn",
      status,
      startRung,
      frequency,
      why: reasonFor(status, frequency),
    };
  });
}

export function recordPracticeResult(input: {
  learnerId: string; expressionId: string; rung: number;
  productive: boolean; correct: boolean; usedHint: boolean;
  reaction?: "already_know" | "too_easy" | "not_relevant" | "too_hard";
}): { status: WordStatus; nextRung: number; comesBackAt: string } {
  if (!input.learnerId) throw new TypeError("A learner id is required");
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();

  return immediate((tx) => {
    const expression = tx.prepare(
      "SELECT familiarity FROM expressions WHERE id = ? AND learner_id = ?",
    ).get(input.expressionId, input.learnerId) as { familiarity: string } | undefined;
    if (!expression) throw new NotFoundError();

    const progress = tx.prepare(
      `SELECT status, next_rung, productive_successes, wrong_streak
       FROM practice_word_progress WHERE learner_id = ? AND expression_id = ?`,
    ).get(input.learnerId, input.expressionId) as {
      status: WordStatus;
      next_rung: number;
      productive_successes: number;
      wrong_streak: number;
    } | undefined;

    let status = progress?.status ?? statusForFamiliarity(expression.familiarity);
    let nextRung = progress ? clampRung(progress.next_rung) : clampRung(input.rung);
    let productiveSuccesses = progress?.productive_successes ?? 0;
    let wrongStreak = progress?.wrong_streak ?? 0;
    const reaction = input.reaction ?? null;
    let delayMs = DAY_MS;
    let markUsed = false;

    // A reaction is recorded after the answer view, so it must not score that
    // answer a second time.
    if (input.reaction) {
      switch (input.reaction) {
        case "already_know":
          status = "active";
          nextRung = 4;
          delayMs = 14 * DAY_MS;
          markUsed = true;
          break;
        case "not_relevant":
          status = "hidden";
          break;
        case "too_easy":
          nextRung = clampRung(nextRung + 1);
          delayMs = 3 * DAY_MS;
          break;
        case "too_hard":
          nextRung = clampRung(nextRung - 1);
          break;
      }
    } else if (input.correct) {
      wrongStreak = 0;
      if (!input.usedHint) nextRung = clampRung(nextRung + 1);
      if (input.productive && !input.usedHint) {
        productiveSuccesses += 1;
        if (productiveSuccesses >= 3) {
          status = "active";
          nextRung = 4;
          markUsed = true;
        }
      }
      if (input.rung === 4 && input.productive && !input.usedHint) delayMs = 3 * DAY_MS;
    } else {
      wrongStreak += 1;
      if (wrongStreak >= 2) {
        nextRung = clampRung(nextRung - 1);
        wrongStreak = 0;
      }
    }

    const comesBackAt = new Date(now.getTime() + delayMs).toISOString();
    tx.prepare(
      `INSERT INTO practice_word_progress
         (learner_id, expression_id, status, next_rung, productive_successes,
          wrong_streak, last_reaction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (learner_id, expression_id) DO UPDATE SET
         status = excluded.status,
         next_rung = excluded.next_rung,
         productive_successes = excluded.productive_successes,
         wrong_streak = excluded.wrong_streak,
         last_reaction = excluded.last_reaction,
         updated_at = excluded.updated_at`,
    ).run(input.learnerId, input.expressionId, status, nextRung, productiveSuccesses, wrongStreak, reaction, nowIso);
    tx.prepare(
      `UPDATE expressions SET next_practice_at = ?,
         familiarity = CASE WHEN ? THEN 'used' ELSE familiarity END
       WHERE id = ? AND learner_id = ?`,
    ).run(comesBackAt, markUsed ? 1 : 0, input.expressionId, input.learnerId);

    return { status, nextRung, comesBackAt };
  }, db);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function statusForFamiliarity(familiarity: string): WordStatus {
  if (familiarity === "known_unused") return "ready";
  if (familiarity === "used") return "active";
  return "learning";
}

function rungForFamiliarity(familiarity: string): 1 | 2 | 4 {
  if (familiarity === "known_unused") return 2;
  if (familiarity === "used") return 4;
  return 1;
}

function clampRung(rung: number): 1 | 2 | 3 | 4 {
  if (!Number.isFinite(rung)) return 1;
  return Math.max(1, Math.min(4, Math.trunc(rung))) as 1 | 2 | 3 | 4;
}

const CORE_WORDS = new Set(
  "a an and are as at be but by can do for from get go have he her here him his how i if in into is it its like make me my no not of on one or our out see she so some take than that the their them then there these they this to up us was we were what when where which who will with would you your say know think come want give use find tell ask work need feel leave call try look good new first also back because day even way well year time people thing man woman child life hand eye place week case point government company number group problem fact home water room mother area money story side business issue door information power country name change system question school state family food friend travel".split(/\s+/),
);
const COMMON_WORDS = new Set(
  "about above across action actually again against almost already always among answer around become before being below between book bring build carry cause certain change clear close community continue course create different early enough especially example experience explain feel follow form general happen health high important include increase interest keep kind learn level local market matter member mind move music offer often order own parent party perhaps plan play possible practice public reason remember result right same service small social speak start still study support sure team together turn understand voice wait watch while without world write".split(/\s+/),
);
const COMMON_PHRASES = new Set(["at least", "in fact", "of course", "take care", "a lot", "as well", "right away"]);

function frequencyFor(text: string): FrequencyBand {
  const normalized = text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  if (CORE_WORDS.has(normalized)) return "core";
  if (COMMON_WORDS.has(normalized) || COMMON_PHRASES.has(normalized)) return "common";
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length >= 4 || normalized.length >= 24) return "rare";
  return "uncommon";
}

function reasonFor(status: WordStatus, frequency: FrequencyBand): string {
  const label = `${frequency[0].toUpperCase()}${frequency.slice(1)} word`;
  if (status === "ready") return `${label} · you know it but don't use it yet`;
  if (status === "active") return `${label} · keep it fresh`;
  return `${label} · build it from a new example`;
}
