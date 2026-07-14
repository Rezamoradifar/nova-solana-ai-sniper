# Roadmap

This roadmap reflects the real, current state of the codebase — completed
items are already shipped and tested; planned items are genuine, identified
gaps, not aspirational marketing copy.

## Shipped

- Multi-source discovery: pump.fun/PumpSwap, Raydium (AMM + CLMM), Orca
  Whirlpool, Meteora DLMM, OpenBook v2, Moonshot, Phoenix, Fluxbeam program
  monitors; DexScreener boost/profile pollers; Birdeye poller; X (Twitter)
  mention monitor; Telegram trend-channel monitor.
- Two-layer risk & AI scoring with a code-enforced hard ceiling.
- Automated buy/sell execution via Jupiter, with a native PumpSwap fallback
  executor.
- Take-profit / stop-loss / adaptive trailing stop / Institutional Mode
  partial-exit ladder / Emergency Exit Engine.
- Internal per-user encrypted wallets, immutable ledger + audit trail
  (database-trigger enforced).
- Performance-fee system, multi-level referral program, Profit Distribution
  Engine (event-driven + reconciliation sweep).
- Reviewed withdrawal engine: request → risk score → admin review → on-chain
  execution → reconciliation, with idempotency keys and crash-safety
  checkpoints.
- Telegram bot suite (trading, wallet, referrals, withdrawals, admin
  controls) and a React dashboard.
- Concurrency hardening: DB-backed mutual exclusion on position close/
  partial-sell, referral-reward grant, and every withdrawal state
  transition.
- Production deployment hardening: Nginx reverse proxy with TLS, firewalled
  application ports, production environment configuration.

## In progress / near-term

- **Native execution fallback for the remaining DEXes.** Only PumpSwap has a
  real native swap-builder today (`solana/dex/pumpswapExecutor.ts`);
  Raydium, Orca, Meteora, Raydium CLMM, OpenBook, Moonshot, Phoenix,
  Fluxbeam currently fall back to `NotImplementedNativeExecutor` and rely on
  Jupiter as the sole real execution path. Jupiter already routes across all
  of these venues, so this is a resilience improvement (a fallback for when
  Jupiter can't route a specific pool), not a current trading gap.
- **Native liquidity readers for Moonshot and Phoenix.** These two venues'
  liquidity-confidence signal is currently sourced from DexScreener only
  (no direct on-chain account decoder), a known, documented gap.
- **Real, browser-trusted TLS certificate** for the production domain (the
  reverse proxy and firewall are live; the certificate issuance step is
  pending final domain confirmation).
- Dependency upgrades reviewed in `SECURITY.md`'s "known accepted findings"
  section (`@solana/web3.js`/`@solana/spl-token` transitive advisories,
  `vitest`/`vite` major-version bump) — deliberately deferred until each can
  be verified without a breaking change to trading-critical code.

## Planned

- Multi-instance/horizontal scaling of the API process (the current
  concurrency guards — DB-unique claim tables — are already designed to
  hold across process boundaries, not just within one Node process, which
  is what this would exercise for the first time).
- Formal load testing at defined concurrent-user targets (100 / 1,000 /
  5,000), with connection-pool sizing tuned against real results rather than
  Prisma's default.
- Expanded automated end-to-end test coverage for the Telegram bot's
  inline-keyboard flows.
- Additional discovery sources and social signal integrations as new
  venues/aggregators emerge on Solana.

## Future expansion

- Multi-chain support (architecture is Solana-specific today by design —
  this would be a substantial, deliberate expansion, not a near-term item).
- Institutional/API-key access tier for programmatic (non-Telegram,
  non-dashboard) integration.
- Advanced portfolio analytics (the `PortfolioStats` engine already computes
  Sharpe-like ratios, drawdown, and profit factor — this would extend it
  with configurable benchmarking and export).
