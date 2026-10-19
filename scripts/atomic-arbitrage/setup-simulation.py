#!/usr/bin/env python3
"""Configure the installed isolated runner and run ONE unsigned simulation.

No account creation, transfers, private-key reads, execution approvals, global
Nova settings, trading activation, daemon or automatic retry. Run as root on the
operator's own VPS. Secrets are entered at the terminal, never as CLI arguments.
"""
from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

CONFIG = Path('/etc/moneyland-arbitrage.env')
RUNNER = Path('/usr/local/bin/moneyland-arbitrage')
HALT = Path('/var/lib/moneyland-arbitrage/HALT')
GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
MAX_CONFIG = 65_536


class Blocked(Exception):
    """A public error code, never a provider exception containing secrets."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise Blocked(code)


def parse_env(text: str) -> dict[str, str]:
    """Docker env-file syntax, not shell code; never source or evaluate values."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        require(match is not None, 'CONFIG_FORMAT')
        key, value = match.groups()
        require(key not in result, 'DUPLICATE_CONFIG_KEY')
        require('\x00' not in value, 'CONFIG_FORMAT')
        result[key] = value
    return result


def owner_address(value: str) -> str:
    value = value.strip()
    require(bool(re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', value)), 'INVALID_PUBLIC_OWNER')
    number = 0
    for char in value:
        number = number * 58 + BASE58.index(char)
    leading = len(value) - len(value.lstrip('1'))
    decoded = b'\0' * leading + number.to_bytes((number.bit_length() + 7) // 8, 'big')
    require(len(decoded) == 32 and any(decoded), 'INVALID_PUBLIC_OWNER')
    # The runner separately enforces an on-curve, non-program owner via the SDK.
    return value


def rpc_url(value: str) -> str:
    value = value.strip()
    require(0 < len(value) <= 4096 and all(32 < ord(c) < 127 for c in value), 'INVALID_RPC_URL')
    try:
        url = urlsplit(value)
        valid = url.scheme == 'https' and bool(url.hostname) and not url.username and not url.password and not url.fragment
        _ = url.port  # Validates malformed port numbers without exposing the URL.
    except ValueError:
        valid = False
    require(valid, 'RPC_HTTPS_REQUIRED')
    return value


def api_key(value: str) -> str:
    value = value.strip()
    require(len(value) <= 4096 and all(32 < ord(c) < 127 for c in value), 'INVALID_API_KEY')
    return value


def check_initial(config: dict[str, str]) -> None:
    require(config.get('ARB_MODE', 'off') in ('off', 'simulate'), 'EXISTING_LIVE_CONFIG_REVIEW_REQUIRED')
    require(not config.get('ARB_KEYPAIR_FILE') and not config.get('ARB_APPROVAL_FILE'), 'EXISTING_SIGNER_CONFIG_REVIEW_REQUIRED')
    require(config.get('ARB_STATE_DIR', '/state') == '/state', 'CUSTOM_STATE_DIRECTORY_REVIEW_REQUIRED')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        raise Blocked('RPC_REDIRECT_BLOCKED')


def probe_rpc(url: str) -> None:
    """Only a read-only getGenesisHash request. No transaction is constructed."""
    payload = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'getGenesisHash', 'params': []}).encode()
    request = Request(url, data=payload, headers={'Content-Type': 'application/json'}, method='POST')
    # Do not pass a credential-bearing RPC URL to an environment-supplied proxy.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            body = response.read(MAX_CONFIG + 1)
        require(len(body) <= MAX_CONFIG, 'RPC_RESPONSE_TOO_LARGE')
        data = json.loads(body)
        require(isinstance(data, dict) and data.get('id') == 1 and 'error' not in data, 'RPC_PROBE_FAILED')
        require(data.get('result') == GENESIS, 'WRONG_NETWORK')
    except HTTPError as exc:
        raise Blocked('RPC_HTTP_' + str(exc.code)) from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise Blocked('RPC_PROBE_FAILED') from None


def read_secure(file: Path) -> bytes:
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'UNSAFE_CONFIG_FILE')
        require(metadata.st_uid == os.geteuid() and metadata.st_mode & 0o077 == 0, 'INSECURE_CONFIG_PERMISSIONS')
        data = stream.read(MAX_CONFIG + 1)
        require(len(data) <= MAX_CONFIG, 'CONFIG_TOO_LARGE')
        return data


def render_config(original: str, owner: str, rpc: str, key: str) -> str:
    existing = parse_env(original)
    check_initial(existing)
    updates = {
        'ARB_MODE': 'simulate', 'ARB_OWNER': owner_address(owner),
        'ARB_RPC_URL': rpc_url(rpc), 'ARB_JUPITER_API_KEY': api_key(key),
        'ARB_KEYPAIR_FILE': '', 'ARB_APPROVAL_FILE': '',
    }
    lines = [line for line in original.splitlines() if line.split('=', 1)[0] not in updates]
    lines.extend(k + '=' + v for k, v in updates.items())
    return '\n'.join(lines) + '\n'


