// Runs the Harper rule checker off the main thread. It answers each request
// with plain data; the main thread never loads the WebAssembly module.
import type { LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { collectLints, createLinter } from "./harper-lint";
import type { RawLint } from "./local-lint";

export type WorkerRequest = { id: number; text: string };
export type WorkerResponse = { id: number; ok: true; lints: RawLint[] } | { id: number; ok: false };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

let linter: Promise<LocalLinter> | null = null;

scope.onmessage = async (event) => {
  const { id, text } = event.data;
  try {
    linter ??= createLinter(binary);
    scope.postMessage({ id, ok: true, lints: await collectLints(await linter, text) });
  } catch {
    // A failed start is not retried by the next message; the adapter turns the
    // failure into "no local suggestions".
    scope.postMessage({ id, ok: false });
  }
};
