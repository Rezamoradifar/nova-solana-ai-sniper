#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
ENV_FILE="$PROJECT_DIR/.env"
TREASURY="GG8ftVUxs1vMuDQJGgtcTtZkWbgC1tZLJtm6sYjq22kw"

cd "$PROJECT_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  cp .env.example "$ENV_FILE"
fi

cp "$ENV_FILE" "$ENV_FILE.backup.$(date +%Y%m%d-%H%M%S)"

read -rsp "Helius API key (input hidden): " HELIUS_KEY
echo
if [[ -z "$HELIUS_KEY" ]]; then
  echo "ERROR: Helius API key is required." >&2
  exit 1
fi

echo "Validating Helius key against Solana mainnet..."
if ! HELIUS_TEST="$(
  curl -fsS --max-time 10 --config - <<EOF
url = "https://mainnet.helius-rpc.com/?api-key=$HELIUS_KEY"
header = "Content-Type: application/json"
request = "POST"
data = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSlot\"}"
EOF
)"; then
  unset HELIUS_KEY
  echo "ERROR: Helius rejected the key or endpoint is unavailable. Nothing was changed." >&2
  exit 1
fi
if ! printf '%s' "$HELIUS_TEST" | grep -q '"result"'; then
  unset HELIUS_KEY
  echo "ERROR: Helius key validation did not return a valid RPC result. Nothing was changed." >&2
  exit 1
fi
unset HELIUS_TEST
echo "Helius RPC validation passed."

set_env() {
  local key="$1" value="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# Solana Mainnet connectivity.
set_env SOLANA_RPC_URL "https://api.mainnet-beta.solana.com"
set_env SOLANA_WS_URL "wss://api.mainnet-beta.solana.com"
set_env HELIUS_API_KEY "$HELIUS_KEY"
set_env PLATFORM_TREASURY_WALLET_ADDRESS "$TREASURY"
set_env JITO_BLOCK_ENGINE_URL "https://mainnet.block-engine.jito.wtf"
set_env JUPITER_API_BASE "https://lite-api.jup.ag"
set_env DEXSCREENER_API_BASE "https://api.dexscreener.com"

# Operator explicitly approved live mode. Paper mode stays off.
set_env LIVE_TRADING "true"
set_env PAPER_TRADING "false"

# Real-time network intelligence / marketing feed.
set_env NETWORK_TRADE_SCANNER_ENABLED "true"
set_env NETWORK_TRADE_FEED_ENABLED "true"
set_env TELEGRAM_TRADES_ONLY "true"
set_env TELEGRAM_DAILY_TRADE_CARD_LIMIT "10"

# Keep core safety controls enabled/conservative.
set_env REAL_VALUE_STOP_ENABLED "true"
set_env ENTRY_FILTER_ENABLED "true"
set_env MAX_BUY_PRICE_IMPACT_PERCENT "5"
set_env EMERGENCY_EXIT_ENABLED "true"
set_env EXIT_STRATEGY_V2_ENABLED "true"
set_env BEST_ROUTE_EXECUTION_ENABLED "true"
set_env DYNAMIC_SIZING_ENABLED "true"
set_env PARTIAL_EXITS_ENABLED "true"
set_env OPPORTUNITY_SCORE_GATE_ENABLED "true"
set_env SMART_MONEY_ANALYSIS_ENABLED "true"
set_env EARLY_MOMENTUM_DETECTION_ENABLED "true"

chmod 600 "$ENV_FILE"
unset HELIUS_KEY

echo "Applying database migrations..."
docker compose up -d postgres redis
docker compose build migrate
docker compose run --rm migrate

echo "Rebuilding Solana-connected services..."
docker compose build --no-cache api telegram-bot marketing-engine nginx
docker compose up -d --force-recreate api telegram-bot marketing-engine nginx

echo
echo "=== SERVICES ==="
docker compose ps

echo
echo "=== API HEALTH ==="
curl -fsS http://127.0.0.1:4000/health || true
echo

echo "=== READINESS ==="
curl -fsS http://127.0.0.1:4000/health/ready || true
echo

echo "Live Mainnet configuration installed. Helius key was written only to .env and was not committed."
