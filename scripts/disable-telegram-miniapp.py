#!/usr/bin/env python3
"""Disable only Nova's Telegram Mini App on the official local Compose install."""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import time

FILES = ('.env', 'docker/nginx/default.conf.template', 'docker/nginx/gsp-port.conf.template')
TEMPLATES = {'nginx': FILES[1], 'gsp-web': FILES[2]}
BEGIN = '    # NOVA_TELEGRAM_MINIAPP_DISABLED_BEGIN'
END = '    # NOVA_TELEGRAM_MINIAPP_DISABLED_END'
BLOCK = r'''    # NOVA_TELEGRAM_MINIAPP_DISABLED_BEGIN
    location = /app {
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        return 410 "Telegram Mini App is disabled.\n";
    }

    location ^~ /app/ {
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        return 410 "Telegram Mini App is disabled.\n";
    }

    location = /api/auth/telegram {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        return 410 '{"code":"MINIAPP_DISABLED","error":"Telegram Mini App is disabled."}';
    }

    location = /api/auth/telegram/ {
        default_type application/json;
        add_header Cache-Control "no-store" always;
        return 410 '{"code":"MINIAPP_DISABLED","error":"Telegram Mini App is disabled."}';
    }
    # NOVA_TELEGRAM_MINIAPP_DISABLED_END'''
FORMAT = ('{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},'
          '"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},'
          '"ports":{{json .NetworkSettings.Ports}}}')


class Failure(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Failure(message)


def run(argv, label, data=None):
    try:
        result = subprocess.run(argv, input=data, text=True, capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        raise Failure(label + ' could not complete; command output withheld') from None
    require(result.returncode == 0, label + ' failed; command output withheld')
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= 1024 * 1024,
            'Expected a regular, non-symlink file no larger than 1 MiB: ' + str(path))
    return path.read_bytes()


def inplace(path, data):
    # Bind mounts retain this inode. Never rename a replacement over the template.
    fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'wb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'Not a regular target file')
        stream.write(data)
        stream.truncate()
        stream.flush()
        os.fsync(stream.fileno())


def patch_template(data):
    text = data.decode('utf-8')
    if BEGIN in text or END in text:
        require(text.count(BEGIN) == text.count(END) == 1 and BLOCK in text,
                'Unexpected existing disable marker; review template manually')
        return data
    require(not re.search(r'location\s+(?:=\s+|\^~\s+)(?:/app\b|/api/auth/telegram\b)', text),
            'Conflicting Mini App locations; no changes made')
    pattern = r'(?m)^    location /app/ \{\n(?:(?!^    \}).*\n)*^    \}'
    matches = list(re.finditer(pattern, text))
    require(len(matches) == 1 and 'try_files $uri /app/index.html;' in matches[0][0],
            'Expected exactly one official /app/ location; no changes made')
    old_comment = ('    # Telegram Mini App (apps/miniapp, built into this image). Telegram Web\n'
                   '    # embeds Mini Apps in an iframe, so the server-wide SAMEORIGIN frame rule is\n'
                   '    # replaced here by an allow-list of Telegram origins.\n')
    return (text[:matches[0].start()] + BLOCK + text[matches[0].end():]).replace(old_comment, '').encode()


def patch_env(data):
    text = data.decode('utf-8')
    pattern = r'(?m)^[ \t]*(?:export[ \t]+)?MINIAPP_URL[ \t]*=[^\r\n]*'
    for match in re.finditer(pattern, text):
        value = match[0].split('=', 1)[1].strip()
        require(not value.startswith(('"', "'")) or value.count(value[0]) == 2,
                'Multiline or unusual MINIAPP_URL value; review .env manually')
    changed, count = re.subn(pattern, 'MINIAPP_URL=', text)
    return (changed if count else text.rstrip('\r\n') + '\nMINIAPP_URL=\n').encode()


def containers(filter_value):
    ids = run(['docker', 'ps', '-aq', '--filter', filter_value], 'Container discovery').split()
    if not ids:
        return []
    return [json.loads(line) for line in run(['docker', 'inspect', '--format', FORMAT] + ids,
                                           'Restricted container inspection').splitlines()]


def service(container):
    return container['labels'].get('com.docker.compose.service', '')


def image_overlay(data):
    """Read only literal image/pull-policy overlays emitted by Nova installers.

    This deliberately supports the tiny generated YAML subset rather than a YAML
    loader: anchors, includes, environment, ports, commands and mounts cannot be
    accepted as a side effect of a previously installed frontend release.
    """
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate overlay key')
            result[key] = value
        return result

    text = data.decode('utf-8')
    if text.lstrip().startswith('{'):
        parsed = json.loads(text, object_pairs_hook=unique)
    else:
        lines = [line.rstrip() for line in text.splitlines()
                 if line.strip() and not line.lstrip().startswith('#')]
        require(lines and lines[0] == 'services:', 'Not a literal services overlay')
        parsed, current = {'services': {}}, None
        for line in lines[1:]:
            entry = re.fullmatch(r'  ([a-z][a-z0-9_-]*):', line)
            if entry:
                current = entry[1]
                require(current not in parsed['services'], 'Duplicate overlay service')
                parsed['services'][current] = {}
                continue
            prop = re.fullmatch(r'    (image|pull_policy):[ \t]*(.+)', line)
            require(prop and current, 'Unsupported overlay property')
            value = prop[2].strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif value.startswith("'"):
                require(value.endswith("'") and value.count("'") == 2, 'Invalid quoted image')
                value = value[1:-1]
            require(prop[1] not in parsed['services'][current], 'Duplicate overlay property')
            parsed['services'][current][prop[1]] = value
    require(isinstance(parsed, dict) and set(parsed) == {'services'} and
            isinstance(parsed['services'], dict) and 1 <= len(parsed['services']) <= 9,
            'Expected an image-only services overlay')
    allowed = {'api', 'gsp-web', 'nginx', 'telegram-bot', 'marketing-engine',
               'migrate', 'postgres', 'redis', 'certbot'}
    for name, fields in parsed['services'].items():
        require(name in allowed and isinstance(fields, dict) and
                set(fields) in ({'image'}, {'image', 'pull_policy'}),
                'Overlay changes configuration beyond images')
        require(isinstance(fields['image'], str) and
                re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}', fields['image']),
                'Overlay image must be literal, without interpolation')
        require(fields.get('pull_policy', 'never') == 'never', 'Unsupported overlay pull policy')
    return parsed['services']


