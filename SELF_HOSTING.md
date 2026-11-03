# Self-hosting gloss

gloss is one Next.js container with a SQLite database on a mounted folder. This guide uses Docker Compose; `docker-compose` (v2, standalone) and `docker compose` both work.

## Requirements

- A Linux host with Docker and Compose, about 1 GB of free memory.
- HTTPS in front of the container (a reverse proxy or a tunnel). The session cookie is `Secure`, so browsers only keep it over HTTPS (or on `localhost`).
- A Meta API key (evaluation of practice answers and speech-to-text) and an OpenRouter API key (proofreading and practice situations). Without a key the features that need it report that they are switched off, and the editor still runs its local checks.

## 1. Configure

Copy the example file and fill it in:

```bash
cp .env.example .env.production
```

| Variable | Meaning |
|---|---|
| `META_API_KEY` | Meta API key for the smart tier (evaluation of practice answers) and speech-to-text. |
| `OPENROUTER_API_KEY` | OpenRouter API key for the fast tier (proofreading and practice situations), funded by you. Without it those jobs answer that cloud checking is off; Meta is never used instead. |
| `OPENROUTER_FAST_MODEL` | Optional. OpenRouter model or preset for the fast tier; default `openai/gpt-oss-120b`. The older name `OPENROUTER_PROOFREAD_MODEL` is read when this one is empty. |
| `OPENROUTER_FAST_PRICE_IN_PER_M`, `OPENROUTER_FAST_PRICE_OUT_PER_M` | Optional. USD per million input and output tokens that bound and settle the fast model's cost. The defaults are twice the highest price listed for gpt-oss-120b; a preset uses them too. Set both for any other model, or it is refused. |
| `GLOSSY_PUBLIC_URL` | The address people open, for example `https://gloss.li`. Used for invite links and to accept form posts from your own site only. |
| `DAILY_BUDGET_USD` | Hard spending ceiling for the whole instance per UTC day. |
| `AI_ENABLED` | `false` switches every cloud call off. |

`compose.yaml` fixes `GLOSSY_DATABASE_PATH`, `PORT` and `NODE_ENV`; do not change them there.

The database lives in `./data`, which the container's `node` user (uid 1000) must be able to write:

```bash
mkdir -p data && sudo chown 1000:1000 data
```

## 2. Start

```bash
docker-compose up -d --build
docker-compose ps                       # wait for "healthy"
curl http://127.0.0.1:3200/api/health   # {"ok":true}
```

The container listens on `127.0.0.1:3200` only. Point your proxy or tunnel at `http://127.0.0.1:3200` and keep the original `Host` header (or send `X-Forwarded-Host` and `X-Forwarded-Proto`). Do not strip `Content-Length` from requests: audio uploads need it.

Logs: `docker-compose logs -f gloss`. To update, fetch the new source and run `docker-compose up -d --build` again; database migrations are applied automatically.

## 3. Invite people

There is no anonymous access: everyone needs an invite link.

```bash
docker-compose exec gloss node scripts/invite.mjs --label "Judges" --uses 5 --profile judge --days 14
```

It prints `GLOSSY_PUBLIC_URL/join/<token>`. The token is shown once; only its hash is stored.

| Profile | Checks per day | Practice tasks and evaluations per day | Speech per day |
|---|---|---|---|
| `pilot` | 20 | 12 | 3 minutes |
| `judge` | 30 | 30 | 5 minutes |
| `owner` | 200 | 100 | 30 minutes |

Opening an invite link only shows a page with a **Continue** button; the invite is used when the button is pressed, so link previews do not spend it. A browser that is already signed in keeps its session and does not use the invite: to try a second invite, use another browser or a private window.

## 4. Kill switch and budget

Cloud calls are allowed only when both switches are on. The first needs no restart:

```bash
docker-compose exec gloss node scripts/ai-switch.mjs off      # or: on, status
```

The second is `AI_ENABLED` in `.env.production`; change it and run `docker-compose up -d`.

Every cloud call reserves its worst-case cost before it is sent (for the fast tier, from the price variables above), and the total for the UTC day can never pass `DAILY_BUDGET_USD`. A call whose outcome is unknown (a timeout, for instance) keeps counting at its worst case. When the ceiling is reached, cloud features report it and the editor keeps working with local checks. `ai-switch.mjs status` shows today's spending. To change the ceiling, edit `DAILY_BUDGET_USD` and run `docker-compose up -d`.

## 5. Back up

Everything is in `data/glossy.db` (SQLite in WAL mode, so `-wal` and `-shm` files sit next to it). A check run stores the submitted text's hash and length, rather than the full submitted text. Saved suggestions contain the original and replacement fragments. Practice tasks, answers and feedback are also stored, so treat the database and its backups as learner data.

A consistent copy while the app is running, with `sqlite3` on the host:

```bash
mkdir -p backup && sqlite3 data/glossy.db ".backup 'backup/glossy-$(date +%F).db'"
```

Or without `sqlite3`, from inside the container (the copy appears in `data/`):

```bash
docker-compose exec gloss node -e "new (require('node:sqlite').DatabaseSync)('/app/data/glossy.db').exec(\"VACUUM INTO '/app/data/backup-$(date +%F).db'\")"
```

Or stop and copy:

```bash
docker-compose stop gloss && cp data/glossy.db* backup/ && docker-compose start gloss
```

To restore, stop the container, replace `data/glossy.db` with the backup, delete any `data/glossy.db-wal` and `data/glossy.db-shm`, and start it again.

## Without Docker

Node 26 is required.

```bash
npm ci && npm run build
cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
set -a; . ./.env.production; set +a      # the standalone server reads real environment variables
cd .next/standalone && PORT=3200 node server.js
```

Set `GLOSSY_DATABASE_PATH` to an absolute path, so the server and the commands below use the same database. Create invites with `npm run invite -- --label ...` and use the kill switch with `npm run ai -- on|off|status`, both from the source folder with the same variables set.
