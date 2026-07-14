# Security

This document describes the security posture of Nova Solana AI Sniper as
implemented in this repository — not aspirational goals.

## Secrets management

- All secrets (RPC/API keys, JWT secret, encryption key, Telegram token,
  database/Redis URLs) are read from environment variables only (`.env`,
  gitignored) — never hardcoded, never committed. `.env.example` documents
  every variable without real values.
- `JWT_SECRET` must be at least 16 characters, `ENCRYPTION_KEY` at least 32
  characters — enforced by schema validation at process boot (`packages/
shared/src/env.ts`), not just documented convention.
- The shared logger (`packages/shared/src/logger.ts`) redacts any object
  field whose key matches `key|token|secret|password|seed|private`, plus an
  explicit path-based redaction list (`Authorization` headers, etc.), so an
  accidental `logger.info({ wallet })` cannot leak a secret field.

## Wallet key custody

- Wallet private keys are **never stored in plaintext**. They are encrypted
  at rest with AES-256-GCM (`packages/shared/src/security/crypto.ts`), using
  a key derived from `ENCRYPTION_KEY` via `scrypt`.
- A decrypted `Keypair` only ever exists in memory for the duration of a
  single sign operation (`unsealKeypair`) and is never logged, cached, or
  returned by any API response — wallet routes return only
  `{ id, label, publicKey }`.
- There is **no pooled treasury wallet** anywhere in this codebase. Trading
  and withdrawals always move funds directly into/out of the user's own
  wallet, using the exact same custody path.
- New wallet generation uses a fresh BIP39 mnemonic (standard Solana
  derivation path); the mnemonic is returned exactly once, to the caller,
  and is never persisted anywhere on the server.

## Authentication & authorization

- User passwords are hashed with `scrypt` + a random per-user salt
  (`apps/api/src/routes/auth.ts`), and compared with
  `crypto.timingSafeEqual` to avoid timing side-channels — never stored or
  logged in plaintext.
- JWT auth (`@fastify/jwt`) with a 7-day expiry — tokens are not eternal.
- Role-based authorization (`TRADER` / `ADMIN`) is enforced server-side on
  every admin route (`fastify.requireAdmin`) — a client cannot self-elevate
  by editing a JWT it didn't sign, and the dashboard's client-side route
  gating is UX-only, never the actual authorization boundary.
- Every REST route that returns user data scopes it to `req.user.userId`
  (wallets, trades, positions, snipe configs, withdrawals) — there is no
  route that returns another user's data by ID alone without an ownership
  check.
- Telegram bot commands resolve identity strictly from Telegram's own
  verified `ctx.from.id`, never a client-supplied user id — no command lets
  one Telegram user act on another user's wallet, position, or withdrawal.
- `AuditLog` records wallet creation/import/backup/restore and
  login/register attempts (success and failure, with IP).

## API hardening

- `trustProxy: true` — the API sits behind Nginx in production, which sets
  `X-Forwarded-For`; without this, rate limiting would key off Nginx's own
  IP instead of the real client's.
- Global rate limit (100 req/min); tighter limits on `/auth/login` and
  `/auth/register` (8/min) and on withdrawal creation (5/min) to slow
  credential stuffing, brute force, and withdrawal-request spam.
- `helmet` (secure headers) and CORS locked to `CORS_ORIGIN`.
- All request bodies/params validated with `zod`; validation failures
  return `400`, never a raw stack trace.
- No SQL injection surface: all database access goes through Prisma's
  parameterized query builder; the only raw-SQL call sites in the codebase
  (a `$queryRaw` health check, and tagged-template row locks in the
  withdrawal engine) use Prisma's tagged-template parameterization, never
  string concatenation.

## Concurrency & duplicate-action protection

A recurring theme in a system that moves real money: a "check, then act"
read-then-write is never sufficient on its own. Every money-moving or
state-changing path below is backed by a database-level guarantee, not just
an application-level check:

