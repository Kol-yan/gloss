<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project conventions

- Read `ARCHITECTURE.md` before changing server code, data model or API contracts.
- Shared request/response contracts live in `src/shared/contracts.ts`. Change them deliberately; client and server both depend on them.
- Code, comments, identifiers, commit messages and UI copy are in English.
- Comments explain intent and constraints, not what the next line does.
- Secrets are read on the server only. Never import server modules into client components.
- Every learner-owned query filters by the learner from the session. There is no default learner.
- Model calls go through `src/server/models` and the budget reservation in `src/server/budget`. No direct `fetch` to model providers elsewhere.
- Text ranges are UTF-16 indices into text normalized by `normalizeText` (`src/lib/text`).
- Learner-facing errors are short and human; never show raw provider errors or stack traces.
- Before finishing: `npm run lint && npm run typecheck && npm test && npm run build`.
