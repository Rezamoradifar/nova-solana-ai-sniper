# Nova / Moneyland: real execution readiness

This is not a claim that Moneyland is already live. Running code, a page showing
LIVE, a funded account and a verified mainnet receipt are different facts.

## What genuinely exists in the current API

- **Copy trading on Solana:** the bounded CopyTradeWatcher sees supported
  SOL/wSOL-funded external wallet buys and proportional sales. The existing
  CopyTradingService calls PositionManager through user-owned trading-wallet
  records after per-user, Redis and token-safety gates. Default per-buy cap
  0.1 SOL, 10 daily attempts, 3 open positions, 1.5% slippage; the server can
  tighten limits. It is NOT exhaustive and can miss rapid source transactions.
- **Sniper/auto trading:** the existing managed account SnipeConfig and
  PositionManager infrastructure can trade on chain when worker mode is LIVE
  and risk controls approve. It requires explicit per-account settings and a
  funded/trusted account. It does not become enabled by merely connecting the
  address-only browser wallet.
- **Portfolio/history:** authenticated records distinguish paper and
  confirmed real trade signatures. An empty history is not a successful trade.
- **Arbitrage:** real on-chain quote observations and a separately proposed
  atomic executor exist. The executor PR remains draft pending independent
  review and mainnet simulation. No production atomic arbitrage activation
  was performed here.
- **DEX:** wallet connection on the public website is address-only.
  The public terminal does not sign or submit a swap.
- **CEX spot/futures, flash loans, local Grid/DCA bots:** the public UI
  does not contain a verified live integration. Do not show fictitious fills or
  claim these features are active.

## What this UI change does

- It routes `/copy` and `/terminal/copy` to the **existing authenticated,
  server-backed** `/copy-trading` workflow, not fictional trader profiles.
- It routes `/bots` and `/terminal/bots` to **existing user SnipeConfigs**;
  the user must sign in and create/enable the configuration.
- It routes portfolio paths to real authenticated portfolio and scanner
  paths to real quote/data sources (read-only), rather than showing fake
  amounts or example traders.
- It replaces the paper ticket at `/trade` with a status-aware connected
  services directory using `/api/public/network/status` and
  `/api/public/copy-trading`. The status is intentionally conservative:
  even a healthy LIVE backend does not prove a user's account is funded
  or that any copy order was filled.
- It does not modify API routes, secrets, contracts, DB migrations, worker
  startup, global LIVE_TRADING, account permissions, or existing risk ceilings.

## VPS preflight (read-only)

On the existing server, through Termius:

```bash
cd /opt/nova-solana-ai-sniper
git fetch origin codex/nova-real-trading-entrypoints-20261022
git show FETCH_HEAD:scripts/check-nova-real-trading.sh > /tmp/check-nova-real-trading.sh
bash /tmp/check-nova-real-trading.sh
```

Do not paste `.env`, a seed phrase or private keys into chat. Share only the
`NOVA_`, `API_`, `NETWORK_`, `COPY_`, `USER_`,
`LIVE_TRANSACTION` and `RECOMMENDED_ACTION` status lines.

To consider REAL copying operational, verify:
1. API ready, RPC actually accessible from the *running* API process,
   copy watcher running and healthy; live (not forced-paper) execution mode.
2. Existing admin feature overrides, kill switch, caps and worker controls.
3. A signed-in account has an explicitly selected, funded trading wallet and
   the user has enabled the chosen public target, with safe caps.
4. Migrations and API version are compatible (backup database and test
   an additive migration before any API replacement).
5. Observe actual source trade, live trade signature, finalized confirmation,
   user account balance delta, tagged position and sell/stop handling.
   Never call simulated calculations or a submitted transaction a profit.
6. Test pause/cancel/recovery, webhook/RPC outage and fail-safe behavior.
   Preserve existing open position exits while stopping new buys.

## Why no automatic LIVE switch

`LIVE_TRADING=true` is an application-wide flag: enabling it can cause
**other configured automatic buys** to spend real funds, not just copy trading.
The current worker may force PAPER if its dedicated RPC/safety probe fails.
Turning off fail-safes, weakening anti-scam checks or blindly restarting
the API is not an acceptable way to show a LIVE badge.

Do not run the older broad `git reset --hard` deployment scripts on a
server holding production wallets. The public-address wallet connector is
not a signing integration. A separate audited user-approved transaction
workflow is required for direct browser DEX swaps.

This change contains no order submission and does not claim any on-chain
trade, gain, VPS deployment or audited flash loan.
