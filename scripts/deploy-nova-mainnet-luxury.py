#!/usr/bin/env python3
"""Deploy reviewed API/web images, then optionally complete the existing mainnet bootstrap."""
import argparse
from contextlib import ExitStack
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location('nova_wallet_web', Path(__file__).with_name('deploy-nova-wallet-language.py'))
web = importlib.util.module_from_spec(spec)
spec.loader.exec_module(web)
ops, require, Failure = web.ops, web.require, web.Failure
TARGETS = ('api', 'gsp-web')
GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'


def merge_images(app, contexts, images):
    require(set(images) == set(TARGETS), 'Both API and web images must be pinned')
    services = {}
    for files in contexts:
        require(files and files[0] == str(app / 'docker-compose.yml'), 'Unexpected Compose base')
        for name in files[1:]:
            path = Path(name)
            require(path.is_absolute() and path.resolve() == path, 'Invalid installed overlay path')
            for service, fields in ops.image_overlay(ops.read_file(path)).items():
                if service in TARGETS:
                    continue
                require(service not in services or services[service] == fields,
                        'Conflicting image pins for an unrelated service; no change made')
                services[service] = fields
    for service, image in images.items():
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', image), 'Immutable image required')
        services[service] = {'image': image, 'pull_policy': 'never'}
    return {'services': services}


def public_json(base, path, allowed=(200,)):
    status, _headers, body = web.http(base, path)
    require(status in allowed, 'Public endpoint unavailable: ' + path.split('?')[0])
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        raise Failure('Invalid public JSON: ' + path.split('?')[0]) from None
    require(isinstance(value, dict), 'Invalid public response')
    return value


def mainnet_verified(value):
    return (value.get('mainnetVerified') is True and value.get('genesisHash') == GENESIS and
            value.get('chain') == 'solana' and value.get('cluster') == 'mainnet-beta' and
            value.get('status') == 'ready' and type(value.get('slot')) is int and value['slot'] > 0 and
            isinstance(value.get('checkedAt'), (int, float)) and
            -5000 <= time.time() * 1000 - value['checkedAt'] <= 45000)


def require_restore_images(rows, expected):
    require(set(expected) == set(TARGETS) and all(rows[s]['image'] == expected[s] for s in TARGETS),
            'A later API or web release is present; refusing to overwrite it')


