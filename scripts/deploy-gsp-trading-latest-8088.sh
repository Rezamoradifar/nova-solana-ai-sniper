#!/usr/bin/env bash
# Compatibility entry point. Deploy the checked-out revision and existing port.
# Do not reset Git, overwrite .env, or remove the site's legacy proxy.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$script_dir/deploy-platform.sh" "${1:-$(pwd)}"
