"""Stateful CLI contract checks: protect a running site and recover archived tags."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a = sys.argv[1:]; root = Path(os.environ['TEST_REPO'])
with (root/'calls').open('a') as f: f.write(json.dumps(a)+'\n')
statefile=root/'images.json'; state=json.loads(statefile.read_text()) if statefile.exists() else {}
if a[:2] == ['image', 'tag']:
    state[a[3]]=a[2]; statefile.write_text(json.dumps(state))
elif a[:2] == ['image', 'save']:
    if os.environ.get('FAIL_SAVE'): sys.exit(2)
    Path(a[3]).write_text(json.dumps(state))
elif a[:2] == ['image', 'load']:
    state=json.loads(Path(a[3]).read_text()); statefile.write_text(json.dumps(state))
elif a[:2] == ['image', 'inspect']:
    if os.environ.get('NO_IMAGES'): sys.exit(1)
    if a[-1].startswith('nova-platform-') and a[-1] not in state: sys.exit(1)
elif a[0] == 'inspect': print('sha256:old-'+a[-1])
elif 'ps' in a and '-aq' in a: print(a[-1]+'-container')
elif 'config' in a and '--images' in a: print('nova-current-'+a[-1])
elif 'build' in a:
    if os.environ.get('FAIL_BUILD'): sys.exit(2)
    statefile.write_text('{}')
elif 'run' in a and 'status' in a and os.environ.get('FAIL_SCHEMA'): sys.exit(2)
elif 'up' in a and '--no-deps' in a:
    override=next((x for x in a if x.endswith('rollback.yml')),None)
    if override:
        text=Path(override).read_text()
        assert all(tag in text for tag in state) and len(state)==2
        assert '--pull' in a and a[a.index('--pull')+1]=='never'
    elif os.environ.get('FAIL_CUTOVER'): sys.exit(2)
elif 'port' in a: print('0.0.0.0:8088')
elif 'exec' in a and '/health/ready' in ' '.join(a) and os.environ.get('FAIL_RPC'): sys.exit(1)
'''

class DeployTests(unittest.TestCase):
    def run_deploy(self, **flags):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'bin').mkdir()
            shutil.copy2(ROOT/'scripts/deploy-platform.sh', root/'deploy.sh')
            original='LIVE_TRADING=false\nGSP_WEB_PORT=8088\nHELIUS_API_KEY=secret-do-not-print\n'
            (root/'.env').write_text(original); (root/'docker-compose.yml').write_text('services: {}')
            programs={'docker':DOCKER,'git':'#!/bin/sh\necho verified-revision\n','curl':'#!/bin/sh\nexit 0\n','sleep':'#!/bin/sh\nexit 0\n'}
            for name, value in programs.items():
                path=root/'bin'/name; path.write_text(value); path.chmod(0o755)
            env={**os.environ, **flags, 'PATH':str(root/'bin')+os.pathsep+os.environ['PATH'],'TEST_REPO':str(root)}
            result=subprocess.run(['bash',str(root/'deploy.sh'),str(root)],env=env,text=True,capture_output=True)
            calls=[json.loads(line) for line in (root/'calls').read_text().splitlines()]
            self.assertEqual((root/'.env').read_text(),original)
            self.assertNotIn('secret-do-not-print',result.stdout+result.stderr)
            return result,calls

    def test_success_separates_rpc_failure_from_website_health(self):
        result,calls=self.run_deploy(FAIL_RPC='1')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('PLATFORM_HTTP_OK',result.stdout)
        self.assertIn('TRADING_DEPENDENCIES_NOT_READY',result.stdout)
        self.assertFalse(any('down' in c or 'prune' in c or 'enable' in c for c in calls))
        self.assertLess(next(i for i,c in enumerate(calls) if 'save' in c),next(i for i,c in enumerate(calls) if 'build' in c))

    def test_archive_failure_does_not_build_or_cut_over(self):
        result,calls=self.run_deploy(FAIL_SAVE='1')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any('build' in c or 'up' in c for c in calls))

    def test_build_failure_does_not_replace_containers(self):
        result,calls=self.run_deploy(FAIL_BUILD='1')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any('up' in c for c in calls))

    def test_pending_schema_does_not_cut_over(self):
        result,calls=self.run_deploy(FAIL_SCHEMA='1')
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any('up' in c and '--no-deps' in c for c in calls))

    def test_failed_cutover_reloads_archive_before_restoring_tags(self):
        result,calls=self.run_deploy(FAIL_CUTOVER='1')
        self.assertNotEqual(result.returncode,0)
        load=next(i for i,c in enumerate(calls) if c[:2]==['image','load'])
        restore=next(i for i,c in enumerate(calls) if 'up' in c and any(x.endswith('rollback.yml') for x in c))
        self.assertLess(load,restore)
        self.assertIn('Archived images restored',result.stderr)

    def test_recovers_when_legacy_image_ids_are_missing(self):
        result,_=self.run_deploy(NO_IMAGES='1')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('RECOVERY_BUILD_REQUIRED',result.stdout)
        self.assertIn('PLATFORM_HTTP_OK',result.stdout)

if __name__=='__main__': unittest.main()
