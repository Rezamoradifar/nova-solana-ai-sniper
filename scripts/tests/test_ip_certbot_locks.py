"""Certbot lock checks using bounded local children, never Docker or a server.

Run with: python3 -m unittest discover -s scripts/tests -p 'test_ip_certbot_locks.py' -v
"""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "certbot_locks.py"
SPEC = importlib.util.spec_from_file_location("certbot_locks_under_test", MODULE_PATH)
locks = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = locks
SPEC.loader.exec_module(locks)

ARG_SECRET = "fixture-argv-secret-726da8"
ENV_SECRET = "fixture-environment-secret-c17a42"
LOCK_CONTENT = "existing certbot lock fixture\n"
HOLD_LOCK = """
import fcntl
import json
from pathlib import Path
import select
import sys

with open(sys.argv[1], "r+") as handle:
    fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print(json.dumps({
        "ready": "locked",
        "pid": int(Path("/proc/self/stat").read_text().split()[0]),
        "comm": Path("/proc/self/comm").read_text().strip(),
    }), flush=True)
    if select.select([sys.stdin], [], [], 5.0)[0]:
        sys.stdin.readline()
"""


@unittest.skipUnless(sys.platform.startswith("linux"), "Requires Linux POSIX locks and /proc")
class CertbotLockTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = {
            name: str(self.root / name)
            for name in ("certbot_logs", "certbot_work", "certificates")
        }
        self.paths = [Path(directory) / ".certbot.lock" for directory in self.state.values()]
        self.owner_info = {}

    @staticmethod
    def stop_holder(child):
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=1.0)
        finally:
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()

    def hold_lock(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(LOCK_CONTENT, encoding="utf-8")
        child = subprocess.Popen(
            [sys.executable, "-u", "-c", HOLD_LOCK, str(path), ARG_SECRET],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={"APP_PRIVATE_KEY": ENV_SECRET},
        )
        self.addCleanup(self.stop_holder, child)
        ready, _, _ = select.select([child.stdout], [], [], 3.0)
        self.assertTrue(ready, "Lock holder did not signal readiness within three seconds")
        identity = json.loads(child.stdout.readline())
        self.assertEqual(identity.pop("ready"), "locked")
        # /proc can expose a different PID namespace from Popen.pid in CI.
        self.owner_info[child.pid] = identity
        return child

    def release_lock(self, child):
        child.stdin.write("release\n")
        child.stdin.flush()
        self.assertEqual(child.wait(timeout=1.0), 0)

    def assert_no_secrets(self, text):
        for secret in (ARG_SECRET, ENV_SECRET, "APP_PRIVATE_KEY"):
            self.assertNotIn(secret, text)

    def test_missing_locks_do_not_create_files_or_directories(self):
        for create_directories in (False, True):
            with self.subTest(existing_directories=create_directories):
                if create_directories:
                    for path in self.paths:
                        path.parent.mkdir()
                before = set(self.root.rglob("*"))
                self.assertEqual(locks.inspect_certbot_locks(self.state), [])
                self.assertIsNone(locks.wait_for_certbot_locks(
                    self.state, timeout=0.1, interval=0.01, report=lambda message: None,
                ))
                self.assertEqual(set(self.root.rglob("*")), before)

    def test_stale_unlocked_files_keep_their_inode_and_content(self):
        identities = {}
        for path in self.paths:
            path.parent.mkdir()
            path.write_text(LOCK_CONTENT, encoding="utf-8")
            metadata = path.stat()
            identities[path] = (metadata.st_dev, metadata.st_ino)
        self.assertEqual(locks.inspect_certbot_locks(self.state), [])
        self.assertIsNone(locks.wait_for_certbot_locks(
            self.state, timeout=0.1, interval=0.01, report=lambda message: None,
        ))
        for path, identity in identities.items():
            metadata = path.stat()
            self.assertEqual((metadata.st_dev, metadata.st_ino), identity)
            self.assertEqual(path.read_text(encoding="utf-8"), LOCK_CONTENT)

    def test_real_posix_contention_identifies_each_child_without_disclosing_secrets(self):
        children = {path: self.hold_lock(path) for path in self.paths}
        identities = {path: path.stat().st_ino for path in self.paths}
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            records = locks.inspect_certbot_locks(self.state)
        self.assertIsInstance(records, list)
        self.assertEqual(len(records), len(self.paths))
        self.assertEqual({record.path for record in records}, set(self.paths))
        for record in records:
            self.assertIsInstance(record.path, Path)
            self.assertIsInstance(record.owners, tuple)
            child = children[record.path]
            expected = self.owner_info[child.pid]
            self.assertEqual({owner.pid for owner in record.owners}, {expected["pid"]})
            for owner in record.owners:
                self.assertIsInstance(owner.pid, int)
                self.assertEqual(owner.comm, expected["comm"])
            self.assertEqual(record.path.stat().st_ino, identities[record.path])
            self.assertEqual(record.path.read_text(encoding="utf-8"), LOCK_CONTENT)
        self.assert_no_secrets(output.getvalue() + repr(records))

    def test_short_timeout_reports_the_lock_and_safe_owner_details(self):
        path = self.paths[0]
        child = self.hold_lock(path)
        owner = self.owner_info[child.pid]
        reports = []
        output = io.StringIO()
        started = time.monotonic()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
                self.assertRaises(locks.CertbotLockError) as caught:
            locks.wait_for_certbot_locks(
                self.state, timeout=0.12, interval=0.02, report=reports.append,
            )
        elapsed = time.monotonic() - started
        self.assertIsInstance(caught.exception, RuntimeError)
        self.assertGreaterEqual(elapsed, 0.08)
        self.assertLess(elapsed, 2.0)
        self.assertTrue(reports, "Contention must produce a waiting diagnostic")
        diagnostic = "\n".join(reports) + output.getvalue() + str(caught.exception)
        for expected in (str(path), str(owner["pid"]), owner["comm"]):
            self.assertIn(expected, diagnostic)
        self.assertRegex(diagnostic.lower(), "wait|busy|lock")
        self.assert_no_secrets(diagnostic)
        self.assertIsNone(child.poll(), "Waiting must not stop the process holding the lock")

    def test_releasing_a_busy_lock_allows_wait_to_finish(self):
        path = self.paths[1]
        child = self.hold_lock(path)
        reports = []

        def report(message):
            reports.append(message)
            if child.poll() is None:
                self.release_lock(child)

        self.assertIsNone(locks.wait_for_certbot_locks(
            self.state, timeout=1.0, interval=0.01, report=report,
        ))
        self.assertTrue(reports, "Release must follow an observed contention report")
        self.assertEqual(child.returncode, 0)
        self.assertEqual(locks.inspect_certbot_locks(self.state), [])
        self.assertEqual(path.read_text(encoding="utf-8"), LOCK_CONTENT)
        self.assert_no_secrets("\n".join(reports))

    def test_inode_replacement_retries_and_detects_the_new_locked_file(self):
        path = self.paths[2]
        replacement = path.with_name("replacement.lock")
        child = self.hold_lock(replacement)
        replacement_inode = replacement.stat().st_ino
        path.write_text("old unlocked inode\n", encoding="utf-8")
        original_open = locks.os.open
        replaced = []

        def open_then_replace(filename, flags, *args, **kwargs):
            descriptor = original_open(filename, flags, *args, **kwargs)
            if Path(filename) == path and not replaced:
                replacement.replace(path)
                replaced.append(True)
            return descriptor

        with mock.patch.object(locks.os, "open", side_effect=open_then_replace):
            records = locks.inspect_certbot_locks(self.state)
        self.assertTrue(replaced)
        self.assertEqual(len(records), 1, "The replacement inode must be checked before declaring it free")
        self.assertEqual(records[0].path, path)
        self.assertEqual({owner.pid for owner in records[0].owners},
                         {self.owner_info[child.pid]["pid"]})
        self.assertEqual(path.stat().st_ino, replacement_inode)
        self.assertEqual(path.read_text(encoding="utf-8"), LOCK_CONTENT)


if __name__ == "__main__":
    unittest.main()
