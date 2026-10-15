# GMGN on the Nova website

The Markets page includes a GMGN Solana trending table showing price, 1h USD
volume, liquidity, and GMGN-tagged smart-money holder count. It refreshes every
15 seconds through `/api/public/gmgn/markets`. Existing market prices continue
using `/api/public/markets`.

The API uses pinned `gmgn-cli@1.6.7` with fixed read-only arguments. The command
returns the documented `rank` list; only validated display fields reach the
browser. CLI stderr and API keys are never returned to the public endpoint.
All viewers share an in-flight request and a 15-second cache per API process.
Failed requests start a five-minute cooldown. Previously received data retains
its original timestamp and is marked unavailable.

## Server configuration

Add `GMGN_API_KEY` to the existing server `.env` through a private editor. Do
not put it in frontend variables, commit it, or paste it into logs. An API key
is sufficient for these market reads; no signing private key is needed.

Run `bash scripts/deploy-market-display.sh` from the existing checkout after
fetching this revision. It builds API/web, checks database migration status
without changing the schema, retains prior images, and checks the nginx/API
market routes after startup. Errors during replacement restore previous images.
It preserves the existing environment and trading activation settings.

The deployment check reports one of these GMGN states:

- `connected`: GMGN returned a valid response.
- `not_configured`: the site is installed, but a server API key is absent.
- `unavailable`: a configured source failed; retry is delayed to avoid bans.

`MARKET_DISPLAY_READY` confirms installation of the website routes, not a
successful GMGN connection. Inspect the separate `gmgn` result above it. A real
provider connection cannot be verified without a working server API key.

Installing the agent skills alone does not install a web integration. This
integration exposes market data; it does not add swap execution or enable live
trading.

## Research and execution workspace

`/research` offers 16 on-demand Solana queries: trending, hot searches, new
launches, signals, search, candlestick charts, token information, security,
liquidity pools, holders, traders, wallet holdings, wallet activity, 7-day
wallet statistics, smart-money trades, and KOL trades. Results are rendered as
fields/tables; OHLC candles are plotted with their actual open/high/low/close.
Ratio metrics such as P&L ratios and holder shares are displayed as percentages.
These are provider data and labels, not an invented investment score.

The backend accepts a fixed command allowlist through
`POST /api/public/gmgn/tools`. No shell, arbitrary flags, signing keys, personal
GMGN follow lists, or trading commands are exposed. Inputs are validated; public
requests are rate limited, coalesced, cached, and bounded to one concurrent CLI
process. Its cache holds at most 64 queries per API process.

`/executions` requires account sign-in. It reads `GET /api/executions` for
confirmed trades and closed-position P&L, with cursor pagination (25 per page),
mode filters, and a 10-second refresh. Failed/pending trades are excluded.
Live and paper records are queried separately. P&L is recorded at position
level because the schema does not link trades to positions; no fabricated P&L
is assigned to an individual buy or sell. Missing recorded P&L remains unknown.

Ordinary users see only their wallets. All-account scope rechecks the current
administrator permission from the database. Responses select public wallet
labels/addresses and never select encrypted secrets. Pagination cursors must
belong to the selected scope, mode, and report type. Header and account
navigation link to both new pages. The deployment smoke check verifies that
reports reject unauthenticated requests and the tool route rejects swaps.
