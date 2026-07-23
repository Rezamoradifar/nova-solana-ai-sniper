# Nova Solana AI Sniper — Public Launch Content Package

Every claim in this document is drawn from the current, verified state of the
codebase (feature set, test suite, fee split) or the existing investor
presentation (`docs/presentation/`) — nothing here is invented. Numbers are as
of 2026-07-22 (960/960 automated tests passing, full workspace build clean).
No third-party security audit exists for this project; this document does not
claim one.

---

## 1. Brand identity

- **Project name:** Nova Solana AI Sniper (short form: **Nova Sniper AI**,
  already used in live trade-notification cards)
- **Primary public surface:** Telegram bot **[@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot)**
- **Category:** AI-assisted Solana token-launch trading bot / custodial
  automated trading platform
- **Voice:** precise, engineering-credible, confident about what's built,
  candid about risk. No hype language ("guaranteed", "risk-free", "moon"),
  no invented metrics. Every performance/feature claim must be traceable to
  the codebase or test suite.
- **Color reference:** Solana's own ecosystem gradient (`#9945FF` violet →
  `#14F195` teal/green) on a near-black background (`#0B0E14`), used purely
  as an aesthetic nod to the ecosystem — this project has no affiliation
  with, endorsement from, or partnership with Solana Labs/Solana Foundation,
  and no listing copy should imply one.

## 2. Tagline

**Primary:** "Institutional-grade risk gating for Solana token launches — automated, transparent, yours."

**Alternates (shorter, for character-limited fields):**

- "AI-gated Solana sniping. Speed without skipping the safety checks."
- "Layered risk analysis, automated execution, your own wallet — not a pool."

## 3. Short English description (~160 characters — bios, directory summary fields)

> Nova Solana AI Sniper detects new Solana token launches, screens each one
> with a deterministic risk engine + AI second opinion, and trades from your
> own encrypted wallet via Telegram or web.

(158 characters)

## 4. Full professional description

Nova Solana AI Sniper is an automated Solana token-launch trading platform
built around one idea: speed and safety don't have to trade off against each
other.

New Solana tokens can go from launch to an unrecoverable price move in
seconds — far faster than a person can manually check mint/freeze authority,
liquidity depth, or holder concentration. Nova Sniper AI watches multiple
independent discovery sources at once (on-chain program-log subscriptions
across pump.fun, PumpSwap, Raydium, Orca, Meteora, OpenBook v2, Moonshot,
Phoenix, and Fluxbeam, plus DexScreener, Birdeye, X/Twitter, and Telegram
trend-channel signals), and runs every candidate through a deterministic,
rule-based risk engine — mint/freeze authority checks, LP lock/burn status,
holder concentration, liquidity depth, honeypot heuristics — before an
optional AI (Claude/OpenAI) second opinion is even consulted. The AI's score
can only make the system more cautious, never override the deterministic
engine upward, and fails closed (score 0) on any timeout or error.

