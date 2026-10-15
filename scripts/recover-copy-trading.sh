#!/usr/bin/env bash
# Recover HTTP service after a legacy rollback referenced unavailable image IDs.
# Uses the current locally built application images, NOT the missing old images.
set -euo pipefail
cd "${2:-$(pwd)}"
[[ -f docker-compose.yml && -f .env && -f scripts/copy-trading-feature.mjs ]] || {
  echo 'Run from the existing Nova/GSP repository.' >&2; exit 1;
}
[[ -n "${1:-}" ]] || { echo 'Supply the failed activation backup directory.' >&2; exit 1; }
saved=$(realpath "$1")
[[ "$saved" == "$(pwd -P)/backups/"* && -f "$saved/env" && -f "$saved/feature.json" ]] || {
  echo 'The saved environment and feature backup are required.' >&2; exit 1;
}
command -v python3 >/dev/null
command -v flock >/dev/null
exec 9>.env.copy-trading-deploy.lock
flock -n 9 || { echo 'Another activation or recovery is running.' >&2; exit 1; }
[[ -z "${COMPOSE_FILE:-}" && ! -f compose.override.yaml && ! -f compose.override.yml && ! -f docker-compose.override.yml && ! -f docker-compose.override.yaml ]] || {
  echo 'Custom Compose configuration detected; recovery needs its normal workflow.' >&2; exit 1;
}
python3 - "$saved/feature.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
assert v is None or isinstance(v, dict) and isinstance(v.get('enabled'), bool), 'Invalid feature backup'
PY
umask 077
recovery=$(mktemp -d "$(pwd -P)/backups/recovery-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
cp -p .env "$recovery/env-before"
# Resolve image names using saved interpolation values without changing .env. Explicit
# -f excludes the invalid legacy rollback.yml; --env-file selects saved values.
dc=(docker compose --env-file "$saved/env" -f docker-compose.yml)
"${dc[@]}" config --quiet
"${dc[@]}" config --images api gsp-web > "$recovery/images.txt"
[[ -s "$recovery/images.txt" ]] || { echo 'No application image names resolved.' >&2; exit 1; }
while IFS= read -r image; do
  [[ -n "$image" ]] || continue
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "RECOVERY_IMAGES_MISSING: $image. No service was replaced; rebuild is required." >&2
    exit 1
  fi
done < "$recovery/images.txt"
cp -p "$saved/env" .env
echo 'Restoring saved activation with the current local API image.'
"${dc[@]}" run --rm --no-deps --pull never -T api node --input-type=module - restore "$(cat "$saved/feature.json")" < scripts/copy-trading-feature.mjs
"${dc[@]}" up -d --no-deps --no-build --pull never api gsp-web
"${dc[@]}" ps -a api gsp-web postgres redis
echo 'Waiting for API and web HTTP responses (up to about three minutes).'
for attempt in $(seq 1 20); do
  if "${dc[@]}" exec -T api node -e '
    fetch("http://127.0.0.1:4000/health", {signal: AbortSignal.timeout(3000)})
      .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  ' && "${dc[@]}" exec -T gsp-web wget -q -T 3 -O /dev/null http://127.0.0.1/; then
    echo 'RECOVERY_HTTP_OK: API and web respond; saved activation restored. RPC/trading readiness is separate.'
    echo "Configuration backup: $recovery"
    exit 0
  fi
  sleep 2
done
echo 'RECOVERY_HTTP_FAILED: containers were started but HTTP health did not pass. Inspect api/gsp-web logs.' >&2
exit 1
