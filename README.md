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

## Docs

See `docs/ARCHITECTURE.md` for system design and `CHANGELOG.md` for release history.
