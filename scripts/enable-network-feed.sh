#!/usr/bin/env bash
# Turns on the Network Trade Feed: real, on-chain-verified completed trades of
# other wallets, posted with the bot's PnL card design to the admin chat (or
# MARKETING_TELEGRAM_CHANNEL_ID) and to every registered bot user.
# Usage (from the repo root): bash scripts/enable-network-feed.sh
set -euo pipefail
cd "$(dirname "$0")/.."

set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
  echo "  $1=$2"
}

test -f .env || { echo "Missing .env: configure Telegram, database and RPC first." >&2; exit 1; }
echo "==> Network feed settings"
# Keep a fixed cutoff across restarts; the schema otherwise defaults to now,
# hiding every completed trade collected before the latest engine restart.
if ! grep -q '^NETWORK_TRADE_FEED_DEPLOYED_AT=.' .env; then
  set_env NETWORK_TRADE_FEED_DEPLOYED_AT "$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)"
fi
set_env NETWORK_TRADE_SCANNER_ENABLED true
set_env NETWORK_TRADE_FEED_ENABLED true
set_env NETWORK_TRADE_FEED_MIN_INTERVAL_MINUTES 20
set_env NETWORK_TRADE_FEED_MAX_INTERVAL_MINUTES 40
set_env NETWORK_TRADE_FEED_MAX_POSTS_PER_DAY 10
set_env MARKETING_DAILY_POSTS_ENABLED false

echo "==> Building and starting"
docker compose build api marketing-engine
docker compose up -d --force-recreate api marketing-engine
sleep 20
docker compose logs marketing-engine --since=2m 2>&1 | grep -E "network trade (feed monitor|broadcast worker) started|disabled" | tail -3
echo "Done. The first post appears once a tracked wallet completes a real, verified trade (can take a while)."

