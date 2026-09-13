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


def images(root):
    path = root / "compose-images.json"
    return json.loads(path.read_text()) if path.exists() else {}


def save_images(root, value):
    temporary = root / ("compose-images-" + str(os.getpid()) + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(root / "compose-images.json")


def image_name(model, service):
    return model["services"][service].get("image") or model["name"] + "-" + service


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
    if values in [["--help"], ["config", "--help"], ["up", "--help"], ["stop", "--help"], ["pull", "--help"], ["build", "--help"]]:
        print("Docker Compose fixture: --ansi --progress --project-directory --project-name --file --env-file --profile config --format json up --detach --no-deps --no-build --pull --force-recreate stop --timeout pull --policy build")
        return 0
    flags = {}
    pair_flags = {"--ansi", "--progress", "--project-directory", "--project-name", "-p", "--file", "-f", "--env-file", "--profile"}
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
        record(root, phase="compose-config", project=name, composeFile=str(source), allProfiles=flags.get("--profile") == "*")
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
    if "--profile" in flags:
        raise ValueError("fixture refuses profile expansion during changes")
    apply_prefix = ["--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--"]
    apply = command == "up" and options[:len(apply_prefix)] == apply_prefix
    if command == "pull" and options[:3] == ["--policy", "always", "--"]:
        selected = options[3:]
    elif command == "build" and options[:1] == ["--"]:
        selected = options[1:]
    elif apply:
        selected = options[len(apply_prefix):]
    elif command == "up" and options in [["-d"], ["--detach"]]:
        selected = [service for service, spec in model["services"].items() if not spec.get("profiles")]
    elif command == "stop" and not options:
        selected = list(model["services"])
    else:
        raise ValueError("fixture rejects unsupported Compose action or options")
    if not selected or len(selected) != len(set(selected)) or any(service not in model["services"] for service in selected):
        raise ValueError("fixture requires distinct known services")
    mode = (root / "compose-mode").read_text().strip() if (root / "compose-mode").exists() else "success"
    record(root, phase="compose-operation", action=command, project=name, mode=mode, services=selected, apply=apply)
    print("NATIVE_COMPOSE_BEGIN " + command + " " + name, flush=True)
    if mode == "quiet":
        while not stopping():
            time.sleep(0.02)
        record(root, phase="compose-cancelled", project=name)
        return 130
    prepared_images = images(root)
    if command in ["pull", "build"]:
        for service in selected:
            spec = model["services"][service]
            if (command == "pull" and not spec.get("image")) or (command == "build" and not spec.get("build")):
                raise ValueError("fixture rejects impossible image preparation")
            if mode == command + "-fail":
                print("NATIVE_COMPOSE_PREPARATION_FAILURE " + service, flush=True)
                record(root, phase="compose-preparation-failed", action=command, project=name)
                return 1
            image = image_name(model, service)
            prepared_images[image] = {"preparation": command, "service": service}
            if command == "build":
                prepared_images[image]["dockerfileDigest"] = hashlib.sha256((directory / "Dockerfile").read_bytes()).hexdigest()
            save_images(root, prepared_images)
            print("NATIVE_COMPOSE_IMAGE_READY " + service, flush=True)
        record(root, phase="compose-complete", action=command, project=name, services=selected)
        return 0
    containers = rows(root)
    if command == "up":
        if apply and any(image_name(model, service) not in prepared_images for service in selected):
            print("NATIVE_COMPOSE_MISSING_LOCAL_IMAGE", flush=True)
            return 1
        containers = [row for row in containers if row["ComposeProject"] != name or row["ComposeService"] not in selected]
        generations = state(root).get("generations", {})
        generations[name] = generations.get(name, 0) + 1
        generation = generations[name]
        save_rows(root, containers, generations)
        for service in selected:
            if stopping():
                record(root, phase="compose-cancelled", project=name)
                return 130
            print("NATIVE_COMPOSE_SERVICE " + service + " creating", flush=True)
            time.sleep(0.4)
            containers.append({
                "Id": hashlib.sha256((name + ":" + service + ":" + str(generation)).encode()).hexdigest(), "Name": "/" + name + "-" + service + "-1",
                "Image": image_name(model, service), "Created": "2026-09-13T00:00:00Z",
                "StartedAt": "2026-09-13T00:00:01Z", "Tty": False, "State": "running",
                "HealthConfigured": service == "api", "Health": "healthy" if service == "api" else None, "Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}]} if service == "api" else None,
                "ComposeProject": name, "ComposeService": service,
                "WorkingDirectory": str(directory), "ConfigFiles": str(source),
                "EnvironmentFile": flags.get("--env-file", ""),
            })
            save_rows(root, containers)
            if not apply:
                prepared_images.setdefault(image_name(model, service), {"preparation": "up", "service": service})
                save_images(root, prepared_images)
            if mode in ["fail", "recreate-fail"]:
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
