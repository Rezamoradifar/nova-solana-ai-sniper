#!/usr/bin/env python3
"""Safely recover scheduled Nova Telegram channel posts; never send a message or trade.

Default: read-only preflight. --apply enables daily AI marketing posts after
verifying the bot's channel posting rights and the configured AI provider.
Only marketing-engine is recreated, pinned to its existing image ID.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request

KNOWN = ("TELEGRAM_BOT_TOKEN", "MARKETING_TELEGRAM_CHANNEL_ID",
         "TELEGRAM_TRADES_ONLY", "MARKETING_DAILY_POSTS_ENABLED",
         "GEMINI_API_KEY", "OPENROUTER_API_KEY")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
RUNNING_LABEL = "com.docker.compose.project.config_files"


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def env_vars(text):
    """Read only named literal env keys; refuse duplicates and unsupported expansion."""
    result = {}
    for raw in text.splitlines():
        match = re.match(r"^([A-Z_][A-Z_0-9]*)=(.*)$", raw)
        if not match or match.group(1) not in KNOWN:
            continue
        key, value = match.groups()
        require(key not in result, "DUPLICATE_ENV_KEY_" + key)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        require(not any(ch in value for ch in ("\n", "\r", "$(", "\0")), "UNSAFE_ENV_VALUE")
        result[key] = value
    return result


def with_daily_posts(text):
    """Change exactly two literal flags, preserving all other environment lines."""
    updates = {"TELEGRAM_TRADES_ONLY": "false",
               "MARKETING_DAILY_POSTS_ENABLED": "true"}
    seen = set()
    out = []
    for line in text.splitlines(keepends=True):
        match = re.match(r"^(TELEGRAM_TRADES_ONLY|MARKETING_DAILY_POSTS_ENABLED)=", line)
        if match:
            key = match.group(1)
            require(key not in seen, "DUPLICATE_ENV_KEY_" + key)
            seen.add(key)
            eol = "\r\n" if line.endswith("\r\n") else "\n"
            out.append(key + "=" + updates[key] + eol)
        else:
            out.append(line)
    if out and not out[-1].endswith("\n"):
        out[-1] += "\n"
    for key in updates:
        if key not in seen:
            out.append(key + "=" + updates[key] + "\n")
    return "".join(out)


def telegram_post_permission(token, chat_id):
    """Never log token/chat id or arbitrary remote errors."""
    def call(method, payload):
        request = urllib.request.Request(
            "https://api.telegram.org/bot" + token + "/" + method,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.load(response)
        require(data.get("ok") is True and isinstance(data.get("result"), dict),
                "TELEGRAM_API_FAILED")
        return data["result"]

    try:
        me = call("getMe", {})
        chat = call("getChat", {"chat_id": chat_id})
        require(chat.get("type") == "channel", "TARGET_NOT_CHANNEL")
        member = call("getChatMember", {"chat_id": chat_id, "user_id": me["id"]})
    except Blocked:
        raise
    except Exception:
        raise Blocked("TELEGRAM_PERMISSION_PROBE_FAILED") from None
    require(member.get("status") in ("administrator", "creator"),
            "BOT_NOT_CHANNEL_ADMIN")
    require(member.get("status") == "creator" or member.get("can_post_messages") is True,
            "BOT_LACKS_POST_PERMISSION")
    return True


def run(cmd, cwd):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=45)
    require(result.returncode == 0, "DOCKER_CHECK_FAILED")
    return result.stdout.strip()


def container_image(app):
    base = str(app / "docker-compose.yml")
    container = run(["docker", "compose", "-f", base, "ps", "-q", "marketing-engine"], app)
    require(bool(container) and re.fullmatch(r"[a-f0-9]{12,64}", container) is not None,
            "MARKETING_SERVICE_MISSING")
    state = run(["docker", "inspect", "--format", "{{.State.Running}}", container], app)
    require(state == "true", "MARKETING_NOT_RUNNING")
    config = run(["docker", "inspect", "--format",
                  "{{index .Config.Labels \"" + RUNNING_LABEL + "\"}}", container], app)
    require(config == base, "CUSTOM_COMPOSE_CONTEXT_REQUIRES_OPERATOR")
    image = run(["docker", "inspect", "--format", "{{.Image}}", container], app)
    require(IMAGE_RE.fullmatch(image) is not None, "INVALID_RUNNING_IMAGE")
    original = run(["docker", "image", "inspect", "--format", "{{.Id}}", image], app)
    require(original == image, "RUNNING_IMAGE_MISSING")
    return image


def atomic_env_write(path, content, original_mode):
    fd, tmp = tempfile.mkstemp(prefix=".env.nova-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), original_mode & 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def pinned_recreate(app, image, overlay):
    # Recreate one service with its exact existing local image, no build/pull/deps.
    base = str(app / "docker-compose.yml")
    run(["docker", "compose", "-f", base, "-f", str(overlay),
         "up", "-d", "--no-deps", "--no-build", "--pull", "never",
         "--force-recreate", "marketing-engine"], app)
    container = run(["docker", "compose", "-f", base, "-f", str(overlay),
                     "ps", "-q", "marketing-engine"], app)
    require(bool(container), "RECREATE_SERVICE_NOT_FOUND")
    actual = run(["docker", "inspect", "--format", "{{.Image}}", container], app)
    require(actual == image, "RECREATE_IMAGE_CHANGED")
    running = run(["docker", "inspect", "--format", "{{.State.Running}}", container], app)
    require(running == "true", "RECREATE_DID_NOT_START")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-dir", default="/opt/nova-solana-ai-sniper")
    parser.add_argument("--apply", action="store_true", help="Recreate marketing-engine with safe daily-post flags")
    args = parser.parse_args()
    app = Path(args.app_dir).resolve()
    env_path = app / ".env"
    require(env_path.is_file() and not env_path.is_symlink(), "ENV_MISSING_OR_LINKED")
    require((app / "docker-compose.yml").is_file(), "COMPOSE_FILE_MISSING")
    before = env_path.read_text()
    values = env_vars(before)
    require(bool(values.get("TELEGRAM_BOT_TOKEN")), "BOT_TOKEN_MISSING")
    require(bool(values.get("MARKETING_TELEGRAM_CHANNEL_ID")), "CHANNEL_ID_MISSING")
    require(bool(values.get("GEMINI_API_KEY") or values.get("OPENROUTER_API_KEY")),
            "AI_PROVIDER_MISSING_FOR_DAILY_POSTS")
    telegram_post_permission(values["TELEGRAM_BOT_TOKEN"],
                             values["MARKETING_TELEGRAM_CHANNEL_ID"])
    require(shutil.which("docker") is not None, "DOCKER_MISSING")
    image = container_image(app)
    changed = with_daily_posts(before)
    if changed == before:
        print("NOVA_CHANNEL_FLAGS=ALREADY_CONFIGURED")
        print("NOVA_CHANNEL_POST_RIGHTS=VERIFIED")
        print("NOVA_CHANNEL_MESSAGE=NOT_SENT")
        return
    if not args.apply:
        print("NOVA_CHANNEL_REPAIR=AVAILABLE_USE_APPLY")
        print("NOVA_CHANNEL_POST_RIGHTS=VERIFIED")
        print("NOVA_CHANNEL_MESSAGE=NOT_SENT")
        return
    require(os.geteuid() == 0, "ROOT_OPERATOR_REQUIRED")
    lock_path = app / ".env.nova-ops.lock"
    os.umask(0o077)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked("ANOTHER_NOVA_OPERATION_RUNNING") from None
        require(env_path.read_text() == before, "ENV_CHANGED_DURING_PREFLIGHT")
        require(container_image(app) == image, "IMAGE_CHANGED_DURING_PREFLIGHT")
        backups = app / "data" / "marketing-recovery"
        backups.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(not backups.is_symlink(), "BACKUP_DIR_LINKED")
        directory = Path(tempfile.mkdtemp(prefix="channel-", dir=backups))
        backup = directory / "before.env"
        backup.write_text(before)
        backup.chmod(0o600)
        overlay = directory / "image-only.json"
        overlay.write_text(json.dumps({"services": {"marketing-engine": {
            "image": image, "pull_policy": "never"}}}) + "\n")
        overlay.chmod(0o600)
        mode = stat.S_IMODE(env_path.stat().st_mode)
        try:
            atomic_env_write(env_path, changed, mode)
            pinned_recreate(app, image, overlay)
        except Exception:
            atomic_env_write(env_path, before, mode)
            try:
                pinned_recreate(app, image, overlay)
                print("NOVA_CHANNEL_REPAIR=ROLLED_BACK")
            except Exception:
                print("NOVA_CHANNEL_REPAIR=RESTORE_NEEDS_OPERATOR")
            raise Blocked("CHANNEL_REPAIR_DID_NOT_VERIFY") from None
        print("NOVA_CHANNEL_REPAIR=APPLIED")
        print("NOVA_CHANNEL_POST_RIGHTS=VERIFIED")
        print("NOVA_CHANNEL_MESSAGE=NOT_SENT")
        print("NOVA_CHANNEL_NOTE=POSTS_FOLLOW_SCHEDULE_NOT_IMMEDIATE")
        print("NOVA_CHANNEL_BACKUP=" + str(directory))


if __name__ == "__main__":
    try:
        main()
    except Blocked as error:
        print("NOVA_CHANNEL_REPAIR_BLOCKED=" + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Never surface untrusted HTTP, Docker, or filesystem text containing secrets.
        print("NOVA_CHANNEL_REPAIR_BLOCKED=INTERNAL_ERROR", file=sys.stderr)
        sys.exit(1)
