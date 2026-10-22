#!/usr/bin/env python3
"""Activate the existing Nova live copy watcher without rebuilding or selecting wallets.

Requires a healthy scanner, dedicated mainnet RPC, existing safety controls, and
zero unrelated active auto-buy configs. Fails before mutation when these are absent.
"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location(
    'nova_miniapp_ops', Path(__file__).with_name('disable-telegram-miniapp.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
Failure, require, run = ops.Failure, ops.require, ops.run
ENV_FLAGS = {'LIVE_TRADING': 'true', 'PAPER_TRADING': 'false',
             'COPY_TRADING_EXECUTION_ENABLED': 'true'}


def patch_env(data):
    text = data.decode('utf-8')
    for key, value in ENV_FLAGS.items():
        pattern = r'(?m)^[ \t]*(?:export[ \t]+)?' + key + r'[ \t]*=[^\r\n]*'
        for match in re.finditer(pattern, text):
            old = match[0].split('=', 1)[1].strip()
            require(not old.startswith(('"', "'")) or old.count(old[0]) == 2,
                    'Unusual multiline mode flag; review .env before activation')
        text, count = re.subn(pattern, key + '=' + value, text)
        if not count:
            text = text.rstrip('\r\n') + '\n' + key + '=' + value + '\n'
    return text.encode()


class Installer:
    def __init__(self, args):
        self.args, self.app = args, Path(args.app_dir).resolve()
        self.backup = None
        self.project = ''
        self.helper = Path(__file__).with_name('nova-live-copy-control.mjs').read_text()
        self.mutated = False

    def current(self):
        return [c for c in ops.containers('label=com.docker.compose.project=' + self.project)
                if c['labels'].get('com.docker.compose.oneoff', '').lower() != 'true']

    def current_api(self):
        found = [c for c in self.current() if ops.service(c) == 'api' and c['running']]
        require(len(found) == 1, 'One running API container is required')
        return found[0]

    def other_ids(self):
        return sorted(c['id'] for c in self.current() if ops.service(c) != 'api')

    def compose(self, overlay=None):
        argv = ['docker', 'compose', '--project-directory', str(self.app),
                '--env-file', str(self.app / '.env'), '-p', self.project,
                '-f', str(self.app / 'docker-compose.yml')]
        return argv + (['-f', str(overlay)] if overlay else [])

    def control(self, action, payload=None, oneoff=False):
        tail = ['node', '--input-type=module', '-', action, json.dumps(payload or {})]
        argv = (self.compose(self.overlay) + ['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'api']
                if oneoff else ['docker', 'exec', '-i', self.current_api()['id']])
        return json.loads(run(argv + tail, 'Redacted copy-trading ' + action, self.helper))

    def preflight(self):
        require(not os.environ.get('COMPOSE_FILE'), 'Custom COMPOSE_FILE is unsupported')
        require(not any((self.app / p).exists() for p in (
            'compose.override.yaml', 'compose.override.yml',
            'docker-compose.override.yml', 'docker-compose.override.yaml')),
            'Custom Compose override is unsupported')
        remote = run(['git', '-C', str(self.app), 'remote', 'get-url', 'origin'],
                     'Nova repository check').strip()
        require(re.fullmatch(r'(?:https://github\.com/|git@github\.com:)'
                             r'Rezamoradifar/nova-solana-ai-sniper(?:\.git)?', remote),
                'Not the expected Nova repository')
        host = os.environ.get('DOCKER_HOST') or json.loads(run(
            ['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
            'Local Docker context check'))
        require(host.startswith('unix://'), 'Only the local Docker Unix socket is supported')
        self.original_env = ops.read_file(self.app / '.env')
        self.patched_env = patch_env(self.original_env)
        candidates = ops.containers('label=com.docker.compose.project.working_dir=' + str(self.app))
        projects = {c['labels'].get('com.docker.compose.project') for c in candidates}
        require(len(projects) == 1 and None not in projects, 'No unique local Compose project')
        self.project = projects.pop()
        require(re.fullmatch(r'[a-z0-9][a-z0-9_-]*', self.project), 'Unexpected Compose project name')
        for c in self.current():
            require(c['labels'].get('com.docker.compose.project.working_dir') == str(self.app)
                    and ops.official_compose_files(c, self.app),
                    'Custom Compose configuration detected; no financial changes made')
        api = self.current_api()
        self.image = api['image']
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', self.image), 'Immutable API image required')
        self.prior_compose = api['labels']['com.docker.compose.project.config_files'].split(',')
        self.before_ids = self.other_ids()
        result = self.control('prepare')
        print('COPY_PREFLIGHT=' + json.dumps(result['report'], separators=(',', ':')))
        require(result['report']['ok'], 'COPY_NOT_ACTIVATED: repair the reported blockers first')
        self.before = result['before']

    def save(self):
        base = self.app / 'data/copy-live-backups'
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not base.is_symlink() and base.stat().st_uid == os.getuid() and
                stat.S_IMODE(base.stat().st_mode) & 0o077 == 0,
                'Backup directory must be private and owned by this user')
        self.backup = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime()), dir=base))
        self.operation_id = str(uuid.uuid4())
        self.manifest = {
            'app_dir': str(self.app), 'project': self.project, 'image': self.image,
            'operationId': self.operation_id, 'before': self.before,
            'prior_compose': self.prior_compose,
            'env_before': ops.digest(self.original_env), 'env_after': ops.digest(self.patched_env),
        }
        for name, data in [('env', self.original_env),
                           ('manifest.json', (json.dumps(self.manifest, indent=2) + '\n').encode())]:
            target = self.backup / name
            target.write_bytes(data)
            target.chmod(0o600)
        self.overlay = self.backup / 'api-live-copy-override.json'
        self.overlay.write_text(json.dumps({
            'services': {'api': {'image': self.image, 'pull_policy': 'never'}}}) + '\n')
        self.overlay.chmod(0o600)
        # A retained image ID is also pinned by a private local tag. No pull/build.
        run(['docker', 'image', 'tag', self.image, 'nova-copy-preserved:' + self.operation_id],
            'Preserve current API image')
        self.report_restore()

    def report_restore(self):
        print('Private backup: ' + str(self.backup))
        print('Restore command: ' + shlex.join([
            'python3', str(Path(__file__).resolve()), '--app-dir', str(self.app),
            '--restore', str(self.backup)]))

    def recreate(self):
        argv = self.compose(self.overlay)
        run(argv + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                    '--force-recreate', 'api'], 'Recreate only the existing API image')

    def restore_state(self):
        current = ops.read_file(self.app / '.env')
        require(ops.digest(current) in (self.manifest['env_before'], self.manifest['env_after']),
                'Later .env edits exist; automatic rollback will not overwrite them')
        original = ops.read_file(self.backup / 'env')
        require(ops.digest(original) == self.manifest['env_before'], 'Saved environment digest mismatch')
        # Restore DB first via a one-off process using the exact preserved image.
        # It starts no workers and still works if the replaced API cannot boot.
        self.control('restore', self.manifest, oneoff=True)
        ops.inplace(self.app / '.env', original)
        # Pin the old image even if someone rebuilt its old mutable Compose tag.
        self.recreate()
        require(self.other_ids() == self.before_ids, 'An unrelated container changed during rollback')
        require(self.current_api()['image'] == self.image, 'Rollback image identity mismatch')
        for _ in range(18):
            try:
                run(['docker', 'exec', self.current_api()['id'], 'node', '-e',
                     "fetch('http://127.0.0.1:4000/health',{signal:AbortSignal.timeout(5000)})"
                     ".then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                    'Restored API liveness')
                return
            except Failure:
                time.sleep(2)
        raise Failure('Saved modes/flags restored, but API liveness still needs investigation')

    def apply(self):
        self.save()
        try:
            require(ops.read_file(self.app / '.env') == self.original_env,
                    'Environment changed during preflight; no activation attempted')
            self.mutated = True  # A lost helper response is reconciled via its DB journal.
            self.control('enable', self.manifest)
            ops.inplace(self.app / '.env', self.patched_env)
            self.recreate()
            result = None
            for attempt in range(18):
                try:
                    result = self.control('status')
                    if result['report']['ok']:
                        break
                except (Failure, ValueError):
                    pass
                time.sleep(2)
            require(result is not None and result['report']['ok'],
                    'Live watcher verification did not pass')
            require(self.other_ids() == self.before_ids, 'An unrelated container was replaced')
            require(self.current_api()['image'] == self.image, 'API image changed unexpectedly')
            print('NOVA_COPY_LIVE_READY=' + json.dumps(result['report'], separators=(',', ':')))
            print('Only existing user-approved copy configs can trade. No wallet or target was selected.')
            print('Activation permits bounded automatic trades; no on-chain transaction or profit was verified here.')
        except (Exception, KeyboardInterrupt):
            if self.mutated:
                try:
                    self.restore_state()
                    print('NOVA_COPY_ROLLED_BACK: saved modes/flags restored; Mini App remains disabled.')
                except (Exception, KeyboardInterrupt):
                    print('NOVA_COPY_PARTIAL: rollback needs the printed restore command; inspect API before retry.')
            raise

    def restore(self):
        host = os.environ.get('DOCKER_HOST') or json.loads(run(
            ['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
            'Local Docker context check'))
        require(host.startswith('unix://'), 'Restore requires a local Docker Unix socket')
        self.backup = Path(self.args.restore).resolve()
        require(self.backup.parent == self.app / 'data/copy-live-backups' and
                self.backup.stat().st_uid == os.getuid() and
                stat.S_IMODE(self.backup.stat().st_mode) & 0o077 == 0,
                'Restore directory must be a private backup from this installation')
        self.manifest = json.loads(ops.read_file(self.backup / 'manifest.json'))
        require(self.manifest['app_dir'] == str(self.app), 'Backup belongs to another app directory')
        self.project, self.image = self.manifest['project'], self.manifest['image']
        require(re.fullmatch(r'[a-z0-9][a-z0-9_-]*', self.project) and
                re.fullmatch(r'sha256:[0-9a-f]{64}', self.image), 'Invalid backup identity')
        self.overlay = self.backup / 'api-live-copy-override.json'
        require(json.loads(ops.read_file(self.overlay)) == {
            'services': {'api': {'image': self.image, 'pull_policy': 'never'}}},
            'Backup override changed')
        self.before_ids = self.other_ids()
        self.report_restore()
        if self.args.dry_run:
            print('DRY RUN: saved modes and these two flags would be restored; no transactions can be undone.')
        else:
            self.restore_state()
            print('NOVA_COPY_RESTORED: saved modes and flags restored; Mini App settings preserved.')


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
                print('DRY RUN: no env, DB feature, container, wallet, or trade change made.')
        else:
            with open(installer.app / '.env.nova-ops.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.restore:
                    installer.restore()
                else:
                    installer.preflight()
                    installer.apply()
    except (Exception, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, Failure) else 'Copy operation failed; sensitive details withheld'
        print('ERROR: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
