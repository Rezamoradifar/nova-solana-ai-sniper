"""Check existing Certbot directory locks without changing their files.

This is a bounded preflight check. Certbot still takes its own authoritative
locks after this check, so a new contender can cause a later Certbot failure.
"""

import errno
import fcntl
import math
import os
from pathlib import Path
import stat
import time
from dataclasses import dataclass
from typing import Callable, List, Mapping, Optional, Tuple


_STORES = ("certbot_logs", "certbot_work", "certificates")
_RACE_ATTEMPTS = 3


class CertbotLockError(RuntimeError):
    """An existing lock could not safely be checked, or did not become free."""


@dataclass(frozen=True)
class LockOwner:
    pid: int
    comm: str


@dataclass(frozen=True)
class LockContention:
    path: Path
    owners: Tuple[LockOwner, ...]

    def describe(self) -> str:
        holders = ", ".join("PID {} ({})".format(owner.pid, owner.comm)
                            for owner in self.owners)
        return "{}: {}".format(str(self.path), holders or "holder unavailable in /proc/locks")


def _owners(device: int, inode: int) -> Tuple[LockOwner, ...]:
    """Read only matching kernel lock metadata and process names, never argv/env."""
    try:
        rows = Path("/proc/locks").read_text().splitlines()
    except OSError:
        return ()
    wanted = (os.major(device), os.minor(device), inode)
    owners = []  # type: List[LockOwner]
    seen = set()
    for row in rows:
        fields = row.split()
        # A row containing '->' describes a waiter, not the current owner.
        if len(fields) < 8 or fields[1] != "POSIX":
            continue
        try:
            major, minor, number = fields[5].split(":")
            identity = (int(major, 16), int(minor, 16), int(number))
            pid = int(fields[4])
        except (ValueError, IndexError):
            continue
        if identity != wanted or pid <= 0 or pid in seen:
            continue
        seen.add(pid)
        try:
            comm = Path("/proc/{}/comm".format(pid)).read_text(
                encoding="utf-8", errors="replace").rstrip("\n")
            comm = "".join(char if char.isprintable() else "?" for char in comm)[:128]
        except OSError:
            comm = "process exited or name unavailable"
        owners.append(LockOwner(pid, comm))
    return tuple(owners)


def _inspect_one(path: Path) -> Optional[LockContention]:
    # O_NONBLOCK also prevents a malformed FIFO at this path from hanging open().
    flags = os.O_WRONLY | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    for attempt in range(_RACE_ATTEMPTS):
        try:
            descriptor = os.open(str(path), flags)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise CertbotLockError("Cannot open existing Certbot lock {}: {}".format(
                path, error.strerror)) from error

        acquired = False
        held = False
        same_file = False
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise CertbotLockError("Certbot lock is not a regular file: {}".format(path))
            try:
                fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN):
                    raise CertbotLockError("Cannot check Certbot lock {}: {}".format(
                        path, error.strerror)) from error
                held = True
            try:
                current = os.stat(str(path), follow_symlinks=False)
                same_file = (opened.st_dev, opened.st_ino) == (current.st_dev, current.st_ino)
            except FileNotFoundError:
                pass
            except OSError as error:
                raise CertbotLockError("Cannot verify Certbot lock {}: {}".format(
                    path, error.strerror)) from error
        finally:
            # Release before reading /proc, reporting, waiting, or retrying.
            try:
                if acquired:
                    fcntl.lockf(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)
        if not same_file:
            continue
        if held:
            return LockContention(path, _owners(opened.st_dev, opened.st_ino))
        return None
    raise CertbotLockError("Certbot lock changed repeatedly while being checked: {}. "
                           "Retry after the current Certbot operation finishes.".format(path))


def inspect_certbot_locks(state: Mapping[str, str]) -> List[LockContention]:
    """Return currently held locks in the three stores; leave absent files absent."""
    contentions = []  # type: List[LockContention]
    for key in _STORES:
        try:
            path = Path(state[key]) / ".certbot.lock"
        except (KeyError, TypeError) as error:
            raise CertbotLockError("Missing or invalid Certbot state directory: {}".format(key)) from error
        result = _inspect_one(path)
        if result is not None:
            contentions.append(result)
    return contentions


def wait_for_certbot_locks(state: Mapping[str, str], timeout: float = 30.0,
                          interval: float = 2.0,
                          report: Callable[[str], None] = print) -> None:
    """Wait up to timeout seconds, reporting contention at most every ten seconds."""
    if not math.isfinite(timeout) or timeout < 0:
        raise ValueError("timeout must be finite and nonnegative")
    if not math.isfinite(interval) or interval <= 0:
        raise ValueError("interval must be finite and positive")
    deadline = time.monotonic() + timeout
    next_report = 0.0
    waited = False
    while True:
        contentions = inspect_certbot_locks(state)
        if not contentions:
            if waited:
                report("Certbot directory locks are available; continuing.")
            return
        now = time.monotonic()
        description = "; ".join(item.describe() for item in contentions)
        remaining = deadline - now
        if remaining <= 0:
            raise CertbotLockError("Timed out waiting for Certbot directory locks: {}. "
                                   "Wait for the holder to finish, then retry.".format(description))
        if now >= next_report:
            report("Waiting for Certbot directory locks (up to {:.0f}s remaining): {}".format(
                remaining, description))
            next_report = now + 10.0
        waited = True
        time.sleep(min(interval, remaining))
