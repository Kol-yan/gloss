import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
