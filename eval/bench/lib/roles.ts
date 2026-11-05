// One adapter per benchmarked role. Each builds the request exactly as the
// app's service does (same prompt builder, JSON schema and role settings) and
// turns the model's answer into a score using the app's own parser.
import { z } from "zod";
import { normalizeText, splitSentences } from "@/lib/text";
import { buildCleanupMessages, DICTATION_CLEANUP_VERSION, DICTATION_JSON_SCHEMA, parseCleanup } from "@/server/dictation/service";
import { parseModelJson } from "@/server/models/json";
import { DICTATION_CLEANUP_ROLE, EVALUATE_ATTEMPT_ROLE, PROOFREAD_ROLE } from "@/server/models/roles";
import {
  buildEvaluationMessages,
  computeVerdict,
  EVALUATION_JSON_SCHEMA,
  EVALUATION_PROMPT_VERSION,
  parseEvaluation,
} from "@/server/practice/evaluation";
import { resolveProofread } from "@/server/proofread/edits";
import { buildProofreadMessages, PROOFREAD_PROMPT_VERSION } from "@/server/proofread/prompt";
import { parseProofreadOutput, PROOFREAD_JSON_SCHEMA } from "@/server/proofread/schema";
import type { BenchRole, DictationItem, EvaluationItem, ItemFor, ProofreadItem } from "./datasets";
import {
  scoreDictation,
  scoreEvaluation,
  scoreProofread,
  type DictationScore,
  type EvaluationScore,
  type JudgedVerdict,
  type ProofreadScore,
} from "./scorers";
import type { ModelTier } from "@/server/models/access";
import type { RoleCall } from "./target";

export type RoleResult =
  | { role: "proofread"; valid: boolean; score: ProofreadScore | null; edits: string[]; improvements: number }
  | { role: "dictation"; valid: boolean; score: DictationScore | null; output: string | null; appAccepted: boolean }
  | { role: "evaluation"; valid: boolean; score: EvaluationScore; verdict: JudgedVerdict | null };

export interface RoleAdapter<R extends BenchRole> {
  role: R;
  promptVersion: string;
  defaultTier: ModelTier;
  request(item: ItemFor<R>, tier: ModelTier): RoleCall;
  // `content` is null when the call itself failed.
  judge(item: ItemFor<R>, content: string | null): RoleResult;
}

const proofread: RoleAdapter<"proofread"> = {
  role: "proofread",
  promptVersion: PROOFREAD_PROMPT_VERSION,
  defaultTier: PROOFREAD_ROLE.tier,
  request(item: ProofreadItem, tier) {
    return {
      kind: "proofread",
      reservationRole: "proofread",
      tier,
      messages: buildProofreadMessages(splitSentences(normalizeText(item.text)), "check"),
      jsonSchema: PROOFREAD_JSON_SCHEMA,
      maxTokens: PROOFREAD_ROLE.maxTokens,
      temperature: PROOFREAD_ROLE.temperature,
    };
  },
  judge(item: ProofreadItem, content) {
    const output = content === null ? null : parseProofreadOutput(content);
    if (!output) return { role: "proofread", valid: false, score: null, edits: [], improvements: 0 };
    const text = normalizeText(item.text);
    const suggestions = resolveProofread(splitSentences(text), output, "check");
    const errors = suggestions.filter((suggestion) => suggestion.category === "error");
    return {
      role: "proofread",
      valid: true,
      score: scoreProofread(text, item.errors, errors),
      edits: errors.map((edit) => `${edit.original} → ${edit.replacement}`),
      improvements: suggestions.length - errors.length,
    };
  },
};

const Cleaned = z.object({ text: z.string() });

const dictation: RoleAdapter<"dictation"> = {
  role: "dictation",
  promptVersion: DICTATION_CLEANUP_VERSION,
  defaultTier: DICTATION_CLEANUP_ROLE.tier,
  request(item: DictationItem, tier) {
    return {
      kind: "proofread",
      reservationRole: "dictation_cleanup",
      tier,
      messages: buildCleanupMessages(item.transcript),
      jsonSchema: DICTATION_JSON_SCHEMA,
      maxTokens: DICTATION_CLEANUP_ROLE.maxTokens,
      temperature: DICTATION_CLEANUP_ROLE.temperature,
    };
  },
  judge(item: DictationItem, content) {
    // Scored on what the model wrote, even when the app would reject it; the
    // app's own verdict is kept separately as `appAccepted`.
    const parsed = content === null ? null : Cleaned.safeParse(parseModelJson(content));
    const output = parsed?.success ? parsed.data.text.trim() : null;
    if (output === null || output === "") {
      return { role: "dictation", valid: false, score: null, output: null, appAccepted: false };
    }
    return {
      role: "dictation",
      valid: true,
      score: scoreDictation({ ...item, output }),
      output,
      appAccepted: content !== null && parseCleanup(content, item.transcript) !== null,
    };
  },
};

const evaluation: RoleAdapter<"evaluation"> = {
  role: "evaluation",
  promptVersion: EVALUATION_PROMPT_VERSION,
  defaultTier: EVALUATE_ATTEMPT_ROLE.tier,
  request(item: EvaluationItem, tier) {
    return {
      kind: "evaluate",
      reservationRole: "evaluate_attempt",
      tier,
      messages: buildEvaluationMessages(item),
      jsonSchema: EVALUATION_JSON_SCHEMA,
      maxTokens: EVALUATE_ATTEMPT_ROLE.maxTokens,
      temperature: EVALUATE_ATTEMPT_ROLE.temperature,
      reasoningEffort: EVALUATE_ATTEMPT_ROLE.reasoningEffort,
    };
  },
  judge(item: EvaluationItem, content) {
    const raw = content === null ? null : parseEvaluation(content);
    const verdict = raw ? computeVerdict(raw) : null;
    return { role: "evaluation", valid: raw !== null, score: scoreEvaluation(item, verdict), verdict };
  },
};

export const ADAPTERS: { [R in BenchRole]: RoleAdapter<R> } = { proofread, dictation, evaluation };
