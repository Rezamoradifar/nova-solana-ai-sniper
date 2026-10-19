# Moneyland — real-source copy directory and public no-demo mode

## What this change does

The public `/copy` page, address profiles, and copy navigation use a real-source directory at `GET /public/copy-leaderboard`. The browser requests `/api/public/copy-leaderboard` through the existing gateway. It never pads the list with fictional profiles, uses invented balances, substitutes demo prices for failed sources, or infers whole-market rankings.

The public page is read-only. **This change does not activate financial copy trading, change account permissions, select a wallet to follow, sign a transaction, or change LIVE_TRADING / COPY_TRADING_EXECUTION_ENABLED.** Those settings and the existing trading engine remain unchanged. A live-mode status reported by the existing server is metadata, not proof that a particular copy order executed.

No VPS installation, provider-key configuration, real GMGN response, executed trade, or server-side feed health has been verified from this change alone. Local/CI responses are explicitly test fixtures and never production fallbacks.

## Sources and ranking scope

| Source | Observations | Refresh | Scope |
| --- | --- | --- | --- |
| GSP | Existing recorded on-chain wallet entries and closed exits | 60 seconds | Up to 100 tracked wallets in the existing bounded candidate query |
| GMGN | Recent public Smart Money actors, then their reported 30-day stats | 5 minutes | Up to 10 valid recently observed external wallets from a bounded 50-event discovery request |
| Browser | Read-only directory snapshot | 20 seconds while visible | No wallet enrollment or financial action |

GSP and GMGN have **separate ranks**. Their scores and accounting currencies are not interchangeable. The directory labels realized SOL from recorded GSP history separately from provider-reported USD. Missing ROI, drawdown, follower counts or history remain unavailable.

GSP retains its existing ranking policy: lookback 30 days, recorded unique closed exits, sufficient token diversity, positive realized SOL, win-rate/profit-factor/outlier/freshness checks. It does not reconstruct the wallet's complete cost basis. An eligibility flag is not a trading recommendation or a guarantee.

GMGN scoring is a transparent research heuristic: 40% win rate, 30% capped positive realized-profit / buy-cost return, 20% sell-count sample, and up to 10% reported token diversity. Missing diversity receives no bonus; it is not displayed as a fabricated measurement. No rank is assigned when required scoring inputs are absent. Positive sample status requires positive reported realized result, positive cost-based return, win rate at least 50%, at least 20 reported sells and a positive buy count. These are provider statistics, **not independently audited closes or safety scores**. A high score does not establish low risk or profitable copying.

Canonical Solana wallet addresses and timestamped transaction references are validated. Known internal/customer GSP wallets are excluded from discovery and public ranking. Provider names are used only when actually supplied; otherwise the actual address is shortened.

Statistics are requested **individually** for each selected address. A response that omits an echoed wallet address can be bound to that single request. An explicit conflicting address, ambiguous batch array, or missing statistics schema is rejected; array order is never guessed. Requests are bounded, spaced, deduplicated and cooled down after errors.

## Data integrity

- Missing API key: `not_configured`, empty external list, no placeholder traders.
- Failed provider or local history load: `unavailable`, no stale list relabeled as fresh.
- Expired local/provider snapshot: no published wallet rows until a new valid snapshot arrives.
- Invalid numeric values: null / em dash, not zero or positive profit.
- The API sets `sampleData: false`, and the browser rejects demo-tagged payloads.
- The current network/source state must be verified after staging deployment with the operator's existing read-only data credentials.

## Public route changes

`/`, `/copy`, `/copy/:address`, `/copy-trading`, `/trade`, `/markets` and `/meme-hub` render real-source observations or honest empty states. `?demo=1` is removed before public demo components can mount. Old `/classic`, `/v2`, `/design-system` and `/terminal/*` demo entry points redirect to real-data or availability pages.

Demo-only exchange, bot, flash-loan and strategy screens now show an unavailable-service state rather than paper fills or invented PnL. This does **not** implement missing execution adapters.

Existing genuine research routes `/arbitrage`, `/research`, `/executions`, `/telegram`, `/wallet`, and authenticated `/dashboard/*` remain in the router. Historic paper trades stored by an existing account are not erased or relabeled as live; this patch is about public demo fixtures, not rewriting financial history.

## Data access and secrets

GSP history needs the existing database connection. External rankings need the operator's existing `GMGN_API_KEY` in the private server environment. It is never sent to the browser or embedded in source. The directory invokes only `track smartmoney` and `portfolio stats` with fixed argument lists through the existing CLI wrapper. It never passes `GMGN_PRIVATE_KEY`, a wallet signer, shell interpolation, swap, order or follow commands. Do not publish `.env` or credential-bearing logs.

Primary provider references:
- https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md
- https://github.com/GMGNAI/gmgn-skills/blob/main/src/commands/portfolio.ts
- https://github.com/GMGNAI/gmgn-skills/blob/main/docs/workflow-smart-money-profile.md

## Verification and rollout

The GitHub Actions workflow `Moneyland real-data directory verification` builds the API and frontend, runs parsing/ranking regressions, verifies the financial engine files were not changed, and tests EN desktop / FA mobile using clearly isolated mocked responses. It tests filtering, source selection, address profiles, failed sources, demo-tag rejection, removed demo URLs, wallet-dialog keyboard behavior and absence of mutating API calls. Its `report.json` is the source of truth for the specific run.

Review the pull request and deploy to a staging instance first. Existing production API restarts may restart unrelated workers; do not toggle trading flags, reset the database or run a mainnet-activation script to publish these read-only changes. No production restart is performed here. DNS and HTTPS for moneyland.tr remain separate from this feature.

After an operator-controlled deployment, read-only checks on the VPS include:

```sh
curl --fail --max-time 15 http://127.0.0.1:4000/public/copy-leaderboard
```

Check source statuses and retrieval timestamps rather than assuming a non-empty list. A healthy build is not proof of real market-source availability. Real-money activation and user-specific spending authorizations are outside this delivery.
