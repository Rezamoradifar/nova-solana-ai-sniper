"""Resume saved deployments with local fixtures and mocked external commands."""

import contextlib
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest import mock

try:
    from .test_ip_deploy import BUILT_IMAGE, IP, OLD_CONFIG, OLD_IMAGE, DeploymentTestCase, deploy_ip
except ImportError:
    from test_ip_deploy import BUILT_IMAGE, IP, OLD_CONFIG, OLD_IMAGE, DeploymentTestCase, deploy_ip


class ResumeTests(DeploymentTestCase):
    def setUp(self):
        super().setUp()
        self.commands = []
        self.running = dict(self.state)
        self.core = ["api api-one", "db db-one"]
        self.actual_image = BUILT_IMAGE
        self.certbot_failure = None
        self.site_failure = None

    def make_attempt(self, name="20261004T120000Z-00000001", *, phase=None, pinned=False):
        release = deploy_ip.STATE_ROOT / IP / name
        release.mkdir(parents=True)
        (release / "source").mkdir()
        state = dict(self.state)
        state.update(
            https_port=8443, revision="b" * 40, core_containers=list(self.core),
            image="gsp-bank-sniper-site:" + "b" * 12 + "-" + name.lower(),
            new_override=str(release / "site.compose.json"),
            rollback_override=str(release / "rollback.compose.json"),
        )
        for field in ("certificates", "certbot_work", "certbot_logs"):
            Path(state[field]).mkdir(parents=True, exist_ok=True)
        (release / "previous.conf.template").write_text(OLD_CONFIG, encoding="utf-8")
        # The installer tests isolate rendering, which has its own test suite.
        (release / "ip.conf.template").write_text("server { listen 443 ssl; }\n", encoding="utf-8")
        target = "/etc/nginx/templates/default.conf.template"
        new_service = {
            "image": BUILT_IMAGE if pinned else state["image"],
            "build": {"context": str(release / "source"), "dockerfile": "apps/dashboard/Dockerfile"},
            "environment": {"NGINX_ENVSUBST_FILTER": "^DOMAIN$"},
            "ports": [{"target": 8443, "published": "8443", "host_ip": "0.0.0.0", "protocol": "tcp"}],
            "volumes": [
                {"type": "bind", "source": str(release / "ip.conf.template"), "target": target, "read_only": True},
                {"type": "bind", "source": state["certificates"], "target": "/etc/letsencrypt-ip", "read_only": True},
            ],
        }
        old_service = {
            "image": OLD_IMAGE,
            "environment": {"NGINX_ENVSUBST_FILTER": "^DOMAIN$"},
            "volumes": [
                {"type": "bind", "source": str(release / "previous.conf.template"), "target": target, "read_only": True},
            ],
        }
        for field, service in (("new_override", new_service), ("rollback_override", old_service)):
            Path(state[field]).write_text(json.dumps({"services": {"nginx": service}}, indent=2) + "\n")
        manifest = release / "state.json"
        if pinned:
            state["image_id"] = BUILT_IMAGE
            state["file_hashes"] = deploy_ip.file_hashes(state, manifest)
        if phase is not None:
            state["phase"] = phase
        manifest.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        # Older installers wrote the manifest after all protected files.
        for path in deploy_ip.protected_files(state, manifest):
            os.utime(str(path), ns=(1600000000000000000, 1600000000000000000))
        os.utime(str(manifest), ns=(1600000001000000000, 1600000001000000000))
        return state, manifest

    def external_command(self, command, *, capture=False, cwd=None):
        command = [str(value) for value in command]
        self.commands.append(command)
        if command == ["docker", "compose", "version"]:
            return "mock Compose"
        if command[:3] == ["docker", "image", "inspect"]:
            return json.dumps(self.actual_image)
        if command[:4] == ["docker", "exec", "nginx-before", "cat"]:
            return OLD_CONFIG.rstrip("\n")
        if command[:4] == ["docker", "exec", "nginx-before", "wget"]:
            return '{"status":"ok"}'
        if command[:2] == ["docker", "exec"] and command[-2:] == ["nginx", "-t"]:
            return ""
        if command[:2] == ["docker", "run"] and "certbot/certbot:v5.8.0" in command:
            if self.certbot_failure:
                raise self.certbot_failure
            return ""
        if command[:2] == ["docker", "compose"] and ("up" in command or "run" in command):
            return ""
        self.fail("Resume attempted an unexpected external command: " + repr(command))

    @contextlib.contextmanager
    def execution(self):
        with self.server_preflight(), \
                mock.patch.object(deploy_ip, "run", side_effect=self.external_command), \
                mock.patch.object(deploy_ip, "discover", side_effect=lambda directory: dict(self.running)), \
                mock.patch.object(deploy_ip, "service_ids", return_value=list(self.core)), \
                mock.patch.object(deploy_ip, "check_https_port", return_value=True), \
                mock.patch.object(deploy_ip, "check_challenge"), \
                mock.patch.object(deploy_ip, "check_site", side_effect=self.site_failure), \
                mock.patch.object(deploy_ip, "install_renewal"), \
                mock.patch.object(deploy_ip, "current_nginx", return_value="nginx-restored"), \
                mock.patch.object(deploy_ip, "rollback", wraps=deploy_ip.rollback) as rollback, \
                mock.patch.object(deploy_ip.time, "sleep"):
            yield rollback

    def updates(self):
        return [command for command in self.commands if command[:2] == ["docker", "compose"] and "up" in command]

    def assert_no_rebuild(self):
        self.assertFalse(any(command[:2] == ["docker", "build"] for command in self.commands))
        self.assertFalse(any(command[0] in ("git", "tar") for command in self.commands))

    def assert_resume_rejected(self, manifest, message):
        before = manifest.read_bytes()
        with self.execution() as rollback:
            with self.assertRaisesRegex(deploy_ip.DeployError, message):
                deploy_ip.resume(IP, None, 8443, str(manifest))
        self.assertEqual(manifest.read_bytes(), before)
        self.certbot_locks.wait_for_certbot_locks.assert_not_called()
        rollback.assert_not_called()
        self.assertEqual(self.updates(), [])
        self.assert_no_rebuild()

    def test_legacy_unchanged_attempt_reuses_pins_and_deploys_built_image_without_rebuild(self):
        original, manifest = self.make_attempt()
        self.assertNotIn("file_hashes", original)
        self.assertNotIn("image_id", original)
        with self.execution() as rollback:
            deploy_ip.resume(IP, None, 8443, str(manifest))
        rollback.assert_not_called()
        saved = json.loads(manifest.read_text())
        self.assertEqual(saved["phase"], "deployed")
        self.assertEqual(saved["image_id"], BUILT_IMAGE)
        self.assertEqual(saved["file_hashes"], deploy_ip.file_hashes(saved, manifest))
        override = json.loads(Path(saved["new_override"]).read_text())
        self.assertEqual(override["services"]["nginx"]["image"], BUILT_IMAGE)
        self.assertEqual(len(self.updates()), 1)
        self.assertIn(saved["new_override"], self.updates()[0])
        self.assert_no_rebuild()
        for name in ("manager.py", "certbot_locks.py", "ip_nginx.py"):
            self.assertTrue((manifest.parent / name).is_file())

    def test_certbot_failure_before_cutover_keeps_pinned_build_and_never_rolls_back(self):
        _, manifest = self.make_attempt()
        self.certbot_failure = subprocess.CalledProcessError(1, ["docker", "run", "certbot"])
        with self.execution() as rollback:
            with self.assertRaises(subprocess.CalledProcessError):
                deploy_ip.resume(IP, None, 8443, str(manifest))
        rollback.assert_not_called()
        self.assertEqual(self.updates(), [])
        saved = json.loads(manifest.read_text())
        self.assertEqual(saved["phase"], "built")
        self.assertEqual(saved["image_id"], BUILT_IMAGE)
        self.certbot_locks.wait_for_certbot_locks.assert_called_once()
        self.assert_no_rebuild()

    def test_replacement_of_original_container_is_rejected_even_with_the_same_image(self):
        state, manifest = self.make_attempt(phase="built", pinned=True)
        self.running["old_container"] = "nginx-recreated-by-another-deployment"
        self.assertEqual(self.running["old_image"], state["old_image"])
        self.assert_resume_rejected(manifest, "old_container")

    def test_changed_original_compose_file_is_rejected_against_saved_hash(self):
        state, manifest = self.make_attempt(phase="built", pinned=True)
        compose_file = Path(state["compose_files"][0])
        compose_file.write_text(compose_file.read_text() + "# concurrent configuration change\n")
        self.assert_resume_rejected(manifest, "original Compose file changed")

    def test_latest_completed_attempt_refuses_resume_without_falling_back_to_older_build(self):
        _, older = self.make_attempt(phase="built", pinned=True)
        _, newest = self.make_attempt("20261004T130000Z-00000002", phase="deployed", pinned=True)
        older_contents = older.read_bytes()
        self.assertEqual(deploy_ip.resume_manifest(IP, 8443, None, "latest"), newest)
        with self.execution() as rollback:
            with self.assertRaisesRegex(deploy_ip.DeployError, "not an unfinished build"):
                deploy_ip.resume(IP, None, 8443, "latest")
        self.assertEqual(self.commands, [])
        self.assertEqual(older.read_bytes(), older_contents)
        rollback.assert_not_called()

    def test_changed_built_image_tag_is_rejected_before_certificate_request(self):
        state, manifest = self.make_attempt(phase="built", pinned=True)
        before = Path(state["new_override"]).read_bytes()
        self.actual_image = "sha256:" + "d" * 64
        self.assert_resume_rejected(manifest, "image tag changed")
        self.assertEqual(Path(state["new_override"]).read_bytes(), before)

    def test_compose_change_during_image_inspection_cannot_reset_hash_baseline(self):
        state, manifest = self.make_attempt(phase="built", pinned=True)
        expected_hashes = dict(state["file_hashes"])
        manifest_before = manifest.read_bytes()
        override_before = Path(state["new_override"]).read_bytes()

        def inspect_image(image):
            compose_file = Path(state["compose_files"][0])
            compose_file.write_text(compose_file.read_text() + "# changed during image inspection\n")
            return BUILT_IMAGE

        with mock.patch.object(deploy_ip, "image_id", side_effect=inspect_image):
            with self.assertRaisesRegex(deploy_ip.DeployError, "changed while selecting the image"):
                deploy_ip.pin_built_image(state, manifest)
        self.assertEqual(state["file_hashes"], expected_hashes)
        self.assertEqual(manifest.read_bytes(), manifest_before)
        self.assertEqual(Path(state["new_override"]).read_bytes(), override_before)

    def test_legacy_override_cannot_add_another_service(self):
        state, manifest = self.make_attempt()
        override = Path(state["new_override"])
        document = json.loads(override.read_text())
        document["services"]["api"] = {"image": "unapproved-api:latest"}
        override.write_text(json.dumps(document))
        # Make this a pre-existing legacy file so the structural check must reject it.
        os.utime(str(override), ns=(1600000000000000000, 1600000000000000000))
        self.assert_resume_rejected(manifest, "Saved nginx override no longer matches")

    def test_resumed_cutover_failure_rolls_back_only_nginx_using_original_compose_files(self):
        state, manifest = self.make_attempt(phase="built", pinned=True)
        self.site_failure = deploy_ip.DeployError("website health failed")
        with self.execution() as rollback:
            with self.assertRaisesRegex(deploy_ip.DeployError, "Previous nginx restored"):
                deploy_ip.resume(IP, None, 8443, str(manifest))
        rollback.assert_called_once()
        self.assertEqual(json.loads(manifest.read_text())["phase"], "rolled_back")
        updates = self.updates()
        self.assertEqual(len(updates), 2)
        for command, override in zip(updates, [state["new_override"], state["rollback_override"]]):
            self.assertEqual(command[command.index("up"):],
                             ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "nginx"])
            files = [command[index + 1] for index, value in enumerate(command) if value == "-f"]
            self.assertEqual(files, state["compose_files"] + [override])
        self.assert_no_rebuild()


if __name__ == "__main__":
    unittest.main()
