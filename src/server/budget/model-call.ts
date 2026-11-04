import type { DatabaseSync } from "node:sqlite";
import type { Reservation } from "./index";
import { withBudgetedCall, type ProviderCallPolicy } from "./provider-request";
import type { AppConfig } from "../config";
import type { ProviderAccess, TextRoute } from "../models/access";
import { metaChat, type MetaChatInput } from "../models/meta";
import { metaTranscribe, type MetaTranscribeInput } from "../models/meta-asr";
import { openRouterChat, openRouterTranscribe } from "../models/openrouter";
import { asrPrice } from "../models/prices";

export interface ModelCallReservationContext {
  reservation: Reservation;
  db: DatabaseSync;
  now: Date;
}

// Only this budget-owned dispatcher can invoke model adapters. The exact
// provider route is snapshotted into the async scope and checked at send time.
export function chatWithRoute(
  input: MetaChatInput,
  route: TextRoute,
  config: AppConfig,
  budget: ModelCallReservationContext,
) {
  const providerCall: ProviderCallPolicy = route.provider === "meta"
    ? { provider: "meta", operation: "chat", model: route.model, apiKey: config.meta.apiKey ?? "", price: route.price }
    : { provider: "openrouter", operation: "chat", model: route.model, apiKey: route.apiKey, price: route.price };
  return withBudgetedCall(budget.reservation.id, {
    ...budget,
    config,
    providerCall,
  }, () => route.provider === "meta"
    ? metaChat(input, { config, timeoutMs: input.timeoutMs })
    : openRouterChat(input, route, config));
}

export function transcribeWithAccess(
  input: MetaTranscribeInput,
  access: ProviderAccess,
  config: AppConfig,
  budget: ModelCallReservationContext,
) {
  const providerCall: ProviderCallPolicy = access.provider === "meta"
    ? { provider: "meta", operation: "asr", model: input.model, apiKey: config.meta.apiKey ?? "", price: asrPrice(input.model) }
    : { provider: "openrouter", operation: "asr", model: input.model, apiKey: access.apiKey, price: asrPrice(input.model) };
  return withBudgetedCall(budget.reservation.id, {
    ...budget,
    config,
    providerCall,
  }, () => access.provider === "meta"
    ? metaTranscribe(input, { config })
    : openRouterTranscribe(input, access.apiKey, config));
}
