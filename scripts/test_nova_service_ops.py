import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mini = load('nova_mini_tests', 'disable-telegram-miniapp.py')
copy = load('nova_copy_tests', 'enable-live-copy-trading.py')
TEMPLATE = b'''server {
    location /api/ { proxy_pass http://api:4000/; }
    location /app/ {
        root /usr/share/nginx/html;
        try_files $uri /app/index.html;
    }
    location / { try_files $uri /index.html; }
}
'''


class FileRules(unittest.TestCase):
    def test_minapp_flag_cleared_without_changing_financial_or_secret_values(self):
        before = b'RPC="private-value"\nLIVE_TRADING=true\n export MINIAPP_URL = "https://a/app/"\n'
        after = mini.patch_env(before)
        self.assertEqual(after, b'RPC="private-value"\nLIVE_TRADING=true\nMINIAPP_URL=\n')
        self.assertEqual(mini.patch_env(after), after)

    def test_live_flags_changed_without_changing_keys_targets_or_limits(self):
        before = b'RPC="private-value"\nCOPY_TRADING_MAX_BUY_SOL=0.05\nMINIAPP_URL=\nLIVE_TRADING=false\n'
        after = copy.patch_env(before)
        self.assertIn(b'RPC="private-value"\nCOPY_TRADING_MAX_BUY_SOL=0.05\nMINIAPP_URL=\n', after)
        self.assertIn(b'LIVE_TRADING=true\n', after)
        self.assertIn(b'COPY_TRADING_EXECUTION_ENABLED=true\n', after)
        self.assertEqual(copy.patch_env(after), after)

    def test_unusual_multiline_mode_flag_is_rejected_before_mutation(self):
        with self.assertRaises(copy.Failure):
            copy.patch_env(b'LIVE_TRADING="false\nmore"\n')
        with self.assertRaises(mini.Failure):
            mini.patch_env(b'MINIAPP_URL="https://a\n/app"\n')

    def test_template_is_idempotent_blocks_assets_and_auth_preserves_site_and_proxy(self):
        after = mini.patch_template(TEMPLATE)
        self.assertIn(b'location ^~ /app/', after)
        self.assertIn(b'location = /app {', after)
        self.assertIn(b'location = /api/auth/telegram {', after)
        self.assertIn(b'return 410', after)
        self.assertIn(b'location /api/ { proxy_pass http://api:4000/; }', after)
        self.assertIn(b'location / { try_files $uri /index.html; }', after)
        self.assertEqual(mini.patch_template(after), after)

    def test_ambiguous_template_is_rejected(self):
        with self.assertRaises(mini.Failure):
            mini.patch_template(TEMPLATE.replace(b'location /app/', b'location ^~ /app/'))

    def test_inplace_preserves_bind_mount_inode_and_symlink_reads_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'template'; p.write_bytes(b'old')
            inode = p.stat().st_ino
            mini.inplace(p, b'new longer')
            self.assertEqual(p.stat().st_ino, inode)
            self.assertEqual(p.read_bytes(), b'new longer')
            link = Path(d) / 'link'; link.symlink_to(p)
            with self.assertRaises(mini.Failure): mini.read_file(link)

    def test_only_exact_image_only_installer_overrides_are_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            app = Path(d)
            extra = app / 'data/copy-live-backups/run/api-live-copy-override.json'
            extra.parent.mkdir(parents=True)
            image = 'sha256:' + 'a' * 64
            valid = {'services': {'api': {'image': image, 'pull_policy': 'never'}}}
            extra.write_text(json.dumps(valid))
            container = {'image': image, 'labels': {'com.docker.compose.service': 'api',
                'com.docker.compose.project.config_files': str(app / 'docker-compose.yml') + ',' + str(extra)}}
            self.assertTrue(mini.official_compose_files(container, app))
            valid['services']['api']['environment'] = {'LIVE_TRADING': 'true'}
            extra.write_text(json.dumps(valid))
            self.assertFalse(mini.official_compose_files(container, app))

    def test_existing_real_ui_and_wallet_release_overlays_match_the_running_web_image(self):
        with tempfile.TemporaryDirectory() as d:
            app, image = Path(d), 'sha256:' + 'a' * 64
            tag = 'nova-real-ui:b859cd8017a92c5dd4fb17aafc35cbe3b961d99f'
            for name, data in [
                ('release.yml', 'services:\n  gsp-web:\n    image: "' + tag + '"\n'),
                ('release.json', json.dumps({'services': {'gsp-web': {'image': tag}}})),
            ]:
                extra = app / name
                extra.write_text(data)
                c = {'image': image, 'labels': {'com.docker.compose.service': 'gsp-web',
                    'com.docker.compose.project.config_files': str(app / 'docker-compose.yml') + ',' + str(extra)}}
                with patch.object(mini, 'run', return_value=image + '\n') as inspect:
                    self.assertTrue(mini.official_compose_files(c, app), name)
                    self.assertEqual(inspect.call_args.args[0][-1], tag)
                with patch.object(mini, 'run', return_value='sha256:' + 'b' * 64):
                    self.assertFalse(mini.official_compose_files(c, app), 'Retagged image must fail')

    def test_multi_service_and_ordered_layers_preserve_unrelated_frontend_image_override(self):
        with tempfile.TemporaryDirectory() as d:
            app, image = Path(d), 'sha256:' + 'a' * 64
            old, new = app / 'rollback.yml', app / 'api-live-copy-override.json'
            old.write_text('services:\n  api:\n    image: "old-api:release"\n    pull_policy: never\n'
                           '  gsp-web:\n    image: "old-web:release"\n    pull_policy: never\n')
            new.write_text(json.dumps({'services': {'api': {'image': image, 'pull_policy': 'never'}}}))
            c = {'image': image, 'labels': {'com.docker.compose.service': 'api',
                'com.docker.compose.project.config_files': ','.join(map(str, [app / 'docker-compose.yml', old, new]))}}
            with patch.object(mini, 'run', side_effect=AssertionError('Last immutable image needs no lookup')):
                self.assertTrue(mini.official_compose_files(c, app))
            c['labels']['com.docker.compose.service'] = 'telegram-bot'
            self.assertTrue(mini.official_compose_files(c, app), 'An unrelated image layer is harmless')

    def test_overlays_cannot_hide_financial_environment_ports_commands_or_includes(self):
        image = 'sha256:' + 'a' * 64
        for key, value in [('environment', {'LIVE_TRADING': 'true'}), ('ports', ['9999:80']),
                           ('command', 'something'), ('volumes', ['/tmp:/repo']),
                           ('build', {'context': '.'})]:
            with self.assertRaises(mini.Failure):
                mini.image_overlay(json.dumps({'services': {'api': {'image': image, key: value}}}).encode())
        invalid = [
            'services:\n  api:\n    image: "' + image + '"\n    environment: true\n',
            'include: other.yml\nservices:\n  api:\n    image: sample\n',
            'services:\n  api:\n    image: sample\n    image: duplicate\n',
            'services:\n  api:\n    image: ${PRIVATE_IMAGE}\n',
            '{"services":{"api":{"image":"a","image":"b"}}}',
        ]
        for text in invalid:
            with self.assertRaises((mini.Failure, ValueError)):
                mini.image_overlay(text.encode())

    def test_overlay_symlink_and_missing_local_image_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            app, image = Path(d), 'sha256:' + 'a' * 64
            target = app / 'release.json'
            target.write_text(json.dumps({'services': {'gsp-web': {'image': 'missing:release'}}}))
            link = app / 'link.json'; link.symlink_to(target)
            c = {'image': image, 'labels': {'com.docker.compose.service': 'gsp-web',
                'com.docker.compose.project.config_files': str(app / 'docker-compose.yml') + ',' + str(link)}}
            self.assertFalse(mini.official_compose_files(c, app))
            c['labels']['com.docker.compose.project.config_files'] = str(app / 'docker-compose.yml') + ',' + str(target)
            with patch.object(mini, 'run', side_effect=mini.Failure('image not present')):
                self.assertFalse(mini.official_compose_files(c, app))


