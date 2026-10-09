#!/usr/bin/env bash
set -euo pipefail
# Run from an existing Nova/GSP checkout after switching to the reviewed revision.
cd "${1:-$(pwd)}"
[[ -f docker-compose.yml && -f .env && -f scripts/copy-trading-feature.mjs ]] || {
  echo 'Run in the existing GSP repository with its existing .env.' >&2; exit 1;
}
command -v python3 >/dev/null
command -v flock >/dev/null
exec 9>.env.copy-trading-deploy.lock
flock -n 9 || { echo 'Another copy-trading deployment is running.' >&2; exit 1; }
# Require the checked-in, single Compose setup; custom overrides need their own rollout.
[[ -z "${COMPOSE_FILE:-}" ]] || { echo 'Custom COMPOSE_FILE detected; use your normal deployment workflow.' >&2; exit 1; }
[[ ! -f compose.override.yaml && ! -f compose.override.yml && ! -f docker-compose.override.yml && ! -f docker-compose.override.yaml ]] || {
  echo 'Custom Compose override detected; use your normal deployment workflow.' >&2; exit 1;
}
api_id=$(docker compose ps -q api)
web_id=$(docker compose ps -q gsp-web)
[[ -n "$api_id" && -n "$web_id" ]] || { echo 'Existing api and gsp-web containers are required.' >&2; exit 1; }
expected_compose="$(pwd -P)/docker-compose.yml"
for container in "$api_id" "$web_id"; do
  actual_compose=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
  [[ "$actual_compose" == "$expected_compose" ]] || { echo 'Running container uses a different Compose configuration.' >&2; exit 1; }
done
umask 077
backup="$(pwd -P)/backups/copy-trading-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
cp -p .env "$backup/env"
api_image=$(docker inspect --format '{{.Image}}' "$api_id")
web_image=$(docker inspect --format '{{.Image}}' "$web_id")
printf 'services:\n  api:\n    image: "%s"\n  gsp-web:\n    image: "%s"\n' "$api_image" "$web_image" > "$backup/rollback.yml"
docker compose exec -T api node --input-type=module - status < scripts/copy-trading-feature.mjs > "$backup/feature.json"
python3 - "$backup/feature.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
assert v is None or isinstance(v.get('enabled'), bool), 'Invalid feature backup'
PY
# A failed build leaves the running application and activation unchanged.
docker compose config --quiet
docker compose build api gsp-web
rollback() {
  trap - ERR INT TERM
  echo 'Activation failed; restoring the saved feature, environment, and images.' >&2
  cp -p "$backup/env" .env
  local failed=0
  docker compose run --rm --no-deps -T api node --input-type=module - restore "$(cat "$backup/feature.json")" < scripts/copy-trading-feature.mjs || failed=1
  docker compose -f docker-compose.yml -f "$backup/rollback.yml" up -d --no-deps --no-build api gsp-web || failed=1
  if [[ "$failed" == 0 ]]; then
    echo "Rollback commands completed; verify service health. Backup: $backup" >&2
  else
    echo "Rollback incomplete; inspect containers and restore from $backup" >&2
  fi
  exit 1
}
trap rollback ERR INT TERM
python3 - <<'PY'
from pathlib import Path
import os, stat, tempfile
p = Path('.env'); mode = stat.S_IMODE(p.stat().st_mode)
lines = [s for s in p.read_text().splitlines() if s.split('=', 1)[0].strip() != 'COPY_TRADING_EXECUTION_ENABLED']
lines.append('COPY_TRADING_EXECUTION_ENABLED=true')
fd, name = tempfile.mkstemp(prefix='.env.copy-trading-', dir='.')
try:
    with os.fdopen(fd, 'w') as f: f.write('\n'.join(lines) + '\n')
    os.chmod(name, mode); os.replace(name, p)
finally:
    if os.path.exists(name): os.unlink(name)
PY
docker compose run --rm --no-deps -T api node --input-type=module - enable < scripts/copy-trading-feature.mjs
docker compose up -d --no-deps --no-build api gsp-web
ready=0
for attempt in $(seq 1 30); do
  if docker compose exec -T api node --input-type=module -e '
    const health = await fetch("http://localhost:4000/health/ready", { signal: AbortSignal.timeout(10000) });
    if (!health.ok) process.exit(1);
    const r = await fetch("http://localhost:4000/public/copy-trading", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) process.exit(1);
    const s = await r.json();
    if (!s.copyWatcherReady || !s.watcher?.running || !s.limits) process.exit(1);
    console.log(JSON.stringify({ watcher: "healthy", executionMode: s.executionMode, limits: s.limits }));
  '; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]]
trap - ERR INT TERM
echo "Copy watcher enabled. Existing LIVE/PAPER mode preserved. Backup: $backup"
echo 'Open /copy-trading to review and enable the specific wallets for your account.'
