# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Fixed

- Local `npm run dev:*` never actually loaded `.env` into `process.env` — only Docker Compose's
  `env_file` directive did. Wired `dotenv-cli` into each app's `dev` script (and the root
  `prisma:migrate`/`prisma:deploy` scripts), pointed at the repo-root `.env` explicitly since
  npm sets each workspace's cwd to its own directory. Caught by actually booting
  `apps/telegram-bot` against a real bot token instead of assuming the plumbing worked.

### Added

- `apps/api/src/social`: X (Twitter) API v2 client and polling monitor (`since_id`-based
  dedupe, resilient to rate-limit errors) for cashtag/keyword mentions. Disabled with a warning
  log when `TWITTER_BEARER_TOKEN` is unset — same graceful-no-op pattern as the Telegram bot
  and AI providers. Publishes `social.mention` on the event bus and pushes a Telegram alert
  (`NotificationService.notifySocialMention`) per mention.
- Real-time updates: an in-process event bus (`apps/api/src/lib/eventBus.ts`) publishing
  `token.created`/`trade.created`/`position.updated`, exposed over a JWT-authenticated `/ws`
  websocket route. The dashboard's `useLiveEvents` hook subscribes and bumps a refresh signal
  that `usePolling` consumes to refetch immediately, with REST polling remaining as a fallback
  if the socket drops.

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
- Deployment: multi-stage Dockerfiles for api/telegram-bot/marketing-engine (Alpine, non-root,
  pruned production `node_modules`), `docker-compose.yml` (Postgres, Redis, one-shot `migrate`
  job, the three app services, Nginx + certbot), `scripts/init-letsencrypt.sh` to bootstrap the
  first TLS certificate, `ecosystem.config.cjs` for PM2 on bare-metal/VPS deployments, and a
  GitHub Actions CI workflow (lint, format check, typecheck, test, build, Docker image builds).
- `apps/dashboard`: React 18 + Vite 6 + Tailwind dark-theme SPA — overview (stat cards, recent
  trades, TradingView chart embed), live token feed, positions, portfolio, wallet
  create/import, snipe-config settings, PnL leaderboard, and a logs view. JWT auth against
  `apps/api` with a protected-route shell; REST polling (no websocket yet). Its own Dockerfile
  builds the static bundle and serves it from the same Nginx image that reverse-proxies
  `/api/` to the API service.

### Security

- JWT tokens now expire (7 days) instead of being valid forever.
- `trustProxy: true` on the API so rate limiting keys off the real client IP (via
  `X-Forwarded-For`) rather than Nginx's own IP once behind the reverse proxy.
- Tighter rate limit (8/min) on `/auth/login` and `/auth/register` against credential
  stuffing/brute force, on top of the existing global 100/min limit.
- `AuditLog` entries for login/register (success and failure, with IP), in addition to the
  existing wallet create/import entries.
- Wallet import now returns 400 on a malformed secret key instead of an unhandled 500.
- DexScreener token-pair lookups URL-encode the mint before interpolating it into the request
  path (defense in depth).
- `SECURITY.md` documents the full posture plus every currently-open `npm audit` finding,
  reviewed individually (none apply to this codebase's actual usage; each would require an
  unverified breaking major-version bump to clear).
