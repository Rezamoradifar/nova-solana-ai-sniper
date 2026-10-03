"""Guarded Certbot SIGINT tests; Docker, PIDs, and elapsed time are mocked."""

import contextlib
import copy
import io
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

try:
    from .test_ip_deploy import DeploymentTestCase, deploy_ip
except ImportError:
    from test_ip_deploy import DeploymentTestCase, deploy_ip


class CertbotInterruptTests(DeploymentTestCase):
    def setUp(self):
        super().setUp()
        self.pid = 1404025
        self.container = "f" * 64
        self.commands = []
        self.events = []
        self.clock = 0.0
        self.signalled = False
        self.signal_failure = False
        self.outcome = "released"
        self.lock_files = {}
        self.lock_records = []
        mounts = []
        for key, destination in (
            ("certificates", "/etc/letsencrypt"),
            ("certbot_work", "/var/lib/letsencrypt"),
            ("certbot_logs", "/var/log/letsencrypt"),
        ):
            path = Path(self.state[key]) / ".certbot.lock"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("existing lock fixture\n", encoding="utf-8")
            self.lock_files[path] = (path.stat().st_ino, path.read_bytes())
            self.lock_records.append(SimpleNamespace(
                path=path, owners=(SimpleNamespace(pid=self.pid, comm="certbot"),),
            ))
            mounts.append({"Type": "bind", "Source": self.state[key], "Destination": destination, "RW": True})
        self.containers = {self.container: {
            ".State.Pid": self.pid,
            ".State.Running": True,
            ".State.Paused": False,
            ".HostConfig.RestartPolicy.Name": "no",
            ".Config.Image": deploy_ip.CERTBOT_IMAGE,
            ".Mounts": mounts,
        }}
        self.certbot_locks.inspect_certbot_locks = mock.Mock(side_effect=self.live_locks)

    def tearDown(self):
        for path, expected in self.lock_files.items():
            self.assertTrue(path.exists(), "The interrupt path must not delete Certbot lock files")
            self.assertEqual((path.stat().st_ino, path.read_bytes()), expected)
        super().tearDown()

    def live_locks(self, state):
        self.events.append("locks checked after signal" if self.signalled else "locks checked before signal")
        if self.signalled:
            if self.outcome in ("released", "container_only"):
                self.containers[self.container][".State.Running"] = False
            if self.outcome in ("released", "locks_only"):
                return []
            if self.outcome == "new_owner":
                return [SimpleNamespace(path=record.path, owners=(SimpleNamespace(pid=self.pid + 1, comm="certbot"),))
                        for record in self.lock_records]
        return self.lock_records

    def docker(self, command, *, capture=False, cwd=None):
        command = [str(value) for value in command]
        self.commands.append(command)
        if command[:2] == ["docker", "ps"]:
            self.assertIn("--no-trunc", command)
            return "\n".join(container for container, metadata in self.containers.items()
                             if metadata[".State.Running"])
        if command[:2] == ["docker", "kill"]:
            self.assertEqual(command, ["docker", "kill", "--signal=SIGINT", self.container])
            self.events.append("SIGINT")
            if self.signal_failure:
                raise subprocess.CalledProcessError(1, command)
            self.signalled = True
            return self.container
        self.fail("Unexpected external operation: " + repr(command))

    def inspect(self, container, field):
        self.events.append("inspect " + field)
        self.assertIn(container, self.containers)
        self.assertIn(field, self.containers[container])
        return copy.deepcopy(self.containers[container][field])

    def advance_time(self, seconds):
        self.clock += seconds

    @contextlib.contextmanager
    def execution(self):
        with mock.patch.object(deploy_ip, "run", side_effect=self.docker), \
                mock.patch.object(deploy_ip, "inspect_value", side_effect=self.inspect), \
                mock.patch.object(deploy_ip.time, "monotonic", side_effect=lambda: self.clock), \
                mock.patch.object(deploy_ip.time, "sleep", side_effect=self.advance_time), \
                mock.patch.object(deploy_ip.os, "kill", side_effect=AssertionError("Host PID signals are forbidden")), \
                contextlib.redirect_stdout(io.StringIO()):
            yield

    def signals(self):
        return [command for command in self.commands if command[:2] == ["docker", "kill"]]

    def assert_one_sigint(self):
        self.assertEqual(self.signals(), [["docker", "kill", "--signal=SIGINT", self.container]])

    def test_matching_private_certbot_gets_one_sigint_then_exit_and_locks_are_verified(self):
        with self.execution():
            deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assert_one_sigint()
        self.assertFalse(self.containers[self.container][".State.Running"])
        self.assertIn("locks checked after signal", self.events)
        self.assertLess(self.events.index("SIGINT"), self.events.index("locks checked after signal"))

    def test_wrong_pid_or_unverified_container_identity_never_receives_a_signal(self):
        cases = ("wrong_pid", "no_owner", "not_container_init", "wrong_image", "wrong_config_mount",
                 "wrong_work_mount", "wrong_logs_mount", "not_bind_mount", "paused", "restart_policy",
                 "multiple_containers")
        initial_containers = copy.deepcopy(self.containers)
        initial_records = copy.deepcopy(self.lock_records)
        for case in cases:
            with self.subTest(reason=case):
                self.commands.clear()
                self.containers = copy.deepcopy(initial_containers)
                self.lock_records = copy.deepcopy(initial_records)
                metadata = self.containers[self.container]
                pid = self.pid
                if case == "wrong_pid":
                    pid += 1
                elif case == "no_owner":
                    self.lock_records[0].owners = ()
                elif case == "not_container_init":
                    metadata[".State.Pid"] = self.pid + 1
                elif case == "wrong_image":
                    metadata[".Config.Image"] = "certbot/certbot:latest"
                elif case in ("wrong_config_mount", "wrong_work_mount", "wrong_logs_mount"):
                    index = ("wrong_config_mount", "wrong_work_mount", "wrong_logs_mount").index(case)
                    metadata[".Mounts"][index]["Source"] += "-other-store"
                elif case == "not_bind_mount":
                    metadata[".Mounts"][0]["Type"] = "volume"
                elif case == "paused":
                    metadata[".State.Paused"] = True
                elif case == "restart_policy":
                    metadata[".HostConfig.RestartPolicy.Name"] = "always"
                elif case == "multiple_containers":
                    self.containers["e" * 64] = copy.deepcopy(metadata)
                with self.execution():
                    with self.assertRaises(deploy_ip.DeployError):
                        deploy_ip.interrupt_certbot(self.state, pid)
                self.assertEqual(self.signals(), [])

    def test_no_held_locks_returns_without_signalling_any_process(self):
        self.lock_records = []
        with self.execution():
            deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assertEqual(self.signals(), [])

    def test_natural_lock_release_before_signal_still_waits_for_container_exit(self):
        checks = 0

        def release_before_signal(state):
            nonlocal checks
            checks += 1
            if checks == 1:
                return self.lock_records
            if self.clock >= 2.0:
                self.containers[self.container][".State.Running"] = False
            return []

        self.certbot_locks.inspect_certbot_locks.side_effect = release_before_signal
        with self.execution():
            deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assertEqual(self.signals(), [])
        self.assertFalse(self.containers[self.container][".State.Running"])
        self.assertGreaterEqual(self.clock, 2.0)
        self.assertLessEqual(self.clock, 30.0)

    def test_changed_owner_on_final_lock_check_prevents_signal(self):
        original = copy.deepcopy(self.lock_records)
        replacement = [SimpleNamespace(path=record.path, owners=(SimpleNamespace(pid=self.pid + 1, comm="certbot"),))
                       for record in original]
        observations = iter((original, replacement))
        self.certbot_locks.inspect_certbot_locks.side_effect = lambda state: next(observations, replacement)
        with self.execution():
            with self.assertRaises(deploy_ip.DeployError):
                deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assertEqual(self.signals(), [])
        self.assertGreaterEqual(self.certbot_locks.inspect_certbot_locks.call_count, 2)

    def test_failed_sigint_with_locks_still_held_stops_without_a_second_signal(self):
        self.signal_failure = True
        with self.execution():
            with self.assertRaises((deploy_ip.DeployError, subprocess.CalledProcessError)):
                deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assert_one_sigint()

    def test_timeout_requires_both_container_exit_and_lock_release_without_escalation(self):
        initial_containers = copy.deepcopy(self.containers)
        for outcome in ("held", "locks_only", "container_only"):
            with self.subTest(outcome=outcome):
                self.containers = copy.deepcopy(initial_containers)
                self.commands.clear()
                self.clock = 0.0
                self.signalled = False
                self.outcome = outcome
                with self.execution():
                    with self.assertRaises(deploy_ip.DeployError):
                        deploy_ip.interrupt_certbot(self.state, self.pid)
                self.assert_one_sigint()
                self.assertLessEqual(self.clock, 30.1)

    def test_new_holder_after_sigint_aborts_without_signalling_the_new_owner(self):
        self.outcome = "new_owner"
        with self.execution():
            with self.assertRaises(deploy_ip.DeployError):
                deploy_ip.interrupt_certbot(self.state, self.pid)
        self.assert_one_sigint()

    def test_cli_requires_resume_and_valid_pid_and_only_forwards_explicit_opt_in(self):
        public_ip = "185.172.64.24"
        base = ["--ip", public_ip, "--https-port", "8443"]
        cases = [
            ("no resume", base + ["--interrupt-certbot", str(self.pid)], False, None),
            ("renewal mode", ["--renew", str(self.root / "active.json"), "--interrupt-certbot", str(self.pid)], False, None),
            ("invalid PID", base + ["--resume", "latest", "--interrupt-certbot", "1"], False, None),
            ("ordinary resume", base + ["--resume", "latest"], True, None),
            ("explicit interrupt", base + ["--resume", "latest", "--interrupt-certbot", str(self.pid)], True, self.pid),
        ]
        for label, arguments, valid, expected_pid in cases:
            with self.subTest(mode=label), \
                    mock.patch.object(sys, "argv", ["deploy_ip.py"] + arguments), \
                    mock.patch.object(deploy_ip.os, "geteuid", return_value=0), \
                    mock.patch.object(deploy_ip.os, "umask"), \
                    mock.patch.object(deploy_ip, "operation_lock", return_value=contextlib.nullcontext()), \
                    mock.patch.object(deploy_ip, "resume") as resume, \
                    mock.patch.object(deploy_ip, "deploy") as deploy, \
                    contextlib.redirect_stderr(io.StringIO()):
                if valid:
                    deploy_ip.main()
                    resume.assert_called_once_with(public_ip, None, 8443, "latest", interrupt_pid=expected_pid)
                else:
                    with self.assertRaises(SystemExit) as error:
                        deploy_ip.main()
                    self.assertEqual(error.exception.code, 2)
                    resume.assert_not_called()
                deploy.assert_not_called()

    def test_finish_checks_baseline_before_optional_interrupt_and_certificate_request(self):
        self.state["new_override"] = str(self.root / "site.compose.json")
        manifest = self.root / "state.json"
        cases = ((None, False), (self.pid, False), (self.pid, True))
        for selected_pid, stale_baseline in cases:
            with self.subTest(pid=selected_pid, stale_baseline=stale_baseline):
                events = []

                def baseline(*args):
                    events.append("baseline checked")
                    if stale_baseline:
                        raise deploy_ip.DeployError("original deployment changed")

                def certificate(*args, **kwargs):
                    events.append("certificate request")
                    # Stop at the certificate boundary before any possible cutover.
                    raise subprocess.CalledProcessError(1, ["mock-certbot"])

                with mock.patch.object(deploy_ip, "check_baseline", side_effect=baseline), \
                        mock.patch.object(deploy_ip, "interrupt_certbot", side_effect=lambda *args: events.append("interrupt")) as interrupt, \
                        mock.patch.object(deploy_ip, "run_certbot", side_effect=certificate) as certbot, \
                        contextlib.redirect_stdout(io.StringIO()):
                    expected_error = deploy_ip.DeployError if stale_baseline else subprocess.CalledProcessError
                    with self.assertRaises(expected_error):
                        deploy_ip.finish_deployment(self.state, manifest, interrupt_pid=selected_pid)
                expected = ["baseline checked"]
                if stale_baseline:
                    interrupt.assert_not_called()
                    certbot.assert_not_called()
                else:
                    if selected_pid is not None:
                        interrupt.assert_called_once_with(self.state, selected_pid)
                        expected.extend(("interrupt", "baseline checked"))
                    else:
                        interrupt.assert_not_called()
                    expected.append("certificate request")
                self.assertEqual(events, expected)


if __name__ == "__main__":
    unittest.main()
