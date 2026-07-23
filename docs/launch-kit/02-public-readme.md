# Nova Solana AI Sniper

**AI-gated Solana token sniper.** Automated launch detection, layered risk
screening, and configurable exit management — from your own encrypted
wallet, controlled entirely through Telegram or a web dashboard.

> This is public-facing documentation. It describes what the platform does
> and how to use it. It intentionally does not include implementation
> source code, infrastructure details, or anything that would help an
> attacker — the underlying codebase is proprietary and not published.

**Telegram bot:** [@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot)

---

## What it does

Nova Solana AI Sniper watches for newly launched and trending Solana tokens
across many independent sources at once, screens each one against a
deterministic risk engine (mint/freeze authority, LP lock/burn, holder
concentration, liquidity depth, honeypot heuristics) plus an optional AI
second opinion, and — only for tokens that clear every gate — executes an
automated buy from your own individually encrypted wallet. Positions are
then managed with configurable take-profit, stop-loss, trailing-stop, and
emergency-exit logic until you close them or an exit condition fires.

## Key features

- Multi-source discovery across 9+ on-chain Solana DEX/launch venues plus
  DexScreener, Birdeye, X/Twitter, and Telegram trend signals.
- Two-layer risk screening: deterministic rules always run; an optional AI
  opinion can only make the system more cautious, never less.
- Automated execution via the Jupiter aggregator with a native fallback
  path, every fill verified on-chain — never trusted from a quote alone.
- Take-profit, stop-loss, adaptive trailing stop, optional partial-exit
  ladder, and a price-independent Emergency Exit Engine for rug/dump
  signals.
- Your own encrypted wallet — funds are never pooled with other users.
- An immutable ledger for every deposit, withdrawal, fee, and referral
  reward.
- A transparent, fixed profit split: **80% to you, 10%/5% to your
  referral chain, 5% to the platform — only on realized profit.**
- A multi-level referral program and referral leaderboard.
- A reviewed withdrawal pipeline (risk-score + admin review before
  on-chain execution).

## Getting started

1. Open the bot: [@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot)
2. Complete onboarding — a dedicated encrypted wallet is created for you.
3. Deposit SOL to your wallet address.
4. Configure your snipe settings (buy size, take-profit/stop-loss or
   trailing stop).
5. The bot detects, screens, and — for tokens that pass every check —
   trades automatically according to your configuration. You can also
   monitor and manage positions manually at any time.
6. Withdraw whenever you like; requests go through an automated risk check
   and admin review before execution on-chain.

## Security & risk — read before depositing

- **No independent third-party security audit exists for this platform as
  of this writing.**
- This is a **custodial** service: your private key is generated and held,
  encrypted, by the platform so it can trade automatically on your behalf.
  This is a different trust model from a non-custodial wallet you control
  yourself.
- Automated risk screening reduces but cannot eliminate the risk of a rug,
  honeypot, or total loss on any given trade.
- New-token/memecoin trading is inherently high-volatility. No profit or
  performance outcome is guaranteed or implied by anything in this
  document.
- Fees apply only to realized profit (see the split above); there is none
  on a losing trade. On-chain gas/priority fees are separate.
- Withdrawals include a deliberate admin-review step and daily limits.
- Not affiliated with, endorsed by, or registered with Solana
  Labs/Foundation or any financial regulator. You are responsible for
  confirming this is lawful to use in your jurisdiction.
- **Only deposit funds you can afford to lose.**

## FAQ

**Is this a smart contract / on-chain program?**
No. Nova Solana AI Sniper is an off-chain application (a Telegram bot and
web dashboard) that executes standard on-chain swaps on your behalf via
existing Solana DEX programs (through the Jupiter aggregator) — it does not
deploy or operate its own on-chain program, and does not custody funds in a
smart contract or pooled treasury. Each user's funds sit in that user's own
individually encrypted wallet.

**Can I lose money?**
Yes. Automated risk screening lowers exposure to known rug/honeypot
patterns but cannot guarantee any outcome. Only trade what you can afford
to lose.

**How is profit split?**
80% to you, 10% to your direct (Level 1) referrer, 5% to a Level-2
referrer, 5% to the platform — computed only on realized profit. No fee on
a loss.

**How do I withdraw?**
Request a withdrawal from the bot or dashboard. It's reviewed
(automated risk score + admin approval) before being executed on-chain.

**Is source code available?**
The codebase is proprietary; it is not open source at this time.

## Contact

Reach the team via the Telegram bot: [@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot)
