# Admin Backoffice & Trading Lab

## Web routes

- `/dashboard/admin` — admin-only operational backoffice.
- `/dashboard/trading-lab` — authenticated trader tooling and market intelligence.

Admin authorization uses the same `requireAdminUser` policy as the existing Mini App:
a DB `ADMIN` role or an authorized Telegram admin ID.

## Admin Control Center

### Immediate controls

These take effect without a process restart:

- Kill switch — blocks new opens while leaving exits available.
- Auto-buy pause/resume.
- Platform performance fee.
- Referral program and per-level percentages.
- Treasury wallet.
- User Snipe Config pause/resume.
- Bulk strategy presets on existing Snipe Configs.
- Force-close an open position (explicit UI confirmation; a LIVE position can move real funds).
- Subscription plan limits/pricing.
- Copy-trade configuration pause/resume (configuration status only; see limitation below).

### Startup feature controls

Approved boolean feature gates can be changed from Admin, but the desired state is
stored in `admin_feature_overrides` and applied before background workers are
constructed on the next API restart.

The UI always shows both **Running** and **Desired** state and marks a mismatch as
**pending restart**. Secrets and numeric platform risk limits are never stored in
this table.

Supported feature overrides include Live Trading, Entry Filter, Dynamic Sizing,
Partial Exits, Best Route Execution, Opportunity Score Gate, Smart Money,
Early Momentum, Emergency Exit, Exit Strategy V2, Arbitrage Radar, Network Trade
Scanner, Telegram Trend Source, Deposit Monitor and Shadow Mode.

## Trading Lab

- Strategy presets edit a user's real Snipe Config through the existing API.
- Stop-loss is hard-capped at 20% by both create/update validation.
- Risk/reward calculator is scenario math only; it does not forecast profit.
- Verified Network Winners are completed positive-ROI/positive-PnL trades from
  external Solana wallets. Internal Nova/GSP custodial wallets are excluded.
- Arbitrage Radar is paper/theoretical only and never executes or borrows funds.

## Copy Trading status

The database/API contains CopyTradeConfig records and the backoffice can inspect
or pause/resume those records. This does **not** claim that external-wallet signal
execution is live: the current worker does not wire SmartWallet observations into
CopyTradingService execution. Keep the UI warning until that path is implemented,
tested and explicitly enabled.

## Secrets

The backoffice never returns private keys, wallet encrypted secrets, API tokens,
RPC credentials or signing material. Integration cards show configured/not
configured only.

## Deployment

This branch adds a Prisma migration for `admin_feature_overrides`. Apply
migrations before replacing the API container.

Docker Compose:

```bash
git fetch origin
git checkout codex/full-admin-backoffice
git reset --hard origin/codex/full-admin-backoffice

docker compose build --no-cache api telegram-bot marketing-engine nginx
docker compose run --rm migrate
docker compose up -d --force-recreate api telegram-bot marketing-engine nginx
docker compose ps
```

For bare-metal/PM2, run `npm run prisma:deploy`, rebuild the monorepo, then
restart the affected PM2 processes.

## Verification

The branch includes `.github/workflows/admin-backoffice-verify.yml` which runs:

1. Prisma client generation
2. TypeScript build for shared/AI/Telegram/API
3. Production dashboard build
