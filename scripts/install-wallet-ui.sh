#!/usr/bin/env bash
# UI-only wallet connector rollout for the existing moneyland.tr Nova VPS.
# Does not change .env, trading workers, API, Redis, Postgres or wallet keys.
set -Eeuo pipefail

APP_DIR=/opt/nova-solana-ai-sniper
RELEASE_BRANCH=codex/fix-nova-wallet-connect-20261022
BASE_SHA=2121d5a26bb5a53326fc45f1c6a346679ed32a73

fail() { echo "NOVA_WALLET_UI_ERROR: $*" >&2; exit 1; }
test -d "$APP_DIR/.git" || fail "Missing repository at $APP_DIR"
cd "$APP_DIR"
test -f .env || fail ".env not found; do not proceed without the saved server configuration"
command -v docker >/dev/null || fail "Docker is not installed"
docker compose version >/dev/null || fail "Docker Compose V2 is required"
docker info >/dev/null 2>&1 || fail "Docker daemon unavailable"

if test -n "$(git status --porcelain --untracked-files=no)"; then
  git status --short >&2
  fail "Tracked local edits exist. Resolve them before changing the release checkout."
fi

previous="$(git rev-parse HEAD)"
echo "NOVA_PREVIOUS_COMMIT=$previous"
git fetch --no-tags origin "$RELEASE_BRANCH"
release="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
git cat-file -e "$release:apps/dashboard/src/components/MobileWalletActions.tsx" 2>/dev/null ||
  fail "Expected wallet UI module missing from release"
git cat-file -e "$release:apps/dashboard/src/lib/walletConnection.ts" 2>/dev/null ||
  fail "Wallet connection module missing from release"
git cat-file -e "$BASE_SHA^{commit}" 2>/dev/null ||
  fail "Expected approved release base missing"
git merge-base --is-ancestor "$BASE_SHA" "$release" ||
  fail "Wallet release is not based on the approved Moneyland build"

# Verify the patch cannot hide changes to trading code, API, or database schema.
blocked="$(git diff --name-only "$BASE_SHA" "$release" -- . |
  grep -Ev '^(apps/dashboard/src/(lib/(walletConnection(\.test)?\.ts|mobileWalletLinks(\.test)?\.ts)|components/MobileWalletActions\.(tsx|css)|moneyland-v2/core\.tsx|neon/ui\.tsx)|scripts/install-wallet-ui\.sh)$' || true)"
if test -n "$blocked"; then
  printf 'Unexpected paths in release:\n%s\n' "$blocked" >&2
  fail "Release contains changes outside the approved public wallet UI scope"
fi

echo "NOVA_WALLET_UI_RELEASE=$release"
if test "$previous" != "$release"; then
  git switch --detach "$release"
fi
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml build gsp-web
docker compose -f docker-compose.yml up -d --no-deps --no-build --force-recreate gsp-web

port="$(sed -nE 's/^GSP_WEB_PORT=([0-9]+)$/\1/p' .env | tail -1)"
port="${port:-8088}"
ready=0
for _ in $(seq 1 15); do
  if curl -fsS --max-time 4 "http://127.0.0.1:$port/" | grep -qi 'Moneyland'; then
    ready=1
    break
  fi
  sleep 2
done
if test "$ready" != 1; then
  docker compose -f docker-compose.yml ps gsp-web >&2 || true
  docker compose -f docker-compose.yml logs --tail=40 gsp-web >&2 || true
  fail "Frontend health check failed. Previous commit: $previous. Do not enable live trading."
fi
docker compose -f docker-compose.yml ps gsp-web api
echo "NOVA_WALLET_UI_OK"
echo "RELEASE=$release"
echo "PREVIOUS=$previous"
echo "TEST=Visit https://moneyland.tr and request a public-address wallet connection."
