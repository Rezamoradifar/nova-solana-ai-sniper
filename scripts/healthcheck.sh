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
echo "=== recent api warnings/errors ==="
docker compose logs api --since=30m 2>&1 | grep -E '"level":(40|50|60)' | grep -o '"msg":"[^"]*"' | sort | uniq -c | sort -rn | head -10
