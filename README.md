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

Invited learners use hosted models: an open-weight model through the operator's
OpenRouter account for proofreading and practice situations, and Meta Muse Spark
for judging answers. Other visitors can use their own OpenRouter key for
equivalent models. The key is stored in the browser and passes
transiently through the server to OpenRouter; the application does not store or
log it. You can forget the key without deleting your workspace.

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

Single-word vocabulary includes a pronunciation guide when available and optional
playback through a local English browser voice. Voice availability varies by browser.

An optional [unpacked browser extension](extension/README.md) opens selected text
in the editor for review. Its source and automated checks are included; manual
browser-extension installation is still pending verification.

## License

[AGPL-3.0](LICENSE)

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for direct runtime dependencies.
