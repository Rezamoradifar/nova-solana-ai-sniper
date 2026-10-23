#!/usr/bin/env python3
"""Install only the reviewed web image; preserve the live Compose context and all account services."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('nova_web_ops', Path(__file__).with_name('disable-telegram-miniapp.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
require, Failure = ops.require, ops.Failure


def project_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-fA-F0-9]{32}', value.strip()) and
            value.strip() != '0' * 32, 'Use the real public Project ID from your Reown dashboard')
    return value.strip()


def combine_overlays(app, paths, web_image):
    require(paths and paths[0] == str(app / 'docker-compose.yml'), 'Unexpected base Compose file')
    result = {}
    for name in paths[1:]:
        path = Path(name)
        require(path.is_absolute() and path.resolve() == path, 'Invalid installed overlay path')
        for service, fields in ops.image_overlay(ops.read_file(path)).items():
            result[service] = fields
    result['gsp-web'] = {'image': web_image, 'pull_policy': 'never'}
    return {'services': result}


def http(base, path):
    try:
        request = Request(base + path, headers={'Cache-Control': 'no-cache', 'User-Agent': 'Nova-wallet-ui-check'})
        with urlopen(request, timeout=8) as response:
            return response.status, response.headers, response.read(2 * 1024 * 1024)
    except HTTPError as error:
        return error.code, error.headers, error.read(4096)
    except (OSError, URLError, TimeoutError):
        raise Failure('Website verification did not respond') from None


def check_site(base, release=None):
    for path in ('/app', '/app/', '/app/assets/disabled.js', '/api/auth/telegram'):
        status, headers, _body = http(base, path)
        require(status == 410 and 'no-store' in headers.get('Cache-Control', '').lower(),
                'Mini App must remain disabled (410/no-store): ' + path)
    for path in ('/', '/api/health', '/api/health/ready'):
        require(http(base, path)[0] == 200, 'Dashboard/API check failed: ' + path)
    if release:
        status, _headers, body = http(base, '/nova-wallet-release.json?release=' + release)
        try:
            value = json.loads(body)
        except (ValueError, UnicodeError):
            value = {}
        require(status == 200 and value.get('release') == release and
                value.get('walletConnectConfigured') is True,
                'Public domain did not serve the expected configured wallet release')
        status, _headers, html = http(base, '/')
        asset = re.search(rb'src="(/assets/[^" ]+\.js)"', html)
        require(status == 200 and asset, 'Dashboard entry asset missing')
        require(http(base, asset[1].decode())[0] == 200, 'Dashboard entry asset unavailable')


def require_restore_image(current, manifest):
    require(current['image'] == manifest['new_image'],
            'A later web deployment is present; refusing to overwrite it')


class Installer:
    def __init__(self, args):
        self.args = args
        self.app = Path(args.app_dir).resolve()
        self.public = args.public_url.rstrip('/')
        parsed = urlsplit(self.public)
        require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and
                not parsed.password and parsed.path in ('', '/') and not parsed.query and
                not parsed.fragment, 'Use the HTTPS site origin')
        require(self.app.is_dir() and (self.app / '.git').exists(), 'Nova repository missing')
        self.env_hash = ops.digest(ops.read_file(self.app / '.env'))

    def discover(self):
        candidates = ops.containers('label=com.docker.compose.service=gsp-web')
        candidates = [c for c in candidates if
                      c['labels'].get('com.docker.compose.project.working_dir') == str(self.app)]
        require(len(candidates) == 1 and candidates[0]['running'], 'Expected one running local gsp-web')
        self.web = candidates[0]
        self.project = self.web['labels']['com.docker.compose.project']
        ops.verify_compose_files(self.web, self.app)
        self.files = self.web['labels']['com.docker.compose.project.config_files'].split(',')
        self.file_hashes = {name: ops.digest(ops.read_file(Path(name))) for name in self.files}
        self.verify_current_config(self.web, self.files)

    def compose(self, files):
        command = ['docker', 'compose', '--project-directory', str(self.app), '--env-file', str(self.app / '.env'), '-p', self.project]
        for name in files:
            command += ['-f', str(name)]
        return command

    def verify_current_config(self, web, files):
        result = ops.run(self.compose(files) + ['config', '--hash', 'gsp-web'], 'Verify live web Compose configuration')
        hashes = re.findall(r'\b[0-9a-f]{64}\b', result)
        require(hashes == [web['labels'].get('com.docker.compose.config-hash')],
                'Current Compose inputs differ from the running web configuration; no change made')

    def current(self):
        rows = ops.containers('label=com.docker.compose.project=' + self.project)
        web = [c for c in rows if ops.service(c) == 'gsp-web']
        require(len(web) == 1, 'Web container identity is ambiguous')
        return web[0], {c['id'] for c in rows if ops.service(c) != 'gsp-web'}

    def unchanged_inputs(self):
        require(ops.digest(ops.read_file(self.app / '.env')) == self.env_hash, '.env changed during the build; no configuration was overwritten')
        for name, digest in self.file_hashes.items():
            require(ops.digest(ops.read_file(Path(name))) == digest, 'Compose inputs changed during the build')

    def recreate(self, overlay):
        ops.run(self.compose([self.app / 'docker-compose.yml', overlay]) +
                ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'gsp-web'],
                'Replace only the existing web service')

    def verify_release(self, release):
        error = None
        for _attempt in range(20):
            try:
                check_site(self.public, release)
                return
            except Failure as caught:
                error = caught
                time.sleep(1)
        raise error

    def write(self, path, value):
        path.write_text(json.dumps(value, indent=2) + '\n')
        path.chmod(0o600)

    def install(self):
        release = self.args.release
        require(release and re.fullmatch(r'[0-9a-f]{40}', release), 'An exact reviewed commit is required')
        for path in ('apps/dashboard/src/components/WalletUI.tsx', 'apps/dashboard/src/lib/walletConnectSdk.ts'):
            ops.run(['git', '-C', str(self.app), 'cat-file', '-e', release + ':' + path], 'Verify reviewed web source')
        self.discover()
        check_site(self.public)
        identifier = os.environ.get('NOVA_WALLETCONNECT_PROJECT_ID', '').strip()
        if not identifier:
            saved = ops.run(['docker', 'image', 'inspect', '--format',
                             '{{index .Config.Labels "tr.moneyland.walletconnect-project-id"}}',
                             self.web['image']], 'Read saved public WalletConnect configuration').strip()
            if re.fullmatch(r'[a-fA-F0-9]{32}', saved) and saved != '0' * 32:
                identifier = saved
        if not identifier:
            require(sys.stdin.isatty(), 'Run in Termius with an interactive terminal for the public Reown Project ID')
            identifier = input('Public Reown Project ID (allow this domain in Reown first): ').strip()
        identifier = project_id(identifier)
        _web, before_ids = self.current()
        backup = Path(tempfile.mkdtemp(prefix='release-', dir=self.backup_root))
        self.backup = backup
        print('NOVA_WALLET_UI_BACKUP=' + str(backup), flush=True)
        restore = ['python3', str(Path(__file__).resolve()), '--app-dir', str(self.app),
                   '--public-url', self.public, '--restore', str(backup)]
        print('Restore command: ' + shlex.join(restore), flush=True)
        old_image = self.web['image']
        ops.run(['docker', 'image', 'tag', old_image, 'nova-wallet-ui-rollback:' + backup.name], 'Retain previous web image')
        new_tag = 'nova-wallet-ui:' + release + '-' + ops.digest(identifier.encode())[:8]
        source = backup / 'source'
        source.mkdir()
        archive = backup / 'source.tar'
        ops.run(['git', '-C', str(self.app), 'archive', '--format=tar', '--output=' + str(archive), release], 'Extract exact release')
        ops.run(['tar', '-xf', str(archive), '-C', str(source)], 'Prepare isolated web source')
        print('Building the isolated web image; running services stay up.', flush=True)
        try:
            built = subprocess.run(['docker', 'build', '--label', 'org.opencontainers.image.revision=' + release,
                                    '--label', 'tr.moneyland.walletconnect-project-id=' + identifier,
                                    '--build-arg', 'VITE_WALLETCONNECT_PROJECT_ID=' + identifier,
                                    '--build-arg', 'NOVA_WALLET_UI_RELEASE=' + release,
                                    '-t', new_tag, '-f', str(source / 'apps/dashboard/Dockerfile'), str(source)],
                                   timeout=1800, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Failure('Web build could not complete; running services were not replaced') from None
        require(built.returncode == 0, 'Web build failed; running services were not replaced')
        new_image = ops.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', new_tag], 'Pin new web image').strip()
        self.unchanged_inputs()
        current, now_ids = self.current()
        require(current['id'] == self.web['id'] and now_ids == before_ids, 'Services changed during build; deployment stopped')
        forward, rollback = backup / 'release.json', backup / 'rollback.json'
        self.write(forward, combine_overlays(self.app, self.files, new_image))
        self.write(rollback, combine_overlays(self.app, self.files, old_image))
        manifest = {'version': 1, 'app': str(self.app), 'project': self.project, 'public': self.public,
                    'old_image': old_image, 'new_image': new_image, 'release': release}
        self.write(backup / 'manifest.json', manifest)
        try:
            self.recreate(forward)
            self.verify_release(release)
            current, now_ids = self.current()
            require(current['running'] and current['image'] == new_image and now_ids == before_ids,
                    'Web image or non-web identity check failed')
            self.unchanged_inputs()
        except (Exception, KeyboardInterrupt):
            print('Web verification failed; restoring the previous web image.', flush=True)
            current, _ids = self.current()
            require(current['image'] in (old_image, new_image), 'A later web deployment prevents automatic rollback')
            self.unchanged_inputs()
            self.recreate(rollback)
            check_site(self.public)
            print('NOVA_WALLET_UI_ROLLED_BACK=YES', flush=True)
            raise
        print('NOVA_WALLET_UI_UPDATED=YES\nWALLETCONNECT_CONFIGURED=YES\nMINIAPP_DISABLED=YES\nNON_WEB_IDS_UNCHANGED=YES\nENV_AND_CHECKOUT_UNCHANGED=YES', flush=True)
        print('Wallet approval is still required on the user device. No trading mode was changed.', flush=True)

    def restore(self):
        backup = Path(self.args.restore).resolve()
        manifest = json.loads(ops.read_file(backup / 'manifest.json'))
        require(manifest.get('version') == 1 and manifest.get('app') == str(self.app) and manifest.get('public') == self.public,
                'Backup belongs to a different installation')
        self.discover()
        require(manifest['project'] == self.project, 'Backup Compose project differs')
        current, before_ids = self.current()
        require_restore_image(current, manifest)
        check_site(self.public)
        rollback = backup / 'restore-current-context.json'
        self.write(rollback, combine_overlays(self.app, self.files, manifest['old_image']))
        self.unchanged_inputs()
        self.recreate(rollback)
        check_site(self.public)
        current, after_ids = self.current()
        require(current['running'] and current['image'] == manifest['old_image'] and before_ids == after_ids,
                'Restore verification failed; inspect the printed backup')
        print('NOVA_WALLET_UI_RESTORED=YES')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', default='/opt/nova-solana-ai-sniper')
    parser.add_argument('--public-url', default='https://moneyland.tr')
    parser.add_argument('--release')
    parser.add_argument('--restore')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run in the existing root Termius session')
    os.umask(0o077)
    installer = Installer(args)
    installer.backup_root = installer.app / 'data/wallet-language-backups'
    installer.backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (installer.backup_root / 'install.lock').open('a') as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure('Another wallet UI deployment is running') from None
        if args.restore:
            installer.restore()
        else:
            installer.install()


if __name__ == '__main__':
    try:
        main()
    except (Failure, OSError, ValueError, KeyboardInterrupt) as error:
        print('NOVA_WALLET_UI_ERROR=' + (str(error) if isinstance(error, Failure) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
