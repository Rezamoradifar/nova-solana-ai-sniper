#!/usr/bin/env bash
# Bootstraps the first Let's Encrypt certificate for docker-compose's nginx service.
#
# Why this script exists: docker/nginx/default.conf.template references a cert that doesn't
# exist yet on a brand-new server, so nginx would crash-loop before certbot ever
# gets a chance to run. This script issues a throwaway self-signed cert first so
# nginx can start, then requests the real certificate from Let's Encrypt via the
# HTTP-01 webroot challenge, then restarts nginx to pick it up.
#
# Usage: ./scripts/init-letsencrypt.sh your-domain.example you@example.com
set -euo pipefail

DOMAIN="${1:?Usage: $0 <domain> <email>}"
EMAIL="${2:?Usage: $0 <domain> <email>}"
COMPOSE="docker compose"

LIVE_PATH="./data/certbot/conf/live/${DOMAIN}"

set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}
echo "==> Writing DOMAIN and MINIAPP_URL to .env"
set_env DOMAIN "$DOMAIN"
set_env MINIAPP_URL "https://${DOMAIN}/app/"

if [ ! -d "$LIVE_PATH" ]; then
  echo "==> Creating a dummy self-signed certificate so nginx can boot"
  mkdir -p "$LIVE_PATH"
  docker run --rm -v "$(pwd)/data/certbot/conf:/etc/letsencrypt" alpine/openssl \
    req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" \
    -out "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" \
    -subj "/CN=${DOMAIN}"
fi

echo "==> Starting nginx with the dummy certificate"
$COMPOSE up -d nginx

echo "==> Deleting dummy certificate so certbot can request the real one"
docker run --rm -v "$(pwd)/data/certbot/conf:/etc/letsencrypt" alpine \
  rm -rf "/etc/letsencrypt/live/${DOMAIN}" "/etc/letsencrypt/archive/${DOMAIN}" "/etc/letsencrypt/renewal/${DOMAIN}.conf"

echo "==> Requesting the real certificate from Let's Encrypt"
docker run --rm \
  -v "$(pwd)/data/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/data/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  --email "$EMAIL" -d "$DOMAIN" --agree-tos --no-eff-email

echo "==> Reloading nginx with the real certificate"
$COMPOSE restart nginx

echo "==> Starting certificate auto-renewal and restarting the bot so it shows the Mini App"
$COMPOSE up -d certbot
$COMPOSE up -d --force-recreate telegram-bot

echo "Done. Mini App: https://${DOMAIN}/app/"
