#!/usr/bin/env bash
# Install only the reviewed Solana public-address wallet UI. Never enable trading.
set -Eeuo pipefail
umask 077
APP_DIR=${NOVA_APP_DIR:-/opt/nova-solana-ai-sniper}
BACKUP_ROOT=${NOVA_BACKUP_ROOT:-/var/backups/nova-wallet-ui}
RELEASE=189e5a36a1fea717a99d4e2168d4e5c0071b3b10
BRANCH=codex/fix-nova-wallet-connect-20261022
fail() { printf 'NOVA_WALLET_ERROR=%s\n' "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || fail 'Run this installer as root.'
for tool in git docker curl tar flock sha256sum; do
  command -v "$tool" >/dev/null || fail "Missing command: $tool"
done
[[ -d "$APP_DIR/.git" && -f "$APP_DIR/.env" ]] || fail 'Repository or saved .env missing.'
cd "$APP_DIR"
mkdir -p "$BACKUP_ROOT"
exec 9>"$BACKUP_ROOT/install.lock"
flock -n 9 || fail 'Another wallet deployment is in progress.'
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail 'Tracked local changes exist; nothing was overwritten.'
previous=$(git rev-parse HEAD)
previous_branch=$(git symbolic-ref --quiet --short HEAD || true)
env_hash=$(sha256sum .env)
git fetch --no-tags origin "$BRANCH"
git cat-file -e "$RELEASE^{commit}"
git merge-base --is-ancestor "$RELEASE" FETCH_HEAD || fail 'Pinned release is not in the fetched branch.'
# Prevent replacing API, workers, Compose, contracts or migrations via checkout.
changed=$(git diff --name-only "$previous" "$RELEASE" -- .)
blocked=$(printf '%s\n' "$changed" | grep -Ev '^(apps/dashboard/.*|scripts/(install-wallet-ui|deploy-wallet-safe)\.sh)?$' || true)
[[ -z "$blocked" ]] || fail "Server checkout differs outside the UI scope; review required: $blocked"
git cat-file -e "$RELEASE:apps/dashboard/src/components/MobileWalletActions.tsx"
docker compose -f docker-compose.yml config --quiet
cid=$(docker compose -f docker-compose.yml ps -q gsp-web)
[[ -n "$cid" && "$cid" != *$'\n'* ]] || fail 'Expected one existing gsp-web container.'
[[ $(docker inspect -f '{{.State.Running}}' "$cid") == true ]] || fail 'Existing gsp-web is not running.'
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid")
config_files=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid")
[[ -n "$project" && "$project" != '<no value>' ]] || fail 'Missing Compose project label.'
[[ "$config_files" == "$APP_DIR/docker-compose.yml" ]] || fail 'Active service uses custom Compose files; refusing to discard them.'
old_image=$(docker inspect -f '{{.Image}}' "$cid")
port=$(docker port "$cid" 80/tcp | awk -F: 'NR==1 {print $NF}')
[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || fail 'Could not determine the existing web port.'
backup=$(mktemp -d "$BACKUP_ROOT/release-XXXXXXXX")
printf '%s\n' "$previous" > "$backup/previous-commit"
printf '%s\n' "$previous_branch" > "$backup/previous-branch"
printf '%s\n' "$RELEASE" > "$backup/release-commit"
cp -a .env docker-compose.yml "$backup/"
docker compose -f docker-compose.yml config --format json > "$backup/compose.json"
old_tag="nova-wallet-rollback:$(basename "$backup")"
new_tag="nova-wallet-ui:$RELEASE"
docker image tag "$old_image" "$old_tag"
printf '{"services":{"gsp-web":{"image":"%s"}}}\n' "$old_tag" > "$backup/rollback.json"
printf '{"services":{"gsp-web":{"image":"%s"}}}\n' "$new_tag" > "$backup/release.json"
printf 'NOVA_BACKUP=%s\n' "$backup"
switched=0
replaced=0
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    set +e
    if (( switched )); then
      if [[ -n "$previous_branch" && $(git rev-parse "$previous_branch" 2>/dev/null) == "$previous" ]]; then
        git switch "$previous_branch"
      else
        git switch --detach "$previous"
      fi
    fi
    if (( replaced )); then
      if docker compose -p "$project" --project-directory "$APP_DIR" -f "$backup/compose.json" -f "$backup/rollback.json" up -d --no-deps --no-build --pull never gsp-web; then
        printf 'NOVA_ROLLBACK_CONTAINER_RESTORED=%s\n' "$old_image"
      else
        printf 'NOVA_ROLLBACK_FAILED=Inspect %s before retrying\n' "$backup" >&2
      fi
    fi
    printf 'NOVA_INSTALL_FAILED_BACKUP=%s\n' "$backup" >&2
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Build from a clean, exact snapshot before touching the running web service.
mkdir "$backup/source"
git archive "$RELEASE" | tar -x -C "$backup/source"
docker build --label "org.opencontainers.image.revision=$RELEASE" -t "$new_tag" -f "$backup/source/apps/dashboard/Dockerfile" "$backup/source"
[[ $(sha256sum .env) == "$env_hash" ]] || fail '.env changed during build; stopping without overwriting it.'
[[ $(git rev-parse HEAD) == "$previous" ]] || fail 'Checkout changed during build.'
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail 'Local edits appeared during build.'
switched=1
git switch --detach "$RELEASE"
docker compose -p "$project" -f docker-compose.yml -f "$backup/release.json" config --quiet
replaced=1
docker compose -p "$project" -f docker-compose.yml -f "$backup/release.json" up -d --no-deps --no-build --pull never gsp-web
ready=0
for _ in $(seq 1 15); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$port/" -o "$backup/index.html" && grep -qi 'Moneyland' "$backup/index.html"; then
    ready=1
    break
  fi
  sleep 2
done
[[ $ready == 1 ]] || fail 'Frontend did not become healthy; restoring previous image.'
asset=$(sed -nE 's/.*src="(\/assets\/[^" ]+\.js)".*/\1/p' "$backup/index.html" | head -1)
[[ -n "$asset" ]] || fail 'Built JavaScript entry point was not found.'
curl -fsS --max-time 10 "http://127.0.0.1:$port$asset" -o "$backup/entry.js"
[[ -s "$backup/entry.js" ]] || fail 'JavaScript entry point was empty.'
[[ $(sha256sum .env) == "$env_hash" ]] || fail '.env changed unexpectedly.'
for path in /api/health /api/health/ready; do
  code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$path" 2>/dev/null) || code=unreachable
  printf 'NOVA_BACKEND_STATUS[%s]=%s\n' "$path" "$code"
done
printf 'NOVA_WALLET_UI_INSTALLED\nRELEASE=%s\nBACKUP=%s\n' "$RELEASE" "$backup"
printf 'SCOPE=Web UI only; API, database, keys, Nginx and trading flags unchanged.\n'
printf 'NEXT=Test wallet approval and rejection on https://moneyland.tr in the wallet browser.\n'
