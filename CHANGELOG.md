# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Internal Wallet, Ledger, Audit and Wallet UX: a real balance/deposit/withdrawal trail for
  every managed wallet, built on top of the existing encrypted-at-rest keystore.
  - `LedgerEntry` (`ledger_entries`): one immutable row per balance-affecting event —
    `DEPOSIT`/`WITHDRAWAL` (SOL, `amountLamports`) and `PROFIT_CREDIT`/`OWNER_FEE`/
    `REFERRAL_CREDIT` (USD bookkeeping, `amountUsd`). `AuditLog` gained `walletId`,
    `status` (`SUCCESS`/`FAILED`/`PENDING`), and `txSignature` so it can carry the
    compliance/security trail (wallet create/import/backup/restore/deactivate) alongside
    the financial one. Both tables are made genuinely immutable by a `BEFORE UPDATE/DELETE`
    Postgres trigger (migration `20260713150000_add_wallet_audit_immutability`,
    `20260713160000_add_ledger_entries`) rather than a `REVOKE` — this app's own DB role owns
    both tables, and Postgres table owners always bypass `GRANT`/`REVOKE` checks on their own
    tables, so only a trigger makes "immutable" actually true regardless of which role writes.
  - `packages/shared/src/wallet/ledgerWrite.ts`'s `writeLedgerAndAudit` is the single place
    either table is written from application code, always inside the caller's own transaction,
    so no financial event can produce a ledger row without its audit counterpart or vice versa.
  - `packages/shared/src/wallet/balanceLedger.ts`'s `refreshWalletBalance` reads a wallet's live
    SOL balance, diffs it against `Wallet.lastKnownBalanceLamports` (new cached-balance columns,
    also added this migration), and records a `DEPOSIT` ledger row on any increase — guarded by
    an optimistic `updateMany` so two concurrent callers (the poller and a manual refresh) can
    never double-count the same deposit. The first-ever read for a wallet only seeds the cache
    and never fabricates a deposit. This one helper is shared by all three places a balance gets
    checked, so they can never disagree about what counts as a deposit:
    - `apps/api/src/wallet/depositMonitor.ts` — polls every active wallet on an interval
      (`DEPOSIT_MONITOR_ENABLED`/`DEPOSIT_MONITOR_INTERVAL_MS`, default 20s), same start/stop/tick
      shape as the existing `PriceMonitor`.
    - `POST /wallets/:id/refresh-balance` — the on-demand dashboard/API equivalent.
    - The Telegram bot's 🔄 Refresh Balance button.
  - `apps/api/src/business/registerFeeSystem.ts`'s `processProfitableClose` now writes
    `PROFIT_CREDIT`/`OWNER_FEE`/(per-referrer) `REFERRAL_CREDIT` ledger+audit rows alongside the
    existing `PerformanceFeeLedger`/`ReferralReward` rows it already created, each referencing
    the `PerformanceFeeLedger` row it came from. Documented architectural finding, verified by
    grepping the whole codebase for `treasury`/`feeWallet`/`collectFee`/`sweepFee`: the
    performance-fee system is a pure USD accounting ledger — no on-chain transfer ever moves
    SOL/tokens to collect a platform fee or pay a referral reward, so these three entry types are
    informational bookkeeping only, never a real wallet-balance change (see
    `profitDistributionAudit.test.ts`, an 8-scenario audit that exercises the real
    `PositionManager`/`processProfitableClose` code paths end-to-end rather than reimplementing
    the math, and documents this finding at the top of the file).
  - New wallet routes: `GET /wallets/:id`, `POST /wallets/:id/refresh-balance`,
    `GET /wallets/:id/audit-log` (compliance trail), `GET /wallets/:id/transactions` (financial
    ledger, optionally filtered by type), and admin-only `POST /wallets/:id/withdrawals` — a
    record-only endpoint: it logs that a withdrawal was already executed manually out-of-band
    and updates the cached balance, but never decrypts a key or signs/broadcasts anything itself.
  - Dashboard: a new per-wallet detail page (`WalletDetail.tsx`) with current balance, a
    deposit-address QR code, tap-to-copy address (`CopyButton`/`clipboard.ts`, with a
    `document.execCommand('copy')` fallback for non-HTTPS/older-iOS contexts), paginated
    Recent Transactions and Wallet History tables, a manual refresh-balance button, and an
    admin-only Record Withdrawal modal. `Layout.tsx` also gained a responsive mobile nav drawer
    (hamburger + slide-over) so wallet actions are usable on a phone, not just desktop.
  - Telegram bot: the Deposit screen now shows live balance/last-updated, a 🔄 Refresh Balance
    button, a scannable QR code of the deposit address, and paginated 🧾 Transaction History /
    📜 Wallet History screens — all routed through `ui/router.ts`'s existing action dispatch.

