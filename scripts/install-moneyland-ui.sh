#!/usr/bin/env bash
# Safe UI-only install from GitHub on the existing Nova VPS.
# Does not alter .env, API, databases, wallets, keys, or trading configuration.
# Does not require moneyland.tr DNS. Domain and HTTPS are separate steps.
set -Eeuo pipefail

APP_DIR=/opt/nova-solana-ai-sniper
BRANCH=codex/nova-fresh-vps-recovery-20261017
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

test -d "$APP_DIR/.git" || fail "Missing git checkout: $APP_DIR"
cd "$APP_DIR"
command -v git >/dev/null || fail 'Git is missing.'
command -v docker >/dev/null || fail 'Docker is missing.'
command -v curl >/dev/null || fail 'curl is missing.'
docker compose version >/dev/null || fail 'Docker Compose v2 is missing.'
docker info >/dev/null 2>&1 || fail 'Docker daemon not accessible.'
test -f .env || fail 'Nova .env is missing. Restore existing settings first.'

# Refuse implicit overwrites to tracked, uncommitted server changes.
if test -n "$(git status --porcelain --untracked-files=no)"; then
  git status --short >&2
  fail 'Local tracked changes found. Review them before installing.'
fi

step "Fetching $BRANCH from GitHub"
git fetch --no-tags origin "$BRANCH"
release="$(git rev-parse --verify FETCH_HEAD^{commit})"
git cat-file -e "$release:apps/dashboard/src/neon/Home.tsx" 2>/dev/null ||
  fail 'Fetched source is not Moneyland Neon 2.0.'
git cat-file -e "$release:apps/dashboard/src/moneyland-v2/core.tsx" 2>/dev/null ||
  fail 'Moneyland V2 compatibility files not found.'
previous="$(git rev-parse HEAD)"
if test "$previous" != "$release"; then
  git switch --detach "$release"
fi

step 'Validating and building ONLY the public website'
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build gsp-web
step 'Updating ONLY gsp-web (not API, trading bots, Postgres or Redis)'
docker compose -f docker-compose.yml up -d --no-deps --no-build --force-recreate gsp-web

port="$(sed -nE 's/^GSP_WEB_PORT=([0-9]+)$/\1/p' .env | tail -1)"
port="$(printf '%s' "$port" | sed 's/^$/8088/')"
ready=0
for n in $(seq 1 20); do
  if curl -fsS --max-time 4 "http://127.0.0.1:$port/" | grep -qi 'Moneyland'; then
    ready=1
    break
  fi
  sleep 2
done
if test "$ready" != 1; then
  docker compose ps gsp-web >&2 || true
  docker compose logs --tail=60 gsp-web >&2 || true
  fail 'UI did not pass local HTTP check; backend and funds were not touched.'
fi

if curl -fsS --max-time 6 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
  api='OK'
else
  api='NOT VERIFIED'
fi
docker compose ps gsp-web api
printf '\nMONEYLAND_UI_OK\n'
printf 'Installed commit: %s\n' "$release"
printf 'Previous commit: %s\n' "$previous"
printf 'Local website: http://127.0.0.1:%s/\n' "$port"
printf 'Existing API health: %s\n' "$api"
printf 'Domain setup: still requires working DNS and origin HTTPS.\n'
