# GSP Bank Sniper website

The public website uses the current **GSP Bank Sniper** product name and the bot's account structure: **Wallets**, **Snipe Configs**, **Open Positions**, and **Packages**. Account counts are never substituted with sample balances or copied from a chat. The account sections open the existing Telegram app.

## Public routes

| Route        | Purpose                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `/`          | Product home, original visual assets, bot sections, and current market preview |
| `/tools`     | Website tools and product workflows                                            |
| `/platform`  | Compatibility alias for the website tools                                      |
| `/telegram`  | Separate Telegram bot section: wallets, snipe configs, positions, and packages |
| `/wallet`    | User-initiated connection to a supported Solana wallet                         |
| `/markets`   | Searchable asset table, sorting, refresh, and observed liquidity pools         |
| `/arbitrage` | Automatically refreshed, read-only cross-venue quote observations              |
| `/security`  | Custody model, quote limitations, and risk information                         |
| `/pricing`   | Packages and current service prices when the API is connected                  |

Existing `/login` and protected `/dashboard/*` routes remain available for deployments with the Nova API. The public website's primary account link is `https://t.me/GSPBankSniperBot`, configurable with `VITE_BOT_URL`.

## Running and building

For the current server without a domain, see [deployment on 185.172.64.24:8443](DEPLOY_IP.md). The IP installer updates nginx only and provisions trusted HTTPS with automatic certificate renewal. Pass `--https-port 8443` for the selected website port.

From the repository root, install the locked dependencies with `npm ci`, then run:

```sh
npm run dev:dashboard
npm run build --workspace apps/dashboard
```

The frontend defaults to same-origin `/api` for bot service requests. During local development, Vite proxies that prefix to `http://localhost:4000` and removes the prefix. A production reverse proxy should do the equivalent, or set `VITE_API_BASE_URL` to the intended public API base **before building**. Only public configuration belongs in Vite environment variables; never include wallet keys, provider secrets, or server credentials.

A standalone static deployment can serve `apps/dashboard/dist` with SPA fallback to `index.html`. Public market and quote requests work directly against their sources without the account API. In that deployment, account operations are available through the linked Telegram app; package prices and background-worker telemetry show their actual unconnected state.

## Public market data

The market explorer requests DEX Screener's `tokens/v1/solana` endpoint for SOL, JUP, RAY, BONK, WIF, and JTO. It refreshes every 30 seconds while the page is visible. The adapter validates prices and liquidity, removes duplicate pool addresses, and uses the deepest returned pool for the displayed asset price. Liquidity and volume are totals across the returned pools, not claims about complete market coverage. Pool links point to DEX Screener; token links point to Solscan.

## Active public arbitrage scanner

The terminal is active when its page is visible. It requests **quotes only** from Jupiter's Swap v1 quote endpoint and never requests a transaction, connects a wallet, signs, simulates, or broadcasts a trade.

- Supported intermediate assets: USDC, USDT, JUP, and RAY.
- Venues: Raydium CLMM, Orca Whirlpool, and Meteora DLMM.
- Starting amount: 0.01–10 SOL; default 0.5 SOL.
- Each scan considers every ordered pair of distinct venues: up to six round trips and nine requests.
- Requests are spaced at least 2.2 seconds apart; rate-limit responses introduce a longer wait.
- The exit quote uses the minimum acceptable first-leg output. The return estimate uses the minimum acceptable second-leg output. Both legs request 50 bps slippage.
- The configured total network-cost budget and additional basis-point buffer are deducted using integer lamport arithmetic, rounded conservatively.
- A new scan starts 60 seconds after the previous scan finishes. Hiding the tab or pausing aborts the current public scan.
- Freshness uses the earlier request timestamp. Already expired routes are not emitted; displayed observations become visibly stale after 45 seconds.
- Users can change scan settings, inspect quote context and both venues, filter positive estimates, pause/resume, and export the current observations as CSV.

A positive estimate is not an executed return. Quotes arrive sequentially, do not reserve liquidity, and do not prove an atomic profitable transaction can be built. The interface never accumulates observations into realized profit, win rates, or completed-trade totals.

## Background bot scanner

`GET /public/arbitrage` returns an allowlisted snapshot of the in-process bot scanner. It does not start scanning and does not call a quote provider for a website request. Its status distinguishes `disabled`, `starting`, `ready`, `stale`, and `unavailable`; its mode is always `observation` and `executionEnabled` is always `false`. It omits wallet/user data, secrets, raw provider errors, and cumulative paper profit.

The scanner now evaluates every distinct ordered DEX pair instead of greedily selecting one buy venue. With four venues and seven assets, the maximum request budget increases from 49 to 112 requests per complete scan. Review the actual provider quota, interval, and quote gap before enabling this separate worker. This change does not enable it or alter existing deployment flags.

Stopping the scanner invalidates its current generation, cancels any quote-gap timer, discards pending responses, and prevents further quote requests or observation commits. An already issued HTTP request may finish under the provider client's existing timeout; its result is ignored after cancellation.

## Verification

Focused test suites cover market validation and deduplication, quote identity and raw amount validation, exact integer cost arithmetic, minimum-output use, freshness boundaries, ordered-pair selection, stopped scanner generations, public endpoint privacy, and anonymous read-only behavior:

```sh
npx vitest run apps/dashboard/src/lib/publicMarket.test.ts apps/dashboard/src/lib/liveArbitrage.test.ts apps/api/src/trading/arbitrageScanner.test.ts apps/api/src/routes/publicArbitrage.test.ts
```

The public source endpoints can be unavailable or rate-limited. Preserve the explicit error/empty states rather than adding simulated prices or opportunities.

## Visual assets

The three original product sculptures are shipped as compressed WebP files in `apps/dashboard/public/images`. Together they are approximately 370 KiB. The site uses a scoped dark, titanium, and lime design system in `landing.css`; existing authenticated-dashboard styles remain separate.