| Risk                                              | Guard                                                                                                                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-close / double-sell of the same position   | `PositionCloseLock`: a DB-unique claim table (`position_close_claims`, primary-key uniqueness) + an in-process mutex + stale-claim auto-recovery, shared by every close path (take-profit, stop-loss, trailing stop, emergency exit, partial exit) |
| Duplicate open position for the same wallet+token | Postgres partial unique index (`positions_wallet_token_open_unique`)                                                                                                                                                                               |
| Duplicate withdrawal request                      | Atomic conditional-`UPDATE` balance reservation, a partial unique index limiting one active request per user, and an optional client idempotency key                                                                                               |
| Duplicate withdrawal execution / double-broadcast | `SELECT ... FOR UPDATE` row locking on every status transition, plus a guarded single-write execution-signature column                                                                                                                             |
| Duplicate profit distribution                     | Unique constraints on `positionId` / `performanceFeeLedgerId` — the fast-path event handler and the periodic reconciliation sweep can safely race                                                                                                  |
| Duplicate referral reward grant                   | Unique constraint on `referrerUserId` in a dedicated `referral_reward_grants` table                                                                                                                                                                |

## Ledger & audit immutability

`LedgerEntry` and `AuditLog` are made genuinely immutable by a Postgres
`BEFORE UPDATE/DELETE` trigger, not merely an application-level convention —
a Postgres table owner always bypasses `GRANT`/`REVOKE` restrictions on its
own tables, so a trigger is the only mechanism that makes "immutable"
actually true regardless of which application code path writes to it.

## AI scoring integrity

The optional LLM (Claude/OpenAI) risk-scoring call can only ever **lower** a
token's score relative to the deterministic rule-based engine's hard
ceiling — the ceiling is re-enforced in code against the same real signals
the prompt was built from, never left solely to the model's compliance with
a prompted instruction. A provider timeout, rate limit, or malformed
response fails closed to a score of 0 ("high risk until re-checked"),
bounded by a 15-second request timeout (`AbortController`) so a hung call
can never stall a fast-moving token's notify/auto-buy decision.

## Network & infrastructure

- The API and dashboard are never directly internet-reachable in a correct
  production deployment — only Nginx (80/443) and SSH accept external
  connections; the application's raw ports are firewalled to loopback-only.
- TLS is terminated at Nginx via Let's Encrypt (certbot), with automatic
  renewal.
- Security headers (`X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`) are set at the Nginx layer for every response.

## Known accepted `npm audit` findings

`npm audit` currently reports 13 advisories (1 critical, 4 high, 8
moderate), all transitive and all requiring a breaking major-version bump
to clear. Reviewed individually rather than blindly force-fixed:

- **`bigint-buffer` (high)** — transitive via `@solana/web3.js`/
  `@solana/spl-token`, an unpatched buffer-overflow advisory upstream in the
  Solana JS ecosystem. Used here for local numeric decoding of RPC
  responses, not exposed to untrusted network input directly. Fixing via
  `npm audit fix --force` would downgrade `@solana/spl-token` to 0.1.8, a
  breaking API change. Re-evaluate when the Solana SDKs ship a fix.
- **`vitest`/`vite`/`esbuild` (1 critical, 1 moderate)** — the critical one
  is "Vitest UI server can read/execute arbitrary files," which only
  applies when running `vitest --ui`; this project never does (CI and
  `npm test` both run `vitest run`), and it's a devDependency never shipped
  in any runtime image. Fixing forces a `vitest@4` major bump this
  codebase's test config hasn't been verified against. Low real risk given
  actual usage; revisit when upgrading the test toolchain deliberately.
- **`uuid` (moderate)** — transitive via `@solana/web3.js`'s RPC client
  (`jayson`), a buffer bounds-check gap in `uuid` v3/v5/v6 when a buffer is
  explicitly provided (not how it's used here). Fixing forces
  `@solana/web3.js` down to a pre-release stub version, not usable.

None of the above are exposed to unauthenticated network input in this
codebase's actual usage; they are flagged here explicitly so they are
revisited deliberately, not silently ignored.

## Design tradeoffs (not vulnerabilities)

- The dashboard authenticates via a JWT stored in `localStorage`, not an
  httpOnly cookie — a standard SPA tradeoff. CSRF risk is correspondingly
  low (auth is header-based, not cookie-based), but any future XSS
  elsewhere in the app would be a more serious token-exfiltration vector
  than with an httpOnly cookie. No `dangerouslySetInnerHTML` or unescaped
  `innerHTML` of user-controlled data exists in the dashboard today.
- The dashboard uses REST polling plus a WebSocket push (`useLiveEvents`),
  not a WebSocket-only design — a latency/complexity tradeoff, not a
  security one.

## Reporting

This is a private, proprietary codebase (see `LICENSE`). Security concerns
should be reported directly to the project owner rather than through a
public issue tracker.
