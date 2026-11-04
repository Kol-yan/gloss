// Typed access to the Tauri API that `app.withGlobalTauri` exposes on
// `window.__TAURI__`. Using the global keeps this frontend free of npm
// runtime dependencies, so the repository's root type check can include it.

type Unlisten = () => void;

interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<Unlisten> };
}

function tauri(): TauriGlobal {
  const api = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!api) throw new Error("This page only works inside the gloss desktop app.");
  return api;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(command, args);
}

export function listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  return tauri().event.listen<T>(event, (event) => handler(event.payload));
}

// Commands reject with a learner-safe sentence; anything else gets a fixed one.
export function errorMessage(error: unknown): string {
  return typeof error === "string" && error ? error : "Something went wrong. Please try again.";
}

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
