# Glossy

Glossy checks your English writing and turns a useful correction into a short writing and speaking practice, so the words you understand become words you use.

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## License

[AGPL-3.0](LICENSE)
