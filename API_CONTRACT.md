# API Contract — for the Telegram Mini App build

Generated from direct inspection of `apps/api/src/routes/*.ts`, `apps/api/src/plugins/*.ts`,
`apps/api/src/lib/eventBus.ts`, and `apps/api/prisma/schema.prisma` on 2026-07-14. Every endpoint
and shape below is what the code actually does today — nothing here is inferred from docs or
memory. Where the Mini App spec assumes something that does not exist, it's called out explicitly
under **Gaps**, per Step 0's instruction not to guess silently.

## Backend framework & routing

Fastify. Routes are plain `FastifyInstance` plugins registered in `apps/api/src/app.ts`. No
GraphQL, no tRPC — REST + one WebSocket route.

## Auth — ⚠️ the biggest gap, read this first

**There is no Telegram `initData` validation anywhere in this codebase.** The only auth mechanism
that exists is email + password → JWT:

- `POST /auth/register` — body `{ email, password, referralCode? }` → `201 { token }`
- `POST /auth/login` — body `{ email, password }` → `200 { token }`
- `GET /auth/me` — bearer JWT → `{ id, email: string | null, role: 'ADMIN' | 'TRADER' }`

JWT payload is `{ userId: string, role: 'ADMIN' | 'TRADER' }`, signed with `JWT_SECRET`, 7-day
expiry (`apps/api/src/plugins/auth.ts`). `fastify.authenticate` (any logged-in user) and
`fastify.requireAdmin` (role === 'ADMIN') are the two guards every other route uses.

`User.telegramId` **does** already exist as a unique column (`prisma/schema.prisma`), and the
Telegram bot (`apps/telegram-bot`) already resolves/creates users by `telegramId` internally — but
that bot talks to Prisma directly, in-process. It never goes through the HTTP API, and there is no
`/auth/telegram` (or similar) route that verifies a Mini App's `initData` HMAC and exchanges it for
a JWT.

**Assumption stated per Step 0's instruction**: building the Mini App as specified requires one new
backend route that:

1. Verifies `initData`'s HMAC-SHA256 signature against the bot token (standard Telegram Mini App
   verification — well-documented, does not touch trading/wallet logic).
2. Looks up (or creates, mirroring what the bot's own `resolveOrCreateUser` already does) a `User`
   row by `telegramId`.
3. Issues the exact same JWT shape (`fastify.jwt.sign({ userId, role })`) `/auth/login` already
   issues, so every other existing route/the WS route work completely unchanged.

I have **not** built this yet. It's a new auth entry point, not a "thin adapter" over an existing
one — flagging it before writing it, since constraint #2 says only to add backend code when
strictly necessary, and this is the one case where that's true (nothing else in the spec works
without it).

## REST endpoints (everything that exists today)

| Method      | Path                                  | Auth                    | Notes                                                                                                            |
| ----------- | ------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET         | `/health`, `/health/ready`            | none                    | liveness/readiness                                                                                               |
| GET         | `/metrics`                            | none                    | in-process counters (not user-scoped)                                                                            |
| GET         | `/metrics/latency`                    | none                    | trading pipeline latency report (added this session, see below)                                                  |
| POST        | `/auth/register`, `/auth/login`       | none                    | see above                                                                                                        |
| GET         | `/auth/me`                            | user                    | see above                                                                                                        |
| GET         | `/tokens`                             | none                    | recent tokens list                                                                                               |
| GET         | `/tokens/:mint`                       | none                    | one token by mint                                                                                                |
| GET         | `/trades`                             | user                    | **all** wallets' trades, `include: token`, hardcoded `take: 100`, no offset/filter                               |
| GET         | `/positions`                          | user                    | **all** wallets' positions, `include: token`, **no limit at all**, no filter                                     |
| PATCH       | `/positions/:id`                      | user                    | update TP/SL/trailing **only** — no sell action                                                                  |
| GET         | `/snipes`                             | user                    | this user's SnipeConfigs                                                                                         |
| POST        | `/snipes`                             | user                    | create a SnipeConfig                                                                                             |
| DELETE      | `/snipes/:id`                         | user                    | delete a SnipeConfig                                                                                             |
| GET         | `/portfolio`                          | user                    | `{ walletId, openPositions, totalInvestedSol, realizedPnlUsd, unrealizedPnlUsd }` — see `PortfolioSummary` below |
| GET         | `/leaderboard`                        | none                    | top wallets by realized PnL                                                                                      |
| GET         | `/wallets`                            | user                    | this user's wallets                                                                                              |
| GET/POST    | `/wallets`, `/wallets/:id`            | user                    | list/create/read                                                                                                 |
| POST        | `/wallets/import`, `/wallets/restore` | user                    |                                                                                                                  |
| POST        | `/wallets/:id/backup`                 | user                    | returns an encrypted backup file (see `WalletBackupFile`)                                                        |
| DELETE      | `/wallets/:id`                        | user                    |                                                                                                                  |
| POST        | `/wallets/:id/refresh-balance`        | user                    | on-demand balance refresh                                                                                        |
| GET         | `/wallets/:id/audit-log`              | user                    | security/action trail for one wallet                                                                             |
| GET         | `/wallets/:id/transactions`           | user                    | ledger entries (deposits, admin withdrawals, fee/referral credits) for one wallet                                |
| POST        | `/wallets/:id/withdrawals`            | **admin only**          | see Gaps — this is a manual record, not a user-facing withdraw flow                                              |
| GET         | `/referrals`                          | user                    | `{ referralCode, subscriptionTier, referredCount }` **only** — no rewards, no tree, no leaderboard               |
| GET         | `/copy-trades`                        | user                    | this user's copy-trade configs                                                                                   |
| POST/DELETE | `/copy-trades`, `/copy-trades/:id`    | user                    |                                                                                                                  |
| GET         | `/ws`                                 | user (JWT as `?token=`) | see below                                                                                                        |

