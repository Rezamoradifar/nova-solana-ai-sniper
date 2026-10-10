# Website integration and recovery

This release builds on the bounded copy-trading release. It connects existing account APIs to the dashboard and makes HTTP recovery independent of trading-provider availability. It introduces no database migrations or changes to trading limits, fee percentages, account roles, wallet targets, or LIVE/PAPER settings.

## Website routes

- `/dashboard/tools`: links to market data, arbitrage observations, the flash-loan simulator, account and browser wallets, snipes, copy trading, positions, Telegram, subscriptions, referrals, and the administrator console.
- `/dashboard/subscription`: current plan, available packages, explicit wallet/payment review, and the account's confirmed subscription receipts. Paying a package moves real SOL even in PAPER trading mode. No payment is sent just by opening the page.
- `/dashboard/referrals`: referral link and registered referral count. `/login?ref=CODE` carries that code into registration.
- `/dashboard/admin`: connection diagnostics with actual read-only HTTP checks for configured Solana RPC providers, Telegram `getMe`, and Ollama model listing. Cached for one minute and restricted to administrators. Other integrations report `unchecked` or `not_configured`; a configured key is not proof of authentication, inference, WebSocket health, or execution.

Temporary account-service failures preserve the session token and offer retry. Protected routes preserve their dashboard destination through login. API requests have timeouts; periodic polling waits for each request to finish before scheduling the next interval.

## Recovery deployment

Run `bash scripts/deploy-platform.sh /root/nova-solana-ai-sniper` from the reviewed checkout with the existing `.env`. The compatibility script `deploy-gsp-trading-latest-8088.sh` delegates to the same installer and preserves the configured port.

The installer:

1. Takes the same exclusive lock as copy activation/recovery and backs up the existing environment.
2. Tags and archives every available API/web image before building replacements. If a legacy rollback deleted those images, it explicitly reports that a recovery build is necessary.
3. Builds API/web/migration-check images while current application containers remain in place. Starts existing PostgreSQL/Redis without recreating them. Checks migration status; pending migrations require separate review and stop the rollout before application replacement.
4. Replaces only API/web, checks liveness through nginx and the published port, and verifies SPA paths. Existing legacy nginx, bot, marketing engine, data volumes and configuration are untouched.
5. Reports `PLATFORM_HTTP_OK` separately from trading/RPC readiness. Failed website cutover reloads the archive and restores available prior images with `--pull never`. An image rollback cannot undo a database migration; this installer does not run migrations.

The installer does not enable every boolean feature flag. Enabling LIVE execution, changing wallet targets or overriding risk gates is not an appropriate remedy for provider authentication failures. Admin feature choices remain stored and apply on restart. Existing copy-trading activation remains available through `scripts/enable-copy-trading.sh` after valid RPC credentials have passed its preflight.

## Payment recovery

Reviewed website payments use PostgreSQL advisory transaction locks to serialize intent creation per user, and immutable audit entries to persist request identities before any broadcast. The lock is released before RPC calls. Completed results are appended as separate audit entries; duplicate requests reuse them. Changed reviewed prices are rejected before accessing the wallet balance or sending funds. An uncertain broadcast or interrupted post-payment database write blocks another reviewed payment for that user and requires operator reconciliation against the recorded signature/server log and subscription history. Do not clear an unresolved intent to make a payment retry possible without reconciling the chain and granting any already-paid subscription. This protection covers the new website endpoint; older bot/payment entry points retain their existing behavior.

## Remaining external requirements

- Helius/RPC 401/403: supply a permitted key/endpoint and review provider restrictions.
- RPC 429: review quota and polling load. Do not treat missing chain data as proof a token is safe.
- Telegram, AI providers and GMGN require the owner's valid existing credentials. Not all providers are needed simultaneously.
- Flash-loan execution remains a simulator; the observation-only arbitrage scanner does not place trades.
- Browser wallet availability depends on the user's wallet/browser. Connecting a browser wallet does not import its private key into a GSP custodial wallet.
- The deployment script verifies localhost/container HTTP. Public DNS, TLS, firewall and the actual VPS outcome need verification on the server.

## Checks

Backend TypeScript and dashboard production build; worker startup/HTTP/shutdown tests; administrator authorization and secret-redaction tests; payment replay, ambiguity and price-change tests; existing copy/safety tests; six platform deployment CLI tests; existing copy rollout tests and archived-image Docker CI recovery.
