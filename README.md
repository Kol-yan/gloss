# gloss

gloss checks your English writing and turns a useful correction into a short writing and speaking practice, so the words you understand become words you use.

Status: under active development.

## Quick start

Requires Node 26.

```bash
npm install
cp .env.example .env.local   # fill in your keys
npm run dev
npm run invite -- --label me --uses 1 --profile owner
```

Open the printed invite link.

## What runs where

- Rule-based checking runs in your browser and never leaves your device.
- Cloud checking, practice tasks, feedback and speech-to-text run on the server only when you ask for them, within daily quotas.

Invited learners use hosted Meta models. Other visitors can use their own
OpenRouter key for the same models. The key is stored in the browser and passes
transiently through the server to OpenRouter; the application does not store or
log it. You can forget the key without deleting your workspace.

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## License

[AGPL-3.0](LICENSE)

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for direct runtime dependencies.
