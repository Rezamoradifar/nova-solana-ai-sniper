# Architecture

This document describes the system design of Nova Solana AI Sniper as it
exists in this repository today. For a shorter, code-organization-focused
version see `docs/ARCHITECTURE.md`; this document is the investor/engineering
-facing overview.

## 1. Monorepo layout

```
apps/
  api/               Fastify backend — detection, risk engine, AI scoring,
                      trading engine, financial core, REST + WebSocket API
  telegram-bot/       User-facing bot (grammy): trading alerts, wallet,
                      referrals, withdrawals, admin controls
  marketing-engine/   AI-generated content scheduler for a marketing bot feed
  dashboard/          React/Vite SPA
packages/
  shared/             Env validation, logger, domain types, financial
                      primitives (withdrawal engine, ledger, referral,
                      portfolio math) shared between apps/api and
                      apps/telegram-bot
  ai/                 Claude/OpenAI provider abstraction + deterministic +
                      LLM-assisted risk scoring
docker/               Dockerfiles, nginx config
docs/                 This documentation set
```

`packages/shared` exists specifically so the withdrawal engine, ledger
writer, and referral logic are called by **both** `apps/api`'s HTTP routes
and `apps/telegram-bot`'s slash commands against the exact same functions
and the same Prisma client — never two independent reimplementations of a
financial workflow.

## 2. High-level component diagram

```mermaid
flowchart TB
    subgraph Sources["Discovery Sources (independently toggleable)"]
        S1["pump.fun / PumpSwap program logs"]
        S2["Raydium AMM+CLMM / Orca Whirlpool / Meteora DLMM /\nOpenBook v2 / Moonshot / Phoenix / Fluxbeam"]
        S3["DexScreener boosts & profiles poller"]
        S4["Birdeye poller"]
        S5["X (Twitter) mention monitor"]
        S6["Telegram trend-channel monitor"]
    end

    subgraph Pipeline["apps/api — Trading Pipeline"]
        DET["Detection / Discovery Registry\n(dedupe, cheap filters, enrichment)"]
        RISK["Risk Analyzer\n(rule-based: mint/freeze authority,\nLP lock, holders, liquidity)"]
        AISC["AI Scoring (packages/ai)\nClaude/OpenAI second opinion,\nhard-ceiling enforced in code"]
        ENTRY["Entry Filter + Position Sizing"]
        AUTO["AutoTrader — evaluates every\nactive SnipeConfig"]
        PM["Position Manager\n(Jupiter primary, native-DEX fallback)"]
        MON["Price Monitor / Emergency Exit Monitor /\nInstitutional partial-exit ladder"]
    end

    subgraph Financial["Financial Core"]
        FEE["Fee & Referral System"]
        DIST["Profit Distribution Engine"]
        WD["Withdrawal Engine + Executor"]
        LEDGER[("Ledger + Audit\n(immutable, DB-trigger enforced)")]
    end

    subgraph Surfaces["User Surfaces"]
        TG["Telegram Bot"]
        DASH["React Dashboard"]
    end

    Sources --> DET --> RISK --> AISC --> ENTRY --> AUTO --> PM
    PM --> MON --> PM
    PM -- "position.updated (event bus)" --> FEE --> DIST --> LEDGER
    DIST --> WD --> LEDGER
    PM --> TG
    PM --> DASH
    WD --> TG
    WD --> DASH
    FEE -.-> TG
    DIST -.-> TG

    Pipeline --> PG[(PostgreSQL / Prisma)]
    Financial --> PG
    Pipeline --> RD[(Redis)]
```

## 3. Data flow: token discovery → automated buy → exit