def official_compose_files(container, app):
    """Preserve installed UI releases while validating image-only Compose layers."""
    configs = container['labels'].get('com.docker.compose.project.config_files', '').split(',')
    if configs == [str(app / 'docker-compose.yml')]:
        return True
    if not 2 <= len(configs) <= 6 or configs[0] != str(app / 'docker-compose.yml'):
        return False
    svc = service(container)
    try:
        effective = None
        for name in configs[1:]:
            extra = Path(name)
            require(extra.is_absolute() and extra.resolve() == extra,
                    'Overlay path must be absolute and not a symlink')
            entries = image_overlay(read_file(extra))
            if svc in entries:
                effective = entries[svc]['image']
        if effective is None:
            # For example, a project-wide frontend image override does not
            # change the bot. Recreated targets are always pinned separately.
            return True
        image = effective if re.fullmatch(r'sha256:[0-9a-f]{64}', effective) else run(
            ['docker', 'image', 'inspect', '--format', '{{.Id}}', effective],
            'Validate installed image-only overlay').strip()
        return image == container['image']
    except (OSError, ValueError, UnicodeError, Failure):
        return False


def verify_compose_files(container, app):
    if not official_compose_files(container, app):
        # Filenames and service names only; no resolved environment or values.
        files = container['labels'].get('com.docker.compose.project.config_files', '').split(',')
        print('NOVA_COMPOSE_CONTEXT=' + json.dumps({
            'service': service(container), 'files': [Path(p).name for p in files[:6]]}))
        raise Failure('Unsupported Compose configuration for ' + service(container) +
                      '; literal image-only UI release/rollback overlays are supported')


