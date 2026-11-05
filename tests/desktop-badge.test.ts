import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

it("allows the badge to receive events and updates its count on successive results", () => {
  const capability = JSON.parse(readFileSync("desktop/src-tauri/capabilities/default.json", "utf8"));
  expect(capability.windows).toContain("badge");
  expect(capability.permissions).toContain("core:event:default");
  const badge = { dataset: {} as Record<string, string>, addEventListener() {} };
  const count = { textContent: "" };
  let receive: ((fixes: number) => void) | undefined;
  const source = readFileSync("desktop/src/badge.ts", "utf8").replace(/^import .* from "\.\/bridge";$/m, "");
  runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), {
    byId: (id: string) => id === "badge" ? badge : count,
    invoke: async () => undefined,
    listen: (event: string, handler: (fixes: number) => void) => {
      expect(event).toBe("badge");
      receive = handler;
      return Promise.resolve(() => undefined);
    },
  });
  receive!(3);
  expect(count.textContent).toBe("3");
  expect(badge.dataset.fixes).toBe("3");
  receive!(1);
  expect(count.textContent).toBe("1");
  expect(badge.dataset.fixes).toBe("1");
});
