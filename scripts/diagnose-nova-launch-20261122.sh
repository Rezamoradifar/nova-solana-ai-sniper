#!/usr/bin/env bash
# Read-only Nova/Moneyland launch diagnostics for the six reported production issues.
# Does not print secrets, alter Docker, migrate, sign, trade, or activate features.
set -uo pipefail
APP_DIR="${NOVA_APP_DIR:-/opt/nova-solana-ai-sniper}"
if ! cd "$APP_DIR" 2>/dev/null; then
  echo 'NOVA_DIAG=CHECKOUT_MISSING'; exit 2
fi
echo 'NOVA_DIAG=READ_ONLY'
echo "SOURCE_SHA=$(git rev-parse --verify --short=12 HEAD 2>/dev/null || echo UNKNOWN)"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'DOCKER_COMPOSE=UNAVAILABLE'; exit 2
fi
if ! docker compose -f docker-compose.yml config --quiet >/dev/null 2>&1; then
  echo 'DOCKER_COMPOSE=INVALID_OR_MISSING_CONFIG'; exit 2
fi
echo 'DOCKER_COMPOSE=VALID'
for service in api gsp-web postgres redis telegram-bot marketing-engine; do
  container="$(docker compose -f docker-compose.yml ps -q "$service" 2>/dev/null || true)"
  if [[ -z "$container" ]]; then
    echo "SERVICE_${service}=MISSING"
    continue
  fi
  state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo UNKNOWN)"
  case "$state" in running|exited|created|restarting|paused|dead) ;; *) state=UNKNOWN ;; esac
  echo "SERVICE_${service}=$state"
done

api="$(docker compose -f docker-compose.yml ps -q api 2>/dev/null || true)"
if [[ -n "$api" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$api" 2>/dev/null)" == true ]]; then
  docker compose -f docker-compose.yml exec -T api node --input-type=module <<'NODE' || echo 'API_PROBES=UNAVAILABLE'
const base = 'http://127.0.0.1:4000';
const query = async (path) => {
  try {
    const response = await fetch(base + path, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body: body && typeof body === 'object' ? body : {} };
  } catch {
    return { status: 0, body: {} };
  }
};
const [health, ready, network, copy, arb, solana] = await Promise.all([
  query('/health'), query('/health/ready'), query('/public/network/status'),
  query('/public/copy-trading'), query('/public/arbitrage'),
  query('/public/solana/overview'),
]);
const code = r => r.status || 'UNREACHABLE';
const bool = value => value === true ? 'YES' : value === false ? 'NO' : 'UNKNOWN';
const oneOf = (v, allow) => typeof v === 'string' && allow.includes(v) ? v : 'UNKNOWN';
console.log('API_HEALTH_HTTP=' + code(health));
console.log('API_READY_HTTP=' + code(ready));
console.log('NETWORK_HTTP=' + code(network));
console.log('NETWORK_TRADING_MODE=' + oneOf(network.body.tradingMode, ['LIVE','PAPER']));
console.log('NETWORK_WORKERS_READY=' + bool(network.body.workersReady));
console.log('COPY_HTTP=' + code(copy));
console.log('COPY_MODE=' + oneOf(copy.body.executionMode, ['live','paper','disabled','stopped']));
console.log('COPY_WATCHER_RUNNING=' + bool(copy.body.watcher?.running));
console.log('COPY_WATCHER_HEALTHY=' + bool(copy.body.watcher?.healthy));
console.log('COPY_BUY_READY=' + bool(copy.body.buyReadiness?.ready ?? copy.body.copyWatcherReady));
console.log('SOLANA_OVERVIEW_HTTP=' + code(solana));
console.log('SOLANA_MAINNET_VERIFIED=' + bool(solana.body.mainnetVerified));
console.log('ARBITRAGE_HTTP=' + code(arb));
console.log('ARBITRAGE_SCANNER=' + oneOf(arb.body.status, ['ready','starting','stale','unavailable','disabled']));
console.log('ARBITRAGE_MODE=' + oneOf(arb.body.mode, ['observation']));
console.log('ARBITRAGE_EXECUTION_ENABLED=' + bool(arb.body.executionEnabled));
console.log('FLASH_LOAN_EXECUTION=NOT_CONNECTED_IN_CURRENT_UI');
console.log('WALLET_BROWSER_APPROVAL=REQUIRES_REAL_BROWSER_TEST');
console.log('ONCHAIN_TRADE_OR_LOAN=NOT_ATTEMPTED');
NODE
else
  echo 'API_PROBES=SKIPPED_API_NOT_RUNNING'