### Fixed

- Every detected token showed `Liquidity = $0`. Root-caused with live mainnet data
  (real Helius RPC + DexScreener calls against freshly-launched tokens) to two
  compounding bugs, both in the `new_token` detection path (`apps/api/src/worker.ts`
  → `RiskAnalyzer.analyze`):
  1. `extractMintFromTx` took `accountKeys[1]` as "the mint" on the assumption it's
     always the 2nd account key in a pump.fun `create` transaction. True only for the
     simplest tx shape — verified wrong in 4 of 5 live sampled creates (anything
     bundled with a dev-buy, routed through Jito, or wrapped by a router shifts
     Solana's account-key ordering, which is grouped by signer/writable status, not
     per-instruction position). Every downstream lookup (mint authority, holder
     concentration, DexScreener) then ran against a garbage non-mint address and
     silently fell back to its default via an existing `.catch()`. Replaced with
     `extractMintFromParsedTx` (`apps/api/src/detection/extractMint.ts`), which reads
     the mint directly out of the transaction's `pre`/`postTokenBalances` — correct
     regardless of transaction shape, verified against real fixtures. Returns
     `undefined` (skip the event) rather than guess when genuinely ambiguous.
  2. Even with the correct mint, DexScreener's own API response for a pre-migration
     pump.fun pair (`dexId: "pumpfun"`) omits the `liquidity` field entirely (confirmed
     by dumping raw live responses — `fdv`/`marketCap` are present, `liquidity` is
     simply absent) — `pair?.liquidity?.usd ?? 0` silently defaulted to 0 for every
     token that hasn't migrated to a real AMM pool yet, i.e. effectively all of them at
     detection time. `RiskAnalyzer` now falls back to reading the token's on-chain
     pump.fun bonding-curve account directly (`apps/api/src/solana/pumpfunBondingCurve.ts`
     — PDA-derived, decoded, cross-checked against the account's own raw lamport
     balance on live data) when DexScreener has no liquidity figure, and as a last
     resort to a Jupiter quote's price-impact (`estimateLiquidityFromPriceImpact`) when
     even that isn't available. Raydium liquidity was already covered correctly by
     DexScreener/Jupiter and needed no separate client. All raw API/RPC responses are
     logged at debug level for future diagnosis (the shared logger already redacts any
     secret-shaped field). Verified end-to-end against 5 real, newly-launched mainnet
     tokens: 0 now show $0 (previously 5/5 would have).
  - This also silently blocked every auto-buy config with a nonzero
    `minLiquidityUsd` threshold (`AutoTrader.evaluateAndMaybeBuy`), since `0 <
minLiquidityUsd` was always true.

### Added

- Referral system: `User.referralCode` (auto-generated, 8-char, ambiguous-character-free) is
  issued at registration; `POST /auth/register` accepts an optional `referralCode` to credit
  the referrer (`User.referredByCode`). New `GET /referrals` returns a user's own code and
  referred-user count. Copy trading now has REST routes (`GET/POST/DELETE /copy-trades`) —
  they didn't exist before, even though the `CopyTradeConfig` model and mirroring service did.
  The platform is 100% free: every user has full access to all features (including copy
  trading) regardless of tier. The `User.subscriptionTier` (FREE/PRO) column and enum remain
  in the schema, unused, so paid tiers can be introduced later without another migration —
  there is currently no auto-upgrade, no `requirePro` gate, and no tier-based restriction
  anywhere in the codebase.

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
