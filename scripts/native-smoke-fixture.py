#!/usr/bin/python3
"""Own an isolated fake Docker socket and a directly launched validation app."""
import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parent.parent
STATE = REPO / ".cache/native-smoke"
ACTIVE = STATE / "active.json"


def engine_listener(root):
    spec = importlib.util.spec_from_file_location("native_engine_http", REPO / "tests/native-smoke/engine_http.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.EngineServer(root)


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
    shutil.copyfile(REPO / "tests/native-smoke/compose_fixture.py", root / "compose_fixture.py")
    compose_spec = importlib.util.spec_from_file_location("native_compose_fixture", root / "compose_fixture.py")
    compose = importlib.util.module_from_spec(compose_spec)
    compose_spec.loader.exec_module(compose)
    compose.make_project(root)
    (root / "docker").chmod(0o700)
    native_config = root / "home/Library/Application Support/io.github.jgoneit.docker2u"
    native_config.mkdir(mode=0o700, parents=True)
    write_json(native_config / "runtime.json", {"dockerPath": str(root / "docker")})


def child_environment(root):
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("DOCKER_", "COMPOSE_", "BUILDX_", "BUILDKIT_")) and key not in ["COLIMA_HOME", "LIMA_HOME"]}
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
              "dockerExecution": "isolated Python fixture with synthetic Compose state; no real Docker CLI is discovered or invoked",
              "uiReports": ui_reports, "requiredCoverageComplete": expected <= coverage,
              "observationCoverageComplete": {("worker", name) for name in OBSERVATION_STEPS} <= coverage}
    write_json(evidence / "report.json", report)
    return report


INSIGHT_STEPS = {
    "project-stats": ["Compose grouping and real stats visible", "standalone tree navigation verified"],
    "live-display": ["paused live display", "paused display while real stdout and stderr arrived", "resume caught up with ring loss notice", "search display frozen", "search froze and resumed without restarting the stream"],
    "pinned-refresh": ["requested inventory refresh with live stream", "inventory refreshed with the same live stream"],
    "clear-cancel": ["requested live Clear", "Clear stopped polling and remained cleared after Refresh"],
    "pane-resize": ["captured live pane before keyboard resize", "resized live pane with keyboard while receiving", "restored live pane without replacing the stream"],
    "detail-tabs": ["captured log view before detail tabs", "native diagnostics and bounded health output verified", "native connection candidates verified", "restored logs after all three tabs"],
}

OBSERVATION_STEPS = {
    "observation-baseline": ["captured native project observation baseline"],
    "observation-restore": ["verified native background collection and restore"],
}

COMPOSE_METADATA_FIELDS = {
    "compose picker": {"kind", "selected"},
    "compose preview": {"name", "services", "existingContainers"},
    "compose preview failed": {"code"},
    "compose registered": {"id", "name", "revision"},
    "compose prepared": {"name", "action", "existingContainers"},
    "compose started": {"id", "action", "phase"},
    "compose phase": {"id", "action", "phase", "outcome", "reconciliation", "observedContainers", "errorCode"},
    "compose cancelled": {"id", "phase", "cancelRequested"},
}


def validate_compose_metadata(step):
    """Accept bounded IPC metadata, never award a UI/viewport completion probe."""
    detail = step.get("detail")
    if not isinstance(detail, dict) or set(detail) != COMPOSE_METADATA_FIELDS[step["name"]]:
        raise ValueError("Compose metadata fields are missing or include unapproved payload")
    for key, value in detail.items():
        if key in ("selected", "cancelRequested"):
            valid = type(value) is bool
        elif key in ("revision", "existingContainers", "observedContainers"):
            valid = (key == "observedContainers" and value is None) or (type(value) is int and value >= (1 if key == "revision" else 0))
        elif key == "services":
            valid = isinstance(value, list) and len(value) <= 256 and all(isinstance(name, str) and 0 < len(name) <= 256 for name in value)
        else:
            valid = (key in ("outcome", "errorCode") and value is None) or (isinstance(value, str) and 0 < len(value) <= 256)
        if not valid:
            raise ValueError("Compose metadata contains an invalid value: " + key)
    for key, allowed in {"kind": {"file", "directory", "env"}, "action": {"up", "stop", "apply"},
                         "phase": {"preparing", "running", "reconciling", "finished"},
                         "outcome": {None, "succeeded", "failed", "resultUnknown", "cancelledBeforeStart", "cancelled"},
                         "reconciliation": {"pending", "succeeded", "failed", "skipped"}}.items():
        if key in detail and detail[key] not in allowed:
            raise ValueError("Compose metadata contains an unknown state: " + key)
    return {"name": step["name"], "timeMs": step["timeMs"], "detail": detail}


