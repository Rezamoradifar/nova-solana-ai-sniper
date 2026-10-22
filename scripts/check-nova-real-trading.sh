#!/usr/bin/env bash
# Read-only readiness check for Nova's existing Solana execution services.
# No API writes, no DB changes, no wallet signing, no orders, no secrets in output.
set -Eeuo pipefail
APP_DIR="${NOVA_APP_DIR:-/opt/nova-solana-ai-sniper}"
fail() { printf 'NOVA_PREFLIGHT_ERROR=%s\n' "$*" >&2; exit 1; }
cd "$APP_DIR" || fail "Nova checkout does not exist"
command -v docker >/dev/null || fail "Docker is not installed"
docker compose version >/dev/null || fail "Docker Compose V2 is required"
docker compose -f docker-compose.yml config --quiet || fail "Compose configuration is invalid"
api_id="$(docker compose -f docker-compose.yml ps -q api)"
web_id="$(docker compose -f docker-compose.yml ps -q gsp-web)"
[[ -n "$api_id" && -n "$web_id" ]] || fail "Running api and gsp-web are required"
[[ "$(docker inspect -f '{{.State.Running}}' "$api_id")" == true ]] || fail "API container is stopped"
[[ "$(docker inspect -f '{{.State.Running}}' "$web_id")" == true ]] || fail "Website container is stopped"
printf 'NOVA_CHECKOUT=%s (source checkout, not proof of running image)\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'NOVA_HTTP_PUBLIC_API=Read-only probe inside existing API container\n'

docker compose -f docker-compose.yml exec -T api node --input-type=module - <<'NODE'
const origin = 'http://127.0.0.1:4000';
async function get(path) {
  try {
    const response = await fetch(origin + path, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, value: json };
  } catch {
    return { status: 0, value: null };
  }
}
const [liveness, readiness, network, copy] = await Promise.all([
  get('/health'),
  get('/health/ready'),
  get('/public/network/status'),
  get('/public/copy-trading'),
]);
const val = (v) => v === true ? 'YES' : v === false ? 'NO' : 'UNKNOWN';
const status = (code) => code ? String(code) : 'UNREACHABLE';
const networkReady = network.status === 200 &&
  network.value?.status === 'ready' &&
  network.value?.workersReady === true;
const watcherReady = copy.status === 200 &&
  copy.value?.copyWatcherReady === true &&
  copy.value?.watcher?.healthy === true &&
  copy.value?.watcher?.running === true;
const modeLive = network.value?.tradingMode === 'LIVE' &&
  copy.value?.executionMode === 'live' &&
  copy.value?.liveExecutionEnabled === true;
const ready = liveness.status === 200 && readiness.status === 200 &&
  networkReady && watcherReady && modeLive;
console.log('API_HEALTH_HTTP=' + status(liveness.status));
console.log('API_READINESS_HTTP=' + status(readiness.status));
console.log('NETWORK_HTTP=' + status(network.status));
console.log('NETWORK_STATUS=' + (network.value?.status ?? 'UNKNOWN'));
console.log('API_TRADING_MODE=' + (network.value?.tradingMode ?? 'UNKNOWN'));
console.log('NETWORK_WORKERS_READY=' + val(network.value?.workersReady));
console.log('COPY_ENDPOINT_HTTP=' + status(copy.status));
console.log('COPY_EXECUTION_MODE=' + (copy.value?.executionMode ?? 'UNKNOWN'));
console.log('COPY_WATCHER_RUNNING=' + val(copy.value?.watcher?.running));
console.log('COPY_WATCHER_HEALTHY=' + val(copy.value?.watcher?.healthy));
console.log('COPY_WATCHER_READY=' + val(copy.value?.copyWatcherReady));
console.log('COPY_MAX_BUY_SOL=' + (
  Number.isFinite(copy.value?.limits?.maxBuySol) ? copy.value.limits.maxBuySol : 'UNKNOWN'
));
console.log('COPY_MAX_DAILY_ATTEMPTS=' + (
  Number.isInteger(copy.value?.limits?.maxDailyBuys) ? copy.value.limits.maxDailyBuys : 'UNKNOWN'
));
console.log('COPY_MAX_OPEN_POSITIONS=' + (
  Number.isInteger(copy.value?.limits?.maxOpenPositions) ? copy.value.limits.maxOpenPositions : 'UNKNOWN'
));
console.log('COPY_BACKEND_READINESS=' + (ready ? 'LIVE_CAPABLE' : 'NOT_VERIFIED_FOR_LIVE'));
console.log('USER_WALLET_FUNDING=NOT_CHECKED');
console.log('USER_COPY_CONFIGURATIONS=NOT_CHECKED');
console.log('LIVE_TRANSACTION=NOT_SENT');
console.log('RECOMMENDED_ACTION=' + (
  ready
    ? 'Validate authenticated wallet, per-target consent and low-value real receipt before production.'
    : 'Fix failed RPC/worker/watcher/mode checks first; do not assume live execution.'
));
NODE
printf 'NOVA_PREFLIGHT_COMPLETE=READ_ONLY\n'
