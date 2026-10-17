#!/usr/bin/env bash
# Fresh Ubuntu/Debian VPS install for Nova/GSP on the reviewed GitHub recovery branch.
# Does not restore an old database and deliberately keeps money movement disabled.
set -Eeuo pipefail
umask 077

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '\n==> %s\n' "$*"; }
[[ "$(id -u)" -eq 0 ]] || fail 'Run as root: sudo bash scripts/bootstrap-fresh-vps.sh'
[[ "$(uname -s)" == Linux ]] || fail 'This installer supports Linux only.'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$script_dir/.." && pwd -P)"
cd "$repo"
[[ -f docker-compose.yml && -f .env.example && -d apps/api && -d apps/dashboard ]] || fail 'Run this script from a complete Nova/GSP checkout.'
command -v git >/dev/null || fail 'git is required; install with: apt-get install -y git'
# Refuse to boot a historical main-branch release missing the reviewed GMGN and GSP code.
reviewed_sha='8b5674648b3337d3f1a04546b9fedfa6613e9805'
git cat-file -e "${reviewed_sha}^{commit}" 2>/dev/null || fail 'The reviewed release commit is not present. Use the recovery branch, not main.'
git merge-base --is-ancestor "$reviewed_sha" HEAD || fail 'Your checkout is not based on the reviewed Nova release.'

install_docker() {
  if command -v docker >/dev/null; then
    docker compose version >/dev/null 2>&1 || fail 'Docker exists without the Compose v2 plugin. Install docker-compose-plugin without replacing existing Docker data.'
    info 'Docker + Compose already installed; leaving the existing installation alone.'
    return
  fi
  command -v apt-get >/dev/null || fail 'Only Ubuntu/Debian apt-based VPS installs are supported.'
  [[ -f /etc/os-release ]] || fail 'Cannot determine Linux distribution.'
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in ubuntu|debian) ;; *) fail 'Docker setup supports official Ubuntu and Debian only.' ;; esac
  local suite="${VERSION_CODENAME:-}"
  if [[ "$ID" == ubuntu ]]; then suite="${UBUNTU_CODENAME:-$suite}"; fi
  [[ -n "$suite" ]] || fail 'Cannot resolve Docker apt release codename.'
  info 'Installing Docker Engine and Compose from the official apt repository.'
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git python3 openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<DOCKER_SOURCES
Types: deb
URIs: https://download.docker.com/linux/${ID}
Suites: ${suite}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
DOCKER_SOURCES
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker compose version >/dev/null || fail 'Docker Compose plugin installation failed.'
}

info 'Checking prerequisites.'
install_docker
command -v openssl >/dev/null || fail 'OpenSSL is required (apt-get install openssl).'
command -v python3 >/dev/null || fail 'Python 3 is required (apt-get install python3).'
command -v curl >/dev/null || fail 'curl is required (apt-get install curl).'
docker info >/dev/null || fail 'Docker daemon is not ready.'

# Writes to .env without printing secrets or putting them in process arguments.
upsert_env() {
  local key="$1" value="$2"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail 'Invalid environment variable key.'
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "Invalid line break in $key."
  NOVA_ENV_KEY="$key" NOVA_ENV_VALUE="$value" python3 - "$repo/.env" <<'PY'
import os, pathlib, re, sys
path = pathlib.Path(sys.argv[1])
key, value = os.environ['NOVA_ENV_KEY'], os.environ['NOVA_ENV_VALUE']
content = path.read_text()
pat = re.compile(rf'(?m)^{re.escape(key)}=.*$')
line = f'{key}={value}'
if pat.search(content):
    content = pat.sub(lambda _: line, content, count=1)
else:
    content += ('\n' if not content.endswith('\n') else '') + line + '\n'
path.write_text(content)
os.chmod(path, 0o600)
PY
}

get_env() {
  local key="$1"
  # Only simple unquoted key=value entries are written by this bootstrap.
  sed -n "s/^${key}=//p" .env | head -n 1
}

if [[ -f .env ]]; then
  info 'Existing .env detected. Preserving it as-is (including encryption and database credentials).'
