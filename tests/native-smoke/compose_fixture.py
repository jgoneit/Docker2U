"""Compose-only fixture; changes synthetic JSON state, never invokes Docker."""
import hashlib
import json
import os
from pathlib import Path
import time

PROJECT = "native-compose"
SECRET = "NATIVE_COMPOSE_ENV_VALUE_MUST_NOT_BE_PROJECT_METADATA"
PROVENANCE_FORMAT = '{"Id":{{json .Id}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"WorkingDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ConfigFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}'


def state(root):
    path = root / "compose-state.json"
    return json.loads(path.read_text()) if path.exists() else {"containers": [], "generations": {}}


def rows(root):
    return state(root).get("containers", [])


def save_rows(root, containers, generations=None):
    temporary = root / ("compose-state-" + str(os.getpid()) + ".tmp")
    temporary.write_text(json.dumps({"containers": containers, "generations": generations if generations is not None else state(root).get("generations", {})}))
    temporary.chmod(0o600)
    temporary.replace(root / "compose-state.json")


def make_project(root):
    directory = root / "compose project 한글"
    directory.mkdir(mode=0o700)
    model = {"name": PROJECT, "services": {
        "api": {"image": "native-compose:fixture", "environment": {"FIXTURE_SECRET": SECRET}},
        "worker": {"build": {"context": ".", "dockerfile": "Dockerfile"}},
    }}
    (directory / "compose.yaml").write_text(json.dumps(model, indent=2))
    (directory / ".env").write_text("FIXTURE_SECRET=" + SECRET + "\n")
    (directory / "Dockerfile").write_text("FROM scratch\n")
    (directory / "invalid.yaml").write_text("services: [\n")
    return directory


def dispatch(root, arguments, record, stopping):
    if not arguments or arguments[0] != "compose":
        return None
    values = arguments[1:]
    expected = {"DOCKER_HOST": "unix://" + str(root / "engine.sock"), "COMPOSE_REMOVE_ORPHANS": "false", "COMPOSE_PROFILES": "", "COMPOSE_MENU": "false", "BUILDX_BUILDER": "default"}
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise ValueError("fixture requires pinned Engine and Compose environment")
    if any(key.startswith(("COMPOSE_", "BUILDX_", "BUILDKIT_")) and key not in expected for key in os.environ):
        raise ValueError("fixture rejected ambient Compose or builder overrides")
    if values == ["version", "--short"]:
        print("2.39.4")
        return 0
    if values in [["--help"], ["config", "--help"], ["up", "--help"], ["stop", "--help"]]:
        print("Docker Compose fixture: --ansi --progress --project-directory --project-name --file --env-file config --format json up --detach stop --timeout")
        return 0
    flags = {}
    pair_flags = {"--ansi", "--progress", "--project-directory", "--project-name", "-p", "--file", "-f", "--env-file"}
    while values and values[0] in pair_flags:
        if len(values) < 2:
            raise ValueError("missing fixture Compose flag value")
        flag, value, *values = values
        if flag in flags:
            raise ValueError("fixture only supports one Compose file")
        flags[flag] = value
    if not values:
        raise ValueError("missing fixture Compose command")
    command, *options = values
    if flags.get("--ansi") != "never" or flags.get("--progress") != "plain":
        raise ValueError("fixture requires plain Compose output")
    if not (flags.get("--file") or flags.get("-f")) or not flags.get("--project-directory"):
        raise ValueError("fixture requires explicit Compose file and working directory")
    source = Path(flags.get("--file", flags.get("-f", ""))).resolve()
    directory = Path(flags.get("--project-directory", "")).resolve()
    if not source.is_relative_to(root.resolve()) or not directory.is_relative_to(root.resolve()):
        raise ValueError("fixture refuses Compose files outside its owned directory")
    if Path.cwd().resolve() != directory:
        raise ValueError("fixture requires the registered working directory")
    env_file = Path(flags.get("--env-file", ""))
    if str(env_file) != "/dev/null" and (not env_file.is_absolute() or not env_file.resolve().is_relative_to(root.resolve()) or not env_file.is_file()):
        raise ValueError("fixture requires an owned environment file or explicit /dev/null")
    model = json.loads(source.read_text())
    name = flags.get("--project-name", flags.get("-p", model.get("name", directory.name)))
    model["name"] = name
    if command == "config" and options == ["--format", "json"]:
        record(root, phase="compose-config", project=name, composeFile=str(source))
        while (root / "compose-config-block").exists() and not stopping():
            time.sleep(0.02)
        if stopping():
            record(root, phase="compose-config-cancelled", project=name)
            return 130
        if (root / "compose-config-fail").exists():
            print("NATIVE_COMPOSE_CONFIG_FAILURE required variable is missing", flush=True)
            return 1
        print(json.dumps(model))
        return 0
    if command not in ["up", "stop"] or (command == "up" and options not in [["-d"], ["--detach"]]) or (command == "stop" and options):
        raise ValueError("fixture accepts only config, up -d, and stop")
    mode = (root / "compose-mode").read_text().strip() if (root / "compose-mode").exists() else "success"
    record(root, phase="compose-operation", action=command, project=name, mode=mode)
    print("NATIVE_COMPOSE_BEGIN " + command + " " + name, flush=True)
    if mode == "quiet":
        while not stopping():
            time.sleep(0.02)
        record(root, phase="compose-cancelled", project=name)
        return 130
    containers = rows(root)
    if command == "up":
        containers = [row for row in containers if row["ComposeProject"] != name]
        generations = state(root).get("generations", {})
        generations[name] = generations.get(name, 0) + 1
        generation = generations[name]
        save_rows(root, containers, generations)
        for service in model["services"]:
            if stopping():
                record(root, phase="compose-cancelled", project=name)
                return 130
            print("NATIVE_COMPOSE_SERVICE " + service + " creating", flush=True)
            time.sleep(0.4)
            containers.append({
                "Id": hashlib.sha256((name + ":" + service + ":" + str(generation)).encode()).hexdigest(), "Name": "/" + name + "-" + service + "-1",
                "Image": "native-compose:fixture", "Created": "2026-09-13T00:00:00Z",
                "StartedAt": "2026-09-13T00:00:01Z", "Tty": False, "State": "running",
                "HealthConfigured": service == "api", "Health": "healthy" if service == "api" else None, "Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}]} if service == "api" else None,
                "ComposeProject": name, "ComposeService": service,
                "WorkingDirectory": str(directory), "ConfigFiles": str(source),
                "EnvironmentFile": flags.get("--env-file", ""),
            })
            save_rows(root, containers)
            if mode == "fail":
                print("NATIVE_COMPOSE_PARTIAL_FAILURE worker failed to start", flush=True)
                record(root, phase="compose-partial-failure", project=name)
                return 1
    else:
        for container in containers:
            if container["ComposeProject"] == name:
                container["State"] = "exited"
                container["Health"] = None
        save_rows(root, containers)
    print("NATIVE_COMPOSE_END " + command, flush=True)
    record(root, phase="compose-complete", action=command, project=name, count=len(containers))
    return 0
