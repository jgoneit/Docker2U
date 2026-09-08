#!/usr/bin/python3
"""Own an isolated fake Docker socket and a directly launched validation app."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parent.parent
STATE = REPO / ".cache/native-smoke"
ACTIVE = STATE / "active.json"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def make_fixture(root):
    # Refuse any existing path: only this successful mkdir grants cleanup ownership.
    root.mkdir(mode=0o700)
    try:
        populate_fixture(root)
    except BaseException:
        shutil.rmtree(root)
        raise


def populate_fixture(root):
    config = root / "docker-config"
    config.mkdir(mode=0o700)
    write_json(config / "config.json", {"currentContext": "native-smoke-local"})
    shutil.copyfile(REPO / "tests/native-smoke/fake_docker.py", root / "docker")
    (root / "docker").chmod(0o700)
    native_config = root / "home/Library/Application Support/io.github.jgoneit.docker2u"
    native_config.mkdir(mode=0o700, parents=True)
    write_json(native_config / "runtime.json", {"dockerPath": str(root / "docker")})


def child_environment(root):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("DOCKER_") and key not in ["COLIMA_HOME", "LIMA_HOME"]}
    # This dictionary belongs only to the child; the launching shell and user's files are unchanged.
    environment.update(HOME=str(root / "home"), DOCKER_CONFIG=str(root / "docker-config"), PATH=str(root) + ":/usr/bin:/bin")
    return environment


def read_trace(root):
    path = root / "trace.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []


def control_event(root, phase):
    descriptor = os.open(root / "trace.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, (json.dumps({"phase": phase, "pid": os.getpid(), "timeMs": time.time_ns() // 1_000_000}) + "\n").encode())
    finally:
        os.close(descriptor)


def archive_trace(manifest):
    root = Path(manifest["fixtureRoot"])
    evidence = Path(manifest["evidenceDirectory"])
    evidence.mkdir(parents=True, exist_ok=True)
    events = read_trace(root) if root.exists() else json.loads((evidence / "trace.json").read_text()) if (evidence / "trace.json").exists() else []
    write_json(evidence / "trace.json", events)
    rejected = [event for event in events if event["phase"] == "rejected-command"]
    submissions = sorted((evidence / "ui-results").glob("*.json")) if (evidence / "ui-results").exists() else []
    ui_reports = [json.loads(path.read_text()) for path in submissions]
    coverage = {(item["ui"]["mode"], name) for item in ui_reports for name in item["verification"]["completedProbes"]}
    expected = {("worker", name) for name in ["search", "connection-clear", "socket", "recovery", *INSIGHT_STEPS]} | {(mode, "search") for mode in ["constructor-fail", "never-ready"]}
    report = {**manifest, "cliEvents": len(events), "rejectedCommands": rejected,
              "dockerExecution": "isolated read-only Python fixture; no real Docker CLI is discovered or invoked",
              "uiReports": ui_reports, "requiredCoverageComplete": expected <= coverage}
    write_json(evidence / "report.json", report)
    return report


INSIGHT_STEPS = {
    "project-stats": ["Compose grouping and real stats visible", "standalone project filter verified"],
    "live-display": ["paused live display", "paused display while real stdout and stderr arrived", "resume caught up with ring loss notice", "search display frozen", "search froze and resumed without restarting the stream"],
    "pinned-refresh": ["requested inventory refresh with live stream", "inventory refreshed with the same live stream"],
    "clear-cancel": ["requested live Clear", "Clear stopped polling and remained cleared after Refresh"],
    "pane-resize": ["captured live pane before keyboard resize", "resized live pane with keyboard while receiving", "restored live pane without replacing the stream"],
}


def successful_command(events, words, begin, end):
    return any(row.get("phase") == "start" and begin <= row.get("timeMs", 0) <= end
               and row.get("args", [])[2:2 + len(words)] == words
               and any(done.get("phase") == "end" and done.get("pid") == row.get("pid")
                       and done.get("exitCode") == 0 and row["timeMs"] <= done.get("timeMs", 0) <= end for done in events)
               for row in events)


def validate_insights(probe, by_name, attempt, events, launch_start):
    begin, end = attempt[0]["timeMs"], attempt[-1]["timeMs"]
    if probe == "project-stats":
        sample = by_name["Compose grouping and real stats visible"]
        expected_ids = {format(number, "064x") for number in [1, 2]}
        if sample.get("detail") != {"projectRows": 2, "cpuPercent": 125.5, "memory": "64MiB / 2GiB"} or by_name["standalone project filter verified"].get("detail") != {"standaloneRows": 1}:
            raise ValueError("Project/stat UI sample does not match the fixture")
        if not successful_command(events, ["container", "inspect"], launch_start, sample["timeMs"]):
            raise ValueError("Project metadata has no successful native inspect")
        if not any(row.get("phase") == "stats-payload" and begin <= row.get("timeMs", 0) <= sample["timeMs"]
                   and row.get("count") == 2 and set(row.get("fullIds", [])) == expected_ids
                   and any(command.get("phase") == "start" and command.get("pid") == row.get("pid")
                           and command.get("args", [])[2:8] == ["container", "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"]
                           and set(command.get("args", [])[8:]) == expected_ids
                           and begin <= command.get("timeMs", 0) <= row["timeMs"] for command in events)
                   and any(done.get("phase") == "end" and done.get("pid") == row.get("pid") and done.get("exitCode") == 0
                           and row["timeMs"] <= done.get("timeMs", 0) <= sample["timeMs"] for done in events) for row in events):
            raise ValueError("Project/stat sample lacks the matching native batch")
        return
    first = by_name[INSIGHT_STEPS[probe][0]]
    last = by_name[INSIGHT_STEPS[probe][-1]]
    before, after = first.get("detail", {}), last.get("detail", {})
    full_id, stream_id = before.get("fullId"), before.get("streamId")
    if full_id not in {format(number, "064x") for number in [1, 2, 3]} or not isinstance(stream_id, str) or not stream_id or after.get("fullId") != full_id or after.get("streamId") != stream_id:
        raise ValueError("Live probe identity changed")
    ready = [row for row in events if row.get("phase") == "follow-ready" and row.get("fullId") == full_id and launch_start <= row.get("timeMs", 0) <= first["timeMs"]]
    if not ready:
        raise ValueError("Live probe has no matching native follow process")
    native_pid = ready[-1]["pid"]
    if any(row.get("pid") == native_pid and row.get("phase") in ["follow-stopped", "end"] and ready[-1]["timeMs"] <= row.get("timeMs", 0) < first["timeMs"] for row in events):
        raise ValueError("Live probe cites an already terminated native process")
    if probe == "live-display":
        paused = by_name["paused display while real stdout and stderr arrived"]
        searching = by_name["search display frozen"]
        for left, right in [(first, paused), (searching, last)]:
            old, new = left.get("detail", {}).get("beforeTick"), right.get("detail", {}).get("afterTick")
            if not isinstance(old, int) or not isinstance(new, int) or new < old + 3 or not any(row.get("phase") == "follow-output" and row.get("pid") == native_pid and row.get("fullId") == full_id and row.get("sequence", -1) >= new and left["timeMs"] <= row.get("timeMs", 0) <= right["timeMs"] for row in events):
                raise ValueError("Frozen display lacks concurrent native output evidence")
        if paused.get("detail", {}).get("newFrames", 0) < 1 or after.get("maximumActiveReads") != 1:
            raise ValueError("Live read IPC evidence is missing or overlapping")
    elif probe == "pinned-refresh":
        if not isinstance(before.get("starts"), int) or before["starts"] < 1 or after.get("starts") != before["starts"]:
            raise ValueError("Refresh replaced the UI stream")
        if not successful_command(events, ["container", "ls"], first["timeMs"], last["timeMs"]):
            raise ValueError("Pinned refresh lacks a successful native inventory")
    elif probe == "pane-resize":
        resized_step = by_name["resized live pane with keyboard while receiving"]
        resized = resized_step.get("detail", {})
        for size in [before, resized, after]:
            numbers = [size.get(key) for key in ["height", "min", "max", "detailHeight", "listHeight"]]
            if any(type(value) not in [int, float] or not math.isfinite(value) for value in numbers):
                raise ValueError("Pane resize lacks finite geometry")
            if not 0 < size["min"] <= size["height"] <= size["max"] or size["listHeight"] <= 0 or abs(size["detailHeight"] - size["height"]) > 1:
                raise ValueError("Pane resize lies outside its announced bounds")
        if any(size["min"] != before["min"] or size["max"] != before["max"] for size in [resized, after]):
            raise ValueError("Pane bounds changed during the keyboard probe")
        delta = 20 if resized.get("key") == "ArrowUp" else -20 if resized.get("key") == "ArrowDown" else 0
        if not delta or resized["height"] != before["height"] + delta or after["height"] != before["height"] or abs(resized["listHeight"] - before["listHeight"] + delta) > 1 or abs(after["listHeight"] - before["listHeight"]) > 1:
            raise ValueError("Pane keyboard resize or restoration was not observed")
        if resized.get("fullId") != full_id or resized.get("streamId") != stream_id or resized.get("preservedView") is not True or after.get("preservedView") is not True or type(after.get("maximumActiveReads")) is not int or after["maximumActiveReads"] != 1 or type(resized.get("newReads")) is not int or resized["newReads"] < 3:
            raise ValueError("Pane resize did not retain the view and serialized stream")
        old, new = before.get("beforeTick"), resized.get("afterTick")
        if not isinstance(old, int) or not isinstance(new, int) or new < old + 3 or not any(row.get("phase") == "follow-output" and row.get("pid") == native_pid and row.get("fullId") == full_id and row.get("sequence", -1) >= new and first["timeMs"] <= row.get("timeMs", 0) <= resized_step["timeMs"] for row in events):
            raise ValueError("Pane resize lacks concurrent native follow output")
    elif probe == "clear-cancel":
        stopped = [row for row in events if row.get("phase") == "follow-stopped" and row.get("pid") == native_pid and row.get("fullId") == full_id and first["timeMs"] <= row.get("timeMs", 0) <= last["timeMs"]]
        if not stopped or after.get("stoppedStreams") != 1 or after.get("starts") != before.get("starts"):
            raise ValueError("Clear lacks native follow cancellation")
        if not any(row.get("phase") == "end" and row.get("pid") == native_pid and row.get("exitCode") == 0 and stopped[-1]["timeMs"] <= row.get("timeMs", 0) <= last["timeMs"] for row in events):
            raise ValueError("Clear did not reap the native follow process")
        if not successful_command(events, ["container", "ls"], stopped[-1]["timeMs"], last["timeMs"]):
            raise ValueError("Clear was not preserved through native Refresh")
    if any(row.get("phase") == "follow-ready" and row.get("fullId") == full_id and first["timeMs"] < row.get("timeMs", 0) <= end for row in events):
        raise ValueError("Live probe unexpectedly restarted its native process")
    if probe != "clear-cancel" and any(row.get("phase") == "follow-stopped" and row.get("pid") == native_pid and first["timeMs"] < row.get("timeMs", 0) <= end for row in events):
        raise ValueError("Live probe lost its native process")


def validate_ui(manifest, ui, events, now_ms=None):
    if ui.get("marker") != "NATIVE_SMOKE_HARNESS" or ui.get("binding") != {key: manifest[key] for key in ["runId", "binarySha256", "startedAtMs"]}:
        raise ValueError("UI report does not belong to this exact native launch and binary")
    if ui.get("nativeIpc") is not True or ui.get("status") != "passed" or ui.get("failures"):
        raise ValueError("UI report contains incomplete or failed probes")
    mode = ui.get("mode")
    if mode not in ["worker", "constructor-fail", "never-ready"]:
        raise ValueError("Unknown Worker mode")
    steps = ui.get("steps", [])
    worker_events = ui.get("workerEvents", [])
    start = manifest["startedAtMs"]
    end = manifest.get("finishedAtMs", now_ms or time.time_ns() // 1_000_000)
    if not steps or any(not isinstance(row.get("timeMs"), int) or not start <= row["timeMs"] <= end for row in steps + worker_events):
        raise ValueError("UI event timestamp lies outside this native launch")
    if any(left["timeMs"] > right["timeMs"] for left, right in zip(steps, steps[1:])):
        raise ValueError("UI steps are out of order")
    completed = []
    clear_order = []
    pending = None
    for index, step in enumerate(steps):
        name = step.get("name", "")
        if name.startswith("started "):
            if pending is not None:
                raise ValueError("Overlapping or incomplete UI probe")
            pending = (name.removeprefix("started "), index)
        elif name.startswith("passed "):
            probe = name.removeprefix("passed ")
            if pending is None or pending[0] != probe or probe not in ["search", "connection-clear", "socket", "recovery", *INSIGHT_STEPS]:
                raise ValueError("UI completion has no matching probe start")
            attempt = steps[pending[1]:index + 1]
            by_name = {row["name"]: row for row in attempt}
            required = {
                "search": ["2 MiB dense count", "last dense match visible", "latest marker visible", "search backend verified"],
                "connection-clear": ["requested pending logs", "cleared pending logs", "native connection warning preserved after Clear"],
                "socket": ["requested missing-socket logs", "native SocketMissing verified"],
                "recovery": ["requested warning-preserving Refresh", "warning retained after successful Refresh without new logs", "requested explicit Reconnect", "explicit reconnect restored the valid session"],
                **INSIGHT_STEPS,
            }[probe]
            if not all(name in by_name for name in required):
                raise ValueError("UI probe is missing required evidence: " + probe)
            if probe == "connection-clear":
                requested = by_name["requested pending logs"]["timeMs"]
                cleared = by_name["cleared pending logs"]["timeMs"]
                reply = next((reply for reply in events if reply["phase"] == "engine-change-reply"
                              and cleared < reply["timeMs"] <= step["timeMs"]
                              and any(held["phase"] == "held-info" and held["pid"] == reply["pid"]
                                      and requested <= held["timeMs"] < cleared for held in events)), None)
                if reply is None:
                    raise ValueError("Native order proof failed: request <= held-info < Clear < same-PID reply <= UI completion")
                clear_order.append({"nativePid": reply["pid"], "requestedAtMs": requested, "clearedAtMs": cleared, "replyAtMs": reply["timeMs"]})
            if probe == "socket":
                requested = by_name["requested missing-socket logs"]["timeMs"]
                socket_changes = [row for row in events if row["phase"] in ["socket-off", "socket-on"] and row["timeMs"] <= requested]
                if not socket_changes or socket_changes[-1]["phase"] != "socket-off" or any(row["phase"] == "socket-on" and requested < row["timeMs"] < step["timeMs"] for row in events):
                    raise ValueError("The fixture socket was not removed throughout the native SocketMissing probe")
            if probe == "search":
                proof = [row for row in worker_events if attempt[0]["timeMs"] <= row["timeMs"] <= step["timeMs"]]
                names = {row["name"] for row in proof}
                total = by_name["2 MiB dense count"].get("detail", {}).get("total")
                if not any(row["phase"] == "logs-payload" and row.get("byteCount") == 2 * 1024 * 1024 and row.get("aCount") == total for row in events):
                    raise ValueError("Dense match count is not bound to a native 2 MiB fixture response")
                for name in ["last dense match visible", "latest marker visible"]:
                    bounds = by_name[name].get("detail", {})
                    viewport, match = bounds.get("viewport", {}), bounds.get("match", {})
                    coordinates = [viewport.get("top"), viewport.get("bottom"), match.get("top"), match.get("bottom")]
                    if any(not isinstance(value, (int, float)) for value in coordinates) or not viewport["top"] - 1 <= match["top"] < match["bottom"] <= viewport["bottom"] + 1:
                        raise ValueError("Search match is outside the actual native log viewport")
                if mode == "worker" and not {"ready", "result", "located"} <= names:
                    # A warm Worker may have sent ready before this search attempt.
                    if not any(row["name"] == "ready" for row in worker_events) or not {"result", "located"} <= names:
                        raise ValueError("Genuine Worker replies are missing")
                if mode == "worker" and not any(row["name"] == "result" and row.get("detail", {}).get("total") == total for row in proof):
                    raise ValueError("The real Worker did not produce the native fixture's dense count")
                if mode == "constructor-fail" and "injected constructor failure" not in {row["name"] for row in worker_events}:
                    raise ValueError("Worker constructor fault evidence is missing")
                if mode == "never-ready" and ("terminated" not in {row["name"] for row in worker_events} or not any(row["name"] == "ready" and row.get("detail", {}).get("suppressed") for row in worker_events)):
                    raise ValueError("Worker startup timeout evidence is missing")
            if probe in INSIGHT_STEPS:
                validate_insights(probe, by_name, attempt, events, start)
            if probe == "recovery":
                refreshed = by_name["warning retained after successful Refresh without new logs"]["timeMs"]
                requested = by_name["requested warning-preserving Refresh"]["timeMs"]
                reconnect = by_name["requested explicit Reconnect"]["timeMs"]
                restored = by_name["explicit reconnect restored the valid session"]["timeMs"]
                if not successful_command(events, ["container", "ls"], requested, refreshed) or any(row.get("phase") == "follow-ready" and requested <= row.get("timeMs", 0) <= refreshed for row in events):
                    raise ValueError("Warning-preserving Refresh restarted logs or lacks native inventory")
                if not any(row.get("phase") == "follow-ready" and reconnect <= row.get("timeMs", 0) <= restored for row in events):
                    raise ValueError("Reconnect lacks a fresh native follow process")
            completed.append(probe)
            pending = None
        elif name.startswith("failed "):
            raise ValueError("UI report retains a failed probe")
    if pending or not completed:
        raise ValueError("UI report has no complete probe")
    return {"accepted": True, "completedProbes": completed, "clearOrderProofs": clear_order}


def owned_controller(manifest):
    result = subprocess.run(["/bin/ps", "-p", str(manifest["controllerPid"]), "-o", "command="], capture_output=True, text=True)
    return str(Path(__file__).resolve()) in result.stdout and manifest["fixtureRoot"] in result.stdout


def serve(root, app, evidence):
    owned = False
    listener = None
    manifest = None
    stop = False

    def stop_requested(_signal, _frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    process = None
    try:
        make_fixture(root)
        owned = True
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(str(root / "engine.sock"))
        listener.listen(4)
        executable = app / "Contents/MacOS/docker2u"
        manifest = {"marker": "NATIVE_SMOKE_HARNESS", "runId": root.name, "fixtureRoot": str(root), "app": str(app), "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "controllerPid": os.getpid(), "evidenceDirectory": str(evidence), "startedAtMs": time.time_ns() // 1_000_000, "status": "running"}
        write_json(root / "launch.json", manifest)
        evidence.mkdir(parents=True, exist_ok=True)
        with (evidence / "app.log").open("wb") as log:
            process = subprocess.Popen([str(executable)], env=child_environment(root), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            manifest["appPid"] = process.pid
            write_json(ACTIVE, manifest)
            print(json.dumps(manifest), flush=True)
            while not stop and process.poll() is None:
                if (root / "socket-off").exists():
                    listener.close()
                    (root / "engine.sock").unlink(missing_ok=True)
                    (root / "socket-off").unlink()
                    control_event(root, "socket-off")
                    write_json(root / "socket-status.json", {"available": False})
                if (root / "socket-on").exists():
                    if not (root / "engine.sock").exists():
                        listener = socket.socket(socket.AF_UNIX)
                        listener.bind(str(root / "engine.sock"))
                        listener.listen(4)
                    (root / "socket-on").unlink()
                    control_event(root, "socket-on")
                    write_json(root / "socket-status.json", {"available": True})
                time.sleep(0.02)
    finally:
        try:
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            if listener:
                listener.close()
            events = read_trace(root) if owned else []
            ended = {row["pid"] for row in events if row["phase"] == "end"}
            for pid in {row["pid"] for row in events if row["phase"] == "start"} - ended:
                def is_owned_cli():
                    command = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
                    return str(root / "docker") in command
                if is_owned_cli():
                    try:
                        os.kill(pid, signal.SIGTERM)
                        deadline = time.monotonic() + 1
                        while is_owned_cli() and time.monotonic() < deadline:
                            time.sleep(0.02)
                        if is_owned_cli():
                            os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if manifest:
                manifest["status"] = "stopped"
                manifest["finishedAtMs"] = time.time_ns() // 1_000_000
                archive_trace(manifest)
                write_json(ACTIVE, manifest)
        finally:
            if owned:
                shutil.rmtree(root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["launch", "serve", "status", "arm-engine-change", "socket-off", "socket-on", "stop", "report"])
    parser.add_argument("--app", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--ui-results", type=Path)
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    if args.command == "serve":
        serve(args.root, args.app, args.evidence)
        return
    if args.command == "launch":
        if ACTIVE.exists() and owned_controller(json.loads(ACTIVE.read_text())):
            raise RuntimeError("An owned native smoke run is already active; stop it first")
        if not args.app or not (args.app / "Contents/MacOS/docker2u").is_file():
            raise RuntimeError("Build the validation bundle before launch")
        root = Path("/tmp").resolve() / ("d2u-smoke-" + uuid.uuid4().hex[:10])
        evidence = STATE / "runs" / root.name
        evidence.mkdir(parents=True)
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), "serve", "--app", str(args.app.resolve()), "--root", str(root), "--evidence", str(evidence)])
    if not ACTIVE.exists():
        raise RuntimeError("No native smoke run exists")
    manifest = json.loads(ACTIVE.read_text())
    if args.command in ["status", "report"]:
        report = archive_trace(manifest)
        if args.ui_results:
            ui = json.loads(args.ui_results.read_text())
            events = json.loads((Path(manifest["evidenceDirectory"]) / "trace.json").read_text())
            verification = validate_ui(manifest, ui, events)
            destination = Path(manifest["evidenceDirectory"]) / "ui-results"
            destination.mkdir(exist_ok=True)
            digest = hashlib.sha256(json.dumps(ui, sort_keys=True).encode()).hexdigest()[:16]
            write_json(destination / (ui["mode"] + "-" + digest + ".json"), {"ui": ui, "verification": verification})
            report = archive_trace(manifest)
        print(json.dumps(report, indent=2))
        return
    if not owned_controller(manifest):
        raise RuntimeError("The recorded controller is no longer running; no other process was touched")
    root = Path(manifest["fixtureRoot"])
    if args.command == "stop":
        os.kill(manifest["controllerPid"], signal.SIGTERM)
        print("Stop requested for the owned native smoke process")
        return
    (root / args.command).write_text("armed\n")
    if args.command.startswith("socket-"):
        deadline = time.monotonic() + 2
        while (root / args.command).exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        if (root / args.command).exists():
            raise RuntimeError("Fixture socket control timed out")
    print(json.dumps({"command": args.command, "fixtureRoot": str(root)}))


if __name__ == "__main__":
    main()
