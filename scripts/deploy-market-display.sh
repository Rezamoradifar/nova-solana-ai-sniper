#!/usr/bin/env bash
set -euo pipefail
# Run from an existing Nova/GSP checkout after switching to the reviewed revision.
cd "${1:-$(pwd)}"
[[ -f docker-compose.yml && -f .env && -f scripts/copy-trading-feature.mjs && -f scripts/check-solana-rpc.mjs ]] || {
  echo 'Run in the existing GSP repository with its existing .env.' >&2; exit 1;
}
command -v python3 >/dev/null
command -v flock >/dev/null
exec 9>.env.copy-trading-deploy.lock
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
# Require the checked-in Compose setup; only our verified image-only rollback overlay is accepted.
[[ -z "${COMPOSE_FILE:-}" ]] || { echo 'Custom COMPOSE_FILE detected; use your normal deployment workflow.' >&2; exit 1; }
[[ ! -f compose.override.yaml && ! -f compose.override.yml && ! -f docker-compose.override.yml && ! -f docker-compose.override.yaml ]] || {
  echo 'Custom Compose override detected; use your normal deployment workflow.' >&2; exit 1;
}
api_id=$(docker compose ps -q api)
web_id=$(docker compose ps -q gsp-web)
[[ -n "$api_id" && -n "$web_id" ]] || { echo 'Existing api and gsp-web containers are required.' >&2; exit 1; }
expected_compose="$(pwd -P)/docker-compose.yml"
api_compose=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$api_id")
web_compose=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$web_id")
[[ "$api_compose" == "$web_compose" ]] || { echo 'API and web use different Compose configurations.' >&2; exit 1; }
if [[ "$api_compose" != "$expected_compose" ]]; then
  [[ "$api_compose" == "$expected_compose,"* ]] || { echo 'Running container uses a different Compose configuration.' >&2; exit 1; }
  prior_overlay=${api_compose#"$expected_compose,"}
  # A rollback from this installer pins only images. Reject extra files,
  # symlinks, altered manifests, ports, mounts or environment overrides.
  python3 - "$(pwd -P)" "$prior_overlay" <<'PY_MANIFEST'
from pathlib import Path
import re, sys
root = Path(sys.argv[1]); manifest = Path(sys.argv[2])
name = manifest.parent.name
if (manifest.name != 'rollback.yml' or
    not re.fullmatch(r'copy-trading-\d{8}T\d{6}Z-[A-Za-z0-9]{6}', name) or
    manifest.parent.parent != root / 'backups' or
    manifest.resolve() != manifest or not manifest.is_file()):
    sys.exit('Unrecognized rollback manifest; use the custom deployment workflow.')
expected = ('services:\n  api:\n    image: "nova-copy-rollback-api:' + name +
    '"\n    pull_policy: never\n  gsp-web:\n    image: "nova-copy-rollback-web:' + name +
    '"\n    pull_policy: never\n')
if manifest.read_text() != expected:
    sys.exit('Rollback manifest differs from the installer image-only format.')
PY_MANIFEST
  prior_name=$(basename "$(dirname "$prior_overlay")")
  for container in "$api_id" "$web_id"; do
    prior_service=api
    [[ "$container" != "$web_id" ]] || prior_service=web
    prior_tag="nova-copy-rollback-$prior_service:$prior_name"
    running_image=$(docker inspect --format '{{.Image}}' "$container")
    pinned_image=$(docker image inspect --format '{{.Id}}' "$prior_tag")
    [[ "$running_image" == "$pinned_image" ]] || { echo 'Rollback image does not match the running container.' >&2; exit 1; }
  done
  echo 'Verified installer rollback detected; retrying from the running images.'
fi
umask 077
mkdir -p backups
backup=$(mktemp -d "$(pwd -P)/backups/copy-trading-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
cp -p .env "$backup/env"
api_rollback="nova-copy-rollback-api:$(basename "$backup")"
web_rollback="nova-copy-rollback-web:$(basename "$backup")"
docker image tag "$(docker inspect --format '{{.Image}}' "$api_id")" "$api_rollback"
docker image tag "$(docker inspect --format '{{.Image}}' "$web_id")" "$web_rollback"
printf 'services:\n  api:\n    image: "%s"\n    pull_policy: never\n  gsp-web:\n    image: "%s"\n    pull_policy: never\n' "$api_rollback" "$web_rollback" > "$backup/rollback.yml"
dc=(docker compose -f docker-compose.yml)
"${dc[@]}" config --quiet
# Build and verify schema compatibility before replacing any running service.
"${dc[@]}" build api gsp-web migrate
"${dc[@]}" run --rm --no-deps --pull never -T migrate npx prisma migrate status --schema apps/api/prisma/schema.prisma
rollback() {
  trap - ERR INT TERM
  echo "Market deployment failed; restoring previous API and web images. Backup: $backup" >&2
  docker compose -f docker-compose.yml -f "$backup/rollback.yml" up -d --no-deps --no-build --pull never api gsp-web || {
    echo "ROLLBACK_FAILED: inspect services using $backup/rollback.yml" >&2
    exit 1
  }
  exit 1
}
trap rollback ERR INT TERM
"${dc[@]}" up -d --no-deps --no-build --pull never api gsp-web
ready=0
for attempt in $(seq 1 30); do
  if "${dc[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/health", {signal: AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    ready=1; break
  fi
  sleep 2
done
[[ "$ready" == 1 ]]
# Check the same nginx -> API route used by the display, including real prices.
"${dc[@]}" exec -T api node --input-type=module -e '
  const r = await fetch("http://gsp-web/api/public/markets", {signal: AbortSignal.timeout(15000)});
  if (!r.ok || !(Number(r.headers.get("x-market-updated-at")) > 0)) process.exit(1);
  const pairs = await r.json();
  if (!Array.isArray(pairs) || !pairs.some(p => p.chainId === "solana" && Number(p.priceUsd) > 0)) process.exit(1);
  console.log(JSON.stringify({marketFeed: "ok", updatedAt: r.headers.get("x-market-updated-at"), pools: pairs.length}));
'
"${dc[@]}" exec -T api node --input-type=module -e '
  const r = await fetch("http://gsp-web/api/public/gmgn/markets", {signal: AbortSignal.timeout(15000)});
  if (!r.ok) process.exit(1);
  const feed = await r.json();
  if (feed.source !== "GMGN" || !["connected", "not_configured", "unavailable"].includes(feed.status)) process.exit(1);
  console.log(JSON.stringify({gmgn: feed.status, updatedAt: feed.updatedAt}));
'
trap - ERR INT TERM
echo "MARKET_DISPLAY_READY: backup=$backup. Existing trading settings preserved."