class Installer(web.Installer):
    def verify_current_config(self, container, files):
        service = ops.service(container)
        require(service in TARGETS, 'Unexpected deployment service')
        result = ops.run(self.compose(files) + ['config', '--hash', service], 'Check live ' + service + ' Compose configuration')
        hashes = re.findall(r'\b[0-9a-f]{64}\b', result)
        require(hashes == [container['labels'].get('com.docker.compose.config-hash')],
                'Current ' + service + ' Compose inputs differ from the running service')

    def state(self):
        rows = [c for c in ops.containers('label=com.docker.compose.project=' + self.project)
                if c['labels'].get('com.docker.compose.oneoff', '').lower() != 'true']
        require(all(c['labels'].get('com.docker.compose.project.working_dir') == str(self.app) for c in rows),
                'Compose project contains a different installation')
        targets = {}
        for service in TARGETS:
            found = [c for c in rows if ops.service(c) == service]
            require(len(found) == 1, 'Expected one ' + service + ' container')
            targets[service] = found[0]
        return targets, sorted(c['id'] for c in rows if ops.service(c) not in TARGETS)

    def discover(self):
        remote = ops.run(['git', '-C', str(self.app), 'remote', 'get-url', 'origin'], 'Verify Nova source').strip()
        require(re.fullmatch(r'(?:https://github\.com/|git@github\.com:)Rezamoradifar/nova-solana-ai-sniper(?:\.git)?', remote),
                'Not the expected Nova repository')
        host = os.environ.get('DOCKER_HOST') or json.loads(ops.run(
            ['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], 'Check local Docker socket'))
        require(isinstance(host, str) and host.startswith('unix://'), 'Local Docker Unix socket required')
        super().discover()
        self.rows, self.protected = self.state()
        self.contexts = []
        for service, row in self.rows.items():
            require(row['running'], service + ' must be running before deployment')
            ops.verify_compose_files(row, self.app)
            files = row['labels']['com.docker.compose.project.config_files'].split(',')
            self.verify_current_config(row, files)
            self.contexts.append(files)
            self.file_hashes.update({name: ops.digest(ops.read_file(Path(name))) for name in files})

    def require_stopped(self):
        rows, _protected = self.state()
        script = "console.log(JSON.stringify({live:process.env.LIVE_TRADING,paper:process.env.PAPER_TRADING,copy:process.env.COPY_TRADING_EXECUTION_ENABLED}))"
        flags = json.loads(ops.run(['docker', 'exec', rows['api']['id'], 'node', '-e', script], 'Check stopped backend modes'))
        require(flags == {'live': 'false', 'paper': 'true', 'copy': 'false'},
                'API image replacement requires the existing stopped PAPER modes')

    def recreate_target(self, overlay, service):
        require(service in TARGETS, 'Unrelated service replacement refused')
        ops.run(self.compose([self.app / 'docker-compose.yml', overlay]) +
                ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', service],
                'Replace only ' + service)

    def wait_api(self):
        for _attempt in range(30):
            try:
                rows, _ids = self.state()
                ops.run(['docker', 'exec', rows['api']['id'], 'node', '-e',
                         "fetch('http://127.0.0.1:4000/health',{signal:AbortSignal.timeout(3000)})"
                         ".then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], 'Check API liveness')
                return
            except Failure:
                time.sleep(2)
        raise Failure('Replaced API did not become live')

    def replace(self, overlay):
        self.recreate_target(overlay, 'api')
        self.wait_api()
        # The installed nginx template resolves api at startup. Recreate web only
        # after the new API exists, so its upstream cannot retain the removed IP.
        self.recreate_target(overlay, 'gsp-web')

    def verify_public(self, release):
        for attempt in range(25):
            try:
                web.check_site(self.public, release)
                overview = public_json(self.public, '/api/public/solana/overview', (200, 503))
                require(overview.get('release') == release and overview.get('schemaVersion') == 1,
                        'Public API did not serve the reviewed release')
                require(overview.get('tradingMode') == 'PAPER', 'Backend mode changed during image replacement')
                copy = public_json(self.public, '/api/public/copy-trading')
                require(copy.get('executionMode') != 'live' and copy.get('liveExecutionEnabled') is False,
                        'Copy execution changed during image replacement')
                require(isinstance(copy.get('buyReadiness'), dict), 'Updated copy readiness API not available')
                return overview
            except Failure:
                if attempt == 24:
                    raise
                time.sleep(2)

    def build(self, source, service, release, identifier):
        name = 'api' if service == 'api' else 'web'
        tag = 'nova-mainnet-' + name + ':' + release + '-' + ops.digest(identifier.encode())[:8]
        args = ['docker', 'build', '--label', 'org.opencontainers.image.revision=' + release,
                '--build-arg', ('NOVA_SITE_RELEASE=' if service == 'api' else 'NOVA_WALLET_UI_RELEASE=') + release]
        if service == 'gsp-web':
            args += ['--label', 'tr.moneyland.walletconnect-project-id=' + identifier,
                     '--build-arg', 'VITE_WALLETCONNECT_PROJECT_ID=' + identifier]
        dockerfile = 'apps/api/Dockerfile' if service == 'api' else 'apps/dashboard/Dockerfile'
        print('Building reviewed ' + name + ' image; current services remain up.', flush=True)
        try:
            result = subprocess.run(args + ['-t', tag, '-f', str(source / dockerfile), str(source)], timeout=1800, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure(name + ' build could not complete; current images retained') from None
        require(result.returncode == 0, name + ' build failed; current images retained')
        return ops.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag], 'Pin reviewed ' + name + ' image').strip()

    def install(self):
        release = self.args.release
        require(release and re.fullmatch(r'[0-9a-f]{40}', release), 'Exact reviewed commit required')
        ops.run(['git', '-C', str(self.app), 'cat-file', '-e', release + ':apps/api/src/solana/mainnetGateway.ts'], 'Check mainnet source')
        self.discover()
        self.require_stopped()
        web.check_site(self.public)
        identifier = os.environ.get('NOVA_WALLETCONNECT_PROJECT_ID', '').strip() or ops.run(
            ['docker', 'image', 'inspect', '--format', '{{index .Config.Labels "tr.moneyland.walletconnect-project-id"}}',
             self.rows['gsp-web']['image']], 'Read installed public Reown identifier').strip()
        identifier = web.project_id(identifier)
        backup = Path(tempfile.mkdtemp(prefix='release-', dir=self.backup_root))
        print('NOVA_MAINNET_BACKUP=' + str(backup), flush=True)
        print('Restore command: ' + shlex.join([sys.executable, str(Path(__file__).resolve()), '--app-dir', str(self.app),
              '--public-url', self.public, '--restore', str(backup)]), flush=True)
        old = {service: row['image'] for service, row in self.rows.items()}
        for service, image in old.items():
            ops.run(['docker', 'image', 'tag', image, 'nova-mainnet-backup-' + service + ':' + backup.name], 'Retain old ' + service + ' image')
        archive = backup / 'source.tar'
        ops.run(['git', '-C', str(self.app), 'archive', '--format=tar', '--output=' + str(archive), release], 'Extract exact reviewed source')
        source = backup / 'source'; source.mkdir()
        ops.run(['tar', '-xf', str(archive), '-C', str(source)], 'Prepare isolated source')
        new = {service: self.build(source, service, release, identifier) for service in TARGETS}
        self.unchanged_inputs()
        current, protected = self.state()
        require(protected == self.protected and all(current[s]['id'] == self.rows[s]['id'] for s in TARGETS),
                'Services changed during image build; no replacement attempted')
        forward, rollback = backup / 'release.json', backup / 'rollback.json'
        self.write(forward, merge_images(self.app, self.contexts, new))
        self.write(rollback, merge_images(self.app, self.contexts, old))
        self.write(backup / 'manifest.json', {'version': 1, 'app': str(self.app), 'project': self.project,
                   'public': self.public, 'old': old, 'new': new, 'release': release})
        try:
            self.require_stopped()
            self.replace(forward)
            overview = self.verify_public(release)
            current, protected = self.state()
            require_restore_images(current, new)
            require(protected == self.protected, 'An unrelated service was replaced')
            self.unchanged_inputs()
        except (Exception, KeyboardInterrupt):
            print('Release check failed; restoring previous API and web images.', flush=True)
            current, _ids = self.state()
            require(all(current[s]['image'] in (old[s], new[s]) for s in TARGETS), 'A later release prevents automatic rollback')
            self.unchanged_inputs()
            self.replace(rollback)
            web.check_site(self.public)
            print('NOVA_MAINNET_RELEASE_ROLLED_BACK=YES', flush=True)
            raise
        self.installed_images = new
        print('NOVA_LUXURY_SITE_UPDATED=YES\nAPI_AND_WEB_RELEASE_MATCH=YES\nMINIAPP_DISABLED=YES\nPROTECTED_SERVICE_IDS_UNCHANGED=YES', flush=True)
        print('SOLANA_MAINNET_VERIFIED=' + ('YES' if mainnet_verified(overview) else 'NO'), flush=True)
        print('Image release preserved the existing environment and trading modes.', flush=True)

    def restore(self):
        backup = Path(self.args.restore).resolve()
        require(backup.parent == self.backup_root and not backup.is_symlink(), 'Expected a backup from this installation')
        manifest = json.loads(ops.read_file(backup / 'manifest.json'))
        require(manifest.get('version') == 1 and manifest.get('app') == str(self.app) and manifest.get('public') == self.public,
                'Backup belongs to a different installation')
        self.discover(); self.require_stopped()
        require(manifest.get('project') == self.project, 'Backup project differs')
        current, protected = self.state(); require_restore_images(current, manifest['new'])
        overlay = backup / 'restore-current-context.json'
        self.write(overlay, merge_images(self.app, self.contexts, manifest['old']))
        self.unchanged_inputs(); self.replace(overlay); web.check_site(self.public)
        current, after = self.state(); require_restore_images(current, manifest['old'])
        require(after == protected, 'An unrelated service changed during restore')
        self.unchanged_inputs()
        print('NOVA_MAINNET_RELEASE_RESTORED=YES', flush=True)

    def reload_web(self):
        current, protected = self.state()
        require_restore_images(current, self.installed_images)
        require(protected == self.protected, 'Unrelated service changed during network completion')
        for action in (['nginx', '-t'], ['nginx', '-s', 'reload']):
            ops.run(['docker', 'exec', current['gsp-web']['id']] + action, 'Refresh API upstream in existing web service')
        for attempt in range(15):
            try:
                require(public_json(self.public, '/api/health').get('status') == 'ok', 'API liveness not confirmed')
                return
            except Failure:
                if attempt == 14:
                    raise
                time.sleep(1)

    def operator_step(self, filename, *arguments):
        # Existing helpers implement private prompts, journals, leases and rollback.
        command = [sys.executable, str(Path(__file__).with_name(filename)), '--app-dir', str(self.app), *arguments]
        try:
            result = subprocess.run(command, check=False)
        finally:
            # Both a successful API restart and its rollback may change Docker IPs.
            self.reload_web()
        require(result.returncode == 0, 'Site release is installed; ' + filename + ' did not complete. Use its printed recovery details.')

    def complete_connection(self):
        if self.args.repair_rpc or self.args.activate_copy:
            overview = public_json(self.public, '/api/public/solana/overview', (200, 503))
            network = public_json(self.public, '/api/public/network/status', (200, 503))
            scanner = network.get('scanner') or {}
            healthy = (mainnet_verified(overview) and overview.get('source') == 'dedicated' and
                       scanner.get('state') == 'HEALTHY' and (scanner.get('wsHealthy') or scanner.get('fallbackHealthy')))
            if not healthy:
                print('Dedicated mainnet HTTP/WSS setup is required. Provider endpoints are entered privately in this terminal.', flush=True)
                self.operator_step('configure-nova-copy-rpc.py')
            overview = public_json(self.public, '/api/public/solana/overview')
            require(mainnet_verified(overview) and overview.get('source') == 'dedicated', 'Dedicated mainnet identity was not confirmed')
            print('DEDICATED_MAINNET_RPC_VERIFIED=YES', flush=True)
        if self.args.activate_copy:
            self.operator_step('enable-live-copy-trading.py', '--release-bootstrap-stop')
            # The helper rejects manual stops, active targets, unrelated auto-buys,
            # wrong-chain providers and invalid limits before enabling its watcher.
            web.check_site(self.public)
            copy = public_json(self.public, '/api/public/copy-trading')
            readiness, watcher = copy.get('buyReadiness') or {}, copy.get('watcher') or {}
            require(copy.get('executionMode') == 'live' and copy.get('copyWatcherReady') is True and
                    copy.get('liveExecutionEnabled') is True and watcher.get('running') is True and
                    watcher.get('healthy') is True and readiness.get('ready') is True and readiness.get('blockers') == [],
                    'Live-copy public readiness is not confirmed')
            print('NOVA_COPY_BACKEND_READY=YES\nNO_WALLET_OR_COPY_TARGET_SELECTED=YES', flush=True)


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == os.geteuid() and
            stat.S_IMODE(info.st_mode) & 0o077 == 0, 'Backup directory must be private and owned by this user')


def lock_file(stack, path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    stream = stack.enter_context(os.fdopen(fd, 'a'))
    require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'Regular lock file required')
    try:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Failure('Another Nova operation is running') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', default='/opt/nova-solana-ai-sniper')
    parser.add_argument('--public-url', default='https://moneyland.tr')
    parser.add_argument('--release'); parser.add_argument('--restore')
    parser.add_argument('--repair-rpc', action='store_true')
    parser.add_argument('--activate-copy', action='store_true')
    args = parser.parse_args()
    require(not args.restore or not (args.repair_rpc or args.activate_copy), 'Restore cannot activate or reconfigure the backend')
    require(os.geteuid() == 0, 'Run in the existing root Termius session')
    os.umask(0o077)
    installer = Installer(args)
    installer.backup_root = installer.app / 'data/mainnet-luxury-backups'
    wallet_backups = installer.app / 'data/wallet-language-backups'
    private_directory(installer.backup_root); private_directory(wallet_backups)
    with ExitStack() as locks:
        lock_file(locks, installer.backup_root / 'install.lock')
        lock_file(locks, wallet_backups / 'install.lock')
        with ExitStack() as env_lock:
            lock_file(env_lock, installer.app / '.env.nova-ops.lock')
            if args.restore:
                installer.restore()
            else:
                installer.install()
        if not args.restore:
            installer.complete_connection()


if __name__ == '__main__':
    try:
        main()
    except (Failure, OSError, ValueError, KeyboardInterrupt) as error:
        print('NOVA_MAINNET_RELEASE_ERROR=' + (str(error) if isinstance(error, Failure) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
