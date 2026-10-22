#!/usr/bin/env python3
"""Install tested mainnet HTTP/WSS endpoints on a stopped Nova bootstrap.

The original env stop and PAPER modes remain on. Only the existing API image is
recreated. Live activation is a separate, explicitly gated operator step.
"""
import argparse
import fcntl
import getpass
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
from urllib.parse import urlsplit
import warnings

spec = importlib.util.spec_from_file_location('nova_rpc_copy_ops', Path(__file__).with_name('enable-live-copy-trading.py'))
copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(copy)
ops, Failure, require = copy.ops, copy.Failure, copy.require
OTHER_PROVIDERS = ('HELIUS_API_KEY', 'QUICKNODE_RPC_URL', 'QUICKNODE_WS_URL',
                   'CHAINSTACK_RPC_URL', 'ADDITIONAL_RPC_URLS')
TRANSIENT = {'API_NOT_READY', 'NETWORK_NOT_READY', 'SCANNER_UNHEALTHY_REPAIR_RPC_OR_WS',
             'SCANNER_BUYS_PAUSED', 'DEDICATED_MAINNET_RPC_NOT_READY'}


def validate_url(value, scheme):
    require(isinstance(value, str) and 1 <= len(value) <= 4096 and
            re.fullmatch(r"[\x21-\x7e]+", value) and not any(c in value for c in "'\"\\`"),
            'Invalid ' + scheme.upper() + ' endpoint; details redacted')
    try:
        parsed = urlsplit(value)
        port = parsed.port
        valid = (parsed.scheme == scheme and parsed.hostname and not parsed.username and
                 not parsed.password and not parsed.fragment and (port is None or 1 <= port <= 65535))
    except ValueError:
        valid = False
    require(valid, 'Use a complete ' + scheme + ':// provider endpoint; details redacted')
    require(parsed.hostname.lower() not in {'api.mainnet-beta.solana.com', 'api.mainnet.solana.com',
            'api.devnet.solana.com', 'api.testnet.solana.com'}, 'A dedicated mainnet provider is required')
    return value


def patch_rpc_env(data, http, ws):
    copy.require_bootstrap_modes(data)
    for key in OTHER_PROVIDERS:
        require(copy.scalar(data, key, '') == '', 'An existing provider setting requires review: ' + key)
    text = data.decode('utf-8')
    for key, value in [('SOLANA_RPC_URL', validate_url(http, 'https')),
                       ('SOLANA_WS_URL', validate_url(ws, 'wss'))]:
        copy.scalar(data, key)  # Reject duplicate/unusual input before writing.
        line = key + "='" + value + "'"
        pattern = r'(?m)^[ \t]*(?:export[ \t]+)?' + key + r'[ \t]*=[^\r\n]*'
        text, count = re.subn(pattern, lambda _: line, text)
        if not count:
            text = text.rstrip('\r\n') + '\n' + line + '\n'
    result = text.encode()
    copy.require_bootstrap_modes(result)
    return result


def prompt_endpoint(label, scheme):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            value = getpass.getpass(label + ' (hidden): ').strip()
    except (OSError, EOFError, getpass.GetPassWarning):
        raise Failure('A private interactive terminal is required; no endpoint was saved') from None
    return validate_url(value, scheme)


def require_stopped(result, allow_warming=False):
    boot, report, before = result['bootstrap'], result['report'], result['before']
    require(boot.get('marker') == '2026-10-17' and boot.get('envKillSwitch') is True and
            boot.get('redisKillSwitch') is False and boot.get('envLiveTrading') is False and
            boot.get('envPaperTrading') is True and boot.get('envCopyExecution') is False,
            'RPC setup requires the stopped fresh bootstrap; Redis/manual stops are preserved')
    require(boot.get('scannerAutoResumeEnabled') is True and
            boot.get('scannerPauseSource') in ('AUTOMATIC_OUTAGE', 'NOT_RECORDED'),
            'Manual scanner pause/auto-resume policy needs review; no change made')
    mode_ok = report.get('mode') == 'PAPER' or (allow_warming and report.get('mode') == 'UNKNOWN' and
              'API_NOT_READY' in report.get('blockers', []))
    require(mode_ok and report.get('otherAutoBuys') == 0 and
            report.get('activeCopyConfigs') == 0 and len(before) == 2 and
            all(row is None or row.get('enabled') is False for row in before),
            'RPC setup refuses active trading/configurations or admin activation flags')


