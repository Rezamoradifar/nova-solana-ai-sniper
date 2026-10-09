"""Exercise rollout ordering/rollback with a fake Docker CLI; no real server calls."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKER = r'''#!/usr/bin/env python3
import os, sys
from pathlib import Path
a = sys.argv[1:]
root = Path(os.environ['TEST_REPO'])
with (root/'calls').open('a') as f: f.write(' '.join(a)+'\n')
if a[:4] == ['compose', 'ps', '-q', 'api']: print('api-id')
elif a[:4] == ['compose', 'ps', '-q', 'gsp-web']: print('web-id')
elif a[0] == 'inspect':
    print(str(root/'docker-compose.yml') if 'config_files' in a[2] else 'sha256:old-'+a[-1])
elif 'status' in a: print('null')
elif 'build' in a and os.environ.get('FAIL_BUILD'): sys.exit(2)
elif 'enable' in a:
    assert 'COPY_TRADING_EXECUTION_ENABLED=true' in (root/'.env').read_text()
elif 'up' in a and os.environ.get('FAIL_CUTOVER') and '-f' not in a: sys.exit(2)
elif '-e' in a: print('{"watcher":"healthy","executionMode":"paper"}')
'''

class RolloutTests(unittest.TestCase):
    def run_rollout(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'bin').mkdir(); (root/'scripts').mkdir()
            for name in ['enable-copy-trading.sh', 'copy-trading-feature.mjs']:
                shutil.copy2(ROOT/'scripts'/name, root/'scripts'/name)
            (root/'docker-compose.yml').write_text('services: {}\n')
            original = 'LIVE_TRADING=false\nRPC_KEY=do-not-print\nCOPY_TRADING_EXECUTION_ENABLED=false\n'
            (root/'.env').write_text(original)
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
        self.assertLess(calls.index('build api gsp-web'), calls.index(' - enable'))
        self.assertIn('up -d --no-deps --no-build api gsp-web', calls)
        self.assertNotIn(' stop ', calls)

    def test_build_failure_leaves_activation_and_containers_untouched(self):
        result, contents, calls, original = self.run_rollout(FAIL_BUILD='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertNotIn(' - enable', calls)
        self.assertNotIn('up -d', calls)

    def test_cutover_failure_restores_flags_and_pinned_images(self):
        result, contents, calls, original = self.run_rollout(FAIL_CUTOVER='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(contents, original)
        self.assertIn(' - restore null', calls)
        self.assertIn('rollback.yml up -d --no-deps --no-build', calls)

if __name__ == '__main__': unittest.main()
