"""Offline tests. No real RPC, Jupiter requests, wallet, or transaction submission."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('setup_simulation', Path(__file__).with_name('setup-simulation.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

OWNER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  # public-format fixture; not an operator wallet
RPC = 'https://rpc.example.invalid/?api-key=PRIVATE_TEST_TOKEN'
ENV = '# Keep original engineering limits\nARB_MODE=off\nARB_OWNER=\nARB_RPC_URL=\nARB_JUPITER_API_KEY=\nARB_KEYPAIR_FILE=\nARB_APPROVAL_FILE=\nARB_AMOUNT_LAMPORTS=10000000\nARB_MAX_FEE_LAMPORTS=100000\nARB_BUY_DEX=Raydium CLMM\nARB_STATE_DIR=/state\n'

class SetupTests(unittest.TestCase):
    def test_address_validation_rejects_ip_seed_and_noncanonical_lengths(self):
        for value in ['', '103.244.227.112', 'not a wallet', 'a b c d e f g h i j k l', '1'*32, '2'*32, '0'*44]:
            with self.subTest(value=value), self.assertRaises(setup.Blocked):
                setup.owner_address(value)
        self.assertEqual(setup.owner_address(' '+OWNER+' '), OWNER)

    def test_credential_urls_require_https_and_no_redirect_credentials(self):
        for value in ['http://127.0.0.1:8899', 'https://user:pass@rpc.example', 'https://rpc.example/#secret', 'https://rpc.example:abc', 'https://rpc.example/\nKEY=bad', '', 'file:///tmp/env']:
            with self.subTest(value=value), self.assertRaises(setup.Blocked):
                setup.rpc_url(value)
        self.assertEqual(setup.rpc_url(RPC), RPC)

    def test_key_cannot_inject_env_lines_or_header_fields(self):
        for value in ['a\nb', 'a\rb', 'a b', '\x00', 'a'*4097]:
            with self.subTest(value=value), self.assertRaises(setup.Blocked):
                setup.api_key(value)
        self.assertEqual(setup.api_key(''), '')

    def test_dotenv_is_not_shell_and_rejects_duplicates(self):
        for value in ['export ARB_MODE=off', 'ARB_MODE=off\nARB_MODE=live', 'source /root/.env', 'BAD=\x00']:
            with self.subTest(value=value), self.assertRaises(setup.Blocked):
                setup.parse_env(value)
        self.assertEqual(setup.parse_env('ARB_BUY_DEX=Raydium CLMM')['ARB_BUY_DEX'], 'Raydium CLMM')

    def test_existing_live_or_secret_configuration_is_not_overwritten(self):
        for before in [ENV.replace('ARB_MODE=off','ARB_MODE=live'), ENV.replace('ARB_KEYPAIR_FILE=','ARB_KEYPAIR_FILE=/run/secrets/key.json'), ENV.replace('ARB_APPROVAL_FILE=','ARB_APPROVAL_FILE=/run/secrets/approval.json'), ENV.replace('/state','/other')]:
            with self.subTest(before=before), self.assertRaises(setup.Blocked):
                setup.render_config(before,OWNER,RPC,'test-key')

    def test_render_preserves_amount_fees_venues_and_comments(self):
        rendered = setup.render_config(ENV,OWNER,RPC,'test-key')
        values = setup.parse_env(rendered)
        self.assertEqual(values['ARB_MODE'],'simulate')
        self.assertEqual(values['ARB_OWNER'],OWNER)
        self.assertEqual(values['ARB_RPC_URL'],RPC)
        self.assertEqual(values['ARB_KEYPAIR_FILE'],'')
        self.assertEqual(values['ARB_APPROVAL_FILE'],'')
        self.assertEqual(values['ARB_AMOUNT_LAMPORTS'],'10000000')
        self.assertEqual(values['ARB_MAX_FEE_LAMPORTS'],'100000')
        self.assertEqual(values['ARB_BUY_DEX'],'Raydium CLMM')
        self.assertTrue(rendered.startswith('# Keep original engineering limits\n'))
        self.assertNotIn('LIVE_TRADING',rendered)
        self.assertNotIn('COPY_TRADING_EXECUTION_ENABLED',rendered)

    def test_read_secure_rejects_world_readable_files(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'test.env';p.write_bytes(ENV.encode());p.chmod(0o644)
            with self.assertRaises(setup.Blocked):setup.read_secure(p)
            p.chmod(0o600)
            self.assertEqual(setup.read_secure(p),ENV.encode())

    def test_read_secure_never_follows_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'test.env';p.write_bytes(ENV.encode());p.chmod(0o600)
            link=Path(temp)/'link.env';link.symlink_to(p)
            with self.assertRaises(OSError):setup.read_secure(link)

    def test_atomic_write_preserves_private_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'test.env';p.write_bytes(ENV.encode());p.chmod(0o600)
            new=setup.render_config(ENV,OWNER,RPC,'key').encode()
            backup=setup.write_atomic(p,ENV.encode(),new)
            self.assertEqual(p.read_bytes(),new)
            self.assertEqual(backup.read_bytes(),ENV.encode())
            self.assertEqual(p.stat().st_mode & 0o777,0o600)
            self.assertEqual(backup.stat().st_mode & 0o777,0o600)

    def test_concurrent_config_change_refuses_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'test.env';p.write_bytes(ENV.encode());p.chmod(0o600)
            with self.assertRaises(setup.Blocked):setup.write_atomic(p,b'outdated',b'new')
            self.assertEqual(p.read_bytes(),ENV.encode())

    def test_rpc_probe_only_calls_read_only_genesis(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'id':1,'result':setup.GENESIS}).encode()
        opener=MagicMock();opener.open.return_value=response
        with patch.object(setup,'build_opener',return_value=opener):setup.probe_rpc(RPC)
        req=opener.open.call_args.args[0]
        body=json.loads(req.data)
        self.assertEqual(body['method'],'getGenesisHash')
        self.assertEqual(body['params'],[])
        self.assertEqual(req.get_method(),'POST')

    def test_wrong_rpc_network_rejected(self):
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps({'id':1,'result':'devnet'}).encode()
        opener=MagicMock();opener.open.return_value=response
        with patch.object(setup,'build_opener',return_value=opener),self.assertRaisesRegex(setup.Blocked,'WRONG_NETWORK'):
            setup.probe_rpc(RPC)

    def test_rpc_error_does_not_expose_secret_url(self):
        opener=MagicMock();opener.open.side_effect=setup.URLError(RPC)
        with patch.object(setup,'build_opener',return_value=opener):
            with self.assertRaises(setup.Blocked) as caught:setup.probe_rpc(RPC)
        self.assertEqual(str(caught.exception),'RPC_PROBE_FAILED')
        self.assertNotIn('PRIVATE_TEST_TOKEN',str(caught.exception))

    def test_rpc_redirect_is_blocked(self):
        with self.assertRaisesRegex(setup.Blocked,'RPC_REDIRECT_BLOCKED'):
            setup.NoRedirect().redirect_request(None,None,302,'',{},'https://foreign.invalid')

    def test_runner_refuses_any_execution_command(self):
        with patch.object(setup.subprocess,'run') as run:
            for command in ['execute-once','reconcile','start','simulate; something']:
                with self.subTest(command=command),self.assertRaises(setup.Blocked):setup.runner_call(command)
            run.assert_not_called()

    def test_status_requires_simulation_configuration(self):
        good={'component':'moneyland-atomic-arbitrage','mode':'simulate','executionEnabled':False,'missing':[]}
        with patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(good),'')) as run:
            self.assertEqual(setup.runner_call('status')['status'],'SIMULATION_CONFIGURED')
            self.assertEqual(run.call_args.args[0],[str(setup.RUNNER),'status'])
        good['mode']='live'
        with patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(good),'')),self.assertRaises(setup.Blocked):
            setup.runner_call('status')

    def test_simulation_output_whitelist_does_not_echo_credentials(self):
        result={'status':'SIMULATION_PASSED','broadcast':False,'feeLamports':1000,'amountLamports':'10000000','privateRpc':RPC,'apiKey':'PRIVATE_TEST_TOKEN'}
        with patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'bindings warning\n'+json.dumps(result),'')) as run:
            clean=setup.runner_call('simulate')
        self.assertEqual(clean['feeLamports'],1000)
        self.assertNotIn('PRIVATE_TEST_TOKEN',json.dumps(clean))
        self.assertNotIn('privateRpc',clean)
        self.assertEqual(run.call_args.args[0],[str(setup.RUNNER),'simulate'])

    def test_runner_error_is_sanitized(self):
        unsafe={'status':'BLOCKED','code':RPC,'broadcast':False}
        with patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'',json.dumps(unsafe))):
            with self.assertRaisesRegex(setup.Blocked,'RUNNER_FAILED'):setup.runner_call('simulate')
        safe={'status':'BLOCKED','code':'NO_PROFITABLE_CYCLE','broadcast':False}
        with patch.object(setup.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'',json.dumps(safe))):
            with self.assertRaisesRegex(setup.Blocked,'NO_PROFITABLE_CYCLE'):setup.runner_call('simulate')

    def test_timeout_does_not_retry(self):
        with patch.object(setup.subprocess,'run',side_effect=subprocess.TimeoutExpired('simulate',120)) as run:
            with self.assertRaisesRegex(setup.Blocked,'SIMULATION_TIMEOUT_REVIEW_LOCK'):setup.runner_call('simulate')
            self.assertEqual(run.call_count,1)

    def test_emergency_halt_prevents_prompt_and_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);runner=root/'runner';cfg=root/'arb.env';halt=root/'HALT'
            runner.write_text('#!/bin/sh\nexit 0\n');runner.chmod(0o700);cfg.write_text(ENV);cfg.chmod(0o600);halt.touch()
            with patch.object(setup.os,'geteuid',return_value=0),patch.object(setup,'RUNNER',runner),patch.object(setup,'CONFIG',cfg),patch.object(setup,'HALT',halt),patch.object(setup.sys.stdin,'isatty',return_value=True),patch('builtins.input') as ask:
                with self.assertRaisesRegex(setup.Blocked,'EMERGENCY_HALT'):setup.main()
                ask.assert_not_called()
            self.assertEqual(cfg.read_text(),ENV)

if __name__ == '__main__':
    unittest.main(verbosity=2)