class Installer(copy.Installer):
    def preflight(self):
        self.inspect_installation()
        copy.require_bootstrap_modes(self.original_env)
        require(copy.scalar(self.original_env, 'MINIAPP_URL', '') == '', 'Finish Mini App shutdown first')
        for key in OTHER_PROVIDERS:
            require(copy.scalar(self.original_env, key, '') == '', 'Existing provider requires review: ' + key)
        result = self.control('prepare')
        require_stopped(result)
        require(set(result['report']['blockers']) <= TRANSIENT | {'KILL_SWITCH_ACTIVE_OR_UNKNOWN'},
                'Repair the existing safety/limit/configuration blockers before RPC setup')
        self.before = result['before']
        http = prompt_endpoint('Solana MAINNET HTTPS endpoint', 'https')
        ws = prompt_endpoint('Solana MAINNET WSS endpoint', 'wss')
        self.patched_env = patch_rpc_env(self.original_env, http, ws)
        self.probe_candidate(http, ws)
        print('RPC preflight OK: mainnet HTTP and actual program-log delivery verified; PAPER and env stop stay on')

    def probe_candidate(self, http, ws):
        source = Path(__file__).with_name('diagnose-nova-copy.mjs').read_text()
        source += '\nconst candidate = ' + json.dumps({'http': http, 'ws': ws}) + ';\n'
        source += r'''
const limit = setTimeout(() => process.exit(2), 45000);
try {
  const {default: Socket} = await import('ws');
  const [checks, ws] = await Promise.all([
    Promise.all(['getGenesisHash','getSlot','getLatestBlockhash'].map(m=>checkRpc(candidate.http,m))),
    checkWs(candidate.ws, Socket, 15000)
  ]);
  console.log(JSON.stringify({checks, ws}));
} catch { console.log(JSON.stringify({failed: true})); }
finally { clearTimeout(limit); }
'''
        result = json.loads(ops.run(['docker', 'exec', '-i', '-w', '/repo', self.current_api()['id'],
                                    'node', '--input-type=module', '-', '--functions-only'],
                                   'Private candidate RPC probe', source))
        print('NOVA_RPC_CANDIDATE=' + json.dumps(result, separators=(',', ':')))
        checks = result.get('checks', [])
        require(len(checks) == 3 and all(c.get('status') == 'OK' for c in checks) and
                result.get('ws', {}).get('status') == 'LOGS_RECEIVED',
                'RPC_CANDIDATE_REJECTED: no file, service or mode change was made')

    def report_restore(self):
        print('Private backup: ' + str(self.backup))
        print('Restore command: ' + shlex.join(['python3', str(Path(__file__).resolve()),
              '--app-dir', str(self.app), '--restore', str(self.backup)]))

    def wait_ready(self, wait_seconds=180):
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                result = self.control('prepare')
            except (Failure, ValueError):
                result = None
            if result is not None:
                require_stopped(result, allow_warming=True)
                require(result['before'] == self.before, 'Admin flags changed during RPC setup')
                blockers = set(result['report']['blockers'])
                print('NOVA_RPC_VERIFY=' + json.dumps(result['report'], separators=(',', ':')))
                startup = {'COPY_BACKEND_NOT_COMPATIBLE'} if 'API_NOT_READY' in blockers else set()
                require(blockers <= TRANSIENT | {'KILL_SWITCH_ACTIVE_OR_UNKNOWN'} | startup,
                        'A safety/limit/configuration gate changed during RPC setup')
                if blockers == {'KILL_SWITCH_ACTIVE_OR_UNKNOWN'}:
                    return result
            require(time.monotonic() < deadline, 'RPC_SCANNER_NOT_READY: returning to the saved stopped environment')
            time.sleep(2)

    def apply(self):
        self.save()
        try:
            require(ops.read_file(self.app / '.env') == self.original_env,
                    'Environment changed during RPC probe; refusing to overwrite it')
            self.mutated = True
            ops.inplace(self.app / '.env', self.patched_env)
            self.recreate()
            self.wait_ready()
            require(self.other_ids() == self.before_ids, 'An unrelated container changed during RPC setup')
            require(self.current_api()['image'] == self.image, 'Existing API image changed')
            print('NOVA_COPY_RPC_READY=YES; PAPER retained; bootstrap env stop remains ON')
        except (Exception, KeyboardInterrupt):
            if self.mutated:
                try:
                    self.restore_state()
                    print('NOVA_RPC_ROLLED_BACK: original environment/image restored; Mini App remains disabled')
                except (Exception, KeyboardInterrupt):
                    print('NOVA_RPC_PARTIAL: use the printed private restore command; sensitive details withheld')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', default='/opt/nova-solana-ai-sniper')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--restore', metavar='BACKUP_DIR')
    args = parser.parse_args()
    os.umask(0o077)
    installer = Installer(args)
    try:
        if args.dry_run:
            if args.restore:
                installer.restore()
            else:
                installer.preflight()
                print('DRY RUN: candidate verified; no env, flag or container change')
        else:
            with open(installer.app / '.env.nova-ops.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.restore:
                    installer.restore()
                else:
                    installer.preflight()
                    installer.apply()
    except (Exception, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, Failure) else 'RPC setup failed; sensitive details withheld'
        print('ERROR: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
