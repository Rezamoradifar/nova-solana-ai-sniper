#!/usr/bin/env bash
# Isolated install: no checkout/reset of Nova, no API restart, no database, no funds.
set -Eeuo pipefail
umask 077
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || fail 'Run as root on the Nova VPS.'
[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'Pass the exact reviewed 40-character Git commit.'
release="$1"
repo=/opt/nova-solana-ai-sniper
dir="/opt/moneyland-arbitrage/releases/$release"
image="moneyland-arbitrage:$release"
command -v docker >/dev/null || fail 'Docker is missing.'
docker info >/dev/null
# Commit must already have been fetched via the known Nova GitHub connection.
git -C "$repo" cat-file -e "$release:scripts/atomic-arbitrage/engine.mjs"
[[ ! -e "$dir" ]] || fail 'Release directory already exists; use the existing runner or review before reinstalling.'
install -d -m 0755 "$dir"
git -C "$repo" archive "$release" | tar -xf - -C "$dir"
docker build --build-arg "RELEASE_SHA=$release" -f "$dir/scripts/atomic-arbitrage/Dockerfile" -t "$image" "$dir"
if [[ ! -e /etc/moneyland-arbitrage.env ]]; then
  install -m 0600 "$dir/scripts/atomic-arbitrage/config.env.example" /etc/moneyland-arbitrage.env
fi
install -d -m 0700 -o 1000 -g 1000 /var/lib/moneyland-arbitrage
install -d -m 0755 /etc/moneyland-arbitrage/secrets
# Do not overwrite any .env; do not schedule/start a persistent worker.
cat > /usr/local/bin/moneyland-arbitrage <<RUNNER
#!/usr/bin/env bash
set -Eeuo pipefail
exec docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \\
  --memory=512m --cpus=1 --pids-limit=128 --tmpfs /tmp:rw,noexec,nosuid,size=16m \\
  --env-file /etc/moneyland-arbitrage.env \\
  -v /var/lib/moneyland-arbitrage:/state \\
  -v /etc/moneyland-arbitrage/secrets:/run/secrets:ro \\
  "$image" "\$@"
RUNNER
chmod 0755 /usr/local/bin/moneyland-arbitrage
moneyland-arbitrage status
printf '\nARBITRAGE_RUNNER_INSTALLED_NO_TRADES\n'
printf 'Separate config: /etc/moneyland-arbitrage.env\n'
printf 'After public RPC and owner configuration in simulate mode: moneyland-arbitrage simulate\n'
printf 'Emergency stop: touch /var/lib/moneyland-arbitrage/HALT\n'