fi

marketing="$(docker compose -f docker-compose.yml ps -q marketing-engine 2>/dev/null || true)"
if [[ -n "$marketing" ]] && [[ "$(docker inspect --format '{{.State.Running}}' "$marketing" 2>/dev/null)" == true ]]; then
  docker compose -f docker-compose.yml exec -T marketing-engine node - <<'NODE' || echo 'TELEGRAM_PROBES=UNAVAILABLE'
const e = process.env;
const flag = name => (e[name] === 'true' ? 'ON' : e[name] === 'false' ? 'OFF' : 'UNKNOWN');
const yes = value => value ? 'YES' : 'NO';
const chat = e.MARKETING_TELEGRAM_CHANNEL_ID || e.TELEGRAM_CHAT_ID?.split(',')[0]?.trim();
console.log('TELEGRAM_BOT_TOKEN_PRESENT=' + yes(e.TELEGRAM_BOT_TOKEN));
console.log('TELEGRAM_TARGET_PRESENT=' + yes(chat));
for (const name of [
  'TELEGRAM_TRADES_ONLY', 'MARKETING_DAILY_POSTS_ENABLED',
  'TRADE_SHOWCASE_ENABLED', 'ACTIVITY_FEED_ENABLED',
  'ECOSYSTEM_FEED_ENABLED', 'NETWORK_TRADE_FEED_ENABLED'
]) console.log(name + '=' + flag(name));
console.log('AI_CONTENT_PROVIDER_PRESENT=' + yes(e.GEMINI_API_KEY || e.OPENROUTER_API_KEY));
// Read-only Bot API permissions: no message is sent and no secret or chat ID is printed.
const api = async (method, payload = {}) => {
  const response = await fetch(
    'https://api.telegram.org/bot' + e.TELEGRAM_BOT_TOKEN + '/' + method,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(6000) },
  );
  if (!response.ok) return null;
  const data = await response.json();
  return data?.ok === true ? data.result : null;
};
(async () => {
  if (!e.TELEGRAM_BOT_TOKEN || !chat) {
    console.log('TELEGRAM_BOT_ACCESS=NOT_CONFIGURED');
    return;
  }
  const me = await api('getMe');
  console.log('TELEGRAM_BOT_ACCESS=' + (me?.id ? 'OK' : 'FAILED_OR_UNAVAILABLE'));
  if (!me?.id) return;
  const target = await api('getChat', { chat_id: chat });
  const type = ['channel', 'group', 'supergroup', 'private'].includes(target?.type)
    ? target.type : 'UNKNOWN';
  console.log('TELEGRAM_TARGET_TYPE=' + type);
  if (type !== 'channel') {
    console.log('TELEGRAM_CHANNEL_POST_RIGHTS=NOT_A_VERIFIED_CHANNEL');
    return;
  }
  const member = await api('getChatMember', { chat_id: chat, user_id: me.id });
  const admin = member?.status === 'creator' || member?.status === 'administrator';
  console.log('TELEGRAM_CHANNEL_POST_RIGHTS=' + (
    admin && member.can_post_messages !== false ? 'YES'
      : !member ? 'UNKNOWN' : 'NO'
  ));
})().catch(() => console.log('TELEGRAM_REMOTE_PERMISSION_CHECK=UNAVAILABLE'))
  .finally(() => console.log('TELEGRAM_DELIVERY=NOT_TESTED_NO_MESSAGE_SENT'));
NODE
else
  echo 'TELEGRAM_PROBES=SKIPPED_MARKETING_NOT_RUNNING'
fi
echo 'NOVA_DIAG_FINISHED=NO_CHANGES_MADE'
