import type {
  CreateExpressionRequest,
  CreateExpressionResponse,
  Expression,
  ExpressionsResponse,
  Familiarity,
  HistoryEntry,
} from "@/shared/contracts";
import { sanitizeIpa } from "@/lib/pronunciation";
import type { Learner } from "../auth/sessions";
import { getDb, immediate, learnerScope, type Row } from "../db";
import type { ServerDeps } from "../deps";
import { ConflictError, InvalidRequestError, NotFoundError } from "../errors";
import { newId } from "../ids";
import { dayLabel, nextPracticeLabel } from "./labels";

// Latest events kept per expression in the list; older ones stay in the database.
const MAX_ENTRIES_PER_EXPRESSION = 30;

export function toExpression(row: Row): Expression {
  return {
    id: String(row.id),
    text: String(row.text),
    meaning: String(row.meaning),
    ipa: sanitizeIpa(row.ipa, String(row.text)),
    familiarity: row.familiarity as Familiarity,
  };
}

// Turns an accepted "expression" suggestion into something to practise.
// Creating it again returns the existing expression. Accepting a suggestion is
// help, so it is recorded as assisted use, never as production.
export function createExpression(
  learner: Learner,
  input: CreateExpressionRequest,
  deps: ServerDeps = {},
): CreateExpressionResponse {
  const now = deps.now ?? new Date();

  return immediate((db) => {
    const scope = learnerScope(learner.id, db);
    const suggestion = scope.selectOne("suggestions", {
      where: "id = :id",
      params: { id: input.suggestionId },
    });
    if (!suggestion) throw new NotFoundError();

    const existing = scope.selectOne("expressions", {
      where: "suggestion_id = :id",
      params: { id: input.suggestionId },
    });
    if (existing) return { expression: toExpression(existing) };

    if (suggestion.status !== "accepted") throw new ConflictError();
    const meaning = typeof suggestion.meaning === "string" ? suggestion.meaning.trim() : "";
    if (!meaning) throw new InvalidRequestError();

    const id = newId();
    const createdAt = now.toISOString();
    const ipa = sanitizeIpa(suggestion.ipa, String(suggestion.replacement));
    db.prepare(
      `INSERT INTO expressions
         (id, learner_id, suggestion_id, text, meaning, familiarity, next_practice_at, created_at, ipa)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, learner.id, input.suggestionId, String(suggestion.replacement), meaning, input.familiarity, createdAt, ipa);
    db.prepare(
      `INSERT INTO evidence_events
         (id, learner_id, expression_id, attempt_id, kind, verdict, cue, hint_used,
          transcript_edited, created_at)
       VALUES (?, ?, ?, NULL, 'assisted_use', NULL, NULL, 0, 0, ?)`,
    ).run(newId(), learner.id, id, createdAt);

    return {
      expression: {
        id,
        text: String(suggestion.replacement),
        meaning,
        ipa,
        familiarity: input.familiarity,
      },
    };
  }, deps.db ?? getDb());
}

// The learner's expressions, newest first, each with its evidence history
// (newest first) and when it is due. An expression that was never practised
// is due now.
export function listExpressions(learner: Learner, deps: ServerDeps = {}): ExpressionsResponse {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const scope = learnerScope(learner.id, db);

  const expressions = scope.select("expressions", { orderBy: "created_at DESC, id" });
  const events = scope.select("evidence_events", { orderBy: "created_at DESC, id" });

  const byExpression = new Map<string, HistoryEntry[]>();
  for (const event of events) {
    const key = String(event.expression_id);
    const entries = byExpression.get(key) ?? [];
    if (entries.length >= MAX_ENTRIES_PER_EXPRESSION) continue;
    entries.push({
      kind: event.kind as HistoryEntry["kind"],
      verdict: event.verdict === null ? null : (event.verdict as HistoryEntry["verdict"]),
      cue: event.cue === null ? null : (event.cue as HistoryEntry["cue"]),
      hintUsed: event.hint_used === 1,
      transcriptEdited: event.transcript_edited === 1,
      dayLabel: dayLabel(new Date(String(event.created_at)), now),
    });
    byExpression.set(key, entries);
  }

  return {
    expressions: expressions.map((row) => {
      const next = row.next_practice_at === null ? null : new Date(String(row.next_practice_at));
      return {
        expression: toExpression(row),
        entries: byExpression.get(String(row.id)) ?? [],
        nextPracticeLabel: next ? nextPracticeLabel(next, now) : null,
        due: next === null || next.getTime() <= now.getTime(),
      };
    }),
  };
}