```mermaid
sequenceDiagram
    participant Chain as Solana RPC / Program Logs
    participant Disc as Discovery Registry
    participant Risk as Risk Analyzer
    participant AI as AI Scoring
    participant Auto as AutoTrader
    participant PM as Position Manager
    participant Mon as Price / Emergency Monitors
    participant Fee as Fee & Referral System
    participant Dist as Profit Distribution

    Chain->>Disc: new token / pool creation log
    Disc->>Disc: dedupe (TTL cache + DB upsert), cheap filters, enrichment
    Disc->>Risk: candidate token
    Risk->>Risk: mint/freeze authority, LP lock/burn,\nholder concentration, liquidity depth
    Risk->>AI: rule-based flags + signals
    AI-->>Risk: score (LLM-assisted, hard ceiling\nre-enforced in code regardless of LLM output)
    Risk->>Auto: combined risk/AI score
    Auto->>Auto: match against every active SnipeConfig\n(liquidity/AI-score thresholds, entry filter)
    Auto->>PM: open position (per matching user wallet)
    PM->>Chain: Jupiter quote → build → sign → simulate → send
    Chain-->>PM: on-chain confirmation (real balance delta, not quote)
    loop every price tick
        Mon->>PM: evaluate TP / SL / trailing stop /\npartial-exit ladder / emergency exit
        PM->>Chain: reverse swap on exit trigger
    end
    PM->>Fee: position.updated (CLOSED, realizedPnlUsd > 0)
    Fee->>Dist: PerformanceFeeLedger row created
    Dist->>Dist: idempotent distribution (DB-unique constraints)
```

## 4. apps/api internals

| Directory                           | Responsibility                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `solana/`                           | RPC connection management (with failover across configured providers), Jupiter swap client, Jito bundle sender, per-DEX native executors, price oracles                                                                                   |
| `detection/`                        | Turns raw on-chain events into semantic signals (new launches, migrations, whale activity); rule-based risk analyzer                                                                                                                      |
| `discovery/`                        | Multi-source discovery registry: adapters, pollers, cheap pre-filters, enrichment, dedupe                                                                                                                                                 |
| `social/`                           | Twitter mention monitor, Telegram trend-channel monitor                                                                                                                                                                                   |
| `trading/`                          | Exit engine (pure function, unit-testable, shared by live trading and backtesting), Position Manager, AutoTrader, entry filter, position sizing, adaptive/institutional trailing stops, Emergency Exit Monitor, copy trading, backtesting |
| `business/`                         | Performance fee & referral system, Profit Distribution Engine                                                                                                                                                                             |
| `wallet/`                           | Deposit monitor, withdrawal execution monitor                                                                                                                                                                                             |
| `security/` (via `packages/shared`) | AES-256-GCM at-rest key encryption, scrypt password hashing                                                                                                                                                                               |
| `routes/`                           | REST API surface — see `API.md`                                                                                                                                                                                                           |
| `worker.ts`                         | Wires detection → risk → AI → auto-trader → monitors into a background pipeline started alongside the HTTP server                                                                                                                         |

## 5. Concurrency & data-integrity design

Every path that moves money or changes a financial record's state is
designed around one rule: **a check-then-act read followed by a separate
write is never trusted alone** — it is always backed by either an atomic
conditional `UPDATE`, a `SELECT ... FOR UPDATE` row lock inside a
transaction, or a database-level unique constraint that makes a duplicate
write physically impossible, not just unlikely.

| Path                                              | Guard                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Position close (TP/SL/trailing/emergency/partial) | `PositionCloseLock` — DB-unique claim table (`position_close_claims`) + in-process mutex + stale-claim auto-recovery                                      |
| Duplicate open position                           | Postgres partial unique index: at most one `OPEN` position per `(walletId, tokenId)`                                                                      |
| Withdrawal request                                | Atomic conditional balance-reservation `UPDATE`, partial unique index (one active request per user), optional idempotency key                             |
| Withdrawal status transition                      | `SELECT ... FOR UPDATE` row lock inside a transaction                                                                                                     |
| Withdrawal execution signature                    | Guarded single-write column — a second write attempt throws instead of silently overwriting                                                               |
| Profit distribution                               | Unique constraint on `(positionId)` / `(performanceFeeLedgerId)` — fast-path event and reconciliation sweep can safely race                               |
| Referral reward grant                             | Unique constraint on `referrerUserId` in a dedicated `referral_reward_grants` table — two simultaneous qualifying referrals can never both grant a reward |

