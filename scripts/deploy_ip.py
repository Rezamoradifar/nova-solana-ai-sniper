#!/usr/bin/env python3
"""Deploy this website to an existing Nova Compose server using trusted IP HTTPS.

Run on the VPS, from a reviewed Git checkout. Only nginx is recreated. Certbot
asks for its account details/terms interactively; no application secrets are read.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid


CERTBOT_IMAGE = "certbot/certbot:v5.8.0"
STATE_ROOT = Path("/var/lib/gsp-bank-sniper-ip")
DOCKER_ENDPOINT = None


class DeployError(RuntimeError):
    pass


def run(args, *, capture=False, cwd=None):
    args = [str(arg) for arg in args]
    environment = None
    if args[0] == "docker" and DOCKER_ENDPOINT:
        args[1:1] = ["--host", DOCKER_ENDPOINT]
        environment = os.environ.copy()
        for name in ("DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            environment.pop(name, None)
    result = subprocess.run(
        args, cwd=cwd, env=environment, text=True,
        stdout=subprocess.PIPE if capture else None, check=True,
    )
    return result.stdout.strip() if capture else ""


def write_private(path, content, mode=0o600):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)


@contextlib.contextmanager
def operation_lock():
    STATE_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE_ROOT / "operation.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError("Another GSP IP installation or renewal is running. Retry later.")
        yield


def inspect_value(container, expression):
    # Select fields explicitly. Never dump docker inspect's application environment.
    return json.loads(run(
        ["docker", "inspect", "--format", "{{json " + expression + "}}", container],
        capture=True,
    ))


def service_ids(project, service=None):
    args = ["docker", "ps", "-a", "--filter", "label=com.docker.compose.project=" + project]
    if service:
        args += ["--filter", "label=com.docker.compose.service=" + service]
    args += ["--format", '{{.Label "com.docker.compose.service"}} {{.ID}}']
    return sorted(line for line in run(args, capture=True).splitlines()
                  if line and not line.startswith("nginx "))


def current_nginx(project):
    ids = run([
        "docker", "ps", "--filter", "label=com.docker.compose.project=" + project,
        "--filter", "label=com.docker.compose.service=nginx", "--format", "{{.ID}}",
    ], capture=True).splitlines()
    if len(ids) != 1:
        raise DeployError("Expected exactly one running nginx container in the selected project.")
    return ids[0]


def discover(project_dir):
    ids = run([
        "docker", "ps", "--filter", "label=com.docker.compose.service=nginx",
        "--format", "{{.ID}}",
    ], capture=True).splitlines()
    candidates = []
    for container in ids:
        labels = inspect_value(container, ".Config.Labels") or {}
        directory = Path(labels.get("com.docker.compose.project.working_dir", "/missing"))
        if project_dir and directory.resolve() != project_dir.resolve():
            continue
        try:
            package = json.loads((directory / "package.json").read_text())
        except (OSError, ValueError):
            continue
        if package.get("name") == "nova-solana-ai-sniper":
            candidates.append((container, directory, labels))
    if len(candidates) != 1:
        raise DeployError(
            "Could not identify exactly one running Nova Compose deployment. "
            "Use --project-dir /actual/existing/repository if there are several; "
            "no containers have been changed."
        )
    container, directory, labels = candidates[0]
    filenames = labels.get("com.docker.compose.project.config_files", "").split(",")
    files = [str((directory / filename).resolve()) for filename in filenames if filename]
    if not files or not all(Path(filename).is_file() for filename in files):
        raise DeployError("The running deployment's original Compose files are unavailable.")
    mounts = inspect_value(container, ".Mounts")
    webroots = [mount for mount in mounts if mount["Destination"] == "/var/www/certbot"]
    if len(webroots) != 1 or webroots[0]["Type"] != "bind":
        raise DeployError("Expected an existing bind-mounted ACME webroot at /var/www/certbot.")
    protected = ("/usr/share/nginx/html", "/etc/nginx")
    for mount in mounts:
        target = mount["Destination"].rstrip("/")
        if target == "/etc/nginx/templates/default.conf.template":
            continue
        if any(target == root or target.startswith(root + "/") or root.startswith(target + "/")
               for root in protected):
            raise DeployError("Custom nginx/static mounts need review before this installer can run.")
    files_in_container = run([
        "docker", "exec", container, "sh", "-c", "ls -1 /etc/nginx/conf.d/",
    ], capture=True).splitlines()
    if [name for name in files_in_container if name.endswith(".conf")] != ["default.conf"]:
        raise DeployError("Additional nginx vhosts need review before choosing the IP TLS default.")
    return {
        "project": labels["com.docker.compose.project"], "directory": str(directory.resolve()),
        "compose_files": files, "old_container": container,
        "old_image": inspect_value(container, ".Image"),
        "webroot": webroots[0]["Source"],
    }


def compose(state, override):
    args = ["docker", "compose", "--project-directory", state["directory"], "-p", state["project"]]
    for filename in state["compose_files"] + [str(override)]:
        args += ["-f", filename]
    return args


def compose_up(state, override):
    # --no-deps is required: nginx depends on api, which depends on migrations/DB.
    return compose(state, override) + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "nginx"]


def local_get(ip, path, *, https=True):
    port, scheme = (443, "https") if https else (80, "http")
    return run([
        "curl", "--fail", "--silent", "--show-error", "--noproxy", "*",
        "--connect-timeout", "5", "--max-time", "15",
        "--resolve", f"{ip}:{port}:127.0.0.1", f"{scheme}://{ip}{path}",
    ], capture=True)


def check_challenge(state):
    marker = "gsp-check-" + uuid.uuid4().hex
    directory = Path(state["webroot"]) / ".well-known" / "acme-challenge"
    for parent in (directory.parent, directory):
        if not parent.exists():
            parent.mkdir(mode=0o755)
            # The installer otherwise uses umask 0077 for private state/keys.
            parent.chmod(0o755)
    path = directory / marker
    try:
        path.write_text(marker, encoding="ascii")
        path.chmod(0o644)
        if local_get(state["ip"], "/.well-known/acme-challenge/" + marker, https=False) != marker:
            raise DeployError("The existing HTTP ACME route did not serve its test file.")
    finally:
        path.unlink(missing_ok=True)


def certbot_command(state, initial=False):
    args = ["docker", "run", "--rm"]
    if initial:
        args += ["-it"]
    for source, target in (
        (state["certificates"], "/etc/letsencrypt"),
        (state["certbot_work"], "/var/lib/letsencrypt"),
        (state["certbot_logs"], "/var/log/letsencrypt"),
        (state["webroot"], "/var/www/certbot"),
    ):
        args += ["--mount", f"type=bind,src={source},dst={target}"]
    args += [CERTBOT_IMAGE]
    if initial:
        args += ["certonly", "--ip-address", state["ip"], "--preferred-profile", "shortlived"]
    else:
        args += ["renew", "--quiet", "--non-interactive"]
    return args + [
        "--cert-name", state["ip"], "--webroot", "--webroot-path", "/var/www/certbot",
    ]


def check_site(state):
    index = local_get(state["ip"], "/")
    if "<html" not in index.lower():
        raise DeployError("The homepage did not return HTML.")
    for path in ("/wallet", "/telegram", "/tools", "/app/"):
        if "<html" not in local_get(state["ip"], path).lower():
            raise DeployError("A required website route failed: " + path)
    asset = re.search(r'<script\b[^>]*\bsrc=[\'"](/assets/[^\'"<>]+\.js)[\'"]', index)
    if not asset or not local_get(state["ip"], asset.group(1)):
        raise DeployError("The homepage JavaScript bundle is unavailable.")
    if json.loads(local_get(state["ip"], "/api/health")).get("status") != "ok":
        raise DeployError("The API liveness check did not return status ok.")
    redirect = run([
        "curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "15",
        "--resolve", f"{state['ip']}:80:127.0.0.1", "--output", "/dev/null",
        "--write-out", "%{http_code} %{redirect_url}", f"http://{state['ip']}/wallet",
    ], capture=True)
    if redirect != f"301 https://{state['ip']}/wallet":
        raise DeployError("The HTTP-to-HTTPS redirect did not match the intended IP.")
    if service_ids(state["project"]) != state["core_containers"]:
        raise DeployError("Other project containers changed during deployment; review concurrent activity.")


def reload_nginx(state):
    container = current_nginx(state["project"])
    run(["docker", "exec", container, "nginx", "-t"])
    run(["docker", "exec", container, "nginx", "-s", "reload"])


def install_renewal(state):
    base = Path(state["certificates"]).parent
    manager = base / "manager.py"
    active = base / "active.json"
    name = "gsp-ip-cert-" + state["ip"].replace(".", "-")
    service_path = Path("/etc/systemd/system") / (name + ".service")
    timer_path = Path("/etc/systemd/system") / (name + ".timer")
    previous = {
        path: (path.read_text(), path.stat().st_mode & 0o777) if path.exists() else None
        for path in (manager, active, service_path, timer_path)
    }
    def unit_is(option):
        return subprocess.run(
            ["systemctl", option, "--quiet", name + ".timer"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        ).returncode == 0
    was_enabled, was_active = unit_is("is-enabled"), unit_is("is-active")
    service = (
        "[Unit]\nDescription=Renew GSP IP HTTPS certificate and reload nginx\n"
        "Wants=network-online.target\nAfter=network-online.target docker.service\n\n"
        "[Service]\nType=oneshot\nUMask=0077\nTimeoutStartSec=900\n"
        f'ExecStart="{sys.executable}" "{manager}" --renew "{active}"\n'
    )
    timer = (
        "[Unit]\nDescription=Check GSP IP certificate renewal twice daily\n\n"
        "[Timer]\nOnCalendar=*-*-* 00,12:00:00\nRandomizedDelaySec=10m\nPersistent=true\n"
        f"Unit={name}.service\n\n[Install]\nWantedBy=timers.target\n"
    )
    try:
        write_private(manager, Path(__file__).read_text(), 0o700)
        write_private(active, json.dumps(state, indent=2) + "\n")
        write_private(service_path, service, 0o644)
        write_private(timer_path, timer, 0o644)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", name + ".timer"])
        run(["systemctl", "is-enabled", "--quiet", name + ".timer"])
        run(["systemctl", "is-active", "--quiet", name + ".timer"])
        # A fresh certificate is not due: check the command/reload, not a real renewal.
        run(certbot_command(state))
        reload_nginx(state)
    except (Exception, KeyboardInterrupt):
        try:
            # A failure before daemon-reload can leave a new unit unknown to systemd.
            with contextlib.suppress(subprocess.CalledProcessError):
                run(["systemctl", "stop", name + ".timer"])
            if not was_enabled:
                with contextlib.suppress(subprocess.CalledProcessError):
                    run(["systemctl", "disable", name + ".timer"])
            for path, saved in previous.items():
                if saved is None:
                    path.unlink(missing_ok=True)
                else:
                    write_private(path, saved[0], saved[1])
            run(["systemctl", "daemon-reload"])
            if was_active:
                run(["systemctl", "start", name + ".timer"])
        except (Exception, KeyboardInterrupt) as cleanup_error:
            raise DeployError("Could not restore the prior renewal timer state: " + str(cleanup_error))
        raise


def rollback(state):
    run(compose_up(state, state["rollback_override"]))
    run(["docker", "exec", current_nginx(state["project"]), "nginx", "-t"])


def deploy(ip, project_dir):
    from ip_nginx import render_ip_config
    global DOCKER_ENDPOINT

    if not sys.stdin.isatty():
        raise DeployError("Run in an interactive server terminal so Certbot can ask its account/terms questions.")
    if not Path("/run/systemd/system").is_dir():
        raise DeployError("This installer needs a systemd VPS for automatic short-lived certificate renewal.")
    for command in ("docker", "curl", "git", "tar", "systemctl"):
        if not shutil.which(command):
            raise DeployError("Required command is missing: " + command)
    run(["docker", "compose", "version"])
    context_host = json.loads(run(
        ["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], capture=True,
    ))
    docker_host = context_host if os.environ.get("DOCKER_CONTEXT") else os.environ.get("DOCKER_HOST", context_host)
    if not docker_host.startswith("unix://"):
        raise DeployError("Run directly on the VPS with its local Docker Engine, not a remote Docker context.")
    DOCKER_ENDPOINT = docker_host
    source = Path(__file__).resolve().parents[1]
    run(["git", "-C", source, "diff", "--quiet", "HEAD", "--"])
    revision = run(["git", "-C", source, "rev-parse", "HEAD"], capture=True)
    state = discover(project_dir)
    state["docker_host"] = docker_host
    state["ip"] = ip
    old_config = run([
        "docker", "exec", state["old_container"], "cat", "/etc/nginx/conf.d/default.conf",
    ], capture=True) + "\n"
    run(["docker", "exec", state["old_container"], "nginx", "-t"])
    candidate = render_ip_config(old_config, ip)
    upstream = run([
        "docker", "exec", state["old_container"], "wget", "-q", "-O-", "http://api:4000/health",
    ], capture=True)
    if json.loads(upstream).get("status") != "ok":
        raise DeployError("The current nginx-to-api liveness check failed before deployment.")
    state["core_containers"] = service_ids(state["project"])
    print("Checking the existing HTTP certificate challenge route...", flush=True)
    check_challenge(state)
    base = STATE_ROOT / ip
    release = base / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8])
    release.mkdir(mode=0o700, parents=True)
    for name in ("certificates", "certbot_work", "certbot_logs"):
        path = base / name
        path.mkdir(mode=0o700, exist_ok=True)
        state[name] = str(path)
    old_template, new_template = release / "previous.conf.template", release / "ip.conf.template"
    write_private(old_template, old_config)
    write_private(new_template, candidate)
    build_context = release / "source"
    build_context.mkdir(mode=0o700)
    archive = release / "source.tar"
    run(["git", "-C", source, "archive", "--format=tar", "--output", archive, "HEAD"])
    run(["tar", "-xf", archive, "-C", build_context])
    archive.unlink()
    image = "gsp-bank-sniper-site:" + revision[:12] + "-" + release.name.lower()
    state["revision"] = revision
    state["image"] = image
    new_override = release / "site.compose.json"
    old_override = release / "rollback.compose.json"
    template_target = "/etc/nginx/templates/default.conf.template"
    for path, service in (
        (new_override, {
            "image": image,
            "build": {"context": str(build_context), "dockerfile": "apps/dashboard/Dockerfile"},
            "environment": {"NGINX_ENVSUBST_FILTER": "^DOMAIN$"},
            "volumes": [
                {"type": "bind", "source": str(new_template), "target": template_target, "read_only": True},
                {"type": "bind", "source": state["certificates"], "target": "/etc/letsencrypt-ip", "read_only": True},
            ],
        }),
        (old_override, {
            "image": state["old_image"],
            "environment": {"NGINX_ENVSUBST_FILTER": "^DOMAIN$"},
            "volumes": [
                {"type": "bind", "source": str(old_template), "target": template_target, "read_only": True},
            ],
        }),
    ):
        write_private(path, json.dumps({"services": {"nginx": service}}, indent=2) + "\n")
    state["new_override"], state["rollback_override"] = str(new_override), str(old_override)
    manifest = release / "state.json"
    write_private(manifest, json.dumps(state, indent=2) + "\n")
    recovery_manager = release / "manager.py"
    write_private(recovery_manager, Path(__file__).read_text(), 0o700)
    print(f"Recovery command: sudo python3 {recovery_manager} --rollback {manifest}", flush=True)
    print("Building the website from clean Git source; the existing services keep running...", flush=True)
    run(["docker", "build", "--pull", "-t", image, "-f", "apps/dashboard/Dockerfile", "."], cwd=build_context)
    print("Requesting trusted HTTPS for " + ip + ". Answer Certbot's prompts in this terminal.", flush=True)
    run(certbot_command(state, initial=True))
    print("Validating the new nginx configuration in a temporary container...", flush=True)
    run(compose(state, new_override) + ["run", "--rm", "--no-deps", "-T", "nginx", "nginx", "-t"])
    if service_ids(state["project"]) != state["core_containers"]:
        raise DeployError("Other project containers changed during preparation; cutover cancelled.")
    try:
        print("Replacing only the nginx website container...", flush=True)
        run(compose_up(state, new_override))
        last_error = None
        for attempt in range(10):
            try:
                check_site(state)
                last_error = None
                break
            except (subprocess.CalledProcessError, ValueError, DeployError) as error:
                last_error = error
                time.sleep(2)
        if last_error:
            raise last_error
        check_challenge(state)
        install_renewal(state)
    except (Exception, KeyboardInterrupt) as error:
        print("Deployment did not pass all checks. Restoring the previous nginx image/configuration...", flush=True)
        try:
            rollback(state)
        except (Exception, KeyboardInterrupt):
            raise DeployError(f"Automatic rollback failed. Recovery state: {manifest}") from error
        raise DeployError(f"Previous nginx restored. Deployment error: {error}. Recovery state: {manifest}") from error
    print(f"\nREADY: https://{ip}\nWallets: https://{ip}/wallet\nTelegram: https://{ip}/telegram")
    print("Trusted HTTPS, website routes, JavaScript, API liveness, and renewal-command checks passed.")
    print("API/bot/database container IDs are unchanged. No trading settings were changed.")
    print(f"Deployment record: {manifest}\nCompose override for future nginx updates: {new_override}")
    print(f"Rollback: sudo python3 {recovery_manager} --rollback {manifest}")


def main():
    global DOCKER_ENDPOINT
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--ip", help="Public IPv4 address of this VPS")
    modes.add_argument("--renew", type=Path, help=argparse.SUPPRESS)
    modes.add_argument("--rollback", type=Path, help="Deployment state.json to restore")
    parser.add_argument("--project-dir", type=Path, help="Existing running Nova checkout, if detection is ambiguous")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run with sudo on the VPS; Docker, certificate storage and systemd need root access.")
    os.umask(0o077)
    if args.ip:
        address = ipaddress.ip_address(args.ip)
        if address.version != 4 or not address.is_global:
            parser.error("--ip must be the VPS's public IPv4 address")
    with operation_lock():
        if args.ip:
            deploy(str(address), args.project_dir)
        else:
            state = json.loads((args.renew or args.rollback).read_text())
            DOCKER_ENDPOINT = state["docker_host"]
            if not DOCKER_ENDPOINT.startswith("unix://"):
                raise DeployError("Saved deployment must use the VPS's local Docker Engine.")
            if args.renew:
                run(certbot_command(state))
                reload_nginx(state)
            else:
                rollback(state)
                print("Previous nginx image/configuration restored; other services were not recreated.")


if __name__ == "__main__":
    try:
        main()
    except (DeployError, subprocess.CalledProcessError, OSError, ValueError) as error:
        print("\nSTOPPED: " + str(error), file=sys.stderr)
        sys.exit(1)
