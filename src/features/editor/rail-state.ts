import type { Suggestion } from "@/shared/contracts";

export const RAIL_TABS = ["checks", "ai", "learning"] as const;
export type RailTab = typeof RAIL_TABS[number];
export const RAIL_LABEL = { checks: "Checks", ai: "AI", learning: "Learning" } as const;

export function tabForSuggestion(suggestion: Suggestion): RailTab {
  return suggestion.origin === "learning" ? "learning" : suggestion.source === "local" ? "checks" : "ai";
}

export function railIndicators(suggestions: Suggestion[], flagCount: number, learningCount: number) {
  return {
    checks: suggestions.filter((s) => tabForSuggestion(s) === "checks").length,
    ai: flagCount + suggestions.filter((s) => tabForSuggestion(s) === "ai").length,
    learning: learningCount + suggestions.filter((s) => tabForSuggestion(s) === "learning").length,
  };
}

export function nextRailTab(current: RailTab, key: string): RailTab {
  const index = RAIL_TABS.indexOf(current);
  if (key === "Home") return RAIL_TABS[0];
  if (key === "End") return RAIL_TABS[2];
  if (key === "ArrowRight") return RAIL_TABS[(index + 1) % 3];
  if (key === "ArrowLeft") return RAIL_TABS[(index + 2) % 3];
  return current;
}