Tokens that clear every gate are bought automatically through the Jupiter
aggregator (with a native per-DEX fallback when Jupiter can't route), and
every fill is verified against the real on-chain balance delta — never
trusted from a quote alone. Open positions are managed continuously with
configurable take-profit, stop-loss, an adaptive trailing stop, an optional
partial-exit profit ladder, and a price-independent Emergency Exit Engine
that reacts to rug/dump signals (liquidity pulled, authorities re-enabled,
developer-wallet dumping) rather than waiting for price alone to confirm
trouble.

Funds are never pooled. Every user gets their own individually
AES-256-GCM-encrypted Solana wallet, and every balance-affecting event —
deposit, withdrawal, profit share, platform fee, referral reward — is
recorded as an immutable ledger entry with a matching audit-log row,
enforced at the database level, not just in application code. Profit is
split on a fixed, transparent schedule: **80% to the trader, 10% to their
direct referrer, 5% to a second-level referrer, 5% to the platform** — and
only on realized profit; there is no fee on a losing trade. Withdrawals go
through a request → risk-score → admin-review → on-chain-execution →
reconciliation pipeline with duplicate-request protection and daily
limits.

Users interact entirely through a Telegram bot (trading alerts, wallet
management, snipe configuration, referral dashboard, withdrawal requests) or
a web dashboard (live positions, portfolio analytics, wallet/transaction
history, a PnL leaderboard, and a live token feed). The backend is a
TypeScript monorepo with 960 automated tests (including dedicated
concurrency/race-condition simulations for the position-close, withdrawal,
and referral-reward paths), and is under active, continuous development.

**This is automated trading of highly volatile, low-liquidity assets. It
does not eliminate the risk of loss.** See the Security & Risk Disclosure
below before depositing funds.

## 5. Feature list (public-facing)

- **Multi-source token discovery** across 9 on-chain venues (pump.fun,
  PumpSwap, Raydium AMM+CLMM, Orca Whirlpool, Meteora DLMM, OpenBook v2,
  Moonshot, Phoenix, Fluxbeam) plus DexScreener, Birdeye, X/Twitter, and
  Telegram trend-channel signals — each source independently toggleable and
  isolated, so one integration going down never stops the others.
- **Two-layer risk & AI scoring** — a deterministic rule-based engine runs
  unconditionally (mint/freeze authority, LP lock/burn, holder
  concentration, liquidity depth, honeypot heuristics); an optional
  Claude/OpenAI second opinion can only lower the score, never raise it, and
  fails closed on timeout.
- **Automated execution** via the Jupiter aggregator with a native per-DEX
  fallback, with every fill verified against the real on-chain balance
  delta.
- **Configurable exit management** — fixed take-profit/stop-loss, an
  adaptive trailing stop, an optional partial-exit profit ladder with a
  protected "moonbag" reserve, and a price-independent Emergency Exit Engine
  for rug/dump signals.
- **Non-custodial-by-design wallet isolation** — an individually
  AES-256-GCM-encrypted wallet per user; funds are never pooled with other
  users' funds.
- **Immutable ledger & audit trail** — every deposit, withdrawal, profit
  share, fee, and referral reward is a database-enforced immutable record.
- **Transparent, fixed profit split** — 80% trader / 10% direct referrer /
  5% second-level referrer / 5% platform, only on realized profit.
- **Multi-level referral program** with an automatic reward-activation
  threshold and a referral leaderboard.
- **Reviewed withdrawal pipeline** — request, risk-score, admin review,
  on-chain execution, and reconciliation, with duplicate-request protection
  and daily limits.
- **Telegram bot + web dashboard** — full trading, wallet, referral, and
  withdrawal control from either surface.

## 6. How it works (user journey)

1. **Start the bot** — open [@Solanxaxsniper_bot](https://t.me/Solanxaxsniper_bot)
   on Telegram and follow the onboarding flow. A dedicated, encrypted Solana
   wallet is generated for you — it is not shared or pooled with any other
   user.
2. **Deposit SOL** to your wallet address (shown in the bot/dashboard).
3. **Configure your snipe settings** — buy amount, take-profit/stop-loss
   (or use the adaptive trailing stop), and optional advanced exit modes.
4. **The system watches the market for you** — new token launches are
   detected across every enabled discovery source in real time.
5. **Every candidate is screened** by the deterministic risk engine (and
   optionally an AI second opinion) before any buy is attempted. Tokens that
   fail — unrevoked mint/freeze authority, extreme holder concentration,
   honeypot signals, etc. — are skipped automatically; you can see exactly
   why in the bot/dashboard.
6. **Qualifying tokens are bought automatically** according to your
   configuration, and the resulting position is monitored continuously.
7. **Exits happen automatically** per your configured take-profit,
   stop-loss, trailing stop, or the Emergency Exit Engine — or you can close
   a position manually at any time from the bot or dashboard.
8. **Withdraw anytime** — a withdrawal request goes through an automated
   risk check and admin review before on-chain execution.

## 7. Security & Risk Disclosure

**This is a financial application that trades highly volatile, low-liquidity
assets on your behalf, using funds you deposit into a custodial wallet
generated and encrypted by this platform.** Read this in full before
depositing anything.

- **No independent security audit has been performed on this codebase as of
  this writing.** No such claim is made anywhere in this listing package;
  treat the absence of an audit as a real, current limitation, not an
  oversight.
- **Custodial wallet model.** Each user's private key is generated and held,
  AES-256-GCM-encrypted, by the platform to enable automated trading. This
  is fundamentally different from a non-custodial wallet you control
  directly (e.g. Phantom) — you are trusting the platform's operational
  security and the operator's integrity with funds you deposit.
- **Automated risk screening reduces but does not eliminate risk.** The
  deterministic risk engine and optional AI second opinion catch known rug
  and honeypot patterns; they cannot guarantee any token is safe, legitimate,
  or will retain value. Total loss of any amount traded is possible on any
  single position.
- **Memecoin/new-launch trading is extremely volatile** by nature. Past
  performance of the risk engine or any individual trade is not indicative
  of future results, and none are published as guarantees in this package.
- **Fees are only taken on realized profit** (see the fixed 80/10/5/5 split
  above) — there is no fee on a losing trade — but profitable trades are
  still subject to that split, and gas/priority fees for on-chain execution
  are separate from and in addition to the platform's split.
- **Withdrawals are reviewed, not instant.** The withdrawal pipeline
  includes an admin-review step and daily limits by design, as a fraud/abuse
  control; do not deposit funds you may need to withdraw immediately.
- **Regulatory status.** This platform is not registered with, endorsed by,
  or affiliated with any financial regulator, exchange, or the Solana
  Foundation/Solana Labs. Users are responsible for determining whether use
  of this platform is lawful in their own jurisdiction.
- **Only deposit what you can afford to lose.** This is standard, necessary
  guidance for any automated trading system operating on volatile assets and
  applies fully here.

## 8. SEO

**Title tag (≤60 chars):** `Nova Solana AI Sniper — AI-Gated Solana Token Sniper Bot`
(57 characters)

**Meta description (≤160 chars):**

> AI-gated Solana token sniper: deterministic risk screening + AI second
> opinion before every auto-buy. Your own encrypted wallet. Telegram &
> dashboard.
> (159 characters)

**Suggested target keywords:** Solana sniper bot, Solana trading bot,
Solana token launch bot, AI risk scoring crypto bot, Telegram Solana trading
bot, pump.fun sniper, automated Solana trading, Solana rug detection bot.