### TypeScript shapes already verified against production use

Pulled directly from `apps/dashboard/src/lib/types.ts` (the existing admin dashboard, which
already consumes these exact endpoints, so these are known-correct, not guessed):

```ts
interface Token {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  dex: 'PUMPFUN' | 'RAYDIUM' | 'ORCA' | 'JUPITER'; // schema actually also has PUMPSWAP,
  // METEORA, RAYDIUM_CLMM, OPENBOOK, MOONSHOT, PHOENIX, LIFINITY, FLUXBEAM — dashboard's
  // union is stale/incomplete versus schema.prisma's real Dex enum; use the schema enum, not this one.
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  aiScore?: number | null;
  aiSummary?: string | null;
  isHoneypotSuspected?: boolean | null;
  createdAt: string;
}
interface Trade {
  id: string;
  side: 'BUY' | 'SELL';
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  amountSol: number;
  priceUsd?: number | null;
  txSignature?: string | null;
  createdAt: string;
  token: Token;
}
interface Position {
  id: string;
  status: 'OPEN' | 'CLOSED';
  entryPriceUsd: number;
  amountToken: number;
  amountSolInvested: number;
  takeProfitPercent?: number | null;
  stopLossPercent?: number | null;
  trailingStopPercent?: number | null;
  realizedPnlUsd?: number | null;
  createdAt: string;
  token: Token;
  // Schema also has: remainingAmountToken, institutionalModeEnabled, exitReason,
  // riskScoreAtEntry, closedAt — present in the DB/route response, just not yet in this type.
}
interface Wallet {
  id: string;
  label: string;
  publicKey: string;
  isActive: boolean;
  createdAt: string;
  lastKnownBalanceLamports: string | null;
  balanceUpdatedAt: string | null;
}
interface PortfolioSummary {
  walletId: string;
  openPositions: number;
  totalInvestedSol: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
}
interface LeaderboardEntry {
  walletId: string;
  publicKey: string;
  label: string;
  realizedPnlUsd: number;
  closedTrades: number;
}
interface LedgerEntry {
  id: string;
  type:
    | 'DEPOSIT'
    | 'WITHDRAWAL'
    | 'REFERRAL_CREDIT'
    | 'PROFIT_CREDIT'
    | 'OWNER_FEE'
    | 'LEDGER_ADJUSTMENT';
  asset: 'SOL' | 'USD';
  direction: 'CREDIT' | 'DEBIT';
  amountLamports: string | null;
  amountUsd: number | null;
  balanceAfterLamports: string | null;
  txSignature: string | null;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
}
```

### `/metrics/latency` (added this session — real, not a gap)

```ts
interface LatencyReport {
  buy: SideLatencyReport;
  sell: SideLatencyReport;
  generatedAt: number;
}
interface SideLatencyReport {
  totalStats?: { count: number; avgMs: number; medianMs: number; p95Ms: number; maxMs: number };
  stageStats: Partial<Record<string, typeof totalStats>>; // key = "prevStage->stage"
  successRate: number;
  fastestMs?: number;
  slowestMs?: number;
  sampleSize: number;
}
```

