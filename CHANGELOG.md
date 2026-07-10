# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Monorepo scaffold: npm workspaces, TypeScript project references, ESLint 9 flat config,
  Prettier, Husky + lint-staged, Vitest.
- `packages/shared`: env schema validation (zod), redacting logger (pino), shared domain types.
- `packages/ai`: Claude/OpenAI provider abstraction with auto-selection, AI token risk scoring.
- `apps/api`: Fastify 5 backend.
  - Prisma schema: users, wallets, tokens, trades, positions, snipe configs, smart wallets,
    copy-trade configs, watchlists, marketing posts, audit log.
  - Security: AES-256-GCM at-rest wallet encryption, scrypt password hashing, JWT auth,
    rate limiting, helmet, redacted logging.
  - Solana layer: RPC/Helius connection manager, Jupiter swap client, Jito bundle sender,
    pump.fun log-subscription monitor.
  - Detection layer: on-chain mint/freeze authority + holder concentration checks,
    DexScreener liquidity lookup, rule-based rug/honeypot risk scoring, whale wallet tracker.
  - Trading engine: TP/stop-loss/trailing-stop exit engine (pure, unit-tested), position
    manager, auto-trader (snipe config evaluation), copy trading executor, backtesting engine.
  - REST API: auth, tokens, trades, positions, snipe configs, wallets, portfolio, leaderboard.
- `apps/telegram-bot`: grammy-based bot (notifications, admin commands, marketing publisher),
  no-ops with a warning log when `TELEGRAM_BOT_TOKEN` is unset. Wired into `apps/api`'s
  position manager so trade opens/exits push Telegram alerts automatically.
- `apps/marketing-engine`: AI-generated marketing posts with weighted category rotation
  (news, trading tips, market updates, trending tokens, referral, announcements), content-hash
  deduplication against previously published posts, and a self-scheduling daily runner that
  posts 3-5 times/day at randomized, minimum-spaced times. No-ops with a warning log when
  Telegram or AI credentials are unset.
