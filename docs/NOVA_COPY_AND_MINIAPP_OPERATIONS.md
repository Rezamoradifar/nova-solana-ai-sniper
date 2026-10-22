# Live copy trading and Telegram Mini App shutdown

This release changes operator scripts, the Mini App nginx locations and bot menu
synchronization. It does not replace the financial engine, choose source wallets,
create account copy configurations, change RPC credentials or increase limits.

## Run on the existing Nova VPS

Use the existing root Termius session on the server hosting
`/opt/nova-solana-ai-sniper`. Fetch this reviewed branch and extract only its
operator scripts into a private persistent directory. Do not switch or reset the
installed checkout and do not run the legacy broad mainnet configuration script.

Run these steps in order:

1. `python3 /path/to/scripts/disable-telegram-miniapp.py --app-dir /opt/nova-solana-ai-sniper`
2. `python3 /path/to/scripts/enable-live-copy-trading.py --app-dir /opt/nova-solana-ai-sniper`

Keep `disable-telegram-miniapp.py`, `enable-live-copy-trading.py` and
`nova-live-copy-control.mjs` together. `--dry-run` performs read-only preflight.
Both mutations share an exclusive `.env.nova-ops.lock`.

## Mini App shutdown

- `/app`, its subroutes and static assets return HTTP 410 and `Cache-Control: no-store`.
- Public Telegram Mini App authentication returns HTTP 410. Ordinary website/API
  routes continue to work.
- `MINIAPP_URL` is cleared without changing other environment values. The current
  bot image is recreated with an empty URL, so newly generated bot home screens
  no longer contain an app button. The default Telegram menu becomes `commands`.
- Website, API, database, Redis and marketing-engine containers are not replaced.
- Each running official nginx template is validated before any reload. Changes
  use the existing bind-mounted inode; replacing the file by rename would leave
  the container using the old configuration.
- Source bot startup now synchronizes both the enabled and disabled menu states.
  SSL renewal/setup no longer re-populates `MINIAPP_URL`.

Success prints `NOVA_MINIAPP_DISABLED=YES`. Previously issued JWTs are not revoked;
the application has no distinct Mini App token scope. Historical chat buttons may
remain in old messages, but their application URL is blocked. BotFather's **Main
Mini App** setting is separate from the default Bot API menu. The installer reports
`has_main_web_app`; it cannot remove that BotFather setting. Network errors during
the final menu reset report a partial result and a failed exit status.

## Live copy activation

The existing engine uses one global `LIVE_TRADING` switch for swaps. Turning that
on with active launch auto-buy configurations could unexpectedly promote those
simulations into real buys. This installer therefore refuses activation when any
unrelated `isActive && autoBuyOnLaunch` configuration exists. It rechecks that
condition under a database table lock before committing the two feature flags.
It does not disable, delete or modify those user configurations.

Other requirements, all checked before any financial-setting mutation:

- Official local Docker Compose installation and compatible running API image.
- Live API/network readiness, a healthy detection scanner and no scanner-buy pause.
- Redis and safety limits work; no kill switch is active; buy simulation is enabled.
- A dedicated RPC proves Solana mainnet by its genesis hash, slot and recent
  blockhash. Up to three existing configured source targets are checked for
  signatures and parsed transaction history. No provider key is printed.
- Existing copy ceilings do not exceed **0.1 SOL per buy, 10 attempts per Tehran
  day, three open positions and 150 bps slippage**. Lower limits stay unchanged.

The installer backs up `.env` and the precise existing admin feature overrides,
sets only `LIVE_TRADING=true`, `PAPER_TRADING=false` and
`COPY_TRADING_EXECUTION_ENABLED=true`, and persists only the two corresponding
admin boolean overrides. A transaction audit records the before/after state so
an uncertain helper response can be reconciled. It restarts **only `api`** using
the exact image ID that was already running, without building, pulling or running
migrations. The Mini App shutdown, website, bot and database settings are kept.

Success requires the network to report `LIVE`, copy execution to report `live`,
and the copy watcher to report both running and healthy, with all safety gates
still passing. It prints `NOVA_COPY_LIVE_READY=...`. Zero active copy targets is
reported as zero: the infrastructure can be enabled without creating trades.
Users must choose and enable their own targets at `/copy-trading` and fund their
existing account trading wallet. Connecting SafePal by public address alone does
not give the server a transaction signer.

Enabling this mode authorizes bounded automatic execution by existing active
user-owned copy configurations. The helper itself constructs no signer and sends
no trade, but the resumed worker may trade after restart. A readiness success is
not proof of a completed on-chain trade or realized profit.

## Failure and recovery

Each installer prints its private backup path and exact `--restore` command.
Copy preflight blockers produce `COPY_NOT_ACTIVATED` before writing mode flags,
while a Mini App shutdown completed in step one stays in place. In particular,
an unhealthy RPC/scanner must be repaired before live activation can succeed.
The scripts do not replace a broken paid RPC with a public endpoint or clear a
manual kill switch/scanner pause.

After an activation failure, rollback restores the saved flags and environment
and restarts the preserved API image. It works through a one-off Node process
even if the API cannot boot. A later manual `.env`/admin edit stops automatic
overwrite and is reported as a partial recovery. Rollback cannot reverse a
transaction already submitted by the worker. Normal position monitoring continues
using the existing per-position real/paper marker in the same image.

Standard Compose or these installers' exact immutable image-only overlays are
supported. Arbitrary custom overlays, symlinked configuration files and unexpected
template layouts are rejected without bypassing their checks.

## Verification scope

Offline tests cover mode/limit gates, concurrent admin changes, response-loss
reconciliation, rollback preservation, template idempotency and immutable image
overlay validation. The Docker integration test checks actual nginx precedence
for disabled routes while retaining the dashboard and ordinary API proxy.

The authoring environment has no Nova SSH key or connected Nova management tool.
Publishing this change and passing CI do not install it on the VPS. Public HTTP
probes can verify the resulting shutdown/runtime status only after the server
command has been executed.
