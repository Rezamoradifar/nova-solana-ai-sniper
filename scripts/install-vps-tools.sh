#!/usr/bin/env bash
# Install host tools only. Does not deploy Nova or enable trading.
set -Eeuo pipefail
trap 'printf "\nINSTALL_FAILED: line %s; do not continue to deployment.\n" "$LINENO" >&2' ERR
[[ $(id -u) -eq 0 ]] || { echo 'Run inside the VPS as root.' >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo 'Cannot detect the operating system.' >&2; exit 1; }
. /etc/os-release
case "$ID" in
  ubuntu) suite="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" ;;
  debian) suite="${VERSION_CODENAME:-}" ;;
  *) echo 'This installer supports Ubuntu and Debian only.' >&2; exit 1 ;;
esac
[[ -n "$suite" && -d /run/systemd/system ]] || { echo 'A standard systemd-based Ubuntu/Debian VPS is required.' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=180 update
apt-get -o DPkg::Lock::Timeout=180 install -y \
  ca-certificates curl git openssh-client openssl \
  python3 python3-venv build-essential pkg-config \
  jq nano unzip zip htop tmux rsync lsof iproute2 dnsutils

# Existing Docker installations are never replaced by this script.
if command -v docker >/dev/null 2>&1; then
  docker compose version >/dev/null 2>&1 || {
    echo 'Docker already exists without Compose. Stop here to avoid replacing an existing installation.' >&2
    exit 1
  }
else
  for package in docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc; do
    state="$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)"
    [[ "$state" != 'install ok installed' ]] || {
      echo "Conflicting package detected: $package. Nothing was removed; review it before installing Docker." >&2
      exit 1
    }
  done
  [[ ! -e /etc/apt/sources.list.d/docker.list && ! -e /etc/apt/sources.list.d/docker.sources ]] || {
    echo 'An existing Docker repository configuration was found; stop to avoid overwriting it.' >&2
    exit 1
  }
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 60 \
    "https://download.docker.com/linux/$ID/dists/$suite/Release" -o /dev/null
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 60 \
    "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $suite
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get -o DPkg::Lock::Timeout=180 update
  apt-get -o DPkg::Lock::Timeout=180 install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker
docker info >/dev/null
docker --version
docker compose version
docker buildx version
git --version
python3 --version
# A disposable connectivity/runtime test; no public ports are published.
docker run --rm hello-world
printf '\nNOVA_TOOLS_READY\n'
printf 'Host: %s | OS: %s\n' "$(hostname)" "$PRETTY_NAME"
printf 'Tools installed. Nova itself has not been deployed or activated.\n'
