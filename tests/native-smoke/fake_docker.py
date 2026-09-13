#!/usr/bin/python3
"""Synthetic Docker protocol fixture. Never discovers or invokes a real CLI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time

_compose_spec = importlib.util.spec_from_file_location("native_compose", Path(__file__).with_name("compose_fixture.py"))
compose = importlib.util.module_from_spec(_compose_spec)
_compose_spec.loader.exec_module(compose)
_export_spec = importlib.util.spec_from_file_location("native_image_export", Path(__file__).with_name("image_export_fixture.py"))
image_export = importlib.util.module_from_spec(_export_spec)
_export_spec.loader.exec_module(image_export)

LIMIT = 2 * 1024 * 1024
END = b"\nNATIVE_SMOKE_END\n"
INSPECT_FORMAT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"StartedAt":{{json .State.StartedAt}},"Tty":{{json .Config.Tty}},"State":{{json .State.Status}},"HealthConfigured":{{$config := .Config}}{{if eq (printf "%T" $config) "map[string]interface {}"}}{{$health := index $config "Healthcheck"}}{{$healthType := printf "%T" $health}}{{if eq $healthType "<nil>"}}false{{else if eq $healthType "map[string]interface {}"}}{{$test := index $health "Test"}}{{$testType := printf "%T" $test}}{{if eq $testType "<nil>"}}false{{else if or (eq $testType "[]interface {}") (eq $testType "[]string")}}{{if eq (len $test) 0}}false{{else}}{{$kind := index $test 0}}{{if eq (printf "%T" $kind) "string"}}{{if or (eq $kind "CMD") (eq $kind "CMD-SHELL")}}true{{else if eq $kind "NONE"}}false{{else}}null{{end}}{{else}}null{{end}}{{end}}{{else}}null{{end}}{{else}}null{{end}}{{else}}null{{end}},"Health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"Ports":{{json (index .NetworkSettings "Ports")}},"ComposeProject":{{with index .Config.Labels "com.docker.compose.project"}}{{json .}}{{else}}null{{end}},"ComposeService":{{with index .Config.Labels "com.docker.compose.service"}}{{json .}}{{else}}null{{end}}}'
MOUNTS_FORMAT = '{"Id":{{json .Id}},"Mounts":[{{range $i,$mount := .Mounts}}{{if $i}},{{end}}{"Type":{{json $mount.Type}},"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}},"Name":{{json $mount.Name}}}{{end}}]}'
DETAILS_FORMAT = '{"Id":{{json .Id}},"State":{{json .State.Status}},"ExitCode":{{json (index .State "ExitCode")}},"StartedAt":{{json (index .State "StartedAt")}},"FinishedAt":{{json (index .State "FinishedAt")}},"OOMKilled":{{json (index .State "OOMKilled")}},"RestartCount":{{json .RestartCount}},"HealthConfigured":{{$config := .Config}}{{if eq (printf "%T" $config) "map[string]interface {}"}}{{$health := index $config "Healthcheck"}}{{$healthType := printf "%T" $health}}{{if eq $healthType "<nil>"}}false{{else if eq $healthType "map[string]interface {}"}}{{$test := index $health "Test"}}{{$testType := printf "%T" $test}}{{if eq $testType "<nil>"}}false{{else if or (eq $testType "[]interface {}") (eq $testType "[]string")}}{{if eq (len $test) 0}}false{{else}}{{$kind := index $test 0}}{{if eq (printf "%T" $kind) "string"}}{{if or (eq $kind "CMD") (eq $kind "CMD-SHELL")}}true{{else if eq $kind "NONE"}}false{{else}}null{{end}}{{else}}null{{end}}{{end}}{{else}}null{{end}}{{else}}null{{end}}{{else}}null{{end}},"Health":{{with index .State "Health"}}{"Status":{{json .Status}},"FailingStreak":{{json .FailingStreak}},"Log":[{{range $i,$entry := .Log}}{{if $i}},{{end}}{"Start":{{json $entry.Start}},"End":{{json $entry.End}},"ExitCode":{{json $entry.ExitCode}},"Output":{{json $entry.Output}}}{{end}}]}{{else}}null{{end}},"NetworkMode":{{json (index .HostConfig "NetworkMode")}},"Ports":{{json (index .NetworkSettings "Ports")}},"Networks":{{with index .NetworkSettings "Networks"}}{ {{$first := true}}{{range $name,$network := .}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}:{"Aliases":{{json $network.Aliases}},"IPAddress":{{json $network.IPAddress}},"GlobalIPv6Address":{{json $network.GlobalIPv6Address}}}{{end}} }{{else}}null{{end}}}'
IDS = [format(number, "064x") for number in [1, 2, 3]]
STOP_REQUESTED = False


def dense_logs(manifest):
    # Bind UI evidence to this launch through the real get_recent_logs response.
    identity = {key: manifest[key] for key in ["runId", "binarySha256", "startedAtMs"]}
    header = ("NATIVE_SMOKE_RUN " + json.dumps(identity, separators=(",", ":")) + "\n").encode()
    return header + b"a" * (LIMIT - len(header) - len(END)) + END


def record(root, **event):
    event.update(pid=os.getpid(), timeMs=time.time_ns() // 1_000_000)
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(root / "trace.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, data)
    finally:
        os.close(descriptor)


def follow_logs(root, identifier):
    # Start from the same dense snapshot as the original search probe. Live
    # ticks are explicitly armed so native Worker evidence remains repeatable.
    manifest = json.loads((root / "launch.json").read_text())
    write_logs(root, manifest)
    record(root, phase="follow-ready", fullId=identifier)
    sequence = 0
    next_tick = time.monotonic()
    while not STOP_REQUESTED:
        if (root / "follow-live").exists() and time.monotonic() >= next_tick:
            sequence += 1
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000000000Z"
            for output, name in [(sys.stdout, "STDOUT"), (sys.stderr, "STDERR")]:
                output.write(f"\n{timestamp} NATIVE_SMOKE_LIVE_{name} {sequence} 한글 fullId={identifier}\n")
                output.flush()
            record(root, phase="follow-output", fullId=identifier, sequence=sequence)
            next_tick = time.monotonic() + 0.25
        time.sleep(0.02)
    record(root, phase="follow-stopped", fullId=identifier, sequence=sequence)
    return 0


def write_logs(root, manifest):
    payload = dense_logs(manifest)
    record(root, phase="logs-payload", byteCount=len(payload), sha256=hashlib.sha256(payload).hexdigest(), aCount=payload.lower().count(b"a"))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def run(root, arguments):
    if arguments == ["--version"]:
        print("Docker version 29.8.0, build native-smoke-fixture")
        return 0
    if arguments == ["context", "inspect"]:
        config = Path(os.environ["DOCKER_CONFIG"])
        if config.resolve() != (root / "docker-config").resolve():
            raise ValueError("fixture rejected a foreign Docker config")
        print(json.dumps([{"Name": "native-smoke-local", "Endpoints": {"docker": {"Host": "unix://" + str(root / "engine.sock")}}}]))
        return 0
    if arguments[:2] != ["--host", "unix://" + str(root / "engine.sock")]:
        raise ValueError("fixture rejected a foreign endpoint or implicit host")
    args = arguments[2:]
    compose_result = compose.dispatch(root, args, record, lambda: STOP_REQUESTED)
    if compose_result is not None:
        return compose_result
    compose_rows = compose.rows(root)
    identifiers = [*IDS, *(row["Id"] for row in compose_rows)]
    export_result = image_export.dispatch(root, args, identifiers, record, lambda: STOP_REQUESTED)
    if export_result is not None:
        return export_result
    if args == ["info", "--format", "{{json .}}"]:
        claimed = root / ("claimed-info-" + str(os.getpid()))
        changed = False
        try:
            (root / "arm-engine-change").rename(claimed)
            changed = True
        except FileNotFoundError:
            pass
        if changed:
            record(root, phase="held-info", holdMs=3000)
            time.sleep(3)
            record(root, phase="engine-change-reply")
        print(json.dumps({"ID": "changed-engine" if changed else "native-smoke-engine", "OSType": "linux", "Architecture": "aarch64", "Name": "NATIVE_SMOKE_HARNESS"}))
        return 0
    if args == ["version", "--format", "{{json .}}"]:
        print(json.dumps({"Client": {"Version": "29.8.0", "ApiVersion": "1.54"}, "Server": {"Version": "29.8.0", "ApiVersion": "1.54"}}))
        return 0
    if args == ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"]:
        for identifier in identifiers:
            print(json.dumps({"ID": identifier}))
        return 0
    if len(args) == 8 and args[:5] == ["container", "ls", "--all", "--no-trunc", "--filter"] and args[6:] == ["--format", "{{.ID}}"] and args[5].startswith("label=com.docker.compose.project="):
        name = args[5].split("=", 2)[2]
        selected = [row["Id"] for row in compose_rows if row["ComposeProject"] == name]
        if name == "native-smoke-project":
            selected = [*IDS[:2], *selected]
        record(root, phase="compose-provenance-list", project=name, fullIds=selected)
        for identifier in selected:
            print(identifier)
        return 0
    if len(args) >= 5 and args[:4] == ["container", "inspect", "--format", compose.PROVENANCE_FORMAT]:
        if len(set(args[4:])) != len(args[4:]) or any(identifier not in identifiers for identifier in args[4:]):
            raise ValueError("fixture rejected unknown or duplicate provenance targets")
        for identifier in args[4:]:
            row = next((row for row in compose_rows if row["Id"] == identifier), {})
            print(json.dumps({"Id": identifier, "Project": row.get("ComposeProject", "native-smoke-project" if identifier in IDS[:2] else None), "WorkingDirectory": row.get("WorkingDirectory"), "ConfigFiles": row.get("ConfigFiles")}))
        record(root, phase="compose-provenance-inspect", fullIds=args[4:])
        return 0
    if len(args) == 5 and args[:4] == ["container", "inspect", "--format", DETAILS_FORMAT] and args[4] in identifiers and args[4] not in IDS:
        row = next(row for row in compose_rows if row["Id"] == args[4])
        configured = row["ComposeService"] == "api"
        running = row["State"] == "running"
        print(json.dumps({"Id": row["Id"], "State": row["State"], "ExitCode": 0, "StartedAt": row["StartedAt"], "FinishedAt": "0001-01-01T00:00:00Z" if running else "2026-09-13T00:01:00Z", "OOMKilled": False, "RestartCount": 0, "HealthConfigured": configured, "Health": {"Status": row["Health"], "FailingStreak": 0, "Log": []} if configured and running else None, "NetworkMode": "bridge", "Ports": row["Ports"], "Networks": {row["ComposeProject"] + "_default": {"Aliases": [row["ComposeService"]], "IPAddress": "172.19.0.2", "GlobalIPv6Address": ""}}}))
        record(root, phase="details-payload", fullId=row["Id"], exitCode=0, oomKilled=False, healthConfigured=configured)
        return 0
    if len(args) == 5 and args[:4] == ["container", "inspect", "--format", DETAILS_FORMAT] and args[4] in IDS:
        identifier = args[4]
        record(root, phase="details-payload", fullId=identifier, exitCode=137, oomKilled=False, healthConfigured=True)
        print(json.dumps({"Id": identifier, "State": "running", "ExitCode": 137,
                          "StartedAt": "2026-09-08T00:00:00Z", "FinishedAt": "2026-09-07T23:59:00Z",
                          "OOMKilled": False, "RestartCount": 3, "HealthConfigured": True,
                          "Health": {"Status": "unhealthy", "FailingStreak": 1, "Log": [
                              {"Start": "2026-09-08T00:00:01Z", "End": "2026-09-08T00:00:02Z", "ExitCode": 1,
                               "Output": "NATIVE_SMOKE_HEALTH_FAILURE <b>refused</b>"}]},
                          "NetworkMode": "bridge", "Ports": {"5432/tcp": [
                              {"HostIp": "0.0.0.0", "HostPort": "15432"}, {"HostIp": "::", "HostPort": "15432"}], "53/udp": None},
                          "Networks": {"native-smoke-default": {"Aliases": ["native-api"], "IPAddress": "172.18.0.2", "GlobalIPv6Address": "fd00::2"}}}))
        return 0
    if len(args) >= 5 and args[:4] == ["container", "inspect", "--format", MOUNTS_FORMAT]:
        targets = args[4:]
        if len(targets) > 100 or len(set(targets)) != len(targets) or any(identifier not in identifiers for identifier in targets):
            raise ValueError("fixture rejected unknown, duplicate or oversized mount targets")
        for identifier in targets:
            number = int(identifier, 16)
            mounts = [{"Type": "bind", "Source": "/synthetic/설정 폴더/" + "long-directory-" * 8 + "/settings.yaml", "Destination": "/app/settings.yaml", "RW": False, "Name": None}]
            if number != 3:
                mounts.append({"Type": "volume", "Source": "/var/lib/docker/volumes/native-shared-data/_data", "Destination": "/data", "RW": number != 2, "Name": "native-shared-data"})
            if number == 2:
                mounts.append({"Type": "tmpfs", "Source": None, "Destination": "/tmp", "RW": True, "Name": None})
            print(json.dumps({"Id": identifier, "Mounts": mounts}))
        record(root, phase="mounts-payload", fullIds=targets, count=len(targets))
        return 0
    if len(args) >= 5 and args[:4] == ["container", "inspect", "--format", INSPECT_FORMAT]:
        for identifier in args[4:]:
            if identifier not in identifiers:
                raise ValueError("fixture rejected an unknown container")
            if identifier not in IDS:
                print(json.dumps(next(row for row in compose_rows if row["Id"] == identifier)))
                continue
            number = int(identifier, 16)
            print(json.dumps({"Id": identifier, "Name": "/native-smoke-" + str(number), "Image": "native-smoke:synthetic", "Created": "2026-09-06T00:00:00Z", "StartedAt": "2026-09-08T00:00:00Z", "Tty": number == 2, "State": "running", "Health": "healthy", "HealthConfigured": True, "Ports": None,
                              "ComposeProject": "native-smoke-project" if number < 3 else None, "ComposeService": {1: "api", 2: "redis"}.get(number)}))
        return 0
    if len(args) >= 7 and args[:6] == ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"]:
        targets = args[6:]
        if len(set(targets)) != len(targets) or any(identifier not in identifiers for identifier in targets):
            raise ValueError("fixture rejected unknown or duplicate stats targets")
        rows = []
        for identifier in targets:
            number = int(identifier, 16)
            rows.append({"ID": identifier, "CPUPerc": {1: "125.50%", 2: "2.50%", 3: "0.50%"}.get(number, "1.25%"),
                         "MemUsage": f"{ {1: 64, 2: 32, 3: 8}.get(number, 16)}MiB / 2GiB", "MemPerc": {1: "3.125%", 2: "1.5625%", 3: "0.390625%"}.get(number, "0.78125%")})
        record(root, phase="stats-payload", fullIds=targets, count=len(rows))
        for row in rows:
            print(json.dumps(row))
        return 0
    if len(args) == 7 and args[:6] == ["container", "logs", "--follow", "--tail", "300", "--timestamps"] and args[6] in identifiers:
        return follow_logs(root, args[6])
    if len(args) == 6 and args[:5] == ["container", "logs", "--tail", "300", "--timestamps"] and args[5] in identifiers:
        write_logs(root, json.loads((root / "launch.json").read_text()))
        return 0
    record(root, phase="rejected-command", args=arguments)
    raise ValueError("fixture only accepts its explicit synthetic command allowlist")


def main():
    def stop(_signal, _frame):
        global STOP_REQUESTED
        STOP_REQUESTED = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    root = Path(__file__).resolve().parent
    arguments = sys.argv[1:]
    record(root, phase="start", args=arguments)
    code = 95
    try:
        code = run(root, arguments)
    except Exception as error:
        print(str(error), file=sys.stderr)
    finally:
        record(root, phase="end", exitCode=code)
    return code


if __name__ == "__main__":
    sys.exit(main())
