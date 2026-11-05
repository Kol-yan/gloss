import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

afterEach(() => vi.unstubAllEnvs());

async function securityHeaders() {
  const rules = await nextConfig.headers!();
  expect(rules).toHaveLength(1);
  expect(rules[0].source).toBe("/:path*");
  return Object.fromEntries(rules[0].headers.map(({ key, value }) => [key, value]));
}

describe("security response headers", () => {
  it("blocks embedding and MIME sniffing while preserving the live demo's resources", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = await securityHeaders();
    const directives = Object.fromEntries(headers["Content-Security-Policy"].split("; ").map(value => {
      const [name, ...sources] = value.split(" ");
      return [name, sources];
    }));
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    for (const directive of ["script-src", "connect-src", "frame-src"]) {
      expect(directives[directive]).toContain("https://challenges.cloudflare.com");
    }
    expect(directives["script-src"]).toContain("'unsafe-inline'");
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["script-src"]).toContain("'wasm-unsafe-eval'");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");
    expect(directives["worker-src"]).toContain("'self'");
    expect(directives["connect-src"]).toContain("data:");
    expect(directives["font-src"]).toEqual(["'self'"]);
  });

  it("permits development debugging without enabling eval in production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await securityHeaders())["Content-Security-Policy"]).toContain("'unsafe-eval'");
  });
});
