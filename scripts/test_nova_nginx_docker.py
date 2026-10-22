"""Real nginx route checks; opt in with NOVA_OPS_DOCKER_TEST=1 on a Docker host."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location('nova_nginx_ops', ROOT / 'scripts/disable-telegram-miniapp.py')
OPS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OPS)


@unittest.skipUnless(os.environ.get('NOVA_OPS_DOCKER_TEST') == '1' and shutil.which('docker'),
                     'requires explicit Docker integration environment')
class NginxIntegration(unittest.TestCase):
    def command(self, *args):
        return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()

    def test_both_real_nginx_templates(self):
        name = 'nova-ops-' + uuid.uuid4().hex[:10]
        network = name + '-net'
        containers = []
        self.command('docker', 'network', 'create', network)
        try:
            with tempfile.TemporaryDirectory() as directory:
                temp = Path(directory)
                api = temp / 'api.conf'
                api.write_text('server { listen 4000; location / { default_type application/json; '
                               'return 200 \'{"status":"ok"}\'; } }\n')
                api_name = name + '-api'
                containers.append(api_name)
                self.command('docker', 'run', '-d', '--name', api_name, '--network', network,
                             '--network-alias', 'api', '-v', str(api) + ':/etc/nginx/conf.d/default.conf:ro',
                             'nginx:1.27-alpine')
                html = temp / 'html'
                (html / 'app/assets').mkdir(parents=True)
                (html / 'index.html').write_text('NOVA_DASHBOARD_RETAINED')
                (html / 'app/index.html').write_text('OLD_APP_MUST_NOT_LOAD')
                (html / 'app/assets/old.js').write_text('OLD_ASSET_MUST_NOT_LOAD')
                cert = temp / 'cert'
                cert.mkdir()
                self.command('openssl', 'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1',
                             '-subj', '/CN=ops.test', '-keyout', str(cert / 'privkey.pem'),
                             '-out', str(cert / 'fullchain.pem'))
                for template, tls, port in [('gsp-port.conf.template', False, 80),
                                             ('default.conf.template', True, 443)]:
                    container = name + '-' + str(port)
                    containers.append(container)
                    self.command('docker', 'run', '-d', '--name', container, '--network', network,
                                 '-e', 'DOMAIN=ops.test', '-p', '127.0.0.1::' + str(port),
                                 '-v', str(ROOT / 'docker/nginx' / template) +
                                 ':/etc/nginx/templates/default.conf.template:ro',
                                 '-v', str(html) + ':/usr/share/nginx/html:ro',
                                 '-v', str(cert) + ':/etc/letsencrypt/live/ops.test:ro',
                                 'nginx:1.27-alpine')
                    binding = json.loads(self.command('docker', 'inspect', '--format',
                        '{{json .NetworkSettings.Ports}}', container))[str(port) + '/tcp'][0]
                    host_port = int(binding['HostPort'])

                    def get(path, method='GET'):
                        con = (http.client.HTTPSConnection('127.0.0.1', host_port, timeout=3,
                               context=ssl._create_unverified_context()) if tls else
                               http.client.HTTPConnection('127.0.0.1', host_port, timeout=3))
                        try:
                            con.request(method, path, body='{}' if method == 'POST' else None)
                            response = con.getresponse()
                            return response.status, response.read(), response.getheader('Cache-Control', '')
                        finally:
                            con.close()

                    for attempt in range(30):
                        try:
                            if get('/')[0] == 200: break
                        except (OSError, http.client.HTTPException): pass
                        time.sleep(0.2)
                    self.command('docker', 'exec', container, 'nginx', '-t')
                    # Reproduce the existing web installer's separate image-only
                    # release file, resolving its tag against actual Docker state.
                    release = temp / ('release-' + str(port) + '.yml')
                    svc = 'nginx' if tls else 'gsp-web'
                    release.write_text('services:\n  ' + svc + ':\n    image: "nginx:1.27-alpine"\n')
                    actual_image = self.command('docker', 'inspect', '--format', '{{.Image}}', container)
                    metadata = {'image': actual_image, 'labels': {
                        'com.docker.compose.service': svc,
                        'com.docker.compose.project.config_files':
                            str(ROOT / 'docker-compose.yml') + ',' + str(release)}}
                    self.assertTrue(OPS.official_compose_files(metadata, ROOT))
                    self.assertEqual(get('/')[:2], (200, b'NOVA_DASHBOARD_RETAINED'))
                    self.assertEqual(json.loads(get('/api/health')[1]), {'status': 'ok'})
                    for path in ['/app', '/app/', '/app/deep/path', '/app/assets/old.js',
                                 '/app/?old=1', '/api/auth/telegram', '/api/auth/telegram/']:
                        for method in (['GET', 'POST'] if path.startswith('/api/') else ['GET']):
                            status, body, cache = get(path, method)
                            self.assertEqual(status, 410, (template, path, method, body))
                            self.assertIn('no-store', cache)
        finally:
            for container in reversed(containers):
                subprocess.run(['docker', 'rm', '-f', container], capture_output=True)
            subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


if __name__ == '__main__': unittest.main()
