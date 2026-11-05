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

## Commits and releases

The website (`web`, the repository root), the browser extension (`extension/`)
and the desktop app (`desktop/`) are versioned and released separately, with
tags `web-vX.Y.Z`, `extension-vX.Y.Z` and `desktop-vX.Y.Z`. Release-please
reads Conventional Commits (checked by commitlint on pull requests) to bump
versions and write each product's `CHANGELOG.md`.

- One commit changes one product, or one concern shared by all of them (CI,
  docs). A commit that touches two products lands in both changelogs.
- Use a scope: `feat(web): …`, `fix(extension): …`, `feat(desktop): …`.
- The subject of a `feat` or `fix` commit is the line users read in the
  changelog. Write what changes for them, in plain words, under 100
  characters. Use `chore`, `refactor`, `test`, `docs`, `ci` or `build` for
  work users do not see; those stay out of the changelog.
- Mark a breaking change with `!` (`feat(desktop)!: …`) and explain it in a
  `BREAKING CHANGE:` footer. It raises the major version. It is breaking when:
  - **web**: an operator must act by hand to upgrade (a new required setting,
    a manual migration step), or released extension or desktop versions stop
    working with the server;
  - **extension**: the manifest asks for a new permission or host access, so
    browsers prompt the user again or disable the extension until they accept;
  - **desktop**: users must reinstall, or grant Accessibility or microphone
    access again, or the minimum macOS version goes up.
- Do not edit versions or changelogs by hand; the release pull request does.
