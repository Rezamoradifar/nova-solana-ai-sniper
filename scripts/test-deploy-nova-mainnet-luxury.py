#!/usr/bin/env python3
"""Deployment boundaries, bootstrap sequencing and opt-in real Compose integration."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
from contextlib import redirect_stdout
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

    def test_retains_original_full_image_identity_using_bare_id(self):
        value=self.installer();value.rows={'api':{'id':'api-container','image':IMAGE_A}}
        with tempfile.TemporaryDirectory(prefix='release-') as directory:
            backup=Path(directory);tag='nova-mainnet-backup-api:'+backup.name
            def docker(command,**_kwargs):
                if command[1:3]==['image','tag']:
                    self.assertEqual(command[3:],[IMAGE_A[7:],tag])
                    return SimpleNamespace(returncode=0,stdout='',stderr='')
                return SimpleNamespace(returncode=0,stdout=IMAGE_A+'\n',stderr='')
            with patch.object(deploy.subprocess,'run',side_effect=docker) as run:
                self.assertEqual(value.retain_images(backup,{'api':IMAGE_A}),{'api':tag})
            self.assertEqual(run.call_args_list[-2].args[0][-1],tag)
            self.assertEqual(run.call_args_list[-1].args[0][-1],IMAGE_A)

    def test_tag_failure_can_use_only_a_verified_original_reference(self):
        value=self.installer();value.rows={'api':{'id':'api-container'}}
        with tempfile.TemporaryDirectory(prefix='release-') as directory:
            def docker(command,**_kwargs):
                if command[1:3]==['container','inspect']:
                    return SimpleNamespace(returncode=0,stdout='installed-api:old\n',stderr='')
                if command[1:3]==['image','tag'] and command[3]!='installed-api:old':
                    return SimpleNamespace(returncode=1,stdout='',stderr='No such image: original ID')
                return SimpleNamespace(returncode=0,stdout=IMAGE_A+'\n',stderr='')
            with patch.object(deploy.subprocess,'run',side_effect=docker) as run:
                value.retain_images(Path(directory),{'api':IMAGE_A})
            tags=[c.args[0][3] for c in run.call_args_list if c.args[0][1:3]==['image','tag']]
            self.assertEqual(tags,[IMAGE_A[7:],IMAGE_A,'installed-api:old'])

    def test_a_moved_original_tag_is_never_accepted_as_the_backup(self):
        value=self.installer();value.rows={'api':{'id':'api-container'}}
        with tempfile.TemporaryDirectory(prefix='release-') as directory:
            def docker(command,**_kwargs):
                if command[1:3]==['container','inspect']:
                    return SimpleNamespace(returncode=0,stdout='installed-api:latest',stderr='')
                if command[-1]=='installed-api:latest':
                    return SimpleNamespace(returncode=0,stdout=IMAGE_B,stderr='')
                return SimpleNamespace(returncode=1,stdout='',stderr='No such image')
            with patch.object(deploy.subprocess,'run',side_effect=docker) as run, self.assertRaisesRegex(deploy.Failure,'IMAGE_ID_MISMATCH'):
                value.retain_images(Path(directory),{'api':IMAGE_A})
            self.assertTrue(all(c.args[0][1:3] in (['image','inspect'],['container','inspect']) for c in run.call_args_list))

    def test_successful_tag_with_wrong_backup_id_still_aborts(self):
        value=self.installer();value.rows={'api':{'id':'api-container'}}
        with tempfile.TemporaryDirectory(prefix='release-') as directory:
            def docker(command,**_kwargs):
                found=IMAGE_B if command[-1].startswith('nova-mainnet-backup-') else IMAGE_A
                return SimpleNamespace(returncode=0,stdout=found,stderr='')
            with patch.object(deploy.subprocess,'run',side_effect=docker),self.assertRaisesRegex(deploy.Failure,'IMAGE_ID_MISMATCH'):
                value.retain_images(Path(directory),{'api':IMAGE_A})

    def test_tag_cannot_hide_an_unusable_immutable_rollback_id(self):
        value=self.installer();value.rows={'api':{'id':'api-container'}}
        with tempfile.TemporaryDirectory(prefix='release-') as directory:
            def docker(command,**_kwargs):
                if command[-1]==IMAGE_A:
                    return SimpleNamespace(returncode=1,stdout='',stderr='No such image')
                return SimpleNamespace(returncode=0,stdout=IMAGE_A,stderr='')
            with patch.object(deploy.subprocess,'run',side_effect=docker),self.assertRaisesRegex(deploy.Failure,'NO_SUCH_IMAGE'):
                value.retain_images(Path(directory),{'api':IMAGE_A})

    def test_original_docker_error_is_private_and_public_diagnostic_is_static(self):
        value=self.installer();message='no space left on device; secret-example-token'
        with tempfile.TemporaryDirectory() as directory:
            backup=Path(directory);output=io.StringIO()
            with redirect_stdout(output),patch.object(deploy.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout='',stderr=message)):
                self.assertEqual(value.image_command(['image','tag',IMAGE_A,'backup:test'],backup,'api','tag-bare-id'),(None,'DISK_FULL'))
            self.assertIn('api:tag-bare-id:DISK_FULL',output.getvalue())
            self.assertNotIn('secret-example-token',output.getvalue())
            journal=backup/'image-retention.private.jsonl'
            self.assertEqual(journal.stat().st_mode & 0o777,0o600)
            self.assertEqual(json.loads(journal.read_text())['detail'],message)

    def test_timeout_and_missing_docker_are_diagnosed_without_raising_raw_errors(self):
        value=self.installer()
        with tempfile.TemporaryDirectory() as directory:
            for error,code in [(subprocess.TimeoutExpired('docker',30),'TIMEOUT'),(FileNotFoundError('docker'),'DOCKER_UNAVAILABLE')]:
                with patch.object(deploy.subprocess,'run',side_effect=error):
                    self.assertEqual(value.image_command(['image','inspect',IMAGE_A],Path(directory),'api','inspect'),(None,code))

    def test_retention_failure_prevents_build_replacement_and_premature_restore_command(self):
        value=self.installer();value.args.release='c'*40
        value.rows={s:{'id':s+'-container','image':IMAGE_A} for s in deploy.TARGETS}
        with tempfile.TemporaryDirectory() as directory:
            value.backup_root=Path(directory);output=io.StringIO()
            with patch.dict(os.environ,{'NOVA_WALLETCONNECT_PROJECT_ID':'1a2b3c4d5e6f708192a3b4c5d6e7f809'}),redirect_stdout(output),patch.object(value,'discover'),patch.object(value,'require_stopped'),patch.object(deploy.web,'check_site'),patch.object(deploy.ops,'run'),patch.object(value,'retain_images',side_effect=deploy.Failure('NO_SUCH_IMAGE')),patch.object(value,'build') as build,patch.object(value,'replace') as replace:
                with self.assertRaisesRegex(deploy.Failure,'NO_SUCH_IMAGE'):value.install()
            build.assert_not_called();replace.assert_not_called()
            self.assertIn('NOVA_MAINNET_REPLACEMENT_STARTED=NO',output.getvalue())
            self.assertIn('NOVA_MAINNET_ROLLBACK_READY=NO',output.getvalue())
            self.assertNotIn('Restore command:',output.getvalue())
            self.assertFalse(list(value.backup_root.glob('release-*/manifest.json')))

    def test_restore_is_announced_only_after_complete_manifest_and_retained_id_checks(self):
        value=self.installer();value.args.release='c'*40
        value.rows={s:{'id':s+'-container','image':IMAGE_A} for s in deploy.TARGETS};value.protected=['bot']
        with tempfile.TemporaryDirectory() as directory:
            value.backup_root=Path(directory);value.contexts=[[str(value.app/'docker-compose.yml')]];output=io.StringIO()
            def replace(_overlay):
                manifest=json.loads(next(value.backup_root.glob('release-*/manifest.json')).read_text())
                self.assertEqual(set(manifest['retained']),set(deploy.TARGETS))
                self.assertIn('NOVA_MAINNET_ROLLBACK_READY=YES',output.getvalue())
                self.assertIn('Restore command:',output.getvalue())
            with patch.dict(os.environ,{'NOVA_WALLETCONNECT_PROJECT_ID':'1a2b3c4d5e6f708192a3b4c5d6e7f809'}),redirect_stdout(output),patch.object(value,'discover'),patch.object(value,'require_stopped'),patch.object(deploy.web,'check_site'),patch.object(deploy.ops,'run'),patch.object(value,'retain_images',return_value={s:'backup-'+s for s in deploy.TARGETS}),patch.object(value,'verify_retained_images') as verify,patch.object(value,'build',return_value=IMAGE_A),patch.object(value,'unchanged_inputs'),patch.object(value,'state',return_value=(value.rows,value.protected)),patch.object(value,'replace',side_effect=replace),patch.object(value,'verify_public',return_value={}):
                value.install()
            verify.assert_called_once()

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
                backup=app/'release-integration';backup.mkdir(mode=0o700)
                tags=value.retain_images(backup,images)
                for service,tag in tags.items():
                    self.assertEqual(run(['docker','image','inspect','--format','{{.Id}}',tag]).strip(),images[service])
                overlay=app/'release.json';value.write(overlay,deploy.merge_images(app,value.contexts,images))
                value.unchanged_inputs()
                value.verify_retained_images(backup,images,tags)
                for service in deploy.TARGETS:value.recreate_target(overlay,service)
                after,after_protected=value.state()
                self.assertEqual(protected,after_protected)
                self.assertTrue(all(before[s]['id']!=after[s]['id'] for s in deploy.TARGETS))
                value.discover()
                self.assertTrue(all(str(overlay) in c for c in value.contexts))
                deploy.require_restore_images(after,images)
            finally:
                run(base+['down','--remove-orphans'])
                for service in deploy.TARGETS:
                    subprocess.run(['docker','image','rm','nova-mainnet-backup-'+service+':release-integration'],capture_output=True)


if __name__=='__main__':unittest.main(verbosity=2)
