import type { AppConfig } from "../config";
import type { ProviderAccess, TextRoute } from "./access";
import { metaChat, type MetaChatInput } from "./meta";
import { metaTranscribe, type MetaTranscribeInput } from "./meta-asr";
import { openRouterChat, openRouterTranscribe } from "./openrouter";

// The route, never the caller, decides the provider: there is no fallback from
// one provider or tier to another.
export function chatWithRoute(input: MetaChatInput, route: TextRoute, config: AppConfig) {
  return route.provider === "meta"
    ? metaChat(input, { config, timeoutMs: input.timeoutMs })
    : openRouterChat(input, route, config);
}

export function transcribeWithAccess(input: MetaTranscribeInput, access: ProviderAccess, config: AppConfig) {
  return access.provider === "meta" ? metaTranscribe(input, { config }) : openRouterTranscribe(input, access.apiKey, config);
}
