#!/usr/bin/env bash
# Deploy GSP TRADING's Moneyland frontend behind origin HTTPS on a fresh Nova VPS.
# Runs no database migration, restores no wallets, and never enables live trading.
set -Eeuo pipefail
umask 077

DOMAIN=moneyland.tr
ORIGIN_IP=103.244.227.112
APP_DIR=/opt/nova-solana-ai-sniper
WEB_PORT=8088

fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || fail 'Run as root: sudo bash scripts/deploy-moneyland.sh'
[[ -d "$APP_DIR" ]] || fail "Nova directory not found: $APP_DIR"
cd "$APP_DIR"
[[ -f docker-compose.yml && -f .env && -f apps/dashboard/src/moneyland.css ]] ||
  fail 'Expected new Moneyland release and existing .env are missing. Check out the reviewed Moneyland branch first.'
command -v docker >/dev/null || fail 'Docker is required.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
command -v curl >/dev/null || fail 'curl is required.'
if grep -Eqi '^LIVE_TRADING=(true|1)$' .env; then
  fail 'Live trading is enabled. Do not restart the API automatically during active money movement; arrange a maintenance window.'
fi

step 'Building the reviewed Moneyland web release (no database or wallet changes).'
docker compose -f docker-compose.yml up -d --build --no-deps gsp-web
for _ in $(seq 1 20); do
  if curl -fsS --max-time 4 "http://127.0.0.1:$WEB_PORT/" -o /tmp/moneyland-home.html; then break; fi
  sleep 2
done
[[ -s /tmp/moneyland-home.html ]] || fail "Site is not answering at http://127.0.0.1:$WEB_PORT/"
grep -q 'Moneyland | GSP TRADING' /tmp/moneyland-home.html ||
  fail 'Expected Moneyland index metadata not found. Confirm branch and dashboard build.'
rm -f /tmp/moneyland-home.html
curl -fsS --max-time 8 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null ||
  fail 'Web frontend is up, but its /api/health proxy failed. Fix API health before adding the public domain.'

step 'Checking public DNS before attempting an ACME certificate.'
command -v dig >/dev/null || { apt-get update -y && apt-get install -y dnsutils; }
for host in "$DOMAIN" "www.$DOMAIN"; do
  addresses="$(dig @1.1.1.1 "$host" A +short +time=3 +tries=2 || true)"
  if ! printf '%s\n' "$addresses" | grep -Fqx "$ORIGIN_IP"; then
    printf '\nPublic DNS for %s resolves as:\n%s\n' "$host" "$addresses"
    printf 'Authoritative NS records:\n'
    dig @1.1.1.1 "$DOMAIN" NS +short || true
    fail "DNS is not pointing directly to $ORIGIN_IP. Set Cloudflare A @ = $ORIGIN_IP and CNAME www = $DOMAIN (both DNS only). Make sure registrar nameservers match Cloudflare, then rerun."
  fi
done
if [[ -n "$(dig @1.1.1.1 "$DOMAIN" AAAA +short +time=3 +tries=1 || true)" ]]; then
  printf '\nWARNING: AAAA record exists. Verify that IPv6 reaches this same HTTPS origin.\n'
fi
step 'DNS resolved to the expected VPS address.'

step 'Installing host Nginx and Certbot.'
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx

# Never delete unrelated sites or Nginx server blocks.
cat >/etc/nginx/sites-available/moneyland.tr <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name moneyland.tr www.moneyland.tr;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 180;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/moneyland.tr /etc/nginx/sites-enabled/moneyland.tr
nginx -t || fail 'Nginx validation failed. Inspect existing config and port bindings.'
if ! systemctl enable --now nginx; then
  ss -ltnp | grep -E ':(80|443) ' || true
  fail 'Host Nginx could not start; check for an existing listener on 80/443. No existing service was stopped.'
fi
systemctl reload nginx
curl -fsS --max-time 8 -H "Host: $DOMAIN" http://127.0.0.1/ >/dev/null ||
  fail 'Nginx HTTP reverse proxy to port 8088 failed.'

step 'Issuing and installing the origin HTTPS certificate.'
certbot --nginx \
  -d "$DOMAIN" \
  -d "www.$DOMAIN" \
  --redirect \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email ||
  fail 'Certificate issue failed. Verify Cloudflare DNS-only mode, open inbound TCP 80/443, and check certbot logs.'

step 'Restricting the web container to localhost and updating CORS origin.'
python3 - "$APP_DIR/.env" <<'PY'
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
settings = {
    "CORS_ORIGIN": "https://moneyland.tr",
    "GSP_WEB_BIND_HOST": "127.0.0.1",
    "GSP_WEB_PORT": "8088",
}
lines = path.read_text().splitlines()
keep = [line for line in lines if not any(line.startswith(key + "=") for key in settings)]
keep.extend(key + "=" + value for key, value in settings.items())
path.write_text("\n".join(keep) + "\n")
os.chmod(path, 0o600)
PY

# Only the public API and web gateway are recreated; data stores are preserved.
docker compose -f docker-compose.yml up -d --no-deps --force-recreate api gsp-web

step 'Running local origin checks.'
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "http://127.0.0.1:$WEB_PORT/" >/dev/null &&
     curl -fsS --max-time 5 "http://127.0.0.1:$WEB_PORT/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" -eq 1 ]] || fail 'Frontend/API failed to recover after the origin change. Inspect docker compose logs.'
curl -fsSI --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" ||
  fail 'Origin HTTPS failed. Inspect Nginx, Certbot, and the domain certificate.'
nginx -t
docker compose -f docker-compose.yml ps api gsp-web

printf '\nMONEYLAND_ORIGIN_OK\n'
printf 'Domain: https://%s/\n' "$DOMAIN"
printf 'Origin IP: %s\n' "$ORIGIN_IP"
printf 'Reverse proxy: Nginx 443 -> localhost:8088 -> frontend/API\n'
printf 'CORS: https://%s\n' "$DOMAIN"
printf 'Container web port: localhost only\n'
printf 'Next: switch both Cloudflare DNS records to Proxied and use SSL/TLS Full (strict).\n'
