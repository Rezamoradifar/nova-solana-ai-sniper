#!/usr/bin/env bash
set -euo pipefail

cd "${1:-$(pwd)}"

BRANCH="codex/gsp-trading-latest-8088"
WEB_PORT="${GSP_WEB_PORT:-8088}"

echo "==> Updating to $BRANCH"
git fetch origin
git checkout -B "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

sed -i '/^GSP_WEB_PORT=/d' .env
printf '\nGSP_WEB_PORT=%s\n' "$WEB_PORT" >> .env

echo "==> Stopping/removing legacy website container only"
docker compose stop nginx 2>/dev/null || true
docker compose rm -f nginx 2>/dev/null || true

echo "==> Starting database dependencies"
docker compose up -d postgres redis

echo "==> Applying migrations"
docker compose build migrate
docker compose run --rm migrate

echo "==> Rebuilding latest API + GSP TRADING website"
docker compose build --no-cache api gsp-web

echo "==> Starting latest GSP TRADING"
docker compose up -d --force-recreate api gsp-web

echo "==> Status"
docker compose ps api gsp-web

echo "==> Port"
ss -lntp | grep ":${WEB_PORT}" || true

echo "==> Local website check"
curl -fsSI --max-time 10 "http://127.0.0.1:${WEB_PORT}/" | head

echo
echo "GSP TRADING latest is expected at: http://<SERVER-IP>:${WEB_PORT}"
