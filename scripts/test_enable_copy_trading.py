"""Exercise rollout ordering/rollback with a fake Docker CLI; no real server calls."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKER = r'''#!/usr/bin/env python3
import json, os, re, sys
from pathlib import Path
a = sys.argv[1:]
root = Path(os.environ['TEST_REPO'])
with (root/'calls').open('a') as f: f.write(' '.join(a)+'\n')
statefile=root/'image-state.json'
state=json.loads(statefile.read_text()) if statefile.exists() else {}
if a[:2] == ['image','tag']:
    state[a[3]]=a[2]; statefile.write_text(json.dumps(state))
elif a[:2] == ['image','save']:
    if os.environ.get('FAIL_SAVE'): sys.exit(2)
    Path(a[3]).write_text(json.dumps(state))
elif a[:2] == ['image','load']:
    state=json.loads(Path(a[3]).read_text()); statefile.write_text(json.dumps(state))
elif a[:2] == ['image','inspect']:
    if '--format' in a:
        tag = a[-1]
        if tag not in state: sys.exit(1)
        print('sha256:wrong' if os.environ.get('MISMATCH_ROLLBACK') else state[tag])
        sys.exit(0)
    for tag in a[2:]:
        if tag.startswith('nova-copy-rollback-') and tag not in state: sys.exit(1)
        if tag.startswith('nova-current-') and os.environ.get('MISSING_CURRENT_IMAGE'): sys.exit(1)
elif 'config' in a and '--images' in a: print('nova-current-api:latest\nnova-current-web:latest')
elif a[:4] == ['compose', 'ps', '-q', 'api']: print('api-id')
elif a[:4] == ['compose', 'ps', '-q', 'gsp-web']: print('web-id')
elif a[0] == 'inspect':
    if 'config_files' in a[2]:
        value = str(root/'docker-compose.yml')
        if os.environ.get('MANAGED_ROLLBACK'): value += ',' + str(root/'backups/copy-trading-20261015T170327Z-KVhx5W/rollback.yml')
        if os.environ.get('EXTRA_COMPOSE'): value += ',' + str(root/'custom.yml')
        print(value)
    else: print('sha256:old-'+a[-1])
elif 'status' in a: print('null')
elif 'run' in a and 'api' in a and a[-1] == '-' and os.environ.get('FAIL_RPC'): sys.exit(1)
elif a[:4] == ['compose', 'run', '--rm', 'migrate'] and os.environ.get('FAIL_MIGRATION'): sys.exit(2)
elif 'build' in a and os.environ.get('FAIL_BUILD'): sys.exit(2)
elif 'build' in a and os.environ.get('DROP_ROLLBACK_IMAGES'): statefile.write_text('{}')
elif 'enable' in a:
    assert 'COPY_TRADING_EXECUTION_ENABLED=true' in (root/'.env').read_text()
elif 'restore' in a:
    if os.environ.get('FAIL_RESTORE'): sys.exit(2)
    if any(x.endswith('rollback.yml') for x in a):
        assert '--pull' in a and a[a.index('--pull')+1]=='never'
        text=Path(next(x for x in a if x.endswith('rollback.yml'))).read_text()
        tags=re.findall(r'image: "([^"]+)"',text)
        assert len(tags)==2 and all(t in state for t in tags)
elif 'up' in a and os.environ.get('FAIL_CUTOVER') and '-f' not in a: sys.exit(2)
elif 'up' in a and any(x.endswith('rollback.yml') for x in a):
    assert '--pull' in a and a[a.index('--pull')+1]=='never'
    text=Path(next(x for x in a if x.endswith('rollback.yml'))).read_text()
    tags=re.findall(r'image: "([^"]+)"',text)
    assert len(tags)==2 and all(t in state and not t.startswith('sha256:') for t in tags)
elif '-e' in a: print('{"watcher":"healthy","executionMode":"paper"}')
'''

class RolloutTests(unittest.TestCase):
    def run_rollout(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'bin').mkdir(); (root/'scripts').mkdir()
            for name in ['enable-copy-trading.sh', 'copy-trading-feature.mjs', 'check-solana-rpc.mjs']:
                shutil.copy2(ROOT/'scripts'/name, root/'scripts'/name)
            (root/'docker-compose.yml').write_text('services: {}\n')
            original = 'LIVE_TRADING=false\nRPC_KEY=do-not-print\nCOPY_TRADING_EXECUTION_ENABLED=false\n'
            (root/'.env').write_text(original)
            if overrides.get('MANAGED_ROLLBACK'):
                name = 'copy-trading-20261015T170327Z-KVhx5W'
                saved = root/'backups'/name; saved.mkdir(parents=True)
                manifest = ('services:\n  api:\n    image: "nova-copy-rollback-api:' + name +
                    '"\n    pull_policy: never\n  gsp-web:\n    image: "nova-copy-rollback-web:' + name +
                    '"\n    pull_policy: never\n')
                if overrides.get('TAMPER_ROLLBACK'): manifest += '    privileged: true\n'
                (saved/'rollback.yml').write_text(manifest)
                (root/'image-state.json').write_text(__import__('json').dumps({
                    'nova-copy-rollback-api:'+name: 'sha256:old-api-id',
                    'nova-copy-rollback-web:'+name: 'sha256:old-web-id',
                }))
            docker = root/'bin/docker'; docker.write_text(DOCKER); docker.chmod(0o755)
            env = {**os.environ, 'TEST_REPO': str(root), 'PATH': str(root/'bin')+':'+os.environ['PATH'], **overrides}
            env.pop('COMPOSE_FILE', None)
            result = subprocess.run(['bash', 'scripts/enable-copy-trading.sh'], cwd=root, env=env, text=True, capture_output=True)
            return result, (root/'.env').read_text(), (root/'calls').read_text(), original

    def test_success_preserves_live_mode_and_secrets(self):
        result, contents, calls, _ = self.run_rollout()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('LIVE_TRADING=false', contents)
        self.assertIn('COPY_TRADING_EXECUTION_ENABLED=true', contents)
        self.assertNotIn('do-not-print', result.stdout+result.stderr+calls)
        self.assertLess(calls.index('build api gsp-web migrate'), calls.index('run --rm migrate'))
        self.assertLess(calls.index('run --rm migrate'), calls.index(' - enable'))
        self.assertIn('up -d --no-deps --no-build api gsp-web', calls)
        self.assertNotIn(' stop ', calls)

    def test_build_failure_leaves_activation_and_containers_untouched(self):
        result, contents, calls, original = self.run_rollout(FAIL_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn(' - enable', calls)
        self.assertNotIn('up -d', calls)

    def test_migration_failure_leaves_activation_and_containers_untouched(self):
        result, contents, calls, original = self.run_rollout(FAIL_MIGRATION='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn('run --rm migrate', calls)
        self.assertNotIn(' - enable', calls)
        self.assertNotIn('up -d', calls)

    def test_archive_failure_stops_before_build_and_activation(self):
        result, contents, calls, original = self.run_rollout(FAIL_SAVE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn('build api', calls)
        self.assertNotIn(' - enable', calls)
        self.assertNotIn('up -d', calls)

    def test_rpc_failure_stops_before_build_or_activation(self):
        result, contents, calls, original = self.run_rollout(FAIL_RPC='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn('build api', calls)
        self.assertNotIn(' - enable', calls)
        self.assertNotIn('up -d', calls)

    def test_cutover_failure_restores_flags_and_pinned_images(self):
        result, contents, calls, original = self.run_rollout(FAIL_CUTOVER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn(' - restore null', calls)
        self.assertIn('rollback.yml up -d --no-deps --no-build --pull never', calls)
        self.assertLess(calls.index('image save'), calls.index('build api'))

    def test_missing_rollback_tags_are_reloaded_from_archive(self):
        result, contents, calls, original = self.run_rollout(FAIL_CUTOVER='1', DROP_ROLLBACK_IMAGES='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn('image load --input', calls)
        self.assertLess(calls.index('image load --input'), calls.index(' - restore'))
        self.assertIn('Rollback commands completed', result.stderr)

    def test_feature_restore_failure_does_not_start_rollback_containers(self):
        result, contents, calls, original = self.run_rollout(FAIL_CUTOVER='1', FAIL_RESTORE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn('rollback.yml up', calls)
        self.assertIn('Rollback incomplete', result.stderr)

    def test_retry_accepts_verified_installer_rollback_and_preflights_running_image(self):
        result, contents, calls, _ = self.run_rollout(MANAGED_ROLLBACK='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Verified installer rollback detected', result.stdout)
        self.assertIn('COPY_TRADING_EXECUTION_ENABLED=true', contents)
        preflight = next(line for line in calls.splitlines() if 'run' in line and line.endswith(' -'))
        self.assertIn('rollback.yml', preflight)
        self.assertIn('--no-build --pull never', preflight)
        self.assertLess(calls.index(preflight), calls.index('build api'))

    def test_modified_rollback_is_rejected_before_backup_or_activation(self):
        result, contents, calls, original = self.run_rollout(MANAGED_ROLLBACK='1', TAMPER_ROLLBACK='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn('image-only format', result.stderr)
        self.assertNotIn('image save', calls)
        self.assertNotIn('up -d', calls)

    def test_mismatched_rollback_image_is_rejected(self):
        result, contents, calls, original = self.run_rollout(MANAGED_ROLLBACK='1', MISMATCH_ROLLBACK='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn('does not match', result.stderr)
        self.assertNotIn('build api', calls)

    def test_custom_compose_is_still_rejected(self):
        result, contents, calls, original = self.run_rollout(EXTRA_COMPOSE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn('image save', calls)

    def test_retry_cutover_failure_restores_new_backup_of_running_images(self):
        result, contents, calls, original = self.run_rollout(MANAGED_ROLLBACK='1', FAIL_CUTOVER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn('Rollback commands completed', result.stderr)
        self.assertIn('rollback.yml up -d --no-deps --no-build --pull never', calls)


class RecoveryTests(unittest.TestCase):
    def run_recovery(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'bin').mkdir(); (root/'scripts').mkdir()
            saved=root/'backups/failed'; saved.mkdir(parents=True)
            for name in ['recover-copy-trading.sh', 'copy-trading-feature.mjs']:
                shutil.copy2(ROOT/'scripts'/name, root/'scripts'/name)
            (root/'docker-compose.yml').write_text('services: {}\n')
            before='LIVE_TRADING=false\nCOPY_TRADING_EXECUTION_ENABLED=true\nKEY=private-key\n'
            original=before.replace('COPY_TRADING_EXECUTION_ENABLED=true','COPY_TRADING_EXECUTION_ENABLED=false')
            (root/'.env').write_text(before); (saved/'env').write_text(original)
            (saved/'feature.json').write_text('null')
            (saved/'rollback.yml').write_text('image: sha256:missing-old-image\n')
            docker=root/'bin/docker'; docker.write_text(DOCKER); docker.chmod(0o755)
            env={**os.environ,'TEST_REPO':str(root),'PATH':str(root/'bin')+':'+os.environ['PATH'],**overrides}
            env.pop('COMPOSE_FILE',None)
            run=subprocess.run(['bash','scripts/recover-copy-trading.sh',str(saved)],cwd=root,env=env,text=True,capture_output=True)
            return run,(root/'.env').read_text(),(root/'calls').read_text(),before,original

    def test_uses_current_images_and_restores_prior_activation(self):
        run, contents, calls, _, original=self.run_recovery()
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertEqual(contents,original)
        self.assertIn('RECOVERY_HTTP_OK',run.stdout)
        self.assertNotIn('rollback.yml',calls)
        self.assertNotIn('build api',calls)
        self.assertIn('up -d --no-deps --no-build --pull never api gsp-web',calls)
        self.assertLess(calls.index(' - restore null'),calls.index('up -d'))
        self.assertNotIn('private-key',run.stdout+run.stderr+calls)

    def test_missing_current_image_leaves_environment_and_containers_untouched(self):
        run,contents,calls,before,_=self.run_recovery(MISSING_CURRENT_IMAGE='1')
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(contents,before)
        self.assertIn('RECOVERY_IMAGES_MISSING',run.stderr)
        self.assertNotIn(' - restore',calls)
        self.assertNotIn('up -d',calls)

    def test_feature_restore_failure_stops_recovery_before_start(self):
        run,_,calls,_,_=self.run_recovery(FAIL_RESTORE='1')
        self.assertNotEqual(run.returncode,0)
        self.assertNotIn('up -d',calls)
        self.assertNotIn('RECOVERY_HTTP_OK',run.stdout)

if __name__ == '__main__': unittest.main()
