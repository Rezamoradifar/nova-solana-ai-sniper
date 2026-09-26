# Installation & Deployment Guide

## Prerequisites

- Node.js >= 20
- PostgreSQL (14+ recommended)
- Redis
- For production: a Linux VPS with either PM2 or Docker + Docker Compose,
  and (for real TLS) a domain name with DNS already pointed at the server

## 1. Local development

```bash
git clone <this-repo>
cd nova-solana-ai-sniper
npm install
cp .env.example .env
```

Edit `.env` — at minimum set `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`
(>= 16 chars), and `ENCRYPTION_KEY` (>= 32 chars). Everything else is
optional; unconfigured integrations disable themselves with a warning log.

```bash
npm run prisma:migrate     # applies every migration to your local DB
npm run dev:api              # Fastify API + background workers, port 4000
npm run dev:bot                # Telegram bot (needs TELEGRAM_BOT_TOKEN)
npm run dev:marketing           # AI marketing content engine
npm run dev:dashboard             # Vite dev server, port 5173
```

The dashboard dev server proxies API calls to `VITE_API_BASE_URL`
(`apps/dashboard/.env.example`, default `http://localhost:4000`).

## 2. Running the test suite

```bash
npm run build          # build every workspace — verifies dist matches src
npm run typecheck       # tsc --noEmit, every workspace
npm run lint             # ESLint
npm run test               # Vitest — full suite
```

## 3. Production deployment — Docker Compose

```bash
cp .env.example .env     # fill in real secrets
docker compose up -d postgres redis
docker compose run --rm migrate
docker compose up -d api telegram-bot marketing-engine
```

Each service uses `restart: unless-stopped` plus a `healthcheck` block — PM2
is not run a second time inside these containers.

### Nginx + TLS (Docker path)

`docker/nginx/default.conf.template` expects a real domain and an existing Let's
Encrypt certificate, neither of which exists on a fresh server. Bootstrap
both with:

```bash
./scripts/init-letsencrypt.sh your-domain.example you@example.com
docker compose up -d nginx certbot
```

This issues a throwaway self-signed certificate so Nginx can boot, requests
the real certificate via the HTTP-01 webroot challenge, then reloads Nginx.
The `certbot` service renews it automatically afterwards.

## 4. Production deployment — bare-metal / PM2

```bash
npm install
npm run build
npm run prisma:deploy        # applies migrations, non-interactive
pm2 start ecosystem.config.cjs
pm2 save
```

`ecosystem.config.cjs` supervises `nova-api`, `nova-telegram-bot`, and
`nova-marketing-engine`, each preloading the repo-root `.env` via
`-r dotenv/config`, with automatic restart, a memory cap, and backoff on
crash-looping. `nova-telegram-bot` / `nova-marketing-engine` exit cleanly
(code 0) rather than crash-looping when their required credentials aren't
configured.

**After any code change:** `npm run build` must be re-run and the affected
PM2 process restarted (`pm2 restart nova-api`) — PM2 runs the compiled
`dist/` output, not the TypeScript source directly, so a rebuild is not
automatic.

### Nginx + TLS (bare-metal path)

1. Build the dashboard: `npm run build --workspace apps/dashboard` (or set
   `VITE_API_BASE_URL=/api` explicitly for a relative, domain-agnostic API
   base — recommended so the same build works regardless of which domain
   ends up pointed at the server).
2. Copy the build output to a path Nginx's worker user (`www-data`) can
   read — **not** a path under `/root`, which is `0700` by default:
   ```bash
   mkdir -p /var/www/nova-dashboard
   rsync -a --delete apps/dashboard/dist/ /var/www/nova-dashboard/
   chown -R www-data:www-data /var/www/nova-dashboard
   ```
3. Create an Nginx site (adapt `docker/nginx/default.conf.template`'s convention —
   `/api/` proxied to `127.0.0.1:4000` with the prefix stripped, everything
   else served from `/var/www/nova-dashboard` with SPA fallback):
   ```nginx
   server {
       listen 80;
       server_name your-domain.example;

       location /.well-known/acme-challenge/ { root /var/www/certbot; }

       location /api/ {
           proxy_pass http://127.0.0.1:4000/;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }

       location / {
           root /var/www/nova-dashboard;
           try_files $uri $uri/ /index.html;
       }
   }
   ```
4. Once DNS for the real domain resolves to this server:
   ```bash
   certbot --nginx -d your-domain.example
   ```
   Certbot rewrites the site file in place to add the 443/TLS block and the
   80→443 redirect, and installs its own renewal timer.
5. **Firewall the raw application ports** — the API and any dashboard dev
   server must never be directly internet-reachable; only Nginx (80/443)
   and SSH should accept external connections:
   ```bash
   iptables -I INPUT -p tcp --dport 4000 -i lo -j ACCEPT
   iptables -A INPUT -p tcp --dport 4000 ! -i lo -j DROP
   # repeat for the dashboard dev server's port if it's ever run in production
   ```
   Install `iptables-persistent` (or your distribution's equivalent) so
   these rules survive a reboot.

## 5. Post-install checklist

- [ ] `NODE_ENV=production` in the deployed `.env`
- [ ] `LIVE_TRADING` set deliberately (`true` only once you intend real
      on-chain trades)
- [ ] `KILL_SWITCH=false` (the one flag that halts all trading instantly if
      flipped to `true`)
- [ ] `CORS_ORIGIN` matches the real dashboard origin
- [ ] A real TLS certificate is installed (not self-signed) once DNS is live
- [ ] Raw application ports are firewalled from external access
- [ ] `npm run build` output (`dist/`) is newer than every source file —
      verify before trusting a running process reflects current source
- [ ] `pm2 list` / `docker compose ps` shows no process in a crash-restart
      loop
