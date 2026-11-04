import { STARTER_ENTRIES } from "./entries-data";
import { loadStarterSet, type LoadedStarterSet } from "./schema";

let loaded: LoadedStarterSet | undefined;

// One validated instance per process. Throws StarterSetError if the data is
// invalid, so a broken build never reaches a learner.
export function starterSet(): LoadedStarterSet {
  loaded ??= loadStarterSet(STARTER_ENTRIES);
  return loaded;
}

export function starterEntry(text: string): import("./entries").StarterEntry | undefined {
  return starterSet().byText.get(text.toLowerCase().replace(/\s+/g, " ").trim());
}

export { STARTER_ENTRIES };
