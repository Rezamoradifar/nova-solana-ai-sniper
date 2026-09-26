#!/usr/bin/env bash
# Applies the recommended "trade fewer, better entries" settings.
# Usage (from the repo root, after building the latest images):
#   bash scripts/apply-profit-settings.sh
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

echo "==> .env"
set_env ENTRY_FILTER_ENABLED true
set_env ENTRY_CONFIRMATION_DELAY_MS 180000
set_env ENTRY_CONFIRMATION_MAX_PRICE_DROP_PERCENT 15
set_env ENTRY_CONFIRMATION_MAX_LIQUIDITY_DROP_PERCENT 30
set_env MAX_BUY_PRICE_IMPACT_PERCENT 5
set_env TIME_STOP_MINUTES 15
set_env TIME_STOP_MIN_PROFIT_PERCENT 10

echo "==> Active sniper configs (entry filter + minimum liquidity)"
docker compose exec -T postgres psql -U nova -d nova_sniper -c "UPDATE snipe_configs SET \"entryFilterEnabled\" = true, \"minBuySellRatio\" = 1.2, \"minHolderCount\" = 15, \"minRecentVolumeUsd\" = 2000, \"maxTop10HolderPercent\" = 30, \"minLiquidityUsd\" = 15000 WHERE \"isActive\";"

echo "==> Restarting api"
docker compose up -d --force-recreate api

echo "==> Mode check"
grep -E "^LIVE_TRADING=" .env || echo "LIVE_TRADING not set (paper)"
echo "Done."
