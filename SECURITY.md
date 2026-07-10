# Security

## Secrets

- All secrets (RPC/API keys, JWT secret, encryption key, Telegram token, DB/Redis URLs) are
  read from environment variables only (`.env`, gitignored) — never hardcoded, never committed.
  `.env.example` documents every variable without real values.
- Wallet private keys are **never stored in plaintext**. They're encrypted at rest with
  AES-256-GCM (`apps/api/src/security/crypto.ts`), using a key derived from `ENCRYPTION_KEY`
  via scrypt. A decrypted `Keypair` only ever exists in memory for the duration of a single
  sign operation (`unsealKeypair`) and is never logged, cached, or returned by any API response
  — wallet routes return only `{ id, label, publicKey }`.
- User passwords are hashed with scrypt + a random salt (`apps/api/src/routes/auth.ts`), and
  compared with `timingSafeEqual` to avoid timing side-channels. Never stored or logged in
  plaintext.
- The shared logger (`packages/shared/src/logger.ts`) redacts any object field whose key matches
  `key|token|secret|password|seed|private`, plus an explicit path-based redaction list
  (`Authorization` headers, etc.), so an accidental `logger.info({ wallet })` can't leak a
  secret field.

## API hardening

- JWT auth (`@fastify/jwt`) with a 7-day expiry — tokens are not eternal.
- `trustProxy: true` — the API sits behind Nginx in the Docker Compose deployment, which sets
  `X-Forwarded-For`; without this, rate limiting would key off Nginx's own IP instead of the
  real client.
- Global rate limit (100 req/min) plus a tighter limit on `/auth/login` and `/auth/register`
  (8 req/min) to slow down credential stuffing / brute force.
- `helmet` (secure headers) and CORS locked to `CORS_ORIGIN`.
- All request bodies/params validated with `zod`; validation failures return 400, never a raw
  stack trace.
- Every REST route that returns user data scopes it to `req.user.userId` (wallets, trades,
  positions, snipe configs) — there is no endpoint that returns another user's data by ID alone
  without an ownership check.
- `AuditLog` records wallet creation/import and login/register (success and failure, with IP).

## Known accepted risks

`npm audit` currently reports 13 advisories (1 critical, 4 high, 8 moderate), all transitive and
all requiring a breaking major-version bump to clear. Reviewed individually rather than blindly
force-fixed:

- **`bigint-buffer` (high)** — transitive via `@solana/web3.js`/`@solana/spl-token`, an unpatched
  buffer-overflow advisory upstream in the Solana JS ecosystem. Used here for local numeric
  decoding of RPC responses, not exposed to untrusted network input directly. Fixing via `npm
audit fix --force` would downgrade `@solana/spl-token` to 0.1.8, a breaking API change.
  Re-evaluate when the Solana SDKs ship a fix.
- **`vitest`/`vite`/`esbuild` (1 critical, 1 moderate)** — the critical one is "Vitest UI server
  can read/execute arbitrary files," which only applies when running `vitest --ui`; this project
  never does (CI and `npm test` both run `vitest run`), and it's a devDependency never shipped in
  any runtime Docker image. Fixing forces a `vitest@4` major bump this codebase's test config
  hasn't been verified against. Low real risk given actual usage; revisit when upgrading the
  test toolchain deliberately.
- **`uuid` (moderate)** — transitive via `@solana/web3.js`'s RPC client (`jayson`), a buffer
  bounds-check gap in `uuid` v3/v5/v6 when a buffer is explicitly provided (not how it's used
  here). Fixing forces `@solana/web3.js` down to a pre-release stub version, not usable.

None of the above are exposed to unauthenticated network input in this codebase's actual usage;
they're flagged here explicitly so they're revisited deliberately rather than silently ignored.

## Design tradeoffs (not vulnerabilities)

- The dashboard uses REST polling, not a websocket, for the first cut — no auth implications,
  just a latency/efficiency tradeoff noted in `docs/ARCHITECTURE.md`.

## Reporting

This is a private project scaffold; if you fork it for production use, run `npm audit` and this
file's checklist again before handling real funds.
