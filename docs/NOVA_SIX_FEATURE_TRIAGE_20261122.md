# Nova / Moneyland: six-feature launch triage — 22 November 2026

A site that renders feature cards is **not** necessarily a functioning trading service.
This runbook covers the issues reported by the operator: copy trading cannot connect,
sniper inactive, Telegram channel empty, loan/flash loan unavailable, arbitrage not
launched, and Connect Wallet failing.

## Zero-write preflight

Run from the existing Nova VPS terminal (not a public web console):

```bash
cd /opt/nova-solana-ai-sniper
git status --short
bash scripts/diagnose-nova-launch-20261122.sh
```

The script only reads existing Compose container states, redacted environment presence
and anonymous internal API health. It prints no channel IDs, tokens, wallet keys,
private RPC endpoints, raw API responses or Docker logs. It makes no trades and
sends no Telegram messages. A clean result is **not proof of live execution**.

## Why each feature is blocked or incomplete

1. **Copy trading.** Require API liveness, worker/scanner health, dedicated
   mainnet HTTPS + WSS with genuine log delivery, safety stops, LIVE watcher readiness,
   and explicit account-funded user targets. The existing `diagnose-nova-copy.mjs`
   checks RPC/safety without changing anything. Never clear a manual stop blindly;
   do not enable while unrelated auto-buy configs are active.
2. **Sniper.** API health and working scanner are prerequisites, but only
   an authorized user test with a transaction signature can verify actual execution.
   Check live detection and execution limits separately from the frontend.
3. **Telegram posts.** `marketing-engine` must be running; token and destination
   must exist, and the relevant feed flag must be enabled. If
   `TELEGRAM_TRADES_ONLY=true`, ordinary daily/marketing feeds are intentionally
   suppressed. AI-authored daily posts require Gemini/OpenRouter configuration.
   Verify sender admin permission on the target channel and inspect redacted
   delivery errors privately before a separately authorized single test post.
4. **Loan / flash loan.** The public `PublicFlashArbitrage` UI documents
   `Simulation only` and `Live submit is not connected`. Project 0 / Jupiter
   adapter, signer, lookup tables and bank/account integration are missing; this
   is an implementation task, not a switch to enable.
5. **Arbitrage.** `GET /public/arbitrage` reports `mode=observation` and
   `executionEnabled=false`. The legacy `enable-arbitrage.sh` only starts
   paper scanning. A real executor must be independently implemented, audited,
   simulated and authorized before any live orders.
6. **Wallet.** The reviewed wallet UI uses a configured Reown WalletConnect
   Project ID for QR, and detected Phantom/Solflare/SafePal providers. Verify
   the domain allowlist, HTTPS, browser wallet permissions and Solana mainnet
   approval on real mobile and desktop devices. Browser approval only supplies
   an address; it never gives the server a signer for copy trading.

## Release dependencies

The repository `main` is behind the staged Nova release work. PR #24 builds on
#23 → #22 → #21 → #20 → #19 and earlier recovery branches. Do not merge #24
against the old `main` or deploy a generic `docker compose up --build` without
first reviewing this stack and the running image/checkpoint. The reviewed
`deploy-nova-mainnet-luxury.py` pins API + web images with rollback and preserves
trading stops by default.

Release acceptance: site HTTPS and API health; wallet approval and disconnect
on desktop/android/iPhone; wallet-specific copy save/stop and live readiness;
scanner healthy; at least one authorized low-value on-chain receipt if live
trading is explicitly approved; verified Telegram channel delivery;
arbitrage accurately labeled observation-only until an executor exists; flash
loan clearly marked unavailable until the protocol integration is complete.

No production SSH access is available from this repository change. This
diagnostic PR is **not a deployment**, and does not claim any issue is fixed.
