# Deploy GSP Bank Sniper on the server IP

The current website target is **https://185.172.64.24:8443**. A domain is not required. This installer updates the website in an **existing, running Nova Docker Compose deployment**, adds the selected HTTPS listener, and gives the IP a publicly trusted HTTPS certificate.

The website keeps its separate sections:

| Address                                | Section                               |
| -------------------------------------- | ------------------------------------- |
| `https://185.172.64.24:8443/`          | GSP Bank Sniper home                  |
| `https://185.172.64.24:8443/tools`     | Website tools                         |
| `https://185.172.64.24:8443/arbitrage` | Public quote scanner                  |
| `https://185.172.64.24:8443/telegram`  | Telegram bot and its account sections |
| `https://185.172.64.24:8443/wallet`    | Connect a supported Solana wallet     |
| `https://185.172.64.24:8443/app/`      | Existing Telegram Mini App            |

These are deployment targets, not a claim that the server has already been updated. Run the installer in the **VPS terminal**, not on a different computer. This repository does not provide a remote login session or credentials.

## Run on the VPS

The server needs Docker Engine, Docker Compose v2, Python 3.8 or newer, Git, curl, tar, and systemd. Public TCP port **8443** must be available for the website, including in the hosting provider's firewall. The existing HTTP challenge route must remain publicly reachable on **port 80** for certificate issuance and renewal. The installer checks Docker port mappings and native listeners before changing nginx; Let's Encrypt independently checks public challenge reachability during issuance.

Use a separate checkout so the running repository and its `.env` stay in place:

```bash
GSP_IP_SOURCE="$(mktemp -d /tmp/gsp-ip.XXXXXX)" &&
git clone --depth 1 --single-branch --branch codex/gsp-bank-sniper-website \
  https://github.com/Rezamoradifar/nova-solana-ai-sniper.git "$GSP_IP_SOURCE" &&
sudo python3 "$GSP_IP_SOURCE/scripts/deploy_ip.py" --ip 185.172.64.24 --https-port 8443
```

Certbot asks for its account/contact information and terms in the terminal when required. Answer those prompts there. The script does not automatically accept its terms, supply an email address, or request any Telegram token, wallet secret, or application password.

If there is more than one Nova deployment on the server, add `--project-dir /actual/path/to/the/running/repository`. The path must belong to the existing deployment. Without an unambiguous match, the installer stops before changing containers.

On success it prints `READY: https://185.172.64.24:8443`, the deployment record, and an exact rollback command. The wallet page requires a supported wallet extension or wallet browser; establishing HTTPS alone does not test a particular user's wallet.

`--https-port` selects the public and internal TLS port together. The compatibility default is 443; the command above explicitly selects 8443. With an alternate port, the installer adds a dedicated TLS server and the matching `8443:8443` publication, explicitly bound to `0.0.0.0` for public IPv4 access. Existing port mappings and nginx server configurations are retained, including the port-80 ACME route. Those existing servers share the image's updated frontend assets. Use the full `https://IP:PORT` address; the old port-80 redirect is not changed to point to the alternate port. An existing alternate-port mapping limited to a specific host address requires review before the loopback-based validation can run.

## What the installer does

1. Identifies the running Nova nginx from Compose labels, checks the existing API liveness, and verifies an HTTP ACME challenge marker through that nginx.
2. Archives the reviewed Git commit into a clean build directory. Local `.env` files and untracked production data never enter the Docker build context.
3. Builds the updated dashboard and Mini App while the existing website and bot continue running.
4. Uses the pinned `certbot/certbot:v5.8.0` image to request an IP certificate with `--ip-address` and the `shortlived` profile.
5. Saves the previous nginx image and rendered configuration. It preserves named domain vhosts and the original certificate store, and adds an IPv4 default HTTPS vhost for the IP on the selected port.
6. Validates the candidate configuration in a temporary container without published ports or dependencies. Then it recreates **only nginx**, using `--no-deps --no-build --pull never`.
7. Checks trusted TLS, the home/tools/Telegram/wallet/Mini App routes, the JavaScript asset, and `/api/health` on the selected port. It rechecks the HTTP challenge on port 80 and, in default port-443 mode, verifies the HTTP redirect. It also checks that the other project container IDs did not change. These local checks do not establish whether an external firewall permits the selected port.
8. Installs and checks a host systemd timer for twice-daily certificate renewal. The host reloads nginx only after Certbot returns successfully and nginx configuration validation passes.

There can be a brief interruption to the website while nginx is replaced. A failure during cutover, validation, or renewal setup triggers restoration of the previous nginx image/configuration. The recovery record remains available if automatic rollback also fails.

The API, Telegram bot, database, Redis, migrations, and trading configuration are not redeployed. The public scanner still observes quotes; this deployment does not enable trade execution. A newly added API endpoint can remain unavailable on an older API until a separate backend deployment is performed.

## Certificates and renewal

Let's Encrypt IP certificates last **160 hours**, so unattended renewal is part of the installation. Certificates and their account/renewal files live under `/var/lib/gsp-bank-sniper-ip/185.172.64.24/certificates`, mounted in nginx as `/etc/letsencrypt-ip`. The whole directory is mounted so renewed `live` symlinks and `archive` files remain accessible.

This store is separate from the old Compose `certbot` service's store. That existing service does not manage the new IP certificate. The new host timer runs at 00:00 and 12:00 in the server's time zone, with up to ten minutes of delay, and retains the local Docker socket selected during installation.

```bash
sudo systemctl status gsp-ip-cert-185-172-64-24.timer --no-pager
sudo systemctl start gsp-ip-cert-185-172-64-24.service
sudo journalctl -u gsp-ip-cert-185-172-64-24.service -n 50 --no-pager
```

The service renews only when due, then validates and reloads nginx. Keep port 80 reachable for future HTTP-01 challenges. Do not delete the certificate directory or disable this timer while the IP certificate is in use.

Official references: [IP certificate availability and lifetime](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/), [Certbot IP/webroot setup and renewal](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/), [HTTP-01 port requirements](https://letsencrypt.org/docs/challenge-types/), and [Compose port merge rules](https://docs.docker.com/reference/compose-file/merge/).

## Recovery and later updates

Each installation has a private directory under `/var/lib/gsp-bank-sniper-ip/185.172.64.24/` containing its clean source, old/new nginx templates, Compose overrides, and `state.json`. Keep these files while that release or its rollback is needed. The terminal prints the exact command to restore the prior website. Restoring the old configuration may also restore its previous HTTPS behavior.

The running nginx's Compose labels record the added override. Use the full Compose file list, including that override, for later nginx changes; a plain `docker compose up -d` from the old source checkout can replace the new nginx configuration. Re-running this installer from an updated, reviewed checkout also discovers the active file list and creates a new recovery record. The IP certificate timer remains useful after a rollback and does not recreate containers.

For a customized nginx deployment (additional `.conf` files, conflicting explicit TLS defaults, mixed IP/domain names, or custom static/config mounts), the installer stops for configuration review. It does not overwrite those customizations, alter the firewall, delete certificates, or fall back to untrusted TLS. The original `scripts/init-letsencrypt.sh` is a separate domain bootstrap script and must not be used for this IP deployment.

## Local verification

```bash
python3 -m unittest discover -s scripts/tests -p 'test_ip_*.py' -v
```

These tests check configuration preservation, selected-port URLs and bindings, Docker/native port conflicts, safe service commands and rollback, renewal ordering, and challenge-file permissions. The actual container configuration and HTTPS are checked on the VPS before the installer reports success.
