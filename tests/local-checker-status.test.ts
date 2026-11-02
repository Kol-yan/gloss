import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class TestWorker {
  static latest: TestWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  lastRequest: { id: number; text: string } | null = null;
  terminate = vi.fn();
  constructor() { TestWorker.latest = this; }
  postMessage(request: { id: number; text: string }) { this.lastRequest = request; }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("local checker startup", () => {
  it("reports starting until the worker actually answers, then ready", async () => {
    const checker = await import("@/features/editor/local-checker");
    const listener = vi.fn();
    const unsubscribe = checker.subscribeLocalChecker(listener);
    const checked = checker.checkLocal("An example");
    expect(checker.getLocalCheckerStatus()).toBe("starting");
    const worker = TestWorker.latest;
    worker.onmessage?.({ data: { id: worker.lastRequest?.id, ok: true, lints: [] } } as MessageEvent);
    expect(await checked).toEqual([]);
    expect(checker.getLocalCheckerStatus()).toBe("ready");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("ends startup and releases pending checks when the worker fails", async () => {
    const checker = await import("@/features/editor/local-checker");
    const checked = checker.checkLocal("An example");
    TestWorker.latest.onerror?.();
    expect(await checked).toEqual([]);
    expect(checker.getLocalCheckerStatus()).toBe("failed");
    expect(TestWorker.latest.terminate).toHaveBeenCalled();
    expect(await checker.checkLocal("Another example")).toEqual([]);
  });
});
