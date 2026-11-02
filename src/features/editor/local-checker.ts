// Main-thread adapter for the on-device rule checker. The worker (and with it
// the ~20 MB WebAssembly module) is created on the first request, so the editor
// paints without waiting for it. If anything fails, checking quietly returns no
// suggestions and the editor keeps working.
import type { Suggestion } from "@/shared/contracts";
import { mapLints } from "./local-lint";
import type { WorkerRequest, WorkerResponse } from "./local-checker.worker";

type Pending = { text: string; resolve: (suggestions: Suggestion[]) => void };
export type LocalCheckStatus = "idle" | "starting" | "ready" | "failed";

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const pending = new Map<number, Pending>();
let status: LocalCheckStatus = "idle";
const listeners = new Set<() => void>();

function setStatus(next: LocalCheckStatus) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

export function subscribeLocalChecker(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getLocalCheckerStatus(): LocalCheckStatus {
  return status;
}

export function getServerLocalCheckerStatus(): LocalCheckStatus {
  return "idle";
}

function failAll() {
  broken = true;
  setStatus("failed");
  worker?.terminate();
  worker = null;
  for (const entry of pending.values()) entry.resolve([]);
  pending.clear();
}

function getWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  setStatus("starting");
  try {
    const created = new Worker(new URL("./local-checker.worker.ts", import.meta.url), { type: "module" });
    created.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (response.ok) {
        setStatus("ready");
        entry.resolve(mapLints(entry.text, response.lints));
      } else {
        // The worker could not start (for example the WebAssembly file failed to load).
        failAll();
        entry.resolve([]);
      }
    };
    created.onerror = failAll;
    worker = created;
    return created;
  } catch {
    broken = true;
    setStatus("failed");
    return null;
  }
}

// Implements the editor's `CheckLocal` hook. `text` must already be normalized.
export function checkLocal(text: string): Promise<Suggestion[]> {
  const target = getWorker();
  if (!target) return Promise.resolve([]);
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { text, resolve });
    const request: WorkerRequest = { id, text };
    try {
      target.postMessage(request);
    } catch {
      failAll();
    }
  });
}
