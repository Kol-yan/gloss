import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers() {
    // Cached shells contain Next's inline bootstrap; per-request nonces would
    // require replacing partial prerendering with dynamic rendering.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' data: blob: https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
  },
  // A self-contained server (.next/standalone) for the Docker image.
  output: "standalone",
  // The migration runner reads db/migrations at run time from a path the
  // tracer cannot follow, so name it. Keeps `node .next/standalone/server.js`
  // working without the source tree.
  outputFileTracingIncludes: {
    "/**": ["./db/migrations/**/*"],
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
