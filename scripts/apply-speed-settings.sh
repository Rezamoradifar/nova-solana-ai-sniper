#!/usr/bin/env bash
# Turns on the faster order-execution settings, then restarts the api.
# Usage (from the repo root, after building the latest api image):
#   bash scripts/apply-speed-settings.sh
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

echo "==> Speed settings"
set_env FAST_SEND_ENABLED true
set_env FAST_SEND_REBROADCAST_MS 2000
set_env SKIP_BUY_SIMULATION true
set_env BUY_PRIORITY_LEVEL veryHigh
grep -q "^JITO_BLOCK_ENGINE_URL=." .env || set_env JITO_BLOCK_ENGINE_URL https://frankfurt.mainnet.block-engine.jito.wtf

echo "==> Restarting api"
docker compose up -d --force-recreate api
sleep 20
echo "==> Fast send check"
docker compose logs api --since=2m 2>&1 | grep -o 'FAST SEND enabled[^}]*}' | tail -1 || echo "not seen yet - check: docker compose logs api | grep 'FAST SEND'"
echo "Done."
