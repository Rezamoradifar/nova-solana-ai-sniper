"""Deployment safety checks; every external process is mocked.

Run with: python3 -m unittest discover -s scripts/tests -p 'test_ip_deploy.py' -v
"""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "deploy_ip.py"
SPEC = importlib.util.spec_from_file_location("ip_deploy_under_test", SCRIPT)
deploy_ip = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_ip)

IP = "203.0.113.45"
SOCKET = "unix:///run/user/1001/docker.sock"
OLD_IMAGE = "sha256:" + "a" * 64
OLD_CONFIG = "server { listen 80; location / { return 301 https://$host$request_uri; } }\n"


class DeploymentTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch("STATE_ROOT", self.root / "private")
        self.patch("DOCKER_ENDPOINT", None)
        guard = mock.patch.object(
            deploy_ip.subprocess, "run",
            side_effect=AssertionError("External subprocess was not mocked by this test"),
        )
        guard.start()
        self.addCleanup(guard.stop)
        self.state = {
            "ip": IP,
            "docker_host": SOCKET,
            "project": "nova-production",
            "directory": str(self.root / "live"),
            "compose_files": [str(self.root / "live" / "docker-compose.yml")],
            "old_container": "nginx-before",
            "old_image": OLD_IMAGE,
            "webroot": str(self.root / "existing-acme"),
        }
        Path(self.state["webroot"]).mkdir()
        for name in ("certificates", "certbot_work", "certbot_logs"):
            self.state[name] = str(deploy_ip.STATE_ROOT / IP / name)

    def patch(self, name, value):
        patcher = mock.patch.object(deploy_ip, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    @contextlib.contextmanager
    def server_preflight(self):
        """Permit local preflight without depending on the test host's services."""
        renderer = types.ModuleType("ip_nginx")
        renderer.render_ip_config = mock.Mock(return_value="server { listen 443 ssl; }\n")
        original_is_dir = Path.is_dir

        def is_dir(path):
            return str(path) == "/run/systemd/system" or original_is_dir(path)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.dict(sys.modules, {"ip_nginx": renderer}))
            stack.enter_context(mock.patch.object(deploy_ip.sys.stdin, "isatty", return_value=True))
            stack.enter_context(mock.patch.object(Path, "is_dir", is_dir))
            stack.enter_context(mock.patch.object(deploy_ip.shutil, "which", return_value="/mock/bin/tool"))
            stack.enter_context(mock.patch.dict(os.environ, {"DOCKER_HOST": SOCKET, "DOCKER_CONTEXT": ""}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            yield

    def renew_from_manifest(self, process):
        manifest = self.root / "active.json"
        manifest.write_text(json.dumps(self.state), encoding="utf-8")
        with mock.patch.object(sys, "argv", [str(SCRIPT), "--renew", str(manifest)]), \
                mock.patch.object(deploy_ip.os, "geteuid", return_value=0), \
                mock.patch.object(deploy_ip.os, "umask"), \
                mock.patch.object(deploy_ip.subprocess, "run", side_effect=process):
            deploy_ip.main()


class CertificateCommandTests(DeploymentTestCase):
    def test_initial_ip_issuance_is_pinned_interactive_and_uses_isolated_state(self):
        command = deploy_ip.certbot_command(self.state, initial=True)
        image = "certbot/certbot:v5.8.0"
        self.assertIn(image, command)
        self.assertIn("-it", command)
        self.assertEqual(command[command.index(image) + 1], "certonly")
        self.assertEqual(command[command.index("--ip-address") + 1], IP)
        self.assertEqual(command[command.index("--preferred-profile") + 1], "shortlived")
        self.assertEqual(command[command.index("--cert-name") + 1], IP)
        for forbidden in ("--agree-tos", "--register-unsafely-without-email", "--email",
                          "--non-interactive", "-n", "--domain", "-d", "--deploy-hook"):
            self.assertNotIn(forbidden, command)
        mounts = {}
        for index, value in enumerate(command):
            if value == "--mount":
                mount = dict(part.split("=", 1) for part in command[index + 1].split(","))
                self.assertEqual(mount["type"], "bind")
                mounts[mount["dst"]] = mount["src"]
        self.assertEqual(mounts, {
            "/etc/letsencrypt": self.state["certificates"],
            "/var/lib/letsencrypt": self.state["certbot_work"],
            "/var/log/letsencrypt": self.state["certbot_logs"],
            "/var/www/certbot": self.state["webroot"],
        })

    def test_saved_docker_socket_overrides_context_and_tls_environment(self):
        self.patch("DOCKER_ENDPOINT", SOCKET)
        conflicting = {
            "DOCKER_CONTEXT": "remote-context",
            "DOCKER_HOST": "tcp://192.0.2.10:2376",
            "DOCKER_TLS_VERIFY": "1",
            "DOCKER_CERT_PATH": "/unused/remote-certificates",
            "GSP_TEST_MARKER": "preserved",
        }
        with mock.patch.dict(os.environ, conflicting), mock.patch.object(
            deploy_ip.subprocess, "run",
            return_value=subprocess.CompletedProcess([], 0, stdout=" container-id\n"),
        ) as process:
            self.assertEqual(deploy_ip.run(["docker", "ps"], capture=True), "container-id")
            args, options = process.call_args
            self.assertEqual(args[0], ["docker", "--host", SOCKET, "ps"])
            self.assertTrue(options["check"])
            for name in conflicting:
                if name.startswith("DOCKER_"):
                    self.assertNotIn(name, options["env"])
                    self.assertEqual(os.environ[name], conflicting[name])
            self.assertEqual(options["env"]["GSP_TEST_MARKER"], "preserved")


class ChallengeTests(DeploymentTestCase):
    def test_new_challenge_directories_are_publicly_readable_despite_private_umask(self):
        directory = Path(self.state["webroot"]) / ".well-known" / "acme-challenge"

        def read_marker(ip, url, *, https):
            self.assertEqual(ip, IP)
            self.assertFalse(https)
            marker = directory / url.rsplit("/", 1)[1]
            self.assertEqual(stat.S_IMODE(directory.parent.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o644)
            return marker.read_text(encoding="ascii")

        previous_umask = os.umask(0o077)
        try:
            with mock.patch.object(deploy_ip, "local_get", side_effect=read_marker):
                deploy_ip.check_challenge(self.state)
        finally:
            os.umask(previous_umask)
        self.assertEqual(list(directory.iterdir()), [])

    def test_challenge_failure_removes_marker_and_preserves_existing_directory_modes(self):
        directory = Path(self.state["webroot"]) / ".well-known" / "acme-challenge"
        directory.mkdir(parents=True)
        directory.parent.chmod(0o750)
        directory.chmod(0o751)
        failures = [
            ("wrong response", mock.Mock(return_value="not the marker"), deploy_ip.DeployError),
            ("curl failure", mock.Mock(side_effect=subprocess.CalledProcessError(22, ["curl"])),
             subprocess.CalledProcessError),
        ]
        for name, request, expected in failures:
            with self.subTest(failure=name), mock.patch.object(deploy_ip, "local_get", request):
                with self.assertRaises(expected):
                    deploy_ip.check_challenge(self.state)
                self.assertEqual(list(directory.iterdir()), [])
                self.assertEqual(stat.S_IMODE(directory.parent.stat().st_mode), 0o750)
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o751)


class RenewalTests(DeploymentTestCase):
    def test_completed_renewal_precedes_host_nginx_validation_and_reload(self):
        events = []

        def process(command, **options):
            self.assertEqual(command[:3], ["docker", "--host", SOCKET])
            self.assertTrue(options["check"])
            action = command[3:]
            if action[0] == "run":
                self.assertIn("certbot/certbot:v5.8.0", action)
                self.assertIn("renew", action)
                self.assertIn("--non-interactive", action)
                for forbidden in ("-it", "-d", "--detach", "--deploy-hook"):
                    self.assertNotIn(forbidden, action)
                events.append("certbot returned successfully")
                output = ""
            elif action[0] == "ps":
                events.append("find current nginx")
                output = "nginx-live\n"
            elif action == ["exec", "nginx-live", "nginx", "-t"]:
                events.append("nginx configuration passed")
                output = ""
            elif action == ["exec", "nginx-live", "nginx", "-s", "reload"]:
                events.append("reload nginx from host")
                output = ""
            else:
                self.fail("Unexpected renewal command: " + repr(command))
            return subprocess.CompletedProcess(command, 0, stdout=output)

        self.renew_from_manifest(process)
        self.assertEqual(events, [
            "certbot returned successfully", "find current nginx",
            "nginx configuration passed", "reload nginx from host",
        ])

    def test_failed_certbot_process_does_not_inspect_or_reload_nginx(self):
        commands = []

        def process(command, **options):
            commands.append(command)
            raise subprocess.CalledProcessError(1, command)

        with self.assertRaises(subprocess.CalledProcessError):
            self.renew_from_manifest(process)
        self.assertEqual(len(commands), 1)
        self.assertIn("renew", commands[0])
        self.assertNotIn("exec", commands[0])

    def test_invalid_nginx_configuration_after_renewal_prevents_reload(self):
        commands = []

        def process(command, **options):
            commands.append(command)
            if command[-2:] == ["nginx", "-t"]:
                raise subprocess.CalledProcessError(1, command)
            output = "nginx-live\n" if command[3] == "ps" else ""
            return subprocess.CompletedProcess(command, 0, stdout=output)

        with self.assertRaises(subprocess.CalledProcessError):
            self.renew_from_manifest(process)
        self.assertTrue(any(command[-2:] == ["nginx", "-t"] for command in commands))
        self.assertFalse(any("reload" in command for command in commands))


class DeploymentRecoveryTests(DeploymentTestCase):
    def test_failed_cutover_restores_actual_previous_image_and_saved_configuration(self):
        commands = []

        def run(command, *, capture=False, cwd=None):
            command = [str(value) for value in command]
            commands.append(command)
            if command[:3] == ["docker", "context", "inspect"]:
                return json.dumps(SOCKET)
            if command[0] == "git" and "rev-parse" in command:
                return "b" * 40
            if command[0] == "git" and "archive" in command:
                Path(command[command.index("--output") + 1]).write_bytes(b"mock archive")
            if command[:4] == ["docker", "exec", "nginx-before", "cat"]:
                return OLD_CONFIG.rstrip("\n")
            if command[:4] == ["docker", "exec", "nginx-before", "wget"]:
                return '{"status":"ok"}'
            return ""

        with self.server_preflight(), \
                mock.patch.object(deploy_ip, "run", side_effect=run), \
                mock.patch.object(deploy_ip, "discover", return_value=dict(self.state)), \
                mock.patch.object(deploy_ip, "service_ids", return_value=["api api-one", "db db-one"]), \
                mock.patch.object(deploy_ip, "check_challenge"), \
                mock.patch.object(deploy_ip, "check_site", side_effect=deploy_ip.DeployError("bad health")), \
                mock.patch.object(deploy_ip, "current_nginx", return_value="nginx-restored"), \
                mock.patch.object(deploy_ip, "install_renewal") as install_renewal, \
                mock.patch.object(deploy_ip.time, "sleep"):
            with self.assertRaisesRegex(deploy_ip.DeployError, "Previous nginx restored"):
                deploy_ip.deploy(IP, None)
        install_renewal.assert_not_called()

        manifests = list(deploy_ip.STATE_ROOT.glob("*/*/state.json"))
        self.assertEqual(len(manifests), 1)
        state = json.loads(manifests[0].read_text())
        self.assertEqual(state["docker_host"], SOCKET)
        old_override = json.loads(Path(state["rollback_override"]).read_text())
        self.assertEqual(set(old_override["services"]), {"nginx"})
        previous = old_override["services"]["nginx"]
        self.assertEqual(previous["image"], OLD_IMAGE)
        self.assertNotIn("build", previous)
        template = next(mount for mount in previous["volumes"]
                        if mount["target"] == "/etc/nginx/templates/default.conf.template")
        self.assertTrue(template["read_only"])
        self.assertEqual(Path(template["source"]).read_text(), OLD_CONFIG)
        self.assertEqual(previous["environment"]["NGINX_ENVSUBST_FILTER"], "^DOMAIN$")

        updates = [command for command in commands
                   if command[:2] == ["docker", "compose"] and "up" in command]
        self.assertEqual(len(updates), 2)
        for command, override in zip(updates, [state["new_override"], state["rollback_override"]]):
            self.assertEqual(command[command.index("up"):],
                             ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "nginx"])
            compose_files = [command[index + 1] for index, value in enumerate(command) if value == "-f"]
            self.assertEqual(compose_files, state["compose_files"] + [override])
        self.assertEqual(commands[-1], ["docker", "exec", "nginx-restored", "nginx", "-t"])
        for name in ("certificates", "certbot_work", "certbot_logs"):
            self.assertEqual(Path(state[name]).parent, deploy_ip.STATE_ROOT / IP)

    def test_ambiguous_deployments_stop_before_writes_or_mutating_commands(self):
        labels = {}
        for suffix in ("one", "two"):
            directory = self.root / suffix
            directory.mkdir()
            (directory / "package.json").write_text('{"name":"nova-solana-ai-sniper"}')
            labels["nginx-" + suffix] = {
                "com.docker.compose.project.working_dir": str(directory),
                "com.docker.compose.project": "nova-" + suffix,
            }
        commands = []

        def run(command, *, capture=False, cwd=None):
            command = [str(value) for value in command]
            commands.append(command)
            if command == ["docker", "compose", "version"]:
                return "Docker Compose version mocked"
            if command[:3] == ["docker", "context", "inspect"]:
                return json.dumps(SOCKET)
            if command[0] == "git" and "diff" in command:
                return ""
            if command[0] == "git" and "rev-parse" in command:
                return "b" * 40
            if command[:2] == ["docker", "ps"]:
                return "nginx-one\nnginx-two"
            if command[:2] == ["docker", "inspect"]:
                self.assertIn("{{json .Config.Labels}}", command)
                return json.dumps(labels[command[-1]])
            self.fail("Ambiguous discovery attempted an unexpected command: " + repr(command))

        with self.server_preflight(), mock.patch.object(deploy_ip, "run", side_effect=run), \
                mock.patch.object(deploy_ip, "write_private") as write_private, \
                mock.patch.object(deploy_ip, "check_challenge") as check_challenge:
            with self.assertRaisesRegex(deploy_ip.DeployError, "exactly one running Nova"):
                deploy_ip.deploy(IP, None)
        write_private.assert_not_called()
        check_challenge.assert_not_called()
        self.assertFalse(deploy_ip.STATE_ROOT.exists())
        self.assertEqual(sum(command[:2] == ["docker", "inspect"] for command in commands), 2)


if __name__ == "__main__":
    unittest.main()
