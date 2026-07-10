# Architecture

## Overview

Nova Solana AI Sniper is a monorepo (npm workspaces) split into independently
deployable apps that share two internal packages:

```
                        ┌──────────────────┐
                        │   packages/shared │  env validation, logger, types
                        │   packages/ai      │  Claude/OpenAI provider, risk scoring
                        └─────────┬─────────┘
                                  │
        ┌─────────────┬──────────┼───────────┬───────────────┐
        │             │          │           │               │
  ┌─────▼─────┐ ┌──────▼─────┐ ┌─▼───────┐ ┌─▼───────────┐   │
  │  apps/api  │ │ telegram-  │ │marketing│ │  dashboard  │   │
  │ (Fastify)  │ │   bot      │ │ engine  │ │ (React/Vite)│   │
  └─────┬──────┘ └──────┬─────┘ └────┬────┘ └─────────────┘   │
        │               │            │                        │
        └───────┬───────┴────────────┘                        │
                │                                              │
        ┌───────▼────────┐      ┌───────────────┐      ┌───────▼──────┐
        │ PostgreSQL      │      │ Redis          │      │ Solana RPC / │
        │ (Prisma)        │      │ (cache/queues) │      │ Helius/Jito  │
        └────────────────┘      └───────────────┘      └──────────────┘
```

## apps/api

The core backend. Organized by layer:

- `solana/` — RPC connection management, Jupiter swap client, Jito bundle
  sender, pump.fun program log subscription.
- `detection/` — turns raw on-chain events into semantic signals: new token
  launches, liquidity adds, migrations, whale wallet activity. Also owns the
  rule-based risk analyzer (mint/freeze authority, holder concentration,
  liquidity depth via DexScreener).
- `trading/` — the exit engine (TP/SL/trailing stop) is a pure function so it
  can be unit tested and reused identically in live trading and backtesting.
  Position manager executes swaps via Jupiter and records trades/positions.
  Auto-trader matches launches against every user's active snipe config.
  Copy-trading mirrors tracked wallets' trades proportionally.
- `security/` — AES-256-GCM at-rest encryption for wallet private keys (never
  stored or logged in plaintext), scrypt password hashing.
- `routes/` — REST API surface (auth, tokens, trades, positions, snipe
  configs, wallets, portfolio, leaderboard).
- `worker.ts` — wires detection → risk analysis → AI scoring → auto-trader
  into a background pipeline started alongside the HTTP server.

### Data flow: new token detection → auto-buy

1. `PumpFunMonitor` subscribes to program logs over the RPC websocket.
2. `TokenEventClassifier` classifies each log batch as a create/buy/migration.
3. On a `new_token` event, `RiskAnalyzer` pulls on-chain mint/freeze authority
   state, holder concentration, and DexScreener liquidity, producing a
   rule-based score independent of any AI call.
4. If an AI provider key is configured, `scoreToken` (packages/ai) asks
   Claude/OpenAI for a second opinion; otherwise the pipeline runs on the
   rule-based score alone (never blocks on a missing AI key).
5. `AutoTrader` evaluates every active `SnipeConfig` with `autoBuyOnLaunch`
   against the combined score and liquidity thresholds, and opens a position
   per matching user wallet via `PositionManager` (Jupiter quote → build →
   sign → simulate → send).
6. Open positions are monitored on each price tick; `evaluateExit` decides
   take-profit/stop-loss/trailing-stop exits, and `PositionManager` closes the
   position via a reverse swap.

## apps/telegram-bot

Three logical bots sharing one grammy `Bot` instance and Telegram token:
notifications (trade/position alerts), admin commands (start/stop
auto-trading, view stats), and the marketing poster (consumes
`apps/marketing-engine` output). Runs as a no-op with a warning log if
`TELEGRAM_BOT_TOKEN` is not set, so its absence never blocks the rest of the
stack from starting.

## apps/marketing-engine

Generates unique, category-rotated marketing posts (news, trading tips,
market updates, trending tokens, referral, announcements) via the shared AI
provider, deduplicates by content hash against `MarketingPost` records so
nothing repeats, and schedules 3-5 random-time posts per day, publishing
through the Telegram marketing bot.

## apps/dashboard

React/Vite dark-theme SPA: live charts (TradingView widget embed), wallet
monitor, trade/position logs, snipe/copy-trade settings, portfolio, and a PnL
leaderboard. Talks to `apps/api` over REST + a websocket for live updates.

## Security posture

- Private keys/seed phrases are encrypted at rest (AES-256-GCM, scrypt-derived
  key) and only ever decrypted in-memory for the duration of a single signing
  operation.
- The shared logger redacts any field matching `key|token|secret|password|seed|private`
  plus an explicit path-based redaction list, so secrets can't leak into logs
  even via an unexpected object shape.
- All secrets are supplied via environment variables (`.env`, gitignored) —
  never committed, never returned by any API response.
- JWT auth + rate limiting + helmet on the API; scrypt (not plaintext/reversible
  hashing) for user passwords.

## Deployment

Docker Compose brings up Postgres, Redis, the API, the Telegram bot, the
marketing engine, and an Nginx reverse proxy (TLS via certbot) in front of the
API and dashboard. PM2 (`ecosystem.config.cjs`) is the process supervisor
inside each app container, restarting on crash and exposing health checks that
Compose's `healthcheck` blocks poll.