In-process only (resets on every `nova-api` restart), currently near-empty in production —
today's live traffic hasn't executed enough real trades to populate it yet.

## WebSocket (`GET /ws?token=<jwt>`)

Browsers can't set headers on a WS handshake, so the JWT goes as a query param, verified manually.
Pushes every `eventBus` event to every connected client — **not scoped to the connecting user**,
the client must filter by payload fields itself (e.g. `mint`/`walletId`) if it only cares about its
own data. Full event catalog, from `apps/api/src/lib/eventBus.ts` (this is the complete list —
nothing else is ever published):

```ts
type LiveEventType =
  'token.created' | 'token.migrated' | 'trade.created' | 'position.updated' | 'social.mention';
interface LiveEvent {
  type: LiveEventType;
  payload: Record<string, unknown>;
  at: string;
}
```

`trade.created`: `{ tradeId, side: 'BUY'|'SELL', mint }`. `position.updated`:
`{ positionId, status: 'OPEN'|'CLOSED', realizedPnlUsd? }`.

## Data models actually in the schema (`apps/api/prisma/schema.prisma`, 28 models)

Directly relevant to this build: `User`, `Wallet`, `Token`, `Trade`, `Position`,
`PositionPartialExit`, `SnipeConfig`, `CopyTradeConfig`, `SmartWallet`, `WatchlistItem`,
`LedgerEntry`, `AuditLog`, `ReferralReward`, `ReferralLevelConfig`, `PerformanceFeeLedger`,
`ProfitDistribution`, `UserDistributionBalance`, `WithdrawalRequest`, `WithdrawalSettings`,
`BlacklistEntry`. Several of these (referral rewards, profit distribution, withdrawal requests)
have real tables and business logic already, but **no REST route exposes them** — see Gaps.

## Gaps — screens in the requested IA with no backing endpoint today

Per constraint #3, these need loading-skeleton + empty-state UI with a
`// TODO: missing backend endpoint` comment, not invented endpoints:

1. **Telegram auth itself** — no `initData` verification route (see above; I'm proposing to build
   this one, since nothing works without it — confirming before I do).
2. **`/discovery`** — no route at all. The detection _pipeline_ (worker.ts) exists and writes to
   `Token`, but nothing aggregates a trending/AI-picks/whale/migration feed for API consumption.
3. **`/signals`** — no dedicated AI-signals endpoint. `Token.aiScore`/`aiSummary` exist per-token
   via `/tokens`, but there's no ranked/live "signals feed" with confidence scoring as its own
   resource.
4. **Manual sell / partial sell / emergency sell** — `PATCH /positions/:id` only edits TP/SL/
   trailing. `PositionManager.closePosition`/`executePartialSell` exist in the trading engine but
   are only ever called internally (PriceMonitor, EmergencyExitMonitor) — no route calls them.
   Portfolio's sell buttons have nothing to call.
5. **Self-service withdrawal** — `POST /wallets/:id/withdrawals` is admin-only and only records
   that a withdrawal happened manually out-of-band; it never signs or broadcasts anything. There is
   no user-facing "request a withdrawal" flow, despite `WithdrawalRequest`/`WithdrawalSettings`
   existing as DB models.
6. **Referral rewards/leaderboard/tree** — `/referrals` returns only code + tier + count. No
   rewards list, no leaderboard, no invite tree, despite `ReferralReward`/`ReferralLevelConfig`
   existing as DB models with real logic (used by the Telegram _bot's_ own in-chat screens, just
   not exposed over REST).
7. **Paginated/filterable trade history** — `/trades` is a flat, unfiltered `take: 100`; `/positions`
   has no limit or filter at all. Fine for an initial load, not for a real History screen with
   filters/pagination.
8. **Profit analytics over time** — `/portfolio` is a single current snapshot, no time series.
9. **Realtime `trade.failed` / `deposit` / `withdrawal` events** — the WS event catalog is fixed at
   5 types (above); none of these three exist. Deposit/withdrawal notifications would need to poll
   `GET /wallets/:id/transactions` instead of subscribing.
10. **Trading Controls (bot start/stop, global auto-buy toggle, risk %)** — `/snipes` covers
    per-token-config CRUD, not a single global on/off + risk-parameter panel. Closest existing
    concept is `SnipeConfig`, which is scoped per config, not a single account-level toggle.
