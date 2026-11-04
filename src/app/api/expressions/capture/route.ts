import { z } from "zod";
import { Expression, Familiarity } from "@/shared/contracts";
import { hashText, normalizeText } from "@/lib/text";
import { requireLearner } from "@/server/auth/request";
import { getDb, immediate, learnerScope } from "@/server/db";
import { errorResponse, jsonError, jsonOk } from "@/server/http";
import { newId } from "@/server/ids";
import { toExpression } from "@/server/practice/expressions";

// POST /api/expressions/capture saves a word or short phrase the learner
// selected on another site (the browser extension's "Add to gloss") to My
// words. It makes no model call and reserves no budget. Saving a word is
// neither help nor production, so no evidence event is recorded.
//
// The contract stays in this file until it is moved to src/shared/contracts.ts
// together with an extension client that imports it.
const MAX_CAPTURE_LENGTH = 80;
const MAX_MEANING_LENGTH = 200;
// A few hundred characters of JSON; anything far beyond that is not a capture.
const MAX_BODY_CHARS = 4_000;

const CaptureExpressionRequest = z.object({
  text: z.string(),
  // Optional short meaning typed by the learner. It fills an empty meaning of
  // an existing expression but never replaces one.
  meaning: z.string().optional(),
  familiarity: Familiarity.optional(),
}).strict();

const CaptureExpressionResponse = z.object({
  expression: Expression,
  // False when the learner already had this word or phrase.
  created: z.boolean(),
});

// One line: NFC, every whitespace run collapsed to a space, trimmed.
function oneLine(value: string): string {
  return normalizeText(value).replace(/\s+/gu, " ").trim();
}

export async function POST(request: Request) {
  try {
    const learner = await requireLearner();

    let input: z.infer<typeof CaptureExpressionRequest>;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_CHARS) return jsonError("invalid_request");
      input = CaptureExpressionRequest.parse(JSON.parse(raw));
    } catch {
      return jsonError("invalid_request");
    }

    const text = oneLine(input.text);
    const meaning = oneLine(input.meaning ?? "");
    if (!/\p{L}/u.test(text) || text.length > MAX_CAPTURE_LENGTH || meaning.length > MAX_MEANING_LENGTH) {
      return jsonError("invalid_request");
    }
    const textHash = await hashText(text);
    const key = text.toLowerCase();
    const now = new Date().toISOString();

    const result = immediate((db) => {
      const scope = learnerScope(learner.id, db);
      // The same word in another case is the same entry in My words.
      const existing = scope.select("expressions", { orderBy: "created_at, id" })
        .find((row) => String(row.text).toLowerCase() === key);
      if (existing) {
        if (meaning && !String(existing.meaning).trim()) {
          db.prepare("UPDATE expressions SET meaning = ? WHERE id = ? AND learner_id = ?")
            .run(meaning, String(existing.id), learner.id);
          return { expression: toExpression({ ...existing, meaning }), created: false };
        }
        return { expression: toExpression(existing), created: false };
      }

      // Every expression belongs to an accepted suggestion of a check run. A
      // captured word gets both, marked with provider 'capture' and model
      // 'none', so the existing schema and practice flow apply unchanged.
      const runId = newId();
      const suggestionId = newId();
      const expressionId = newId();
      const familiarity = input.familiarity ?? "new";
      db.prepare(
        `INSERT INTO check_runs
           (id, learner_id, request_id, text_hash, text_length, provider, model, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'capture', 'none', 'ok', ?)`,
      ).run(runId, learner.id, newId(), textHash, text.length, now);
      db.prepare(
        `INSERT INTO suggestions
           (id, check_run_id, learner_id, "start", "end", original, replacement, category, reason,
            meaning_change, meaning, status, decided_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, 'expression', 'Saved from a web page.', 0, ?, 'accepted', ?)`,
      ).run(suggestionId, runId, learner.id, text.length, text, text, meaning || null, now);
      db.prepare(
        `INSERT INTO expressions
           (id, learner_id, suggestion_id, text, meaning, familiarity, next_practice_at, created_at, ipa)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      ).run(expressionId, learner.id, suggestionId, text, meaning, familiarity, now);

      return {
        expression: { id: expressionId, text, meaning, ipa: null, familiarity },
        created: true,
      };
    }, getDb());

    return jsonOk(CaptureExpressionResponse.parse(result));
  } catch (error) {
    return errorResponse(error);
  }
}
