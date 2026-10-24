#!/usr/bin/env python3
"""Deployment boundaries, bootstrap sequencing and opt-in real Compose integration."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('nova_luxury_deploy', Path(__file__).with_name('deploy-nova-mainnet-luxury.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
IMAGE_A = 'sha256:' + 'a' * 64
IMAGE_B = 'sha256:' + 'b' * 64


class MainnetDeployment(unittest.TestCase):
    def installer(self):
        value = deploy.Installer.__new__(deploy.Installer)
        value.app = Path('/opt/nova-solana-ai-sniper'); value.public = 'https://moneyland.tr'; value.project = 'nova'
        value.args = SimpleNamespace(repair_rpc=False, activate_copy=False)
        return value

    def test_combines_different_api_web_contexts_and_keeps_unrelated_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory); base = str(app / 'docker-compose.yml')
            first, second = app/'api.json', app/'web.json'
            first.write_text(json.dumps({'services':{'api':{'image':'old-api'},'telegram-bot':{'image':'bot:fixed'}}}))
            second.write_text(json.dumps({'services':{'api':{'image':'stale-api'},'gsp-web':{'image':'old-web'}}}))
            result = deploy.merge_images(app, [[base,str(first)],[base,str(second)]], {'api':IMAGE_A,'gsp-web':IMAGE_B})
            self.assertEqual(result['services']['api'], {'image':IMAGE_A,'pull_policy':'never'})
            self.assertEqual(result['services']['gsp-web'], {'image':IMAGE_B,'pull_policy':'never'})
            self.assertEqual(result['services']['telegram-bot'], {'image':'bot:fixed'})

    def test_rejects_conflicting_unrelated_images_and_non_image_overlays(self):
        with tempfile.TemporaryDirectory() as directory:
            app=Path(directory); base=str(app/'docker-compose.yml'); first=app/'one.json'; second=app/'two.json'
            first.write_text(json.dumps({'services':{'telegram-bot':{'image':'bot:one'}}}))
            second.write_text(json.dumps({'services':{'telegram-bot':{'image':'bot:two'}}}))
            with self.assertRaises(deploy.Failure): deploy.merge_images(app,[[base,str(first)],[base,str(second)]],{'api':IMAGE_A,'gsp-web':IMAGE_B})
            second.write_text(json.dumps({'services':{'api':{'image':'api:old','environment':{'KILL_SWITCH':'false'}}}}))
            with self.assertRaises(deploy.Failure): deploy.merge_images(app,[[base,str(second)]],{'api':IMAGE_A,'gsp-web':IMAGE_B})

    def test_recreation_and_nginx_refresh_never_recreate_dependencies(self):
        value=self.installer()
        with patch.object(deploy.ops,'run',return_value='') as run:
            value.recreate_target(Path('/private/release.json'),'api')
            value.recreate_target(Path('/private/release.json'),'gsp-web')
            with self.assertRaises(deploy.Failure): value.recreate_target(Path('/private/release.json'),'postgres')
        for call, target in zip(run.call_args_list,deploy.TARGETS):
            command=call.args[0]
            self.assertEqual(command[command.index('up'):],['up','-d','--no-deps','--no-build','--pull','never','--force-recreate',target])

    def test_api_becomes_live_before_web_resolves_its_new_address(self):
        value=self.installer(); events=[]
        with patch.object(value,'recreate_target',side_effect=lambda _overlay,service:events.append(service)), patch.object(value,'wait_api',side_effect=lambda:events.append('api-live')):
            value.replace(Path('/private/release.json'))
        self.assertEqual(events,['api','api-live','gsp-web'])

    def test_restore_refuses_a_later_release_of_either_component(self):
        expected={'api':IMAGE_A,'gsp-web':IMAGE_B}; rows={s:{'image':image} for s,image in expected.items()}
        deploy.require_restore_images(rows,expected)
        for service in deploy.TARGETS:
            altered={s:dict(row) for s,row in rows.items()};altered[service]['image']='later-image'
            with self.assertRaises(deploy.Failure): deploy.require_restore_images(altered,expected)

    def test_live_modes_prevent_api_image_replacement(self):
        value=self.installer()
        with patch.object(value,'state',return_value=({'api':{'id':'api-container'}},[])):
            for flags in [{'live':'true','paper':'false','copy':'true'}, {'live':'false','paper':'true','copy':'true'}]:
                with patch.object(deploy.ops,'run',return_value=json.dumps(flags)), self.assertRaises(deploy.Failure): value.require_stopped()
            with patch.object(deploy.ops,'run',return_value=json.dumps({'live':'false','paper':'true','copy':'false'})): value.require_stopped()

    def test_current_compose_hash_is_checked_for_each_target(self):
        value=self.installer()
        for service in deploy.TARGETS:
            row={'labels':{'com.docker.compose.service':service,'com.docker.compose.config-hash':'a'*64}}
            with patch.object(deploy.ops,'run',return_value=service+' '+'a'*64) as run:
                value.verify_current_config(row,[str(value.app/'docker-compose.yml')])
                self.assertEqual(run.call_args.args[0][-3:],['config','--hash',service])
            with patch.object(deploy.ops,'run',return_value=service+' '+'b'*64),self.assertRaises(deploy.Failure):
                value.verify_current_config(row,[str(value.app/'docker-compose.yml')])

    def test_mainnet_requires_fresh_matching_chain_evidence(self):
        value={'mainnetVerified':True,'genesisHash':deploy.GENESIS,'chain':'solana','cluster':'mainnet-beta','status':'ready','slot':100,'checkedAt':time.time()*1000}
        self.assertTrue(deploy.mainnet_verified(value))
        for changes in [{'genesisHash':'devnet'},{'checkedAt':0},{'slot':0},{'cluster':'devnet'},{'mainnetVerified':False}]:
            self.assertFalse(deploy.mainnet_verified({**value,**changes}))

    def test_rpc_failure_cannot_continue_to_copy_activation(self):
        value=self.installer();value.args.activate_copy=True
        with patch.object(deploy,'public_json',side_effect=[{'mainnetVerified':False},{'scanner':{'state':'UNHEALTHY'}}]),patch.object(value,'operator_step',side_effect=deploy.Failure('RPC not ready')) as run:
            with self.assertRaises(deploy.Failure):value.complete_connection()
        self.assertEqual([call.args[0] for call in run.call_args_list],['configure-nova-copy-rpc.py'])

    def test_site_image_release_does_not_implicitly_repair_rpc_or_activate_copy(self):
        value=self.installer()
        with patch.object(value,'operator_step') as run,patch.object(deploy,'public_json') as read:
            value.complete_connection()
        run.assert_not_called();read.assert_not_called()

    def test_successful_rpc_and_copy_steps_reuse_existing_gated_helpers(self):
        value=self.installer();value.args.activate_copy=True
        good={'mainnetVerified':True,'genesisHash':deploy.GENESIS,'chain':'solana','cluster':'mainnet-beta','status':'ready','slot':100,'checkedAt':time.time()*1000,'source':'dedicated'}
        with patch.object(deploy,'public_json',side_effect=[{'mainnetVerified':False},{'scanner':{'state':'UNHEALTHY'}},good,{'executionMode':'live','copyWatcherReady':True,'liveExecutionEnabled':True,'watcher':{'running':True,'healthy':True},'buyReadiness':{'ready':True,'blockers':[]}}]),patch.object(value,'operator_step') as run,patch.object(deploy.web,'check_site'):
            value.complete_connection()
        self.assertEqual([call.args for call in run.call_args_list],[('configure-nova-copy-rpc.py',),('enable-live-copy-trading.py','--release-bootstrap-stop')])

    def test_nginx_is_refreshed_even_when_operator_helper_rolls_back(self):
        value=self.installer()
        with patch.object(deploy.subprocess,'run',return_value=SimpleNamespace(returncode=1)),patch.object(value,'reload_web') as refresh:
            with self.assertRaises(deploy.Failure):value.operator_step('configure-nova-copy-rpc.py')
        refresh.assert_called_once()

    @unittest.skipUnless(os.environ.get('NOVA_MAINNET_COMPOSE_INTEGRATION')=='1','opt-in real Docker Compose check')
    def test_real_api_and_web_hashes_image_only_rollout_and_protected_identity(self):
        def run(command): return subprocess.run(command,check=True,capture_output=True,text=True).stdout
        with tempfile.TemporaryDirectory(prefix='nova-mainnet-compose-') as directory:
            app=Path(directory);(app/'.env').write_text('PAPER_TRADING=true\n')
            run(['git','init',str(app)]);run(['git','-C',str(app),'remote','add','origin','https://github.com/Rezamoradifar/nova-solana-ai-sniper.git'])
            (app/'docker-compose.yml').write_text('services:\n  api:\n    image: nginx:alpine\n  gsp-web:\n    image: nginx:alpine\n  telegram-bot:\n    image: nginx:alpine\n')
            project='nova-mainnet-test-'+uuid.uuid4().hex[:10]
            base=['docker','compose','--project-directory',str(app),'--env-file',str(app/'.env'),'-p',project,'-f',str(app/'docker-compose.yml')]
            run(['docker','pull','nginx:alpine'])
            try:
                run(base+['up','-d','--no-build','--pull','never'])
                value=deploy.Installer(SimpleNamespace(app_dir=str(app),public_url='https://moneyland.tr'))
                value.discover();self.assertEqual(value.project,project)
                before,protected=value.state();images={s:r['image'] for s,r in before.items()}
                overlay=app/'release.json';value.write(overlay,deploy.merge_images(app,value.contexts,images))
                value.unchanged_inputs()
                for service in deploy.TARGETS:value.recreate_target(overlay,service)
                after,after_protected=value.state()
                self.assertEqual(protected,after_protected)
                self.assertTrue(all(before[s]['id']!=after[s]['id'] for s in deploy.TARGETS))
                value.discover()
                self.assertTrue(all(str(overlay) in c for c in value.contexts))
                deploy.require_restore_images(after,images)
            finally:run(base+['down','--remove-orphans'])


if __name__=='__main__':unittest.main(verbosity=2)
