# API Reference

Base URL: the API listens on `API_HOST:API_PORT` (default `0.0.0.0:4000`),
fronted in production by Nginx, which proxies `/api/*` to the API with the
`/api` prefix stripped. All routes below are relative to the API's own root
(i.e. what Nginx forwards them as).

- **Auth:** `Authorization: Bearer <jwt>` — obtained from `/auth/login` or
  `/auth/register`. Tokens expire after 7 days.
- **Content type:** JSON in, JSON out. Request bodies are validated with
  Zod; a validation failure returns `400` with a structured error, never a
  raw stack trace.
- **Rate limiting:** global 100 requests/minute; `/auth/login` and
  `/auth/register` are limited to 8/minute; `/withdrawals` (creation) to
  5/minute.
- **Ownership:** every route that returns user-scoped data filters by
  `req.user.userId` (derived from the JWT) — there is no route that returns
  another user's data by ID alone without an ownership check.
- **Admin routes** require `role: 'ADMIN'` on the authenticated user
  (`fastify.requireAdmin`); a non-admin JWT gets `403`.

## Auth

| Method | Path             | Auth | Description                                                                         |
| ------ | ---------------- | ---- | ----------------------------------------------------------------------------------- |
| POST   | `/auth/register` | —    | Create an account. Body: `{ email, password, referralCode? }`. Returns `{ token }`. |
| POST   | `/auth/login`    | —    | Body: `{ email, password }`. Returns `{ token }`.                                   |
| GET    | `/auth/me`       | user | Current user profile (`id`, `email`, `role`, `subscriptionTier`, `referralCode`).   |

## Tokens

| Method | Path            | Auth | Description                          |
| ------ | --------------- | ---- | ------------------------------------ |
| GET    | `/tokens`       | —    | List recently discovered tokens.     |
| GET    | `/tokens/:mint` | —    | Single token detail by mint address. |

## Trades / Positions

| Method | Path             | Auth | Description                                                                                                                                                                                                                                     |
| ------ | ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/trades`        | user | Trade history for the caller's wallets.                                                                                                                                                                                                         |
| GET    | `/positions`     | user | `{ open: OpenPositionReport[], closed: ClosedPositionReport[] }` — a fully enriched report per position (AI score, current risk label, ROI, trailing-stop state, take-profit ladder, emergency-exit status, on-chain liquidity/volume signals). |
| PATCH  | `/positions/:id` | user | Update `takeProfitPercent` / `stopLossPercent` / `trailingStopPercent` on an owned position.                                                                                                                                                    |

## Snipe & Copy-Trade Configs

| Method | Path               | Auth | Description                                                                                            |
| ------ | ------------------ | ---- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/snipes`          | user | List the caller's snipe configs.                                                                       |
| POST   | `/snipes`          | user | Create a snipe config (buy amount, slippage, min liquidity/AI score, TP/SL/trailing, auto-buy toggle). |
| DELETE | `/snipes/:id`      | user | Delete an owned snipe config.                                                                          |
| GET    | `/copy-trades`     | user | List copy-trade configs.                                                                               |
| POST   | `/copy-trades`     | user | Create a copy-trade config (target wallet + sizing).                                                   |
| DELETE | `/copy-trades/:id` | user | Delete an owned copy-trade config.                                                                     |

## Wallets

| Method | Path                           | Auth  | Description                                                                                     |
| ------ | ------------------------------ | ----- | ----------------------------------------------------------------------------------------------- |
| GET    | `/wallets`                     | user  | List the caller's wallets.                                                                      |
| GET    | `/wallets/:id`                 | user  | Wallet detail (never returns the encrypted secret).                                             |
| POST   | `/wallets`                     | user  | Generate a brand-new wallet (returns the mnemonic once — never persisted).                      |
| POST   | `/wallets/import`              | user  | Import an existing wallet from a secret key.                                                    |
| POST   | `/wallets/:id/backup`          | user  | Retrieve an encrypted backup payload.                                                           |
| POST   | `/wallets/restore`             | user  | Restore a wallet from a backup payload.                                                         |
| DELETE | `/wallets/:id`                 | user  | Deactivate an owned wallet.                                                                     |
| POST   | `/wallets/:id/refresh-balance` | user  | On-demand live balance refresh (same race-safe path as the deposit monitor).                    |
| GET    | `/wallets/:id/audit-log`       | user  | Audit trail for this wallet.                                                                    |
| GET    | `/wallets/:id/transactions`    | user  | Ledger transaction history (deposits, admin-recorded withdrawals) for this wallet.              |
| POST   | `/wallets/:id/withdrawals`     | admin | Record a manually-executed, out-of-band withdrawal (never signs or broadcasts anything itself). |

## Portfolio / Leaderboard

