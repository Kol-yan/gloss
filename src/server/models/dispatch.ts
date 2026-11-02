import type { AppConfig } from "../config";
import type { ProviderAccess } from "./access";
import { metaChat, type MetaChatInput } from "./meta";
import { metaTranscribe, type MetaTranscribeInput } from "./meta-asr";
import { openRouterChat, openRouterTranscribe } from "./openrouter";

export function chatWithAccess(input: MetaChatInput, access: ProviderAccess, config: AppConfig) {
  return access.provider === "meta" ? metaChat(input, { config }) : openRouterChat(input, access.apiKey, config);
}

export function transcribeWithAccess(input: MetaTranscribeInput, access: ProviderAccess, config: AppConfig) {
  return access.provider === "meta" ? metaTranscribe(input, { config }) : openRouterTranscribe(input, access.apiKey, config);
}