def validate_observation(probe, by_name, attempt, steps, events, manifest):
    expected_binding = {key: manifest[key] for key in ("runId", "binarySha256", "startedAtMs")}
    ids = {format(value, "064x") for value in (1, 2)}
    baseline_rows = [row for row in steps if row.get("name") == OBSERVATION_STEPS["observation-baseline"][0]
                     and row["timeMs"] <= attempt[-1]["timeMs"]]
    if not baseline_rows:
        raise ValueError("Observation restore lacks a native baseline")
    baseline_row = baseline_rows[-1]
    baseline = baseline_row.get("detail", {})
    if any(type(baseline.get(key)) is not int or baseline[key] < 1 for key in ("at", "generation", "sequence")):
        raise ValueError("Observation baseline lacks positive Core sequence and generation")
    if baseline.get("binding") != expected_binding or baseline.get("engineId") != "native-smoke-engine" or baseline.get("contextName") != "native-smoke-local":
        raise ValueError("Observation baseline is not bound to the owned Engine and launch")
    if manifest.get("fixtureRoot") and baseline.get("endpoint") != "unix://" + manifest["fixtureRoot"] + "/engine.sock":
        raise ValueError("Observation baseline uses a foreign fixture socket")
    if not isinstance(baseline.get("sessionId"), str) or not baseline["sessionId"] or set(baseline.get("fullIds", [])) != ids or baseline.get("sources") != 2:
        raise ValueError("Observation baseline lacks the exact native sources and session")
    if not {"tty", "stdout"} <= set(baseline.get("pipes", [])) or baseline.get("eventStatus") != "following" or baseline.get("resourcePoints", 0) < 1:
        raise ValueError("Observation baseline lacks real TTY, multiplex, resources and events")
    if not manifest["startedAtMs"] <= baseline.get("at", 0) <= baseline_row["timeMs"]:
        raise ValueError("Observation baseline timestamp lies outside the launch")
    for full_id in ids:
        if not any(row.get("phase") == "api-log-binding" and row.get("fullId") == full_id and row.get("binding") == expected_binding
                   and manifest["startedAtMs"] <= row.get("timeMs", 0) <= baseline["at"] for row in events):
            raise ValueError("Observation launch binding was not emitted by both owned API streams")
    if probe == "observation-baseline":
        return
    value = by_name[OBSERVATION_STEPS[probe][0]].get("detail", {})
    if any(type(value.get(key)) is not int for key in ("hiddenAt", "restoredAt", "beforeGeneration", "afterGeneration", "beforeLogSequence", "afterLogSequence", "displayedInventoryAt")):
        raise ValueError("Observation restore lacks numeric Core and visibility timestamps")
    hidden, restored = value.get("hiddenAt", 0), value.get("restoredAt", 0)
    if not baseline["at"] <= hidden < restored <= attempt[-1]["timeMs"] or restored - hidden < 10_000 or attempt[-1]["timeMs"] - baseline["at"] < 15_000:
        raise ValueError("Native observation hidden interval is missing or too short")
    if value.get("sessionId") != baseline["sessionId"] or value.get("beforeGeneration") != baseline.get("generation") or value.get("beforeLogSequence") != baseline.get("sequence"):
        raise ValueError("Observation restore replaced its session or baseline")
    if value.get("afterGeneration", 0) <= value["beforeGeneration"] or value.get("afterLogSequence", 0) <= value["beforeLogSequence"]:
        raise ValueError("Background observations did not advance")
    if not {("hidden", hidden), ("visible", restored)} <= {(row.get("state"), row.get("at")) for row in value.get("visibility", [])}:
        raise ValueError("Native WebView visibility evidence is missing")
    for key, count, minimum in [("resourceReceipts", "hiddenResourcePoints", 2), ("logReceipts", "hiddenLogRows", 2), ("eventReceipts", "hiddenEvents", 1)]:
        rows = value.get(key, [])
        if len(rows) < minimum or value.get(count) != len(rows) or any(row.get("fullId") not in (ids | {format(3, "064x")} if key == "resourceReceipts" else ids) or not hidden + 1000 < row.get("at", 0) < restored - 1000 for row in rows):
            raise ValueError("Core observation receipts lie outside the hidden interval: " + key)
    if value.get("renderedRows", 0) < 1 or not hidden < value.get("displayedInventoryAt", 0) <= attempt[-1]["timeMs"]:
        raise ValueError("Restored native screen has not applied background data")
    if type(value.get("visibleLogRows")) is not int or not 1 <= value["visibleLogRows"] <= value["renderedRows"]:
        raise ValueError("Restored native log rows are not visible inside the viewport")
    if not successful_command(events, ["container", "ls"], hidden, restored) or not successful_command(events, ["container", "stats"], hidden, restored):
        raise ValueError("Hidden interval lacks successful native inventory and stats collection")
    if not any(row.get("phase") == "stats-payload" and set(row.get("fullIds", [])) == ids | {format(3, "064x")} and hidden < row.get("timeMs", 0) < restored for row in events):
        raise ValueError("Native hidden stats payload does not match the navigation inventory")
    for phase, receipts in [("api-log-output", value["logReceipts"]), ("api-health-event", value["eventReceipts"])]:
        if not any(row.get("phase") == phase and hidden < row.get("timeMs", 0) < restored
                   and hidden < row.get("producedAtMs", 0) <= row["timeMs"]
                   and any(receipt["fullId"] == row.get("fullId") and row["producedAtMs"] <= receipt["at"] for receipt in receipts) for row in events):
            raise ValueError("Hidden Core receipts lack owned API output: " + phase)