class TelegramRecovery(unittest.TestCase):
    def test_transient_exec_and_network_failures_retry_without_exposing_errors(self):
        results = [mini.Failure('private token'), json.dumps({
            'ok': False, 'error': {'code': 'TIMEOUT', 'method': 'setChatMenuButton'}}),
            json.dumps({'ok': True, 'menu': {'type': 'commands'}, 'has_main_web_app': False})]
        with patch.object(mini, 'run', side_effect=results) as run, \
             patch.object(mini.time, 'sleep') as delay, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(mini.telegram('bot', {'type': 'commands'})['menu']['type'], 'commands')
        self.assertEqual(run.call_count, 3)
        self.assertEqual(delay.call_count, 2)
        self.assertNotIn('private token', output.getvalue())
        self.assertIn('CONTAINER_EXEC_UNAVAILABLE', output.getvalue())
        self.assertIn('TIMEOUT', output.getvalue())

    def test_bad_credentials_and_long_rate_limits_are_not_blindly_retried(self):
        for error in [{'code': 'TOKEN_REJECTED', 'status': 401},
                      {'code': 'TELEGRAM_REJECTED', 'status': 429, 'retryAfter': 300}]:
            with patch.object(mini, 'run', return_value=json.dumps({'ok': False, 'error': error})) as run, \
                 patch.object(mini.time, 'sleep') as delay, contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(mini.Failure, 'TELEGRAM_MENU_NOT_VERIFIED'):
                    mini.telegram('bot', {'type': 'commands'})
            run.assert_called_once()
            delay.assert_not_called()

    def node_request(self, setup):
        with patch.object(mini, 'run', return_value='{"ok":true}') as run:
            mini.telegram('bot', {'type': 'commands'})
        script = run.call_args.args[2]
        completed = subprocess.run(['node', '-'], input=setup + '\n' + script,
                                   text=True, capture_output=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn('private-test-token', completed.stdout + completed.stderr)
        return json.loads(completed.stdout)

    def test_real_node_request_does_not_fail_confirmed_menu_for_optional_metadata(self):
        result = self.node_request('''
process.env.TELEGRAM_BOT_TOKEN = 'private-test-token';
globalThis.fetch = async url => {
  if (url.endsWith('/getMe')) throw new Error('private-test-token');
  return {ok:true,status:200,json:async()=>({ok:true,
    result:url.endsWith('/setChatMenuButton') ? true : {type:'commands'}})};
};''')
        self.assertTrue(result['ok'])
        self.assertEqual(result['menu']['type'], 'commands')
        self.assertIsNone(result['has_main_web_app'])
        self.assertEqual(result['metadataWarning']['method'], 'getMe')

    def test_real_node_request_redacts_provider_description_and_rejects_wrong_menu(self):
        cases = [
            ("return {ok:false,status:401,json:async()=>({ok:false,description:'private-test-token'})};",
             'TOKEN_REJECTED'),
            ("return {ok:true,status:200,json:async()=>({ok:true,result:"
             "url.endsWith('/setChatMenuButton') ? true : {type:'web_app'}})};", 'MENU_NOT_APPLIED'),
            ("throw Object.assign(new Error('private-test-token'),{cause:{code:'EAI_AGAIN'}});",
             'DNS_LOOKUP_FAILED'),
        ]
        for body, code in cases:
            result = self.node_request("process.env.TELEGRAM_BOT_TOKEN='private-test-token';"
                                       'globalThis.fetch=async url=>{' + body + '};')
            self.assertFalse(result['ok'])
            self.assertEqual(result['error']['code'], code)

    def test_stable_api_runner_is_used_only_for_the_same_bot_token(self):
        inst = mini.Installer(argparse.Namespace(app_dir='/unused'))
        bot = {'id': 'bot'}
        inst.api = {'id': 'api'}
        for fingerprints, expected in [(['a' * 64, 'a' * 64], 'api'),
                                       (['a' * 64, 'b' * 64], 'bot'),
                                       ([mini.Failure('restarting')], 'bot')]:
            with patch.object(mini, 'telegram_token_fingerprint', side_effect=fingerprints):
                self.assertEqual(inst.menu_container(bot)['id'], expected)

    def menu_fixture(self, directory):
        inst = mini.Installer(argparse.Namespace(app_dir=directory, dry_run=False, menu_only=True))
        inst.original = inst.patched = {'already': b'disabled'}
        inst.old_bot = {'id': 'bot'}
        inst.api = {'id': 'api'}
        inst.bot_running = True
        inst.before_ids = ['api', 'web']
        return inst

    def test_menu_recovery_makes_no_file_backup_or_container_changes(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()) as output:
            inst = self.menu_fixture(d)
            with patch.object(inst, 'verify_disabled_routes') as verify, \
                 patch.object(mini, 'run', return_value='') as run, \
                 patch.object(inst, 'reset_menu', return_value={'has_main_web_app': None}) as reset, \
                 patch.object(inst, 'nonbot_ids', return_value=inst.before_ids), \
                 patch.object(inst, 'bot', return_value=inst.old_bot), \
                 patch.object(inst, 'save_backup', side_effect=AssertionError('No new backup')), \
                 patch.object(inst, 'reload_web', side_effect=AssertionError('No reload')), \
                 patch.object(inst, 'recreate_bot', side_effect=AssertionError('No recreate')):
                inst.finish_menu()
            reset.assert_called_once_with(inst.old_bot)
            self.assertEqual(verify.call_count, 2)
            self.assertEqual(list(Path(d).iterdir()), [])
            run.assert_called_once()
            self.assertIn('NOVA_MINIAPP_DISABLED=YES', output.getvalue())
            self.assertIn('has_main_web_app=unknown', output.getvalue())

    def test_menu_recovery_refuses_open_routes_or_bot_with_old_app_url(self):
        for failure in ['files', 'routes', 'bot_env']:
            with tempfile.TemporaryDirectory() as d:
                inst = self.menu_fixture(d)
                if failure == 'files': inst.patched = {'still': b'enabled'}
                with patch.object(inst, 'verify_disabled_routes',
                                  side_effect=mini.Failure('open routes') if failure == 'routes' else None), \
                     patch.object(mini, 'run', side_effect=mini.Failure('bot env') if failure == 'bot_env' else None), \
                     patch.object(inst, 'reset_menu') as reset:
                    with self.assertRaises(mini.Failure): inst.finish_menu()
                reset.assert_not_called()

    def test_menu_recovery_dry_run_never_sets_remote_menu(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()):
            inst = self.menu_fixture(d)
            inst.args.dry_run = True
            with patch.object(inst, 'verify_disabled_routes'), patch.object(mini, 'run'), \
                 patch.object(inst, 'menu_container', return_value=inst.api), \
                 patch.object(mini, 'telegram', return_value={'menu': {'type': 'web_app'}}) as request, \
                 patch.object(inst, 'reset_menu') as reset:
                inst.finish_menu()
            request.assert_called_once_with('api')
            reset.assert_not_called()


class FakeCopy(copy.Installer):
    def __init__(self, app, failure=None):
        super().__init__(argparse.Namespace(app_dir=str(app), dry_run=False, restore=None))
        self.failure = failure
        self.project = 'nova'
        self.image = 'sha256:' + 'a' * 64
        self.original_env = (app / '.env').read_bytes()
        self.patched_env = copy.patch_env(self.original_env)
        self.before = [None, None]
        self.prior_compose = [str(app / 'docker-compose.yml')]
        self.before_ids = ['web', 'bot', 'db']
        self.calls = []
        self.flags_enabled = False
        self.api_changed = False

    def other_ids(self): return self.before_ids
    def current_api(self): return {'id': 'api', 'image': self.image}

    def recreate(self, prior=False):
        self.calls.append('recreate')
        self.api_changed = True

    def control(self, action, payload=None, oneoff=False):
        self.calls.append(action)
        if action == 'enable':
            self.flags_enabled = True
            if self.failure == 'lost_response': raise copy.Failure('response lost after commit')
            return {'enabled': True}
        if action == 'restore':
            self.flags_enabled = False
            return {'restored': 'restored'}
        if action == 'status':
            return {'report': {'ok': self.failure != 'unhealthy_after_restart',
                               'activeCopyConfigs': 0}}
        raise AssertionError(action)


class RolloutRules(unittest.TestCase):
    def web_fixture(self, directory):
        inst = mini.Installer(argparse.Namespace(app_dir=directory, dry_run=False, restore=None))
        inst.web = [{'id': 'web', 'labels': {'com.docker.compose.service': 'gsp-web'}}]
        inst.baseline = {'web': 'original-dashboard'}
        return inst

    def test_reload_waits_for_old_workers_then_requires_two_complete_valid_passes(self):
        for old_status in [200, 301]:
            with tempfile.TemporaryDirectory() as d, patch.object(mini.time, 'sleep') as delay:
                inst = self.web_fixture(d)
                responses = [(old_status, b'old response', '')] + [(410, b'disabled', 'no-store')] * 12
                with patch.object(inst, 'request', side_effect=responses) as request, \
                     patch.object(inst, 'site_check', return_value='original-dashboard') as site:
                    inst.verify_disabled_routes()
                self.assertEqual(request.call_count, 13)
                self.assertEqual(site.call_count, 2)
                self.assertGreaterEqual(delay.call_count, 2)
                self.assertEqual(request.call_args_list[0].args[1], '/app')
                self.assertEqual(request.call_args_list[1].args[1], '/app')

    def test_reload_keeps_failure_if_routes_stay_open_or_cache_control_is_wrong(self):
        for status, cache in [(200, ''), (301, ''), (410, 'public'), (410, 'x-no-store')]:
            with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()) as output:
                inst = self.web_fixture(d)
                with patch.object(inst, 'request', return_value=(status, b'not acceptable', cache)):
                    with self.assertRaisesRegex(mini.Failure, 'NGINX_MINIAPP_RELOAD_NOT_READY'):
                        inst.verify_disabled_routes(wait_seconds=0)
                self.assertIn('NOVA_MINIAPP_HTTP_CHECK=', output.getvalue())
                self.assertIn('"http": ' + str(status), output.getvalue())

    def test_reload_does_not_accept_a_changed_dashboard_even_when_app_is_blocked(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()) as output:
            inst = self.web_fixture(d)
            with patch.object(inst, 'request', return_value=(410, b'disabled', 'no-store')), \
                 patch.object(inst, 'site_check', return_value='unexpected new page'):
                with self.assertRaises(mini.Failure): inst.verify_disabled_routes(wait_seconds=0)
            self.assertIn('DASHBOARD_OR_API_HEALTH_CHANGED', output.getvalue())

    def test_render_verification_reports_stale_mount_without_dumping_configuration(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()) as output:
            inst = self.web_fixture(d)
            path = Path(d) / mini.TEMPLATES['gsp-web']
            path.parent.mkdir(parents=True)
            path.write_bytes(mini.patch_template(TEMPLATE))
            with patch.object(mini, 'run', side_effect=['', '', 'old rendered config', 'private-old-template-value']):
                with self.assertRaisesRegex(mini.Failure, 'NGINX_RENDERED_MINIAPP_BLOCK_MISSING'):
                    inst.render_and_validate(require_disabled=True)
            self.assertIn('"mountedTemplateMatchesHost": false', output.getvalue())
            self.assertNotIn('private-old-template-value', output.getvalue())

    def fixture(self, directory, failure=None):
        root = Path(directory)
        (root / '.env').write_bytes(b'LIVE_TRADING=false\nMINIAPP_URL=\nPRIVATE_KEY_ENV=preserved\n')
        return FakeCopy(root, failure)

    def test_activation_preserves_minapp_disable_and_other_settings(self):
        with tempfile.TemporaryDirectory() as d, patch.object(copy, 'run', return_value=''), \
                patch.object(copy.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            inst = self.fixture(d)
            inst.apply()
            self.assertTrue(inst.flags_enabled)
            self.assertIn(b'MINIAPP_URL=\nPRIVATE_KEY_ENV=preserved', (Path(d) / '.env').read_bytes())
            self.assertEqual(inst.calls, ['enable', 'recreate', 'status'])

    def test_post_restart_failure_restores_modes_and_flags_but_keeps_miniapp_off(self):
        with tempfile.TemporaryDirectory() as d, patch.object(copy, 'run', return_value=''), \
                patch.object(copy.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            inst = self.fixture(d, 'unhealthy_after_restart')
            with self.assertRaises(copy.Failure): inst.apply()
            self.assertFalse(inst.flags_enabled)
            self.assertEqual((Path(d) / '.env').read_bytes(), inst.original_env)
            self.assertIn('restore', inst.calls)

    def test_lost_enable_response_is_reconciled_and_restored(self):
        with tempfile.TemporaryDirectory() as d, patch.object(copy, 'run', return_value=''), \
                patch.object(copy.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
            inst = self.fixture(d, 'lost_response')
            with self.assertRaises(copy.Failure): inst.apply()
            self.assertFalse(inst.flags_enabled)
            self.assertEqual((Path(d) / '.env').read_bytes(), inst.original_env)
            self.assertIn('restore', inst.calls)

    def test_rollback_refuses_to_overwrite_later_env_edits(self):
        with tempfile.TemporaryDirectory() as d, patch.object(copy, 'run', return_value=''), \
                contextlib.redirect_stdout(io.StringIO()):
            inst = self.fixture(d)
            inst.save()
            newer = inst.original_env + b'NEW_MANUAL_SETTING=value\n'
            (Path(d) / '.env').write_bytes(newer)
            with self.assertRaises(copy.Failure): inst.restore_state()
            self.assertEqual((Path(d) / '.env').read_bytes(), newer)
            self.assertNotIn('restore', inst.calls)

    def test_symlink_env_does_not_get_rewritten(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / 'actual'; target.write_bytes(b'saved')
            link = Path(d) / '.env'; link.symlink_to(target)
            with self.assertRaises(copy.Failure): copy.ops.read_file(link)
            self.assertEqual(target.read_bytes(), b'saved')

    def test_blocked_preflight_makes_no_env_db_or_container_changes(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()):
            root = Path(d)
            original = b'LIVE_TRADING=false\nMINIAPP_URL=\n'
            (root / '.env').write_bytes(original)
            (root / 'compose.override.yaml').write_text('services: {}\n')
            containers = [{
                'id': service, 'image': 'sha256:' + 'a' * 64, 'running': True,
                'labels': {
                    'com.docker.compose.service': service,
                    'com.docker.compose.project': 'nova',
                    'com.docker.compose.project.working_dir': d,
                    'com.docker.compose.project.config_files': d + '/docker-compose.yml',
                }} for service in ['api', 'gsp-web']]
            inst = copy.Installer(argparse.Namespace(app_dir=d, dry_run=True, restore=None))
            result = {'report': {'ok': False, 'blockers': ['SCANNER_UNHEALTHY_REPAIR_RPC_OR_WS']}}
            def read_command(argv, label, data=None):
                if argv[0] == 'git': return 'https://github.com/Rezamoradifar/nova-solana-ai-sniper.git'
                if argv[:3] == ['docker', 'context', 'inspect']: return '"unix:///var/run/docker.sock"'
                raise AssertionError('Unexpected mutating command: ' + repr(argv))
            with patch.object(copy, 'run', side_effect=read_command), \
                 patch.object(copy.ops, 'containers', return_value=containers), \
                 patch.dict(os.environ, {'COMPOSE_FILE': 'unused-by-explicit-operator-commands.yml'}), \
                 patch.object(inst, 'control', return_value=result) as control:
                with self.assertRaises(copy.Failure): inst.preflight()
                control.assert_called_once_with('prepare')
            self.assertEqual((root / '.env').read_bytes(), original)
            self.assertFalse((root / 'data').exists())
            self.assertFalse(inst.mutated)

    def test_minapp_render_failure_restores_env_and_both_templates(self):
        with tempfile.TemporaryDirectory() as d, contextlib.redirect_stdout(io.StringIO()):
            root = Path(d)
            inst = mini.Installer(argparse.Namespace(app_dir=d, dry_run=False, restore=None))
            inst.project = 'nova'
            inst.original = {mini.FILES[0]: b'MINIAPP_URL=https://a/app/\nLIVE_TRADING=false\n',
                             mini.FILES[1]: TEMPLATE, mini.FILES[2]: TEMPLATE}
            inst.patched = {mini.FILES[0]: mini.patch_env(inst.original[mini.FILES[0]]),
                            mini.FILES[1]: mini.patch_template(TEMPLATE),
                            mini.FILES[2]: mini.patch_template(TEMPLATE)}
            for name, data in inst.original.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            inst.bot_running = False
            inst.bot_image = None
            inst.menu_before = {'menu': {'type': 'commands'}}
            inst.before_ids = ['api', 'web', 'db']
            with patch.object(inst, 'render_and_validate', side_effect=[mini.Failure('invalid nginx'), None]), \
                 patch.object(inst, 'reload_web'), \
                 patch.object(inst, 'nonbot_ids', return_value=inst.before_ids):
                with self.assertRaises(mini.Failure): inst.apply()
            for name, data in inst.original.items():
                self.assertEqual((root / name).read_bytes(), data)


if __name__ == '__main__': unittest.main()
