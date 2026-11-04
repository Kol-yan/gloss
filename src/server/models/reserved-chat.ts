import type { DatabaseSync } from "node:sqlite";
import { markUnknown, settle, type Reservation } from "../budget";
import type { AppConfig } from "../config";
import { immediate } from "../db";
import {
  ModelHttpError,
  ModelNotConfiguredError,
  ModelOutputError,
  UnknownModelError,
  type TokenUsage,
} from "./errors";
import { type MetaChatInput } from "./meta";
import { settledTextCostMicros } from "./prices";
import { resolveProviderAccess, resolveTextRoute, type ModelTier, type ProviderAccess, type TextRoute } from "./access";
import { chatWithRoute } from "./dispatch";

export interface ReservedChatArgs<T> {
  db: DatabaseSync;
  now: Date;
  config: AppConfig;
  // Already made by the caller, before this call.
  reservation: Reservation;
  // The model comes from the route that the tier selects for this learner.
  tier: ModelTier;
  chat: Omit<MetaChatInput, "model">;
  providerAccess?: ProviderAccess;
  // Returns null when the content is not usable.
  parse: (content: string) => T | null;
}

// Runs one model call against an existing reservation and closes the
// reservation whatever happens:
// - outcome unknown (timeout, dropped connection): keeps counting max cost;
// - provider refused (HTTP error) or nothing was sent: cost 0;
// - answer unusable: the work was billed, so reported usage or max cost.
// On failure the model error is rethrown after the bookkeeping.
export async function runReservedChat<T>(args: ReservedChatArgs<T>): Promise<{
  value: T;
  latencyMs: number;
}> {
  const { db, now, config, reservation, chat, parse } = args;
  const close = (cost: number | "unknown") =>
    immediate((tx) => {
      if (cost === "unknown") markUnknown(reservation.id, { db: tx, now });
      else settle(reservation.id, cost, { db: tx, now });
    }, db);
  let route: TextRoute | undefined;
  const billed = (usage: TokenUsage | null) =>
    route ? settledTextCostMicros(route.price, usage, reservation.maxCostMicros) : reservation.maxCostMicros;

  let result;
  try {
    const access = resolveProviderAccess(reservation.learnerId, args.providerAccess, db);
    route = resolveTextRoute(access, config, args.tier);
    result = await chatWithRoute({ ...chat, model: route.model }, route, config, { reservation, db, now });
  } catch (error) {
    if (error instanceof ModelOutputError) close(billed(error.usage));
    else if (
      error instanceof ModelHttpError ||
      error instanceof ModelNotConfiguredError ||
      error instanceof UnknownModelError ||
      error instanceof RangeError
    ) {
      close(0);
    } else {
      // ModelTimeoutError or anything unexpected: the provider may have billed.
      close("unknown");
    }
    throw error;
  }

  const value = parse(result.content);
  if (value === null) {
    close(billed(result.usage));
    throw new ModelOutputError("invalid_output", result.usage, result.latencyMs);
  }
  close(billed(result.usage));
  return { value, latencyMs: result.latencyMs };
}
