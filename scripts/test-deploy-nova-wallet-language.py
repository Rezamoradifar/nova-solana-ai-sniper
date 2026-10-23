#!/usr/bin/env python3
"""Read-only transport, scope and rollback regression checks for the web installer."""
import importlib.util
import json
import argparse
import os
from pathlib import Path
import tempfile
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('nova_wallet_deploy', Path(__file__).with_name('deploy-nova-wallet-language.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentSafety(unittest.TestCase):
    def test_public_id_is_a_real_identifier_not_an_endpoint_or_placeholder(self):
        self.assertEqual(deploy.project_id(' a1234567890abcdef1234567890abcde '), 'a1234567890abcdef1234567890abcde')
        for value in ('YOUR_PROJECT_ID', '0' * 32, 'https://rpc.example/key', 'abc\nsecret', ''):
            with self.assertRaises(deploy.Failure):
                deploy.project_id(value)

    def test_compacts_existing_literal_image_pins_without_touching_other_services(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            old = app / 'old.json'
            old.write_text(json.dumps({'services': {'api': {'image': 'nova-api:existing'}, 'gsp-web': {'image': 'nova-web:old'}}}))
            new = deploy.combine_overlays(app, [str(app / 'docker-compose.yml'), str(old)], 'sha256:' + 'a' * 64)
            self.assertEqual(new['services']['api'], {'image': 'nova-api:existing'})
            self.assertEqual(new['services']['gsp-web'], {'image': 'sha256:' + 'a' * 64, 'pull_policy': 'never'})

    def test_rejects_a_prior_overlay_that_could_change_env_or_ports(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            old = app / 'old.json'
            content = json.dumps({'services': {'gsp-web': {'image': 'nova:old', 'environment': {'KILL_SWITCH': 'false'}}}})
            old.write_text(content)
            with self.assertRaises(deploy.Failure):
                deploy.combine_overlays(app, [str(app / 'docker-compose.yml'), str(old)], 'nova:new')
            self.assertEqual(old.read_text(), content)

    def test_refuses_to_restore_over_a_later_release(self):
        with self.assertRaises(deploy.Failure):
            deploy.require_restore_image({'image': 'later'}, {'new_image': 'installed'})
        deploy.require_restore_image({'image': 'installed'}, {'new_image': 'installed'})

    def test_recreation_targets_only_web_with_no_dependency_start_or_build(self):
        installer = deploy.Installer.__new__(deploy.Installer)
        installer.app, installer.project = Path('/opt/nova-solana-ai-sniper'), 'nova-solana-ai-sniper'
        with patch.object(deploy.ops, 'run', return_value='') as run:
            installer.recreate(Path('/private/backup/release.json'))
        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index('up'):], ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', 'gsp-web'])
        self.assertEqual(argv[-1], 'gsp-web')
        self.assertNotIn('api', argv)
        self.assertNotIn('telegram-bot', argv)
        self.assertNotIn('migrate', argv)

    def test_changed_compose_interpolation_cannot_silently_change_live_web_ports(self):
        installer = deploy.Installer.__new__(deploy.Installer)
        installer.app, installer.project = Path('/opt/nova-solana-ai-sniper'), 'nova-solana-ai-sniper'
        web = {'labels': {'com.docker.compose.config-hash': 'a' * 64}}
        with patch.object(deploy.ops, 'run', return_value='gsp-web ' + 'b' * 64):
            with self.assertRaises(deploy.Failure):
                installer.verify_current_config(web, ['/opt/nova-solana-ai-sniper/docker-compose.yml'])

    def test_actual_http_requires_closed_miniapp_health_and_the_exact_release(self):
        state = {'miniapp': 410, 'release': 'a' * 40, 'configured': True}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path.startswith(('/app', '/api/auth/telegram')):
                    self.send_response(state['miniapp']); self.send_header('Cache-Control', 'no-store'); body = b'disabled'
                elif self.path.startswith('/nova-wallet-release.json'):
                    self.send_response(200); body = json.dumps({'release': state['release'], 'walletConnectConfigured': state['configured']}).encode()
                else:
                    self.send_response(200); body = b'<script type="module" src="/assets/test.js"></script>'
                self.end_headers(); self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            deploy.check_site(base, 'a' * 40)
            for key, value in [('release', 'b' * 40), ('configured', False), ('miniapp', 200)]:
                original = state[key]; state[key] = value
                with self.assertRaises(deploy.Failure):
                    deploy.check_site(base, 'a' * 40)
                state[key] = original
        finally:
            server.shutdown(); server.server_close(); thread.join()


@unittest.skipUnless(os.environ.get('NOVA_UI_COMPOSE_INTEGRATION') == '1', 'Docker Compose integration is opt-in')
class ActualComposeLease(unittest.TestCase):
    def test_hash_lease_and_compacted_overlay_match_the_actual_running_web(self):
        with tempfile.TemporaryDirectory(prefix='nova-wallet-compose-') as directory:
            app = Path(directory).resolve()
            (app / '.git').mkdir()
            (app / '.env').write_text('')
            (app / 'docker-compose.yml').write_text('services:\n  gsp-web:\n    image: nginx:1.27-alpine\n    command: ["sleep", "90"]\n')
            name = 'nova-wallet-hash-' + uuid.uuid4().hex[:8]
            command = ['docker', 'compose', '--project-directory', str(app), '--env-file', str(app / '.env'),
                       '-p', name, '-f', str(app / 'docker-compose.yml')]
            try:
                subprocess.run(command + ['up', '-d', 'gsp-web'], check=True, capture_output=True)
                installer = deploy.Installer(argparse.Namespace(app_dir=str(app), public_url='https://moneyland.tr'))
                installer.discover()
                current, before = installer.current()
                overlay = app / 'release.json'
                installer.write(overlay, deploy.combine_overlays(app, installer.files, current['image']))
                installer.recreate(overlay)
                installer.discover()
                after, other_ids = installer.current()
                self.assertNotEqual(current['id'], after['id'])
                self.assertEqual(current['image'], after['image'])
                self.assertEqual(before, other_ids)
            finally:
                subprocess.run(command + ['down'], check=False, capture_output=True)


if __name__ == '__main__':
    unittest.main()
