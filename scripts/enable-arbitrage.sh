#!/usr/bin/env bash
# Turns on the DEX-to-DEX arbitrage scanner (paper only - it never trades).
# Usage (from the repo root): bash scripts/enable-arbitrage.sh
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

echo "==> Arbitrage scanner settings"
set_env ARBITRAGE_SCANNER_ENABLED true
set_env ARBITRAGE_INTERVAL_MS 90000
set_env ARBITRAGE_AMOUNT_SOL 0.5
set_env ARBITRAGE_MIN_NET_SOL 0.0005

echo "==> Building and restarting api"
docker compose build api
docker compose up -d --force-recreate api
echo "Waiting for the first scan (~30s)..."
sleep 45
docker compose exec -T api node -e '
fetch("http://127.0.0.1:" + (process.env.API_PORT || 4000) + "/metrics/arbitrage").then(r => r.json()).then(r => {
  if (!r.enabled) return console.log("scanner not enabled");
  console.log("scans=" + r.scans + " quotes ok/failed=" + r.quotesOk + "/" + r.quotesFailed + " opportunities=" + r.opportunities + " paper net=" + r.paperNetSol.toFixed(6) + " SOL");
  for (const [m, v] of Object.entries(r.lastByMint)) console.log("  " + m.slice(0, 6) + "  " + (v ? v.buyDex + " -> " + v.sellDex + "  net " + v.netSol.toFixed(6) + " SOL" : "no route"));
});'
