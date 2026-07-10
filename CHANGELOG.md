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