## 6. apps/telegram-bot

A single `grammy` bot instance serving three logical surfaces: trading/exit
alerts, an inline-keyboard-driven user experience (wallet, snipe/exit-
strategy configuration, referrals, withdrawals, profit/earnings dashboards),
and an admin control surface. Shares `packages/shared`'s withdrawal/ledger/
referral logic directly with `apps/api` — never a second implementation.

## 7. apps/marketing-engine

Generates category-rotated marketing posts (news, trading tips, market
updates, trending tokens, referral pushes, announcements) via the shared AI
provider, deduplicates by content hash, and schedules a small number of
random-time posts per day, publishing through the Telegram bot.

## 8. apps/dashboard

A React/Vite SPA. REST polling on a fixed interval, plus a `/ws` WebSocket
event push (`token.created` / `trade.created` / `position.updated`) from an
in-process event bus so pages refresh immediately rather than waiting out
the poll interval. JWT is passed as a `?token=` query param on the WebSocket
handshake (browsers cannot set custom headers on a WS upgrade request); REST
polling remains as a resilience fallback if the socket drops.

## 9. Database

PostgreSQL via Prisma. Every migration is a plain, reviewable SQL file (no
destructive migrations are auto-generated without review). Key model
groups: `User` / `Wallet` / `Token` / `Trade` / `Position` /
`PositionPartialExit` / `EmergencyExitLog` / `SnipeConfig`; the financial
core: `LedgerEntry` / `AuditLog` / `PerformanceFeeLedger` / `ReferralReward`
/ `ProfitDistribution` / `UserDistributionBalance` / `OwnerBalance` /
`PlatformBalance` / `WithdrawalRequest` / `WithdrawalSettings` /
`BusinessSettings` / `ReferralLevelConfig`; and the concurrency-guard tables
`position_close_claims` / `referral_reward_grants`.

`LedgerEntry` and `AuditLog` are made genuinely immutable by a Postgres
`BEFORE UPDATE/DELETE` trigger — not merely an application-level
convention — since a table owner always bypasses `GRANT`/`REVOKE`
restrictions on their own tables in Postgres.

## 10. Deployment topology

```mermaid
flowchart LR
    Internet((Internet)) -->|HTTPS 443 / HTTP 80| Nginx[Nginx\nreverse proxy + TLS]
    Nginx -->|"/api/* (prefix stripped)"| API["nova-api\n(Fastify, PM2)"]
    Nginx -->|"/* (SPA fallback)"| Static["Dashboard static build"]
    API --> PG[(PostgreSQL)]
    API --> Redis[(Redis)]
    API --> RPC["Solana RPC providers\n(Helius / QuickNode / Chainstack / public)"]
    Bot["nova-telegram-bot\n(PM2)"] --> PG
    Bot --> TGAPI[["Telegram Bot API"]]
    Marketing["nova-marketing-engine\n(PM2)"] --> PG
    Marketing --> TGAPI
```

Two supported deployment paths:

- **Bare-metal / VPS** — `ecosystem.config.cjs`, PM2 supervises `nova-api`,
  `nova-telegram-bot`, `nova-marketing-engine` directly, with automatic
  restart, a memory cap, and backoff on crash-looping.
- **Docker Compose** — `docker-compose.yml` runs Postgres, Redis, a one-shot
  migration job, the three Node services, and an Nginx + certbot pair, each
  with `restart: unless-stopped` and a healthcheck (PM2 is not run a second
  time inside containers).

See `INSTALL.md` for step-by-step setup of either path.

## 11. Security posture summary

See `SECURITY.md` for the complete, audited posture. Summary: private keys
encrypted at rest (AES-256-GCM), decrypted only in-memory for a single sign
operation; scrypt + `timingSafeEqual` password handling; JWT auth with
tiered rate limiting; Zod validation on every input; ownership checks on
every user-scoped route; an immutable, trigger-enforced ledger/audit trail;
and a firewalled, Nginx-fronted network topology — the API and dashboard dev
server are never directly internet-reachable.
