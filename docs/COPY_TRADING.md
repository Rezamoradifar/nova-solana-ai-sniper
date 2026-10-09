# Copy trading: activation and operating limits

This revision completes bounded **buy mirroring** in the existing GSP TRADING
branch. It does not select a spending account automatically. A signed-in user
reviews wallets at `/copy-trading` and enables or pauses their own configurations.

## What runs

- The watcher polls up to ten distinct external targets per tick, rotating fairly.
  It reads the latest eight signatures, rejects failed/stale/future transactions,
  requires a signing target and a supported swap program, and recognizes
  single-token SOL/wSOL-funded buys. Fees and non-wSOL token-account rent are
  excluded from source sizing. Stablecoin-funded buys and source sells are not
  mirrored; high-frequency wallets can exceed this bounded polling coverage.
- Redis claims each source signature for seven days. An uncertain processing
  attempt is not automatically retried. This is at-most-once best effort, not a
  guarantee of delivery; crashes can skip a trade instead of duplicating it.
- A token must exist in discovery and pass the shared blacklist, critical-security
  and reverse sell-quote pipeline again (including its existing short risk cache).
  Copy buys additionally require $10,000 observed liquidity and rule score >=70.
  These checks reduce exposure; they cannot prove a token safe or guarantee a fill.
- Per-account copy attempts are serialized with a Redis lease. Suspended/deleted
  users are excluded, and active status is rechecked before submission. Duplicate
  legacy target configurations are processed once per user per source signal.
- Subscription limits and the normal PositionManager gates still apply: kill
  switch, scanner pause, trade size, daily realized loss, duplicate positions,
  open positions, fee reserve and price impact. Existing stop-loss/trailing exits
  manage copied positions; **the source wallet's sells are not mirrored**.

Default copy ceilings (server environment can tighten them):

| Setting                                            | Default        |
| -------------------------------------------------- | -------------- |
| Maximum per buy                                    | 0.1 SOL        |
| Maximum attempts per account per Tehran day        | 10             |
| Maximum total open positions for a copying account | 3              |
| Slippage                                           | 150 bps (1.5%) |
| Minimum observed token liquidity                   | $10,000        |
| Signal age                                         | 120 seconds    |
| Poll interval                                      | 15 seconds     |

Failed or uncertain submissions consume a daily attempt. The atomic Redis quota
survives API restart, provided Redis data is retained. The Redis lease and normal
position gates are not a platform-wide transaction lock against unrelated manual
or auto-trader calls. Recommended initial user copy percentage is 25%, still
bounded by the server and subscription caps. No outcome or profit is promised.

## Wallet review candidates

The API ranks up to 100 tracked wallets with recent recorded entries, considering
at most 500 observations per wallet from the last 30 days. It returns at most three
qualified **review candidates**, not a network-wide or complete-portfolio ranking.
Internal GSP wallets and truncated histories are excluded.

Eligibility requires 20 verified closed trades, five tokens, positive recorded
realized SOL profit, profit factor >=1.5, win rate >=50%, median holding time >=120
seconds, no single winner exceeding 50% of gains, rug exposure <=5%, and a verified
exit in the last 72 hours. EXPIRED, open, unsigned and non-finite outcomes do not
count as verified realized profit. Reused exit signatures are excluded because
the observation ledger does not consolidate repeated buys into full cost basis.

Known Sybil confidence above 20 excludes a wallet. Missing Sybil assessment is
explicitly disclosed as a warning requiring review; it is not silently marked
safe. The legacy tracker does not populate that assessment for every wallet.
An empty result stays empty until real history qualifies. GMGN feed volume/tags
remain separate from these candidates and require an approved server-side API key.

Copy activation also starts the bounded network scanner and wallet exit sampler,
so recorded outcomes can accumulate without enabling shadow decision sampling.
The scanner/sampler rotation fixes from PR #8 (commit `7a9039f`) are reused here;
this does not merge that PR's marketing/broadcast changes.

## Existing-server activation

Prerequisites: the existing GSP single `docker-compose.yml` deployment, its real
`.env`, running `api` and `gsp-web` containers, Python 3 and `flock`, and the existing
admin-feature migration already applied. No new database migration is introduced.
Custom Compose configurations deliberately stop and require their normal rollout.

From the existing repository, preserve any local edits before switching revisions:

```bash
git diff --quiet && git diff --cached --quiet &&
git fetch origin codex/copy-trading-ranked-wallets-20261009 &&
git switch --detach FETCH_HEAD &&
bash scripts/enable-copy-trading.sh
```

The script builds before replacing containers, backs up `.env`, the copy-feature
value and running image IDs under private `backups/`, enables the copy watcher in
both environment and the existing admin override, and recreates only `api` and
`gsp-web`. It preserves LIVE/PAPER and all secrets. Already-active account copy
configurations begin receiving eligible signals if the existing worker mode is
LIVE; otherwise they remain paper executions. New accounts still need a wallet
and an explicit copy configuration.

Health verification requires `/health/ready` and a healthy copy watcher. Failure
restores the previous environment, feature override and pinned images, then asks
the operator to verify health. The script does not stop nginx, delete containers'
data, reset Git, disable risk checks or turn on LIVE trading.

Before building, activation now makes a read-only `getSlot` probe with the
environment that would be deployed. If all configured HTTP providers fail, it
stops without replacing containers or changing activation. For a standalone
check, run `docker compose run --rm --no-deps -T api node --input-type=module - < scripts/check-solana-rpc.mjs`.
The output contains provider labels and status codes, never endpoint URLs, API
keys or raw provider errors. This checks HTTP reads only, not WebSocket access,
capacity under load, or the eventual worker trading mode.

`ACCESS_DENIED` / 403 from Helius requires checking the key's permissions, server
IP restrictions and endpoint access in the Helius dashboard. A public fallback
returning 429 is rate-limited; it is not evidence that the API needs reinstalling.
Fix provider access first. Do not disable token security gates to hide missing RPC
data. Requests and latency probes now skip providers until their error cooldown
expires; when all are cooling down, reads fail locally with a bounded retry delay
instead of repeatedly sending traffic to the same rejected endpoints.

After activation, check `/copy-trading`: actual LIVE/PAPER mode, watcher health,
server limits, qualified candidates and your own enabled wallets. Health and mode
are separate: a degraded worker may still execute healthy targets. Pause a wallet
to stop new copy buys; existing positions keep their exits. To stop all copy buys,
disable the Copy-trade watcher in Admin and restart the API.

## Validation scope

Local tests cover source parsing/deduplication, rejected signals, account controls,
bounded execution, recommendation eligibility, scanner/sampler rotation, existing
security gates, and installer ordering/rollback with a mocked Docker CLI. Backend
TypeScript and the production dashboard build are also checked. These are not
proof of a VPS deployment, live Redis concurrency, provider availability or actual
on-chain fills. No live trade is executed by this development task.

Local result for this revision: 117 targeted Vitest tests and three mocked Docker
rollout tests passed; backend TypeScript, targeted lint and the production dashboard
build passed. Browser interaction QA was blocked because Chromium was absent and
the browser download returned an invalid archive. Docker/VPS/live-trade checks
remain unexecuted.

RPC recovery follow-up: 146 targeted RPC/copy/security tests, four mocked Docker
rollout tests, backend TypeScript and targeted lint passed. Four isolated probe
simulations verified healthy responses, HTTP 403/429, JSON-RPC errors and transport
errors, including output redaction. No server credentials were read or changed;
provider access and VPS deployment still require operator verification.
