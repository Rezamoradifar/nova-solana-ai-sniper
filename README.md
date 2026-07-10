# Nova Solana AI Sniper

An AI-powered Solana sniper trading platform: token launch detection, on-chain
risk/honeypot analysis, AI scoring, automated buy/sell with TP/SL/trailing
stops, copy trading, a Telegram bot suite, an AI marketing engine, and a web
dashboard.

Competing feature set target: BullX, Photon, Maestro, Banana Gun, Trojan, BonkBot.

## Monorepo layout

```
apps/
  api/               Fastify backend: detection, risk engine, trading engine, REST API
  telegram-bot/       Notification bot, admin bot, marketing bot (grammy)
  marketing-engine/   AI content generator + scheduler for the marketing bot
  dashboard/          React/Vite dark-theme web dashboard
packages/
  shared/             Env validation, logger, shared domain types
  ai/                 Claude/OpenAI provider abstraction + AI risk scoring
docker/               Dockerfiles, nginx config
docs/                 Architecture docs
.github/workflows/    CI
```

## Requirements

- Node.js >= 20
- PostgreSQL
- Redis
- Docker + Docker Compose (for deployment)

## Getting started

```bash
npm install
cp .env.example .env   # fill in secrets, see below
npm run prisma:migrate
npm run dev:api
```

Every `dev:*` and `prisma:*` script loads the root `.env` automatically via
`dotenv-cli` (wired per-workspace since npm sets each workspace's cwd to its
own directory, not the repo root). Docker Compose doesn't need this — it
injects `.env` via `env_file` directly.

## Environment variables

See `.env.example` for the full list. Only `DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, and `ENCRYPTION_KEY` are required to boot the API. Everything
else (Solana RPC, Helius, Jito, Anthropic/OpenAI, Telegram, Twitter) is
optional and the affected feature is disabled/no-ops with a warning log until
configured.

**Never commit `.env`.** Wallet private keys are encrypted at rest (AES-256-GCM)
using `ENCRYPTION_KEY` and are never logged or returned by the API.

## Scripts

- `npm run dev:api` / `dev:bot` / `dev:marketing` / `dev:dashboard`
- `npm run build` — build all workspaces
- `npm run test` — run the test suite
- `npm run lint` / `npm run format`
- `npm run prisma:migrate` / `prisma:deploy`

## Deployment (Docker Compose)

```bash
cp .env.example .env   # fill in secrets
docker compose up -d postgres redis
docker compose run --rm migrate
docker compose up -d api telegram-bot marketing-engine
```

PM2 process management (`ecosystem.config.cjs`) and Docker Compose's own
`restart: unless-stopped` + healthchecks cover crash recovery in the two
respective deployment paths — see the comment at the top of
`ecosystem.config.cjs` for when to use which.

### Nginx + SSL

`docker/nginx/nginx.conf` expects a real domain and an existing Let's Encrypt
certificate, which don't exist yet on a fresh server. Bootstrap both with:

```bash
./scripts/init-letsencrypt.sh your-domain.example you@example.com
docker compose up -d nginx certbot
```

This issues a throwaway self-signed cert so nginx can boot, requests the real
certificate via the HTTP-01 webroot challenge, then reloads nginx. The
`certbot` service renews it automatically afterwards.

## Docs

See `docs/ARCHITECTURE.md` for system design and `CHANGELOG.md` for release history.
