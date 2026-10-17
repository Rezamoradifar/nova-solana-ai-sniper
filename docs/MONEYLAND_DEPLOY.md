# Moneyland production-domain deployment

This release restyles the existing GSP TRADING/Nova site as an original blockchain operations console. It does not copy Tenderly logos, imagery, or code and it does not change trading or ledger logic.

- Domain: https://moneyland.tr
- VPS origin IPv4: 103.244.227.112
- Public frontend: Docker Compose service gsp-web on port 8088
- API: service api on port 4000, exposed by the frontend at /api/

## 1. Correct DNS_PROBE_FINISHED_NXDOMAIN

The domain registrar (where moneyland.tr was bought) must point its authoritative nameservers to the two values provided in the Cloudflare Overview page. Adding the zone to Cloudflare alone does not delegate it.

In the Cloudflare DNS records add:
- A / @ / 103.244.227.112 / DNS only (gray cloud)
- CNAME / www / moneyland.tr / DNS only (gray cloud)

Wait until Cloudflare reports Active. Check:
~~~
dig @1.1.1.1 moneyland.tr A +short
dig @1.1.1.1 www.moneyland.tr A +short
~~~
Both must resolve to 103.244.227.112 while DNS-only is active. Ensure inbound TCP 80 and TCP 443 are allowed by the VPS provider firewall. No server-side React/Nginx change can fix NXDOMAIN by itself.

## 2. Install the reviewed Moneyland release on the Nova VPS

Inspect any uncommitted changes first; do not hard-reset your existing working tree.

~~~bash
cd /opt/nova-solana-ai-sniper
git status --short
git fetch origin codex/moneyland-tenderly-inspired-20261017
git switch --detach origin/codex/moneyland-tenderly-inspired-20261017
bash scripts/deploy-moneyland.sh
~~~

The deployment script rebuilds the GSP frontend, checks the website and API, verifies both public DNS records, installs a dedicated host Nginx reverse proxy, obtains a Let's Encrypt certificate and HTTPS redirect, then sets CORS_ORIGIN=https://moneyland.tr and restricts frontend port 8088 to 127.0.0.1. It preserves PostgreSQL, Redis, wallets, balances, keys and existing trading settings. It refuses to restart the API while LIVE_TRADING=true.

If DNS does not yet resolve, it stops after rebuilding the website without attempting to issue SSL.

Do not use an auto port detector: the actual public site is on port 8088 and the API is proxied through that site.

## 3. Finish Cloudflare

When the script prints MONEYLAND_ORIGIN_OK, switch both DNS records to Proxied (orange cloud). Under SSL/TLS -> Overview select Full (strict), not Flexible.

Check:
~~~bash
curl -fsSI https://moneyland.tr/
curl -fsSI https://www.moneyland.tr/
curl -fsS https://moneyland.tr/api/health
~~~

Verify the market feed, responsive navigation, arbitrage, GMGN tools, executions, copy-trading, wallet and Telegram pages. Public market values are sourced from the API and may be temporarily unavailable. The visual network topology is deliberately marked as illustrative, not as a filled trade or profit claim.

Only declare production online once HTTPS and API health both succeed.