else
  info 'Preparing a new encrypted, private environment file.'
  cp .env.example .env
  chmod 600 .env
  upsert_env 'NOVA_FRESH_BOOTSTRAP' '2026-10-17'
  db_password="$(openssl rand -hex 24)"
  upsert_env 'POSTGRES_PASSWORD' "$db_password"
  upsert_env 'DATABASE_URL' "postgresql://nova:${db_password}@postgres:5432/nova_sniper"
  upsert_env 'REDIS_URL' 'redis://redis:6379'
  upsert_env 'JWT_SECRET' "$(openssl rand -hex 32)"
  upsert_env 'ENCRYPTION_KEY' "$(openssl rand -hex 32)"
  upsert_env 'NODE_ENV' 'production'
  upsert_env 'PAPER_TRADING' 'true'
  upsert_env 'LIVE_TRADING' 'false'
  upsert_env 'KILL_SWITCH' 'true'
  upsert_env 'COPY_TRADING_EXECUTION_ENABLED' 'false'
  upsert_env 'WITHDRAWAL_EXECUTION_ENABLED' 'false'
  upsert_env 'DEPOSIT_MONITOR_ENABLED' 'false'
  upsert_env 'NETWORK_TRADE_FEED_ENABLED' 'false'
  upsert_env 'NETWORK_TRADE_SCANNER_ENABLED' 'false'
  upsert_env 'GSP_WEB_PORT' '8088'
  public_host="${NOVA_PUBLIC_HOST:-}"
  if [[ -z "$public_host" && -t 0 ]]; then
    read -r -p 'New VPS public IP/domain (blank for localhost): ' public_host
  fi
  if [[ -n "$public_host" ]]; then
    [[ "$public_host" =~ ^[A-Za-z0-9.-]+$ ]] || fail 'Use only a public IPv4 address or DNS hostname, without a scheme or port.'
    upsert_env 'CORS_ORIGIN' "http://${public_host}:8088"
  else
    upsert_env 'CORS_ORIGIN' 'http://localhost:8088'
  fi
  telegram_token="${NOVA_TELEGRAM_BOT_TOKEN:-}"
  gmgn_key="${NOVA_GMGN_API_KEY:-}"
  if [[ -t 0 ]]; then
    if [[ -z "$telegram_token" ]]; then
      read -r -s -p 'Telegram bot token (optional, hidden): ' telegram_token
      printf '\n'
    fi
    if [[ -z "$gmgn_key" ]]; then
      read -r -s -p 'GMGN API key (optional, hidden): ' gmgn_key
      printf '\n'
    fi
  fi
  if [[ -n "$telegram_token" ]]; then upsert_env 'TELEGRAM_BOT_TOKEN' "$telegram_token"; fi
  if [[ -n "$gmgn_key" ]]; then upsert_env 'GMGN_API_KEY' "$gmgn_key"; fi
  unset telegram_token gmgn_key
fi

# A retry after a failed/interrupted first setup must resume prompting for the
# required PUBLIC treasury address without regenerating the encryption key.
treasury="$(get_env PLATFORM_TREASURY_WALLET_ADDRESS)"
if [[ -z "$treasury" ]]; then
  treasury="${NOVA_TREASURY_WALLET:-}"
  if [[ -z "$treasury" && -t 0 ]]; then
    read -r -p 'Operator-controlled Solana treasury PUBLIC address (required): ' treasury
  fi
  [[ "$treasury" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || fail 'Provide a real Solana PUBLIC address (not a private key) via the prompt or NOVA_TREASURY_WALLET.'
  upsert_env 'PLATFORM_TREASURY_WALLET_ADDRESS' "$treasury"
fi
[[ "$treasury" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || fail 'Invalid Solana treasury public address in .env.'
unset treasury

[[ -n "$(get_env JWT_SECRET)" && -n "$(get_env ENCRYPTION_KEY)" ]] || fail 'Missing JWT_SECRET / ENCRYPTION_KEY in .env.'
[[ -n "$(get_env PLATFORM_TREASURY_WALLET_ADDRESS)" ]] || fail 'Missing required PLATFORM_TREASURY_WALLET_ADDRESS in .env.'
[[ "$(get_env DATABASE_URL)" == *'@postgres:5432/nova_sniper' ]] || fail 'DATABASE_URL must connect to the compose postgres service, not localhost.'
[[ "$(get_env REDIS_URL)" == 'redis://redis:6379' ]] || fail 'REDIS_URL must connect to compose redis service.'
[[ "$(get_env LIVE_TRADING)" == 'false' ]] || fail 'Fresh bootstrap requires LIVE_TRADING=false. Enable real funds separately after recovery and review.'
[[ "$(get_env KILL_SWITCH)" == 'true' ]] || fail 'Fresh bootstrap requires KILL_SWITCH=true.'

info 'Validating the Compose definition.'
docker compose -f docker-compose.yml config --quiet
info 'Starting the database, migrations, API and GSP website.'
docker compose -f docker-compose.yml up -d postgres redis
docker compose -f docker-compose.yml up -d --build api gsp-web

if [[ -n "$(get_env TELEGRAM_BOT_TOKEN)" ]]; then
  info 'Starting Telegram bot and marketing engine using the configured bot token.'
  docker compose -f docker-compose.yml up -d --build telegram-bot marketing-engine
else
  info 'Telegram token missing; leaving the bot and marketing service stopped until configured.'
fi

info 'Waiting for the local HTTP gateway and API health endpoint.'
ready=0
for _ in $(seq 1 45); do
  if curl -fsS --max-time 3 http://127.0.0.1:8088/ >/dev/null 2>&1 && \
     curl -fsS --max-time 3 http://127.0.0.1:8088/api/health >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done

docker compose -f docker-compose.yml ps
if [[ "$ready" != 1 ]]; then
  docker compose -f docker-compose.yml logs --tail=60 api gsp-web migrate >&2 || true
  fail 'Website/API health is not ready; read the logs above. Live trading remains disabled.'
fi

status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8088/api/health/ready || true)"
printf '\nNOVA_BOOTSTRAP_OK: website and API HTTP health passed.\n'
printf 'Local: http://127.0.0.1:8088/\n'
printf 'Trading: disabled (LIVE_TRADING=false, KILL_SWITCH=true). RPC readiness HTTP status: %s\n' "$status"
printf 'Check: docker compose -f docker-compose.yml logs --tail=100 api\n'
printf 'For public access use the new VPS IP on port 8088 after opening the port in your hosting firewall.\n'
printf 'Use a valid HTTPS domain/reverse proxy before asking users to sign in or use Telegram Mini App.\n'
printf 'No old PostgreSQL records, wallet keys or open positions have been restored by this installer.\n'