def successful_command(events, words, begin, end):
    return any(row.get("phase") == "start" and begin <= row.get("timeMs", 0) <= end
               and row.get("args", [])[2:2 + len(words)] == words
               and any(done.get("phase") == "end" and done.get("pid") == row.get("pid")
                       and done.get("exitCode") == 0 and row["timeMs"] <= done.get("timeMs", 0) <= end for done in events)
               for row in events)


def validate_recovery(by_name, events):
    requested = by_name["requested warning-preserving Refresh"]
    rejected = by_name["warning retained after NeedsValidation rejected Refresh without new logs"]
    reconnect = by_name["requested explicit Reconnect"]
    restored = by_name["explicit reconnect restored the valid session"]
    before, blocked, retry, fresh = (row.get("detail", {}) for row in (requested, rejected, reconnect, restored))
    if not requested["timeMs"] <= rejected["timeMs"] <= reconnect["timeMs"] <= restored["timeMs"]:
        raise ValueError("Recovery evidence is not ordered Refresh then Reconnect")
    session = before.get("sessionId")
    if not isinstance(session, str) or not session or blocked.get("sessionId") != session or retry.get("sessionId") != session:
        raise ValueError("Blocked Refresh is not bound to the invalid native session")
    if blocked.get("errorCode") != "NeedsValidation" or blocked.get("renderedErrorCode") != "NeedsValidation" or type(blocked.get("request")) is not int or blocked["request"] < 1:
        raise ValueError("Blocked Refresh lacks an actual NeedsValidation IPC rejection and UI error")
    if any(type(blocked.get(key)) is not int for key in ("requestedAtMs", "repliedAtMs")) or not requested["timeMs"] <= blocked["requestedAtMs"] <= blocked["repliedAtMs"] <= rejected["timeMs"]:
        raise ValueError("NeedsValidation IPC reply does not belong to this Refresh attempt")
    if any(blocked.get(key) is not True for key in ("inventoryPreserved", "warningVisible", "recoveryBlocked")) or not before.get("listCheckedAt") or blocked.get("listCheckedAt") != before["listCheckedAt"]:
        raise ValueError("Blocked Refresh did not retain the inventory, warning, and disabled recovery")
    for key in ("starts", "startRequests"):
        if type(before.get(key)) is not int or before[key] < 0 or blocked.get(key) != before[key] or retry.get(key) != before[key]:
            raise ValueError("Blocked Refresh requested or opened logs before Reconnect")
    if any(requested["timeMs"] <= row.get("timeMs", 0) < reconnect["timeMs"] and
           (row.get("phase") in ("follow-ready", "api-log-binding") or
            (row.get("phase") == "start" and row.get("args", [])[2:4] in (["container", "ls"], ["container", "logs"]))) for row in events):
        raise ValueError("Blocked Refresh dispatched native inventory or logs before Reconnect")
    fresh_session = fresh.get("sessionId")
    if not isinstance(fresh_session, str) or not fresh_session or fresh_session == session or fresh.get("responseSessionId") != fresh_session or fresh.get("errorCode") is not None:
        raise ValueError("Reconnect lacks inventory from a fresh native session")
    if type(fresh.get("request")) is not int or fresh["request"] <= blocked["request"] or any(type(fresh.get(key)) is not int for key in ("requestedAtMs", "repliedAtMs")) or not reconnect["timeMs"] <= fresh["requestedAtMs"] <= fresh["repliedAtMs"] <= restored["timeMs"]:
        raise ValueError("Fresh inventory IPC reply does not belong to explicit Reconnect")
    if type(fresh.get("starts")) is not int or fresh["starts"] <= before["starts"] or not fresh.get("streamId") or fresh.get("fullId") != format(3, "064x") or fresh.get("warningVisible") is not False or fresh.get("recoveryAvailable") is not True:
        raise ValueError("Reconnect did not restore fresh standalone logs and recovery availability")
    if not successful_command(events, ["container", "ls"], reconnect["timeMs"], restored["timeMs"]):
        raise ValueError("Reconnect lacks successful native inventory")
    if not any(row.get("phase") == "follow-ready" and row.get("fullId") == fresh["fullId"] and reconnect["timeMs"] <= row.get("timeMs", 0) <= restored["timeMs"] for row in events):
        raise ValueError("Reconnect lacks a fresh native follow process")


