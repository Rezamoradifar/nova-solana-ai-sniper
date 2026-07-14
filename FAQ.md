# Frequently Asked Questions

### What does this platform actually do?

It watches Solana for newly launched and trending tokens across multiple
discovery sources, scores each one for risk and profit potential using a
deterministic rule engine plus an optional AI second opinion, and — when a
user's configured criteria are met — automatically buys and later sells
(take-profit / stop-loss / trailing stop / emergency exit) on that user's
behalf, using that user's own wallet.

### Does the platform ever hold user funds in a shared/pooled wallet?

No. There is no pooled treasury wallet anywhere in this codebase. Every user
has their own individually generated, individually encrypted Solana wallet.
Trading and withdrawals always move funds directly into and out of that
specific wallet.

### How are private keys protected?

Encrypted at rest with AES-256-GCM, using a key derived (via `scrypt`) from
a server-side `ENCRYPTION_KEY`. A decrypted key only ever exists in memory
for the duration of a single sign operation and is never logged, cached, or
returned by any API response.

### What happens if two trading signals try to close the same position at

the same time?

They cannot both succeed. Every close/partial-sell path (take-profit,
stop-loss, trailing stop, emergency exit) is serialized through a
database-backed mutual-exclusion claim (`PositionCloseLock`) before any swap
is submitted — this was specifically hardened after a real historical
incident (see `CHANGELOG.md`) and is now covered by dedicated concurrency
tests.

### How does the AI scoring work, and can it be tricked into approving a

bad token?

Every token first gets a deterministic, rule-based score (mint/freeze
authority, LP lock/burn status, holder concentration, liquidity depth). An
optional LLM call (Claude or OpenAI) can add a second opinion, but a hard
disqualification ceiling computed from the same real signals is re-applied
in code afterward — the LLM's output can only ever cap the score down, never
raise it above what the deterministic engine allows. If the AI call fails,
times out (bounded at 15 seconds), or returns something unparseable, the
system fails closed to a score of 0, not an optimistic default.

### How does withdrawal actually work?

A user requests a withdrawal against their own accumulated withdrawable
balance. The system reserves that amount atomically, computes a fraud/risk
score, and (depending on configuration) queues it for admin review. Once
approved, an executor signs and broadcasts a real on-chain SOL transfer from
the user's own wallet, records the transaction signature the instant it's
broadcast (before confirmation is even awaited, so a crash mid-transfer
can't lose track of it), and reconciles the final on-chain outcome against
the ledger.

### What stops someone from requesting the same withdrawal twice, or an

admin from approving it twice?

A database partial-unique index allows at most one active withdrawal
request per user regardless of how many times the request is retried,
optional client idempotency keys make an exact retry a no-op rather than a
second request, and every admin status transition is wrapped in a
`SELECT ... FOR UPDATE` row lock so two concurrent approval attempts can
never both proceed.

### How does the referral program work?

Every user gets a unique referral code at signup. Trading fees earned from a
referred user's profitable closes are shared up the referral chain (to a
configurable depth) per a configurable percentage per level. Referring 3
users unlocks a free default sniper configuration for the referrer, granted
exactly once — a database-unique constraint makes it physically impossible
for two simultaneous qualifying referrals to grant the reward twice.

### Is this open source?

No. This is a private, proprietary codebase (see `LICENSE`). This
documentation set exists for internal, investor, and authorized-partner
use.

### What's the tech stack?

TypeScript throughout, Fastify (API), Prisma/PostgreSQL, Redis, React/Vite
(dashboard), grammy (Telegram), and the Anthropic/OpenAI SDKs behind a
pluggable provider abstraction. See `ARCHITECTURE.md` for the full
breakdown.

### How is the system tested?

997 automated tests (Vitest) across every workspace, including dedicated
concurrency/race-condition simulations for the position-close path, the
withdrawal engine, and the referral-reward grant path — not just
happy-path assertions. `npm run build`, `npm run typecheck`, and
`npm run lint` all run clean with zero errors.

### What happens if the AI provider or an RPC endpoint goes down?

The pipeline degrades gracefully rather than crashing: a missing/failed AI
call falls back to the deterministic rule-based score; a discovery source
failure is caught and logged per-source without killing the poll loop for
every other source; Solana RPC calls are retried and can fail over across
multiple configured providers.

### Can I run this without live trading enabled?

Yes. `LIVE_TRADING` is the single hard safety switch gating real swaps; when
unset or `false`, the system runs in paper-trading mode. `KILL_SWITCH` is a
separate, always-available flag that halts all trading instantly regardless
of any other configuration.
