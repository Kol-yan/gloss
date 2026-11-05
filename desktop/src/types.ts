// Payloads from the Rust side (src-tauri/src/state.rs and check.rs). The
// suggestion shape is the server's own (src/shared/contracts.ts).

export type Permission = "granted" | "missing" | "notRequired";

export interface QuotaState {
  used: number;
  limit: number;
}

export interface Settings {
  serverUrl: string;
  checkShortcut: string;
  dictationShortcut: string;
  checkAsYouType: boolean;
}

export interface Account {
  signedIn: boolean;
  displayName: string | null;
  accessMode: string | null;
  aiEnabled: boolean | null;
  checks: QuotaState | null;
  dictationSeconds: QuotaState | null;
  notice: string | null;
  remembered: boolean;
  shortcutPressed: boolean;
}

export interface Overview {
  settings: Settings;
  account: Account;
  os: string;
  accessibility: Permission;
  shortcutError: string | null;
  /** "on" while the right Option monitor runs; "off" otherwise. */
  inputMonitoring: "on" | "off";
  version: string;
}

export type SuggestionCategory = "error" | "style" | "expression";

export interface Suggestion {
  id: string;
  source: string;
  category: SuggestionCategory;
  start: number;
  end: number;
  original: string;
  replacement: string;
  reason: string;
  meaningChange: boolean;
  meaning: string | null;
  ipa?: string | null;
}

export type PanelAction = "openSettings" | "grantAccessibility" | "openMicrophoneSettings";

export type PanelView =
  | { phase: "idle" }
  | { phase: "checking"; preview: string }
  | { phase: "ready"; text: string; suggestions: Suggestion[]; quota: QuotaState }
  | { phase: "notice"; title: string; detail: string; action: PanelAction | null };

export function remaining(quota: QuotaState | null): number | null {
  return quota ? Math.max(0, Math.floor(quota.limit - quota.used)) : null;
}
