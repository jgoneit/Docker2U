#!/usr/bin/python3
"""Read-only Docker protocol fixture. Never discovers or invokes a real CLI."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time

LIMIT = 2 * 1024 * 1024
END = b"\nNATIVE_SMOKE_END\n"
INSPECT_FORMAT = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"State":{{json .State.Status}},"Health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"Ports":{{json (index .NetworkSettings "Ports")}},"ComposeProject":{{with index .Config.Labels "com.docker.compose.project"}}{{json .}}{{else}}null{{end}},"ComposeService":{{with index .Config.Labels "com.docker.compose.service"}}{{json .}}{{else}}null{{end}}}'
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
        for identifier in IDS:
            print(json.dumps({"ID": identifier}))
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
    if len(args) >= 5 and args[:4] == ["container", "inspect", "--format", INSPECT_FORMAT]:
        for identifier in args[4:]:
            if identifier not in IDS:
                raise ValueError("fixture rejected an unknown container")
            number = int(identifier, 16)
            print(json.dumps({"Id": identifier, "Name": "/native-smoke-" + str(number), "Image": "native-smoke:synthetic", "Created": "2026-09-06T00:00:00Z", "State": "running", "Health": "healthy", "Ports": None,
                              "ComposeProject": "native-smoke-project" if number < 3 else None, "ComposeService": {1: "api", 2: "redis"}.get(number)}))
        return 0
    if len(args) >= 7 and args[:6] == ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"]:
        identifiers = args[6:]
        if len(set(identifiers)) != len(identifiers) or any(identifier not in IDS for identifier in identifiers):
            raise ValueError("fixture rejected unknown or duplicate stats targets")
        rows = []
        for identifier in identifiers:
            number = int(identifier, 16)
            rows.append({"ID": identifier, "CPUPerc": {1: "125.50%", 2: "2.50%", 3: "0.50%"}[number],
                         "MemUsage": f"{ {1: 64, 2: 32, 3: 8}[number]}MiB / 2GiB", "MemPerc": {1: "3.125%", 2: "1.5625%", 3: "0.390625%"}[number]})
        record(root, phase="stats-payload", fullIds=identifiers, count=len(rows))
        for row in rows:
            print(json.dumps(row))
        return 0
    if len(args) == 7 and args[:6] == ["container", "logs", "--follow", "--tail", "300", "--timestamps"] and args[6] in IDS:
        return follow_logs(root, args[6])
    if len(args) == 6 and args[:5] == ["container", "logs", "--tail", "300", "--timestamps"] and args[5] in IDS:
        write_logs(root, json.loads((root / "launch.json").read_text()))
        return 0
    record(root, phase="rejected-command", args=arguments)
    raise ValueError("fixture only accepts its explicit read-only command allowlist")


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