def validate_insights(probe, by_name, attempt, events, launch_start):
    begin, end = attempt[0]["timeMs"], attempt[-1]["timeMs"]
    if probe == "project-stats":
        sample = by_name["Compose grouping and real stats visible"]
        expected_ids = {format(number, "064x") for number in [1, 2, 3]}
        value = sample.get("detail", {})
        expected = {"projectRows": 2, "observedSources": 3, "cpuPercent": 125.5, "memoryUsageBytes": 67108864, "memoryLimitBytes": 2147483648}
        if any(value.get(key) != expected[key] for key in expected) or set(value.get("fullIds", [])) != expected_ids or not isinstance(value.get("sessionId"), str) or not value["sessionId"] or type(value.get("observationSequence")) is not int or value["observationSequence"] < 1:
            raise ValueError("Project/stat UI sample does not match the fixture")
        try:
            sampled_at = datetime.fromisoformat(value["sampledAt"].replace("Z", "+00:00")).timestamp() * 1000
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ValueError("Project/stat sample lacks a Core receipt time")
        if not begin <= sampled_at <= sample["timeMs"] or by_name["standalone tree navigation verified"].get("detail") != {"standaloneRows": 1, "inventoryRows": 3, "fullId": format(3, "064x")}:
            raise ValueError("Project/stat UI sample or tree navigation does not match the fixture")
        if not successful_command(events, ["container", "inspect"], launch_start, sample["timeMs"]):
            raise ValueError("Project metadata has no successful native inspect")
        if not any(row.get("phase") == "stats-payload" and begin <= row.get("timeMs", 0) <= sample["timeMs"]
                   and row.get("count") == 3 and set(row.get("fullIds", [])) == expected_ids
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
    if probe == "detail-tabs":
        diagnostic = by_name["native diagnostics and bounded health output verified"]
        connections = by_name["native connection candidates verified"]
        if diagnostic.get("detail") != {"fullId": full_id, "exitCode": 137, "oomKilled": False, "healthConfigured": True, "healthFailures": 1}:
            raise ValueError("Diagnostic UI values do not match the synthetic native response")
        if connections.get("detail") != {"ipv4Candidate": "127.0.0.1:15432", "ipv6Candidate": "[::1]:15432", "alias": "native-api", "unpublishedUdp": True}:
            raise ValueError("Connection UI values do not match the synthetic native response")
        payloads = [row for row in events if row.get("phase") == "details-payload" and first["timeMs"] <= row.get("timeMs", 0) <= diagnostic["timeMs"]]
        if len(payloads) != 1 or payloads[0].get("fullId") != full_id:
            raise ValueError("Detail tabs lack one matching native inspect response")
        payload = payloads[0]
        commands = [row for row in events if row.get("phase") == "start" and row.get("pid") == payload.get("pid")
                    and first["timeMs"] <= row.get("timeMs", 0) <= payload["timeMs"]
                    and row.get("args", [])[2:5] == ["container", "inspect", "--format"]
                    and row.get("args", [])[-1:] == [full_id]]
        if not commands or len(commands[0]["args"]) != 7 or '"HealthConfigured"' not in commands[0]["args"][5]:
            raise ValueError("Details evidence lacks the allowlisted native inspect command")
        if not any(row.get("phase") == "end" and row.get("pid") == payload.get("pid") and row.get("exitCode") == 0
                   and payload["timeMs"] <= row.get("timeMs", 0) <= diagnostic["timeMs"] for row in events):
            raise ValueError("Detail inspect did not finish successfully")
        if after.get("preservedView") is not True or after.get("detailsReads") != 1 or after.get("starts") != before.get("starts") or after.get("maximumActiveReads") != 1:
            raise ValueError("Detail tabs did not preserve their shared read and log view")
    elif probe == "live-display":
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
            numbers = [size.get(key) for key in ["width", "min", "max", "detailWidth", "listWidth"]]
            if any(type(value) not in [int, float] or not math.isfinite(value) for value in numbers):
                raise ValueError("Pane resize lacks finite geometry")
            if not 0 < size["min"] <= size["width"] <= size["max"] or size["listWidth"] <= 0 or abs(size["listWidth"] - size["width"]) > 1:
                raise ValueError("Pane resize lies outside its announced bounds")
        if any(size["min"] != before["min"] or size["max"] != before["max"] for size in [resized, after]):
            raise ValueError("Pane bounds changed during the keyboard probe")
        delta = 20 if resized.get("key") == "ArrowRight" else -20 if resized.get("key") == "ArrowLeft" else 0
        if not delta or resized["width"] != before["width"] + delta or after["width"] != before["width"] or abs(resized["detailWidth"] - before["detailWidth"] + delta) > 1 or abs(after["detailWidth"] - before["detailWidth"]) > 1:
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
    if ui.get("nativeIpc") is not True or ui.get("status") not in ("passed", "ready") or ui.get("failures"):
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
    metadata = []
    pending = None
    for index, step in enumerate(steps):
        name = step.get("name", "")
        if name in COMPOSE_METADATA_FIELDS:
            metadata.append(validate_compose_metadata(step))
        elif name.startswith("compose "):
            raise ValueError("Unknown Compose metadata step")
        elif name.startswith("started "):
            if pending is not None:
                raise ValueError("Overlapping or incomplete UI probe")
            pending = (name.removeprefix("started "), index)
        elif name.startswith("passed "):
            probe = name.removeprefix("passed ")
            if pending is None or pending[0] != probe or probe not in ["search", "connection-clear", "socket", "recovery", "project-recovery", *INSIGHT_STEPS, *OBSERVATION_STEPS]:
                raise ValueError("UI completion has no matching probe start")
            attempt = steps[pending[1]:index + 1]
            by_name = {row["name"]: row for row in attempt}
            required = {
                "search": ["2 MiB dense count", "last dense match visible", "latest marker visible", "search backend verified"],
                "connection-clear": ["requested pending logs", "cleared pending logs", "native connection warning preserved after Clear"],
                "socket": ["requested missing-socket logs", "native SocketMissing verified"],
                "recovery": ["requested warning-preserving Refresh", "warning retained after NeedsValidation rejected Refresh without new logs", "requested explicit Reconnect", "explicit reconnect restored the valid session"],
                "project-recovery": ["injected project configure response failure", "native project retry restored visible logs"],
                **INSIGHT_STEPS,
                **OBSERVATION_STEPS,
            }[probe]
            if not all(name in by_name for name in required):
                raise ValueError("UI probe is missing required evidence: " + probe)
            if probe == "project-recovery":
                injected = by_name[required[0]].get("detail", {})
                recovered = by_name[required[1]].get("detail", {})
                visible = recovered.get("visibleLogRows")
                if (injected.get("nativeConfigureCompleted") is not True or injected.get("responseFaultOnly") is not True
                        or not injected.get("sessionId") or injected.get("project") != "native-smoke-project"
                        or type(recovered.get("nativeRetries")) is not int or recovered["nativeRetries"] != 1
                        or type(visible) is not int or visible <= 0 or recovered.get("errorCleared") is not True):
                    raise ValueError("Project response recovery lacks real IPC and visible viewport evidence")
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
            if probe in OBSERVATION_STEPS:
                validate_observation(probe, by_name, attempt, steps[:index + 1], events, manifest)
            if probe == "recovery":
                validate_recovery(by_name, events)
            completed.append(probe)
            pending = None
        elif name.startswith("failed "):
            raise ValueError("UI report retains a failed probe")
    if pending or (not completed and not metadata):
        raise ValueError("UI report has no complete probe")
    if completed and ui.get("status") != "passed":
        raise ValueError("UI report contains incomplete or failed probes")
    return {"accepted": True, "completedProbes": completed, "clearOrderProofs": clear_order,
            "metadataEvidence": metadata, "metadataOnly": not completed, "composeUiVerified": False}


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
        executable = app / "Contents/MacOS/docker2u"
        manifest = {"marker": "NATIVE_SMOKE_HARNESS", "runId": root.name, "fixtureRoot": str(root), "app": str(app), "binarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(), "controllerPid": os.getpid(), "evidenceDirectory": str(evidence), "startedAtMs": time.time_ns() // 1_000_000, "status": "running"}
        listener = engine_listener(root)
        write_json(root / "launch.json", manifest)
        evidence.mkdir(parents=True, exist_ok=True)
        with (evidence / "app.log").open("wb") as log:
            process = subprocess.Popen([str(executable)], env=child_environment(root), stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            manifest["appPid"] = process.pid
            write_json(ACTIVE, manifest)
            print(json.dumps(manifest), flush=True)
            while not stop and process.poll() is None:
                if (root / "socket-off").exists():
                    if listener:
                        listener.close()
                    listener = None
                    (root / "engine.sock").unlink(missing_ok=True)
                    (root / "socket-off").unlink()
                    control_event(root, "socket-off")
                    write_json(root / "socket-status.json", {"available": False})
                if (root / "socket-on").exists():
                    if not (root / "engine.sock").exists():
                        listener = engine_listener(root)
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
