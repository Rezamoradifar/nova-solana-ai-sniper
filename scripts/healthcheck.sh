#!/usr/bin/env bash
# Read-only health check of a running Docker Compose deployment.
# Usage (from the repo root): bash scripts/healthcheck.sh
set -u
cd "$(dirname "$0")/.."

redis_get() { docker compose exec -T redis redis-cli GET "$1" 2>/dev/null | tr -d '\r'; }
sql() { docker compose exec -T postgres psql -U nova -d nova_sniper -tAc "$1" 2>/dev/null | tr -d '\r'; }

echo "=== containers ==="
docker compose ps --format '{{.Service}}: {{.Status}}'

echo
echo "commit:        $(git log -1 --oneline)"
echo "api image:     $(docker compose images api --format "{{.CreatedAt}}" 2>/dev/null | head -1)"
echo "kill switch:   [$(redis_get nova:trading:kill_switch)]   (empty or 0 = OK)"
echo "autobuy pause: [$(redis_get nova:trading:scanner_autobuy_paused)]   (empty or 0 = OK)"
echo "mode:          $(docker compose logs api 2>&1 | grep -o 'LIVE TRADING mode\|PAPER TRADING mode' | tail -1)"
echo "notif off:     $(docker compose logs api --since=10m 2>&1 | grep -c 'notifications disabled')   (0 = OK)"
echo "chat ids:      $(grep '^TELEGRAM_CHAT_ID=' .env | cut -d= -f2)"
echo "rpc provider:  $(docker compose logs api 2>&1 | grep -o '"provider":"[a-z]*"' | tail -1)"
echo "tokens 10min:  $(sql "SELECT count(*) FROM tokens WHERE \"createdAt\" > now() - interval '10 minutes';")   (>0 = OK)"
echo "tokens 24h:    $(sql "SELECT count(*) FROM tokens WHERE \"createdAt\" > now() - interval '24 hours';")"
echo "active sniper: $(sql "SELECT count(*) FROM snipe_configs WHERE \"isActive\" AND \"autoBuyOnLaunch\";")   (>=1 = OK)"
echo "open positions: $(sql "SELECT count(*) FROM positions WHERE status = 'OPEN';")"
echo "trades 24h:    $(sql "SELECT count(*) FROM trades WHERE \"createdAt\" > now() - interval '24 hours';")"

echo
echo "=== snipe configs ==="
sql "SELECT \"buyAmountSol\" || ' SOL, minAiScore=' || \"minAiScore\" || ', active=' || \"isActive\" || ', autoBuy=' || \"autoBuyOnLaunch\" FROM snipe_configs;"

echo
echo "=== buy pipeline, last 2h ==="
LOGS2H="$(docker compose logs api --since=2h 2>&1)"
echo "token accepted: $(grep -c 'TOKEN ACCEPTED' <<<"$LOGS2H")"
echo "buy started:    $(grep -c '"msg":"BUY STARTED"' <<<"$LOGS2H")"
echo "buy executed:   $(grep -c '"msg":"BUY EXECUTED' <<<"$LOGS2H")"
echo "--- why buys were cancelled ---"
grep -oE 'BUY CANCELLED\\nReason:\\n[^"]{0,70}' <<<"$LOGS2H" | sed -E 's/BUY CANCELLED\\nReason:\\n//; s/[=:][^ ]*//g' | sort | uniq -c | sort -rn | head -8
echo "--- security gate blocks ---"
grep -oE 'SECURITY GATE BLOCKED CANDIDATE\\nReasons:\\n[^"]*' <<<"$LOGS2H" | sed -E 's/.*Reasons:\\n//' | tr ',' '\n' | sed 's/^ *//' | sort | uniq -c | sort -rn | head -8

echo
echo "=== strategy settings (as seen by the running api container) ==="
for v in LIVE_TRADING EXIT_STRATEGY_V2_ENABLED ENTRY_FILTER_ENABLED ENTRY_CONFIRMATION_DELAY_MS \
  MAX_BUY_PRICE_IMPACT_PERCENT TIME_STOP_MINUTES TIME_STOP_MIN_PROFIT_PERCENT \
  SCANNER_AUTO_BUY_AUTO_RESUME_ENABLED MINIAPP_URL; do
  echo "  $v=$(docker compose exec -T api printenv "$v" 2>/dev/null | tr -d '\r')"
done
echo "--- sniper config filters ---"
sql "SELECT 'entryFilter=' || \"entryFilterEnabled\" || ', minLiq=' || \"minLiquidityUsd\" || ', buySell>=' || \"minBuySellRatio\" || ', vol>=' || \"minRecentVolumeUsd\" || ', top10<=' || \"maxTop10HolderPercent\" || ', exit=' || coalesce(\"exitStrategy\", '-') FROM snipe_configs WHERE \"isActive\";"

echo
echo "=== new filters at work, last 2h ==="
echo "waiting for confirmation: $(grep -c 'ENTRY CONFIRMATION: waiting' <<<"$LOGS2H")"
echo "confirmed:                $(grep -c 'ENTRY CONFIRMED' <<<"$LOGS2H")"
echo "confirmation failed:      $(grep -c 'entry_confirmation_failed' <<<"$LOGS2H")"
echo "entry filter blocked:     $(grep -c 'entry_filter_blocked' <<<"$LOGS2H")"
echo "price impact too high:    $(grep -c 'price_impact_too_high' <<<"$LOGS2H")"
echo "time stops:               $(grep -c 'time stop: position' <<<"$LOGS2H")"

echo
echo "=== results (closed positions, 7 days, SOL in vs out) ==="
sql "WITH p AS (SELECT p.id, p.\"isPaperTrade\" paper, p.\"amountSolInvested\" inv, (SELECT coalesce(sum(t.\"amountSol\"),0) FROM trades t WHERE t.\"walletId\"=p.\"walletId\" AND t.\"tokenId\"=p.\"tokenId\" AND t.side='SELL' AND t.status='CONFIRMED' AND t.\"createdAt\" BETWEEN p.\"createdAt\" AND p.\"closedAt\" + interval '2 minutes') ret FROM positions p WHERE p.status='CLOSED' AND p.\"closedAt\" > now() - interval '7 days' AND NOT (p.\"isPaperTrade\" AND p.\"closedAt\" - p.\"createdAt\" < interval '15 seconds' AND p.\"exitReason\"='stop_loss')) SELECT CASE WHEN paper THEN 'paper' ELSE 'LIVE ' END || ': ' || count(*) || ' trades, ' || sum(CASE WHEN ret>inv THEN 1 ELSE 0 END) || ' wins, net ' || round(sum(ret-inv)::numeric,4) || ' SOL' FROM p GROUP BY paper;"

echo
echo "=== recent api warnings/errors ==="
docker compose logs api --since=30m 2>&1 | grep -E '"level":(40|50|60)' | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -10