def write_atomic(file: Path, original: bytes, replacement: bytes) -> Path:
    """Private backup + atomic replacement; refuse concurrent changes."""
    require(read_secure(file) == original, 'CONFIG_CHANGED_RETRY')
    backup_fd, backup_name = tempfile.mkstemp(prefix=file.name + '.before-sim.', dir=file.parent)
    with os.fdopen(backup_fd, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    fd, temp_name = tempfile.mkstemp(prefix='.' + file.name + '.', dir=file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(replacement)
            stream.flush()
            os.fsync(stream.fileno())
        require(read_secure(file) == original, 'CONFIG_CHANGED_RETRY')
        os.replace(temp_name, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return Path(backup_name)


def runner_call(command: str) -> dict[str, Any]:
    require(command in ('status', 'simulate'), 'READ_ONLY_COMMAND_REQUIRED')
    try:
        process = subprocess.run([str(RUNNER), command], capture_output=True, text=True, timeout=120, check=False)
    except subprocess.TimeoutExpired:
        raise Blocked('SIMULATION_TIMEOUT_REVIEW_LOCK') from None
    try:
        # Node may emit a native-bindings warning on stdout/stderr before JSON.
        output = process.stdout if process.returncode == 0 else process.stderr
        start = output.find('{')
        require(start >= 0, 'RUNNER_OUTPUT_UNAVAILABLE')
        report = json.loads(output[start:])
        require(isinstance(report, dict), 'RUNNER_OUTPUT_UNAVAILABLE')
        if process.returncode:
            code = report.get('code', '')
            raise Blocked(code if re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', str(code)) else 'RUNNER_FAILED')
        if command == 'status':
            require(report.get('component') == 'moneyland-atomic-arbitrage' and report.get('mode') == 'simulate'
                    and report.get('executionEnabled') is False and report.get('missing') == [], 'RUNNER_NOT_READY')
            return {'status': 'SIMULATION_CONFIGURED', 'executionEnabled': False}
        require(report.get('status') == 'SIMULATION_PASSED' and report.get('broadcast') is False, 'UNEXPECTED_SIMULATION_RESULT')
        # Shareable output deliberately excludes credentials, logs and URLs.
        safe: dict[str, Any] = {'status': 'SIMULATION_PASSED', 'broadcast': False}
        for field in ('amountLamports', 'minimumReturnLamports', 'conservativeNetLamports', 'feeLamports', 'computeUnits', 'bytes'):
            value = report.get(field)
            if type(value) is int or (isinstance(value, str) and re.fullmatch(r'[0-9]{1,25}', value)):
                safe[field] = value
        return safe
    except (ValueError, TypeError):
        raise Blocked('RUNNER_OUTPUT_UNAVAILABLE') from None


def main() -> int:
    require(os.geteuid() == 0, 'RUN_AS_ROOT_ON_VPS')
    require(sys.stdin.isatty(), 'INTERACTIVE_TERMINAL_REQUIRED')
    require(RUNNER.exists() and CONFIG.exists(), 'INSTALL_RUNNER_FIRST')
    require(not HALT.exists(), 'EMERGENCY_HALT')
    metadata = RUNNER.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_mode & 0o022 == 0
            and os.access(RUNNER, os.X_OK), 'UNTRUSTED_RUNNER_FILE')
    original = read_secure(CONFIG)
    existing = parse_env(original.decode('utf8'))
    check_initial(existing)
    print('Simulation setup only. Never paste a seed phrase or a private key.')
    print('Public RPC reads and one unsigned simulation; no transfer, approval or worker activation.')
    owner = owner_address(input('Dedicated Solana PUBLIC wallet address (Enter keeps existing): ').strip() or existing.get('ARB_OWNER', ''))
    rpc = rpc_url(getpass.getpass('HTTPS Solana MAINNET RPC URL (hidden; Enter keeps existing): ').strip() or existing.get('ARB_RPC_URL', ''))
    key = api_key(getpass.getpass('Jupiter API key (hidden; Enter keeps existing/blank): ').strip() or existing.get('ARB_JUPITER_API_KEY', ''))
    print('Checking RPC network without sending a transaction...')
    probe_rpc(rpc)
    replacement = render_config(original.decode('utf8'), owner, rpc, key).encode('utf8')
    require(not HALT.exists(), 'EMERGENCY_HALT')
    backup = write_atomic(CONFIG, original, replacement)
    print('RPC_MAINNET_OK. Private configuration saved; backup: ' + str(backup))
    print(json.dumps(runner_call('status'), indent=2))
    print('Running one unsigned simulation. No retry loop or trading activation.')
    print(json.dumps(runner_call('simulate'), indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, EOFError):
        print(json.dumps({'status': 'STOPPED', 'code': 'OPERATOR_CANCELLED', 'broadcast': False}))
        sys.exit(130)
    except Blocked as exc:
        print(json.dumps({'status': 'BLOCKED', 'code': str(exc), 'broadcast': False}))
        sys.exit(1)
    except Exception:
        # Never echo an OS/provider exception that may include an RPC secret.
        print(json.dumps({'status': 'BLOCKED', 'code': 'LOCAL_SETUP_FAILED', 'broadcast': False}))
        sys.exit(1)