def telegram(container_id, button=None):
    # The token is read only inside the container. Return only bounded, allowlisted
    # diagnostics: Telegram descriptions and fetch errors may contain the token.
    script = r'''
const token = process.env.TELEGRAM_BOT_TOKEN;
let method = 'getChatMenuButton';
function fail(code, extra = {}) {
  throw Object.assign(new Error('redacted'), {safe: {code, method, ...extra}});
}
function safe(error) {
  return error?.safe || {code: 'REQUEST_FAILED', method};
}
async function call(method, body) {
  if (!token) fail('TOKEN_MISSING');
  let r;
  try {
    r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000)
    });
  } catch (error) {
    const code = error?.cause?.code;
    if (['TimeoutError', 'AbortError'].includes(error?.name)) fail('TIMEOUT');
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) fail('DNS_LOOKUP_FAILED');
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code)) fail('NETWORK_UNREACHABLE');
    fail('CONNECTION_FAILED');
  }
  let j;
  try { j = await r.json(); } catch { fail('INVALID_RESPONSE'); }
  if (!r.ok || !j.ok) {
    const status = Number.isInteger(r.status) ? r.status : 0;
    const retryAfter = Number.isSafeInteger(j.parameters?.retry_after)
      ? Math.max(0, Math.min(j.parameters.retry_after, 86400)) : 0;
    fail(status === 401 || status === 403 ? 'TOKEN_REJECTED' : 'TELEGRAM_REJECTED',
      {status, retryAfter});
  }
  return j.result;
}
(async () => {
  const requested = BUTTON;
  if (requested) {
    method = 'setChatMenuButton';
    if (await call(method, {menu_button: requested}) !== true) fail('SET_NOT_CONFIRMED');
  }
  method = 'getChatMenuButton';
  const menu = await call('getChatMenuButton');
  if (!menu || !['commands', 'web_app', 'default'].includes(menu.type)) fail('INVALID_RESPONSE');
  if (requested && menu.type !== requested.type) fail('MENU_NOT_APPLIED', {menuType: menu.type});
  let has_main_web_app = null, metadataWarning;
  method = 'getMe';
  try {
    const me = await call('getMe');
    if (!me || !Number.isSafeInteger(me.id)) fail('INVALID_RESPONSE');
    has_main_web_app = me.has_main_web_app === true;
  } catch (error) { metadataWarning = safe(error); }
  console.log(JSON.stringify({ok: true, menu, has_main_web_app, metadataWarning}));
})().catch(error => { console.log(JSON.stringify({ok: false, error: safe(error)})); });
'''.replace('BUTTON', json.dumps(button))
    for attempt in range(1, 4):
        try:
            result = json.loads(run(['docker', 'exec', '-i', container_id, 'node', '-'],
                                    'Telegram menu request', script))
        except (Failure, ValueError):
            result = {'ok': False, 'error': {'code': 'CONTAINER_EXEC_UNAVAILABLE'}}
        if result.get('ok') is True:
            if result.get('metadataWarning'):
                print('NOVA_TELEGRAM_METADATA_CHECK=' + json.dumps(result['metadataWarning']))
            return result
        error = result.get('error', {'code': 'REQUEST_FAILED'})
        print('NOVA_TELEGRAM_MENU_CHECK=' + json.dumps({'attempt': attempt, **error}))
        retry_after = error.get('retryAfter', 0)
        retryable = error.get('code') in {
            'TIMEOUT', 'DNS_LOOKUP_FAILED', 'NETWORK_UNREACHABLE', 'CONNECTION_FAILED',
            'CONTAINER_EXEC_UNAVAILABLE', 'INVALID_RESPONSE', 'MENU_NOT_APPLIED',
        } or error.get('status', 0) >= 500 or error.get('status') == 429
        if attempt == 3 or not retryable or retry_after > 20:
            raise Failure('TELEGRAM_MENU_NOT_VERIFIED: see NOVA_TELEGRAM_MENU_CHECK')
        time.sleep(max(attempt, retry_after))


def telegram_token_fingerprint(container_id):
    # Compare credentials privately before using a stable API container for the
    # bot's menu request. Never send a request for a different bot as a fallback.
    script = ("const t=process.env.TELEGRAM_BOT_TOKEN; if(!t) process.exit(1);"
              "console.log(require('node:crypto').createHash('sha256').update(t).digest('hex'))")
    value = run(['docker', 'exec', container_id, 'node', '-e', script],
                'Private Telegram credential comparison').strip()
    require(re.fullmatch(r'[0-9a-f]{64}', value), 'Telegram credential comparison unavailable')
    return value


