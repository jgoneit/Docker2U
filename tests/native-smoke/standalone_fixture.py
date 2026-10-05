"""Explicit standalone scenario state; only synthetic owned fixture files change."""
import json
import os
import time


def enabled(root):
    return (root / "standalone-state.json").exists()


def state(root):
    path = root / "standalone-state.json"
    return json.loads(path.read_text()) if path.exists() else {"containers": [], "events": []}


def rows(root):
    return state(root)["containers"]


def row(number, name=None):
    return {"Id": format(number, "064x"), "Name": "/" + (name or f"native-smoke-{number}"),
            "Image": "native-smoke:synthetic", "Created": "2026-09-06T00:00:00Z", "StartedAt": "2026-09-08T00:00:00Z",
            "Tty": number == 4, "State": "running", "Health": "unhealthy", "HealthConfigured": True,
            "Ports": None, "ComposeProject": None, "ComposeService": None}


def save(root, value):
    temporary = root / ("standalone-state-" + str(os.getpid()) + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(root / "standalone-state.json")


def initialize(root):
    if enabled(root):
        raise ValueError("Standalone scenario already exists")
    save(root, {"stage": "initial", "containers": [row(3), row(4)], "events": []})


def transition(root, command, record):
    if not enabled(root):
        raise ValueError("Launch with --fixture-mode standalone before lifecycle controls")
    current = state(root)
    expected = "initial" if command == "standalone-recreate" else "recreated" if command == "standalone-remove-all" else None
    if expected is None or current["stage"] != expected:
        raise ValueError("Standalone lifecycle command is unknown or out of order")
    now = time.time_ns()
    if command == "standalone-recreate":
        next_rows, changed = [row(4), row(5, "native-smoke-3")], [(row(3), "destroy"), (row(5, "native-smoke-3"), "create")]
        stage = "recreated"
    else:
        next_rows, changed = [], [(item, "destroy") for item in current["containers"]]
        stage = "empty"
    emitted = [{"Type": "container", "Action": action, "Actor": {"ID": item["Id"], "Attributes": {"name": item["Name"].lstrip("/")}}, "timeNano": now + index}
               for index, (item, action) in enumerate(changed)]
    save(root, {"stage": stage, "containers": next_rows, "events": current["events"] + emitted})
    record(root, phase="standalone-transition", stage=stage, previousIds=[item["Id"] for item in current["containers"]], fullIds=[item["Id"] for item in next_rows])


def details(item):
    return {"Id": item["Id"], "State": item["State"], "ExitCode": 137, "StartedAt": item["StartedAt"],
            "FinishedAt": "2026-09-07T23:59:00Z", "OOMKilled": False, "RestartCount": 3, "HealthConfigured": True,
            "Health": {"Status": "unhealthy", "FailingStreak": 1, "Log": [{"Start": "2026-09-08T00:00:01Z", "End": "2026-09-08T00:00:02Z", "ExitCode": 1, "Output": "NATIVE_STANDALONE_HEALTH_FAILURE"}]},
            "NetworkMode": "bridge", "Ports": None, "Networks": {"bridge": {"Aliases": [], "IPAddress": "172.18.0.3", "GlobalIPv6Address": ""}}}