| Method | Path           | Auth | Description                                                                                                                                                                                                                                                                                    |
| ------ | -------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/portfolio`   | user | Per-wallet summary: open/closed position counts, invested SOL, realized/unrealized PnL, live balance, portfolio value, and full `PortfolioStats` (today/weekly/monthly profit, win rate, average ROI, average holding time, largest win/loss, profit factor, max drawdown, Sharpe-like ratio). |
| GET    | `/leaderboard` | —    | Top wallets by realized PnL.                                                                                                                                                                                                                                                                   |

## Referrals

| Method | Path                      | Auth | Description                                          |
| ------ | ------------------------- | ---- | ---------------------------------------------------- |
| GET    | `/referrals`              | user | Referral code, direct referral count, chain summary. |
| GET    | `/referrals/history`      | user | Referral reward history.                             |
| GET    | `/referrals/transactions` | user | Referral-linked ledger transactions.                 |

## Profit Distribution

| Method | Path                                 | Auth  | Description                                    |
| ------ | ------------------------------------ | ----- | ---------------------------------------------- |
| GET    | `/profit-distribution/summary`       | user  | Current profit/referral/withdrawable balances. |
| GET    | `/profit-distribution/history`       | user  | Distribution history for the caller.           |
| GET    | `/profit-distribution/fees`          | user  | Performance fee history.                       |
| GET    | `/profit-distribution/referrals`     | user  | Referral-share breakdown of distributions.     |
| GET    | `/profit-distribution/owner`         | admin | Owner balance.                                 |
| GET    | `/profit-distribution/platform`      | admin | Platform balance.                              |
| GET    | `/profit-distribution/admin/history` | admin | Global distribution history.                   |

## Withdrawals

| Method | Path                                  | Auth  | Description                                                                                                        |
| ------ | ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `/withdrawals`                        | user  | Request a withdrawal. Body: `{ walletId, destinationAddress, amountUsd, idempotencyKey? }`. Rate-limited to 5/min. |
| GET    | `/withdrawals`                        | user  | The caller's withdrawal history.                                                                                   |
| GET    | `/withdrawals/pending`                | user  | The caller's pending/under-review/approved requests, with an estimated processing time.                            |
| GET    | `/withdrawals/:id`                    | user  | Single request detail + its ledger entries.                                                                        |
| POST   | `/withdrawals/:id/cancel`             | user  | Cancel a request that hasn't started processing.                                                                   |
| GET    | `/withdrawals/admin`                  | admin | Admin queue, bucketed by status (`pending`/`approved`/`completed`/`rejected`).                                     |
| GET    | `/withdrawals/admin/:id`              | admin | Full detail incl. risk score, fraud flags, user info, ledger entries, audit log.                                   |
| POST   | `/withdrawals/admin/:id/under-review` | admin | Move to `UNDER_REVIEW`.                                                                                            |
| POST   | `/withdrawals/admin/:id/approve`      | admin | Approve — triggers a fast-path real on-chain execution attempt.                                                    |
| POST   | `/withdrawals/admin/:id/reject`       | admin | Reject with a reason (refunds the reservation).                                                                    |
| POST   | `/withdrawals/admin/:id/processing`   | admin | Mark `PROCESSING`.                                                                                                 |
| POST   | `/withdrawals/admin/:id/complete`     | admin | Manually record completion (does not itself move funds).                                                           |
| POST   | `/withdrawals/admin/:id/fail`         | admin | Mark `FAILED` with a reason (refunds the reservation).                                                             |
| GET    | `/withdrawals/admin/reconciliation`   | admin | Read-only cross-check of `COMPLETED` rows, the ledger, and the chain.                                              |
| GET    | `/withdrawals/admin/settings/current` | admin | Current min/max/daily withdrawal limits.                                                                           |
| PATCH  | `/withdrawals/admin/settings`         | admin | Update withdrawal limits (validated: min < max ≤ daily limit).                                                     |

## Discovery / Health / Metrics

| Method | Path               | Auth               | Description                                                                               |
| ------ | ------------------ | ------------------ | ----------------------------------------------------------------------------------------- |
| GET    | `/discovery/stats` | —                  | Per-source discovery counters.                                                            |
| GET    | `/health`          | —                  | Liveness check.                                                                           |
| GET    | `/health/ready`    | —                  | Readiness check (DB/Redis reachable).                                                     |
| GET    | `/metrics`         | —                  | Prometheus-style metrics.                                                                 |
| GET    | `/ws`              | user (query token) | WebSocket upgrade — pushes `token.created` / `trade.created` / `position.updated` events. |

## Error format

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

Financial-workflow routes (withdrawals) surface specific machine-readable
codes (`WALLET_NOT_OWNED`, `BELOW_MINIMUM`, `ABOVE_MAXIMUM`,
`INSUFFICIENT_BALANCE`, `DAILY_LIMIT_EXCEEDED`, `DUPLICATE_ACTIVE_REQUEST`,
`NOT_FOUND`, `FORBIDDEN`, `INVALID_TRANSITION`) mapped to the appropriate
HTTP status.
