import type { DatabaseSync } from "node:sqlite";
import { reserve, type Reservation } from "@/server/budget";
import type { AppConfig } from "@/server/config";
import { createTempDb, insertLearner } from "./db";
import { newId } from "@/server/ids";
import { asrCostMicros, asrPrice, estimateMaxCostMicros, textPrice } from "@/server/models/prices";
import { parseWav } from "@/server/practice/wav";
import {
  withBudgetedCall,
  type ProviderCallPolicy,
} from "@/server/budget/provider-request";
import type { MetaChatInput } from "@/server/models/meta";
import type { MetaTranscribeInput } from "@/server/models/meta-asr";
import type { FundingSource } from "@/server/models/access";

type ModelInput = MetaChatInput | MetaTranscribeInput;

// Assembled at runtime so secret scanners never see a key-shaped literal.
export const TEST_BYOK_KEY = ["sk", "or", "v1", "test", "key", "1234567890"].join("-");

export interface BudgetedModelFixtureOptions {
  provider?: "meta" | "openrouter";
  apiKey?: string;
  fundingSource?: FundingSource;
  role?: string;
  maxCostMicros?: number;
  db?: DatabaseSync;
  now?: Date;
}

export interface BudgetedModelFixture {
  db: DatabaseSync;
  reservation: Reservation;
  learnerId: string;
  now: Date;
  providerCall: ProviderCallPolicy;
  cleanup(): void;
  run<T>(callback: () => T): T;
}

export function createBudgetedModelFixture(
  input: ModelInput,
  config: AppConfig,
  options: BudgetedModelFixtureOptions = {},
): BudgetedModelFixture {
  const temp = options.db ? undefined : createTempDb();
  const db = options.db ?? temp!.db;
  const now = new Date(options.now ?? new Date());
  const provider = options.provider ?? "meta";
  const fundingSource = options.fundingSource ?? "hosted";
  const apiKey = options.apiKey ?? (provider === "meta" ? config.meta.apiKey ?? "" : TEST_BYOK_KEY);
  const learnerId = insertLearner(db);
  db.prepare("UPDATE learners SET funding_source = ? WHERE id = ?").run(fundingSource, learnerId);

  const isChat = "messages" in input;
  const operation = isChat ? "chat" : "asr";
  const model = input.model;
  const role = options.role ?? (isChat
    ? input.maxTokens === 2048 ? "detect" : "proofread"
    : "dictation_asr");
  const kind = isChat ? (role === "proofread" || role === "dictation_cleanup" ? "proofread" :
    role === "build_practice" || role === "evaluate_attempt" ? "evaluate" : "detect") : "asrSeconds";
  const textPricing = isChat ? textPrice(model) : undefined;
  const asrPricing = isChat ? undefined : asrPrice(model);
  const inputChars = isChat
    ? input.messages.reduce((sum, message) => sum + message.content.length, 0) +
      JSON.stringify({ name: input.jsonSchema.name, schema: input.jsonSchema.schema }).length
    : 0;
  const audioUnits = isChat ? 0 : Math.ceil(parseWav(input.audio).seconds);
  const maxCostMicros = options.maxCostMicros ?? (isChat
    ? estimateMaxCostMicros(model, inputChars, input.maxTokens, textPricing)
    : asrCostMicros(model, audioUnits));
  const reservation = reserve({
    learnerId,
    kind,
    requestId: newId(),
    units: isChat ? 1 : audioUnits,
    maxCostMicros,
    role,
  }, { db, now, config });
  const providerCall: ProviderCallPolicy = {
    provider,
    operation,
    model,
    apiKey,
    price: textPricing ?? asrPricing!,
  };

  return {
    db,
    reservation,
    learnerId,
    now,
    providerCall,
    cleanup() {
      if (temp) temp.cleanup();
    },
    run<T>(callback: () => T): T {
      return withBudgetedCall(reservation.id, {
        db,
        now,
        config,
        reservation,
        providerCall,
      }, callback);
    },
  };
}

export async function runBudgetedModelCall<T>(
  input: ModelInput,
  config: AppConfig,
  callback: () => T | Promise<T>,
  options: BudgetedModelFixtureOptions = {},
): Promise<Awaited<T>> {
  const fixture = createBudgetedModelFixture(input, config, options);
  try {
    return await fixture.run(callback);
  } finally {
    fixture.cleanup();
  }
}

export function makeTestWav(seconds = 1): Uint8Array {
  const sampleRate = 16_000;
  const channels = 1;
  const bits = 16;
  const dataLength = sampleRate * seconds * channels * bits / 8;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bits / 8, true);
  view.setUint16(32, channels * bits / 8, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  return bytes;
}