class Installer:
    def __init__(self, args):
        self.args, self.app = args, Path(args.app_dir).resolve()
        self.backup = None
        self.bot_touched = False
        self.changed = False
        self.project = ''

    def current(self):
        return containers('label=com.docker.compose.project=' + self.project)

    def bot(self):
        found = [c for c in self.current() if service(c) == 'telegram-bot']
        require(len(found) <= 1, 'Multiple bot containers are unsupported')
        return found[0] if found else None

    def nonbot_ids(self):
        return sorted(c['id'] for c in self.current() if service(c) != 'telegram-bot')

    def menu_container(self, bot=None):
        reference = bot if bot is not None else (self.old_bot if self.bot_running else self.api)
        if reference['id'] != self.api['id']:
            try:
                if telegram_token_fingerprint(reference['id']) == telegram_token_fingerprint(self.api['id']):
                    return self.api
            except Failure:
                pass
        return reference

    def preflight(self):
        require(shutil.which('docker') and shutil.which('git'), 'Docker and Git are required')
        run(['docker', 'compose', 'version'], 'Docker Compose prerequisite')
        host = os.environ.get('DOCKER_HOST') or json.loads(run(
            ['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
            'Local Docker context check'))
        require(host.startswith('unix://'), 'Only the local Unix-socket Docker context is supported')
        remote = run(['git', '-C', str(self.app), 'remote', 'get-url', 'origin'], 'Repository check').strip()
        require(re.fullmatch(r'(?:https://github\.com/|git@github\.com:)'
                             r'Rezamoradifar/nova-solana-ai-sniper(?:\.git)?', remote),
                'App directory is not the expected Nova repository')
        require((self.app / 'docker-compose.yml').is_file(), 'Official docker-compose.yml is missing')
        self.original = {name: read_file(self.app / name) for name in FILES}
        self.patched = {FILES[0]: patch_env(self.original[FILES[0]])}
        self.patched.update({name: patch_template(self.original[name]) for name in FILES[1:]})
        candidates = containers('label=com.docker.compose.project.working_dir=' + str(self.app))
        projects = {c['labels'].get('com.docker.compose.project') for c in candidates}
        require(len(projects) == 1 and None not in projects, 'No unique Compose project at --app-dir')
        self.project = projects.pop()
        require(re.fullmatch(r'[a-z0-9][a-z0-9_-]*', self.project), 'Unexpected Compose project name')
        all_containers = self.current()
        for c in all_containers:
            labels = c['labels']
            require(labels.get('com.docker.compose.project.working_dir') == str(self.app),
                    'Project includes containers from a different working directory')
            verify_compose_files(c, self.app)
        self.before_ids = self.nonbot_ids()
        self.web = [c for c in all_containers if c['running'] and service(c) in TEMPLATES]
        require(self.web and len({service(c) for c in self.web}) == len(self.web),
                'Expected at least one running official web service without replicas')
        api = [c for c in all_containers if service(c) == 'api' and c['running']]
        require(len(api) == 1, 'One running API container is required for health/menu verification')
        self.api = api[0]
        self.old_bot = self.bot()
        self.bot_running = bool(self.old_bot and self.old_bot['running'])
        self.bot_image = self.old_bot['image'] if self.bot_running else None
        if self.bot_image:
            require(re.fullmatch(r'sha256:[0-9a-f]{64}', self.bot_image), 'Immutable bot image ID required')
        self.targets = {}
        for c in self.web:
            mounts = [m for m in c['mounts'] if m['Destination'] == '/etc/nginx/templates/default.conf.template']
            require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and
                    Path(mounts[0]['Source']) == self.app / TEMPLATES[service(c)],
                    'Web template bind mount does not match the official source path')
            run(['docker', 'exec', c['id'], 'test', '-x', '/docker-entrypoint.d/20-envsubst-on-templates.sh'],
                'nginx template-renderer prerequisite')
            run(['docker', 'exec', c['id'], 'nginx', '-t'], 'Existing nginx configuration')
            port = '443/tcp' if service(c) == 'nginx' else '80/tcp'
            bindings = c['ports'].get(port) or []
            require(bindings, 'Expected published web port is missing')
            bind = bindings[0]
            address = bind['HostIp']
            address = '127.0.0.1' if address in ('', '0.0.0.0', '::') else address
            self.targets[c['id']] = (address, int(bind['HostPort']), port == '443/tcp')
        self.baseline = {c['id']: self.site_check(c) for c in self.web}
        if not getattr(self.args, 'menu_only', False):
            self.menu_before = telegram(self.menu_container()['id'])
        print('Preflight OK: project=' + self.project + '; web=' + ','.join(service(c) for c in self.web))
        print('Bot action: ' + ('verify existing container; no recreation' if getattr(self.args, 'menu_only', False)
                                else 'recreate with its current immutable image' if self.bot_running
                                else 'leave stopped/absent'))

    def request(self, c, path, method='GET', timeout=10):
        host, port, tls = self.targets[c['id']]
        connection = (http.client.HTTPSConnection(host, port, timeout=timeout, context=ssl._create_unverified_context())
                      if tls else http.client.HTTPConnection(host, port, timeout=timeout))
        try:
            connection.request(method, path, body='{}' if method == 'POST' else None,
                               headers={'Content-Type': 'application/json',
                                        'Connection': 'close', 'Cache-Control': 'no-cache'})
            response = connection.getresponse()
            body = response.read(2 * 1024 * 1024)
            return response.status, body, response.getheader('Cache-Control', '')
        except (OSError, http.client.HTTPException):
            raise Failure('Local HTTP verification failed for ' + service(c)) from None
        finally:
            connection.close()

    def site_check(self, c):
        status, body, _ = self.request(c, '/')
        require(status == 200, 'Existing dashboard root must return 200: ' + service(c))
        root_hash = digest(body)
        status, body, _ = self.request(c, '/api/health')
        require(status == 200 and json.loads(body).get('status') == 'ok',
                'API health must remain OK through ' + service(c))
        return root_hash

    def save_backup(self):
        base = self.app / 'data/miniapp-disable-backups'
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not base.is_symlink() and base.stat().st_uid == os.getuid() and
                stat.S_IMODE(base.stat().st_mode) & 0o077 == 0, 'Backup parent must be private and owned by this user')
        self.backup = Path(tempfile.mkdtemp(prefix=time.strftime('%Y%m%dT%H%M%SZ-', time.gmtime()), dir=base))
        for index, name in enumerate(FILES):
            path = self.backup / str(index)
            path.write_bytes(self.original[name])
            path.chmod(0o600)
        self.manifest = {'app_dir': str(self.app), 'project': self.project, 'bot_running': self.bot_running,
                         'bot_image': self.bot_image, 'menu_before': self.menu_before['menu'],
                         'before': {n: digest(self.original[n]) for n in FILES},
                         'after': {n: digest(self.patched[n]) for n in FILES}}
        self.write_private('manifest.json', self.manifest)
        self.report_backup()

    def write_private(self, name, value):
        path = self.backup / name
        path.write_text(json.dumps(value, indent=2) + '\n')
        path.chmod(0o600)
        return path

    def report_backup(self):
        print('Private backup: ' + str(self.backup))
        command = ['python3', str(Path(sys.argv[0]).resolve()), '--app-dir', str(self.app), '--restore', str(self.backup)]
        print('Restore command: ' + shlex.join(command))

    def render_and_validate(self, require_disabled=False):
        for c in self.web:
            run(['docker', 'exec', c['id'], '/docker-entrypoint.d/20-envsubst-on-templates.sh'], 'Render nginx templates')
            run(['docker', 'exec', c['id'], 'nginx', '-t'], 'Validate rendered nginx')
            if require_disabled:
                effective = run(['docker', 'exec', c['id'], 'nginx', '-T'], 'Read effective nginx configuration')
                if BEGIN not in effective or BLOCK not in effective:
                    mounted = run(['docker', 'exec', c['id'], 'cat',
                                   '/etc/nginx/templates/default.conf.template'], 'Read mounted web template')
                    expected = read_file(self.app / TEMPLATES[service(c)])
                    print('NOVA_NGINX_RENDER_CHECK=' + json.dumps({
                        'service': service(c), 'disabledBlockLoaded': False,
                        'mountedTemplateMatchesHost': digest(mounted.encode()) == digest(expected)}))
                    raise Failure('NGINX_RENDERED_MINIAPP_BLOCK_MISSING: ' + service(c) +
                                  '; inspect template rendering or a stale bind mount')

    def reload_web(self):
        for c in self.web:
            run(['docker', 'exec', c['id'], 'nginx', '-s', 'reload'], 'Reload nginx')

    def verify_disabled_routes(self, wait_seconds=15):
        # nginx -s reload sends HUP and returns before new workers necessarily
        # accept connections. Use new connections and require two complete passes;
        # the first old-worker 200/301 must not immediately trigger rollback.
        deadline = time.monotonic() + wait_seconds
        passes = 0
        paths = ('/app', '/app/', '/app/deep/route', '/app/assets/disabled.js',
                 '/api/auth/telegram', '/api/auth/telegram/')
        while True:
            failures = []
            for c in self.web:
                for path in paths:
                    status, cache = 'UNREACHABLE', ''
                    try:
                        timeout = max(0.1, min(2, deadline - time.monotonic()))
                        status, _, cache = self.request(
                            c, path, 'POST' if path.startswith('/api/') else 'GET', timeout=timeout)
                    except Failure:
                        pass
                    no_store = 'no-store' in [part.strip().lower() for part in cache.split(',')]
                    if status != 410 or not no_store:
                        failures.append({'service': service(c), 'path': path,
                                         'http': status, 'noStore': no_store})
                        break
                else:
                    try:
                        require(self.site_check(c) == self.baseline[c['id']], 'Dashboard root changed')
                    except Failure:
                        failures.append({'service': service(c), 'path': '/',
                                         'reason': 'DASHBOARD_OR_API_HEALTH_CHANGED'})
            passes = passes + 1 if not failures else 0
            if passes >= 2:
                return
            if time.monotonic() >= deadline:
                print('NOVA_MINIAPP_HTTP_CHECK=' + json.dumps({'failures': failures, 'passes': passes}))
                raise Failure('NGINX_MINIAPP_RELOAD_NOT_READY: disabled routes did not converge to 410/no-store')
            time.sleep(0.25)

    def recreate_bot(self, image):
        override = self.write_private('telegram-miniapp-override.json',
                                      {'services': {'telegram-bot': {'image': image, 'pull_policy': 'never'}}})
        run(['docker', 'compose', '--project-directory', str(self.app), '--env-file', str(self.app / '.env'),
             '-p', self.project, '-f', str(self.app / 'docker-compose.yml'), '-f', str(override),
             'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'telegram-bot'],
            'Recreate only telegram-bot with its existing image')
        for _ in range(10):
            bot = self.bot()
            if bot and bot['running'] and bot['image'] == image:
                return bot
            time.sleep(1)
        raise Failure('Bot did not return running on the original image')

    def restore_files(self):
        for index, name in enumerate(FILES):
            require(digest(read_file(self.app / name)) in (self.manifest['before'][name], self.manifest['after'][name]),
                    'Refusing to overwrite a later manual edit: ' + name)
            original = read_file(self.backup / str(index))
            require(digest(original) == self.manifest['before'][name], 'Backup content check failed')
        for index, name in enumerate(FILES):
            inplace(self.app / name, read_file(self.backup / str(index)))
        self.render_and_validate()
        self.reload_web()

    def apply(self):
        self.save_backup()
        try:
            for name in FILES:
                inplace(self.app / name, self.patched[name])
            self.changed = True
            self.render_and_validate(require_disabled=True)  # Validate every config before the first reload.
            self.reload_web()
            self.verify_disabled_routes()
            bot = self.old_bot
            if self.bot_running:
                self.bot_touched = True
                bot = self.recreate_bot(self.bot_image)
                run(['docker', 'exec', bot['id'], 'node', '-e',
                     'process.exit(process.env.MINIAPP_URL ? 1 : 0)'], 'Verify empty bot MINIAPP_URL')
            require(self.nonbot_ids() == self.before_ids, 'A non-bot container ID changed during this operation')
        except (Exception, KeyboardInterrupt):
            print('FAILED: attempting rollback of files, web configuration and the original bot image.')
            try:
                self.restore_files()
                if self.bot_touched:
                    self.recreate_bot(self.bot_image)
                require(self.nonbot_ids() == self.before_ids, 'Non-bot ID check failed after rollback')
                print('Rollback completed; Mini App disable was not completed.')
            except (Exception, KeyboardInterrupt):
                print('PARTIAL: rollback could not complete. Use the printed private backup/restore command.')
            raise
        try:
            result = self.reset_menu(bot if self.bot_running else self.api)
        except Exception:
            raise Failure('PARTIAL: web routes are disabled and bot configuration applied, but Telegram menu is unverified; use --menu-only after reviewing NOVA_TELEGRAM_MENU_CHECK') from None
        self.report_success(result)

    def reset_menu(self, bot):
        container = self.menu_container(bot)
        print('NOVA_TELEGRAM_MENU_RUNNER=' + service(container))
        return telegram(container['id'], {'type': 'commands'})

    def report_success(self, result):
        print('SUCCESS: Mini App routes return 410; dashboard and API health preserved; non-bot IDs unchanged.')
        print('NOVA_MINIAPP_DISABLED=YES')
        main_app = result['has_main_web_app']
        print('Telegram default menu=commands; has_main_web_app=' +
              ('unknown' if main_app is None else str(main_app).lower()))
        print('Existing JWT sessions are not selectively revoked. BotFather Main Mini App settings are separate.')

    def finish_menu(self):
        # Recovery for a completed local shutdown whose remote menu check failed.
        # No file writes, nginx reload, container recreation or backup replacement.
        require(self.original == self.patched, 'MENU_ONLY_REQUIRES_DISABLED_FILES: run the full shutdown first')
        self.verify_disabled_routes()
        bot = self.old_bot if self.bot_running else self.api
        if self.bot_running:
            run(['docker', 'exec', bot['id'], 'node', '-e',
                 'process.exit(process.env.MINIAPP_URL ? 1 : 0)'], 'Verify empty bot MINIAPP_URL')
        if self.args.dry_run:
            result = telegram(self.menu_container(bot)['id'])
            print('DRY RUN: disabled routes verified; Telegram default menu=' + result['menu']['type'])
            return
        result = self.reset_menu(bot)
        require(self.nonbot_ids() == self.before_ids, 'A non-bot container changed during menu recovery')
        require((self.bot() or {}).get('id') == (self.old_bot or {}).get('id'),
                'Bot container changed during menu recovery')
        self.verify_disabled_routes()
        self.report_success(result)

    def restore(self):
        self.backup = Path(self.args.restore).resolve()
        require(self.backup.parent == self.app / 'data/miniapp-disable-backups' and
                self.backup.stat().st_uid == os.getuid() and stat.S_IMODE(self.backup.stat().st_mode) & 0o077 == 0,
                'Restore backup must be a private backup belonging to this installation')
        self.manifest = json.loads(read_file(self.backup / 'manifest.json'))
        require(self.manifest['app_dir'] == str(self.app) and self.manifest['project'] == self.project,
                'Backup belongs to a different installation')
        self.report_backup()
        if self.args.dry_run:
            print('DRY RUN: would restore only the saved templates/env and original bot image/menu.')
            return
        self.restore_files()
        bot = self.recreate_bot(self.manifest['bot_image']) if self.manifest['bot_running'] else self.api
        telegram(self.menu_container(bot)['id'], self.manifest['menu_before'])
        require(self.nonbot_ids() == self.before_ids, 'Non-bot IDs changed during restore')
        print('RESTORED: saved templates/env, original bot image (if previously running), and default menu.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', default='/opt/nova-solana-ai-sniper')
    parser.add_argument('--dry-run', action='store_true', help='Read-only preflight; no file, container or Telegram mutation')
    parser.add_argument('--restore', metavar='BACKUP_DIR')
    parser.add_argument('--menu-only', action='store_true',
                        help='Finish a partial shutdown: verify disabled routes and reset only the Telegram menu')
    args = parser.parse_args()
    if args.menu_only and args.restore:
        parser.error('--menu-only cannot be combined with --restore')
    os.umask(0o077)
    installer = Installer(args)
    try:
        if args.dry_run:
            installer.preflight()
            if args.menu_only:
                installer.finish_menu()
                return 0
            if args.restore:
                installer.restore()
                return 0
            print('DRY RUN: would back up three files, disable routes, reload web, and reset only the default Telegram menu.')
        else:
            with open(installer.app / '.env.nova-ops.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                installer.preflight()
                if args.menu_only:
                    installer.finish_menu()
                elif args.restore:
                    installer.restore()
                else:
                    installer.apply()
    except (Exception, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, Failure) else 'Operation failed; details withheld to protect configuration secrets'
        print('ERROR: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
