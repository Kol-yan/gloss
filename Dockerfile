# syntax=docker/dockerfile:1

# --- dependencies ------------------------------------------------------------
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build -------------------------------------------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `public/` may be empty, and git does not keep empty directories.
RUN mkdir -p public
RUN npm run build
# The invite and kill-switch CLIs are TypeScript with path aliases and tsx is a
# dev dependency, so ship them as plain bundled Node scripts.
RUN npx esbuild scripts/invite.ts scripts/ai-switch.ts \
      --bundle --platform=node --format=esm --target=node26 \
      --outdir=.runtime-scripts --out-extension:.js=.mjs --log-level=warning

# --- runtime -----------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    GLOSSY_DATABASE_PATH=/app/data/glossy.db

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Read from the working directory at run time by the migration runner.
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/.runtime-scripts ./scripts

# The database lives here; mount a volume owned by uid 1000 over it.
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
