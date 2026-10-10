#!/usr/bin/env bash
# Update the existing API and web without depending on trading-provider health.
set -euo pipefail
cd "${1:-$(pwd)}"
[[ -f docker-compose.yml && -f .env ]] || { echo 'Existing repository and .env required.' >&2; exit 1; }
command -v python3 >/dev/null
command -v flock >/dev/null
command -v curl >/dev/null
exec 9>.env.copy-trading-deploy.lock
flock -n 9 || { echo 'Another deployment or recovery is running.' >&2; exit 1; }
[[ -z "${COMPOSE_FILE:-}" && ! -f compose.override.yaml && ! -f compose.override.yml && ! -f docker-compose.override.yml && ! -f docker-compose.override.yaml ]] || {
  echo 'Custom Compose configuration detected; use its deployment workflow.' >&2; exit 1;
}
umask 077
mkdir -p backups
backup=$(mktemp -d "$(pwd -P)/backups/platform-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
cp -p .env "$backup/env"
git rev-parse HEAD > "$backup/revision.txt"
dc=(docker compose -f docker-compose.yml)
"${dc[@]}" config --quiet
# Archive every recoverable application image before building replacements.
# A legacy failed rollback may have no usable container/image; that service
# then has no rollback target and the new build serves as its recovery.
printf 'services:\n' > "$backup/rollback.yml"
rollback_services=()
rollback_tags=()
for service in api gsp-web; do
  container=$("${dc[@]}" ps -aq "$service")
  prior=''
  if [[ -n "$container" ]]; then prior=$(docker inspect --format '{{.Image}}' "$container"); fi
  if [[ -z "$prior" ]] || ! docker image inspect "$prior" >/dev/null 2>&1; then
    prior=$("${dc[@]}" config --images "$service")
  fi
  if [[ -n "$prior" ]] && docker image inspect "$prior" >/dev/null 2>&1; then
    tag="nova-platform-$service:$(basename "$backup")"
    docker image tag "$prior" "$tag"
    rollback_services+=("$service")
    rollback_tags+=("$tag")
    printf '  %s:\n    image: "%s"\n    pull_policy: never\n' "$service" "$tag" >> "$backup/rollback.yml"
  else
    echo "RECOVERY_BUILD_REQUIRED: $service has no usable previous image."
  fi
done
if (( ${#rollback_tags[@]} )); then
  docker image save --output "$backup/images.tar" "${rollback_tags[@]}"
fi
# Build failures leave current application containers and configuration intact.
"${dc[@]}" build api gsp-web migrate
# Existing database/Redis containers are never recreated by this installer.
"${dc[@]}" up -d --no-recreate --wait --wait-timeout 90 postgres redis
# This release has no schema changes. Do not migrate an unknown older database
# or claim an image rollback can undo database changes.
if ! "${dc[@]}" run --rm --no-deps --pull never -T migrate npx prisma migrate status --schema apps/api/prisma/schema.prisma > "$backup/schema-check.log" 2>&1; then
  echo "DATABASE_CHECK_FAILED: no application container was replaced. Review $backup/schema-check.log" >&2
  exit 1
fi
rollback() {
  trap - ERR INT TERM
  echo "DEPLOY_FAILED: restoring available archived application images. Backup: $backup" >&2
  if (( ${#rollback_services[@]} )); then
    docker image load --input "$backup/images.tar" && \
      docker compose -f docker-compose.yml -f "$backup/rollback.yml" up -d --no-deps --no-build --pull never "${rollback_services[@]}" || {
        echo "ROLLBACK_INCOMPLETE: inspect services and $backup" >&2; exit 1;
      }
    echo 'Archived images restored; verify HTTP health.' >&2
  else
    echo 'No previous images were available. New containers remain for diagnosis.' >&2
  fi
  exit 1
}
trap rollback ERR INT TERM
"${dc[@]}" up -d --no-deps --no-build --pull never api gsp-web
ready=0
for attempt in $(seq 1 30); do
  if "${dc[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/health", {signal: AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
    && "${dc[@]}" exec -T gsp-web wget -q -T 3 -O /dev/null http://127.0.0.1/api/health; then
    ready=1; break
  fi
  sleep 2
done
[[ "$ready" == 1 ]]
binding=$("${dc[@]}" port gsp-web 80 | head -n 1)
web_port=${binding##*:}
# Check both SPA routing and the nginx -> API path through the published port.
for path in / /dashboard/tools /dashboard/subscription /copy-trading /api/health; do
  curl --fail --silent --show-error --connect-timeout 3 --max-time 8 -o /dev/null "http://127.0.0.1:$web_port$path"
done
trap - ERR INT TERM
echo "PLATFORM_HTTP_OK: web and API respond on port $web_port."
echo "BACKUP=$backup"
# RPC readiness is reported separately. A 403 or 429 must not take the website down.
if "${dc[@]}" exec -T api node -e 'fetch("http://127.0.0.1:4000/health/ready", {signal: AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
  echo 'TRADING_DEPENDENCIES_READY: review the actual trading mode and feature switches in Admin.'
else
  echo 'TRADING_DEPENDENCIES_NOT_READY: website is up; inspect Admin connection diagnostics. No trading-mode or feature setting was changed.'
fi
"${dc[@]}" ps -a api gsp-web postgres redis
