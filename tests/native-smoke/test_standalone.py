"""Owned standalone lifecycle and archived-source protocol; no Docker access."""
import copy
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from engine_http import EngineServer, record
from test_engine_http import UnixHTTPConnection
import standalone_fixture as standalone
import test_fixture as shared


class StandaloneFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="d2u-stand-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "owned"
        shared.fixture.make_fixture(self.root, "standalone")
        shared.fixture.write_json(self.root / "launch.json", shared.identity())
        self.server = EngineServer(self.root)
        self.addCleanup(self.server.close)

    def client(self, path):
        client = UnixHTTPConnection(self.root / "engine.sock")
        self.addCleanup(client.close)
        client.request("GET", path)
        return client.getresponse()

    def cli(self, args):
        return subprocess.run([sys.executable, str(self.root / "docker"), "--host", "unix://" + str(self.root / "engine.sock"), *args], env=shared.fixture.child_environment(self.root), capture_output=True, timeout=3)

    def inventory(self):
        reply = self.cli(["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"])
        self.assertEqual(reply.returncode, 0, reply.stderr)
        return [json.loads(line)["ID"] for line in reply.stdout.splitlines()]

    def test_explicit_mode_has_two_standalone_sources_and_preserves_compose(self):
        ids = self.inventory()
        self.assertEqual(ids, [format(number, "064x") for number in (1, 2, 3, 4)])
        reply = self.cli(["container", "inspect", "--format", shared.docker.INSPECT_FORMAT, *ids])
        rows = [json.loads(line) for line in reply.stdout.splitlines()]
        self.assertEqual([item["ComposeProject"] for item in rows], ["native-smoke-project", "native-smoke-project", None, None])
        self.assertEqual([item["Tty"] for item in rows[-2:]], [False, True])
        details = self.cli(["container", "inspect", "--format", shared.docker.DETAILS_FORMAT, ids[2]])
        self.assertEqual(json.loads(details.stdout)["Health"]["FailingStreak"], 1)

    def test_both_stream_formats_emit_owned_binding_and_health_events_have_no_compose_labels(self):
        for number in (3, 4):
            response = self.client(f"/v1.47/containers/{number:064x}/logs?follow=1")
            self.assertEqual(response.status, 200)
            if number == 3:
                _, length = struct.unpack(">BxxxI", response.read(8))
                header = response.read(length)
            else:
                header = response.readline()
            self.assertEqual(json.loads(header.decode().split("NATIVE_PROJECT_RUN ", 1)[1]), shared.identity())
        stream = self.client("/v1.47/events")
        events = [json.loads(stream.readline()) for _ in range(3)]
        self.assertEqual({item["Actor"]["ID"] for item in events}, {format(number, "064x") for number in (1, 3, 4)})
        for event in events[1:]:
            self.assertEqual(set(event["Actor"]["Attributes"]), {"name"})
            self.assertTrue(event["Action"].startswith("health_status:"))

    def test_deleted_full_id_stream_ends_and_same_name_replacement_gets_new_identity(self):
        old = self.client(f"/v1.47/containers/{3:064x}/logs?follow=1")
        for _ in range(2):
            _, length = struct.unpack(">BxxxI", old.read(8))
            old.read(length)
        standalone.transition(self.root, "standalone-recreate", record)
        old.read()  # Buffered old frames may drain; stream must end, not attach to ID 5.
        self.assertEqual(self.inventory(), [format(number, "064x") for number in (1, 2, 4, 5)])
        self.assertEqual(self.client(f"/v1.47/containers/{3:064x}/logs").status, 404)
        self.assertEqual(self.client(f"/v1.47/containers/{3:064x}/json").status, 404)
        replacement = next(item for item in standalone.rows(self.root) if item["Id"] == format(5, "064x"))
        self.assertEqual(replacement["Name"], "/native-smoke-3")
        self.assertEqual(self.client(f"/v1.47/containers/{5:064x}/json").status, 200)
        actions = standalone.state(self.root)["events"]
        self.assertEqual([(item["Action"], item["Actor"]["ID"]) for item in actions], [("destroy", format(3, "064x")), ("create", format(5, "064x"))])
        standalone.transition(self.root, "standalone-remove-all", record)
        self.assertEqual(self.inventory(), [format(number, "064x") for number in (1, 2)])
        self.assertEqual(self.client(f"/v1.47/containers/{5:064x}/json").status, 404)

    def test_lifecycle_rejects_out_of_order_commands_without_changing_state(self):
        before = standalone.state(self.root)
        for command in ("standalone-remove-all", "stop", "rm", "reset"):
            with self.subTest(command=command), self.assertRaises(ValueError):
                standalone.transition(self.root, command, record)
        self.assertEqual(standalone.state(self.root), before)
        default = self.root / "default"
        default.mkdir()
        with self.assertRaises(ValueError):
            standalone.transition(default, "standalone-recreate", record)
        self.assertEqual(list(default.iterdir()), [])


class StandaloneEvidenceTests(unittest.TestCase):
    def evidence(self):
        ids = [format(number, "064x") for number in (3, 4, 5)]
        manifest = {**shared.identity(), "fixtureRoot": "/owned", "fixtureMode": "standalone", "coverageProfile": "group-observation-v2"}
        counts = {"configure": 2, "stop": 1, "retry": 0, "terminalStarts": 0}
        identity = {"sessionId": "native-session", "fullId": ids[0], "eventSequence": 6}
        occurred = "1970-01-01T00:00:01.400123456Z"
        query = {**identity, "occurredAt": occurred, "minutes": 2, "timeFrom": "1969-12-31T23:58:01.400Z", "timeTo": "1970-01-01T00:02:01.400Z",
                 "rows": 12, "allRowsExactId": True, "allRowsInWindow": True, "visibleRows": True, "graphMarkers": 2}
        group = {**identity, "binding": shared.identity(), "engineId": "native-smoke-engine", "endpoint": "unix:///owned/engine.sock",
                 "fullIds": ids[:2], "logRows": 24, "resourcePoints": 4, "occurredAt": occurred, "counts": counts.copy()}
        report = {**shared.clear_report(), "coverageProfile": "group-observation-v2", "steps": [
            shared.step("started standalone-incident", 1100),
            shared.step("standalone group collected", 1600, group),
            shared.step("standalone incident rendered", 2000, {**query, "requestedAt": 1800, "repliedAt": 1900, "testedMinutes": [1, 5, 2], "refreshed": True, "counts": counts.copy()}),
            shared.step("standalone incident returned", 2400, {**identity, "minutes": 2, "diagnosticsVisited": True, "terminalVisited": True, "terminalNotStarted": True, "focusRestored": True, "counts": counts.copy()}),
            shared.step("passed standalone-incident", 2500),
            shared.step("started standalone-archive", 3200),
            shared.step("standalone replaced archive verified", 3500, {**query, "requestedAt": 3300, "repliedAt": 3400, "currentIds": ids[1:], "currentDisabled": True, "groupSelected": True, "countsBefore": counts.copy(), "countsAfter": counts.copy()}),
            shared.step("passed standalone-archive", 3600),
            shared.step("started standalone-empty", 4200),
            shared.step("standalone empty archive verified", 4500, {**query, "requestedAt": 4300, "repliedAt": 4400, "currentIds": [], "currentDisabled": True, "groupSelected": True, "countsBefore": counts.copy(), "countsAfter": counts.copy()}),
            shared.step("passed standalone-empty", 4600),
        ]}
        trace = [{"phase": "api-log-binding", "fullId": identifier, "binding": shared.identity(), "timeMs": 1200} for identifier in ids[:2]]
        trace += [{"phase": "stats-payload", "fullIds": ids[:2], "timeMs": 1300},
                  {"phase": "api-standalone-event", "fullId": ids[0], "action": "health_status: unhealthy", "producedAtMs": 1400, "timeMs": 1450},
                  {"phase": "details-payload", "fullId": ids[0], "exitCode": 137, "timeMs": 2100},
                  {"phase": "standalone-transition", "stage": "recreated", "previousIds": ids[:2], "fullIds": ids[1:], "timeMs": 3000},
                  {"phase": "standalone-transition", "stage": "empty", "previousIds": ids[1:], "fullIds": [], "timeMs": 4000}]
        return manifest, report, trace

    def test_accepts_native_roundtrip_and_both_archived_stages_with_nanosecond_event_time(self):
        manifest, report, trace = self.evidence()
        result = shared.fixture.validate_ui(manifest, report, trace, now_ms=5000)
        self.assertEqual(result["completedProbes"], ["standalone-incident", "standalone-archive", "standalone-empty"])

    def test_rejects_wrong_launch_scope_or_unapproved_metadata(self):
        for fault in ("mode", "profile", "ui-profile", "binding", "endpoint", "source", "session", "raw", "missing", "event", "window", "nan", "bool-counter"):
            manifest, report, trace = copy.deepcopy(self.evidence())
            group, query = report["steps"][1]["detail"], report["steps"][2]["detail"]
            if fault == "mode": manifest["fixtureMode"] = "default"
            elif fault == "profile": manifest["coverageProfile"] = "legacy"
            elif fault == "ui-profile": report["coverageProfile"] = "legacy"
            elif fault == "binding": group["binding"]["runId"] = "another-run"
            elif fault == "endpoint": group["endpoint"] = "unix:///foreign.sock"
            elif fault == "source": group["fullIds"] = [format(1, "064x"), format(2, "064x")]
            elif fault == "session": query["sessionId"] = "reconnected"
            elif fault == "raw": query["rawLogs"] = "not-allowed"
            elif fault == "missing": del query["visibleRows"]
            elif fault == "event": query["eventSequence"] = 7
            elif fault == "window": query["timeFrom"] = "1969-12-31T23:59:01.400Z"
            elif fault == "nan": query["rows"] = float("nan")
            else: group["counts"]["configure"] = True
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=5000)

    def test_rejects_collection_changes_auto_exec_and_unrendered_return(self):
        for fault in ("configure", "stop", "retry", "terminalStarts", "auto-exec", "no-focus", "no-diagnostics", "no-terminal", "no-rows", "no-graphs", "no-refresh"):
            manifest, report, trace = copy.deepcopy(self.evidence())
            rendered, returned = report["steps"][2]["detail"], report["steps"][3]["detail"]
            if fault in ("configure", "stop", "retry", "terminalStarts"): returned["counts"][fault] += 1
            elif fault == "auto-exec": trace.append({"phase": "api-terminal-created", "fullId": format(3, "064x"), "timeMs": 2250})
            elif fault == "no-focus": returned["focusRestored"] = False
            elif fault == "no-diagnostics": returned["diagnosticsVisited"] = False
            elif fault == "no-terminal": returned["terminalNotStarted"] = False
            elif fault == "no-rows": rendered["rows"] = 0
            elif fault == "no-graphs": rendered["graphMarkers"] = 1
            else: rendered["refreshed"] = False
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=5000)

    def test_requires_native_log_event_stats_details_and_lifecycle_trace(self):
        for index in range(7):
            manifest, report, trace = copy.deepcopy(self.evidence())
            removed = trace.pop(index)
            with self.subTest(removed=removed["phase"]), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=5000)

    def test_rejects_recreated_id_rebinding_missing_group_or_reopened_old_stream(self):
        for fault in ("new-id", "current-enabled", "group-missing", "new-collection", "no-empty", "reopen-old", "duplicate-transition", "missing-archive", "out-of-order-query"):
            manifest, report, trace = copy.deepcopy(self.evidence())
            archived, empty = report["steps"][6]["detail"], report["steps"][9]["detail"]
            if fault == "new-id": archived["fullId"] = format(5, "064x")
            elif fault == "current-enabled": archived["currentDisabled"] = False
            elif fault == "group-missing": empty["groupSelected"] = False
            elif fault == "new-collection": archived["countsAfter"]["configure"] += 1
            elif fault == "no-empty": empty["currentIds"] = [format(5, "064x")]
            elif fault == "reopen-old": trace.append({"phase": "api-log-binding", "fullId": format(3, "064x"), "timeMs": 3400})
            elif fault == "duplicate-transition": trace.append(copy.deepcopy(trace[5]))
            elif fault == "missing-archive": report["steps"] = report["steps"][:5] + report["steps"][8:]
            else: archived["requestedAt"] = 1800
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=5000)

    def test_v2_coverage_uses_group_probes_and_historical_profile_remains_separate(self):
        manifest, ui, trace = self.evidence()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "owned"
            root.mkdir()
            evidence = Path(directory) / "evidence"
            submissions = evidence / "ui-results"
            submissions.mkdir(parents=True)
            manifest.update(fixtureRoot=str(root), evidenceDirectory=str(evidence))
            shared.fixture.write_json(submissions / "accepted.json", {"ui": ui, "verification": {"completedProbes": list(shared.fixture.STANDALONE_STEPS)}})
            self.assertTrue(shared.fixture.archive_trace(manifest)["requiredCoverageComplete"])
            self.assertTrue(shared.fixture.archive_trace(manifest)["standaloneCoverageComplete"])
            manifest.pop("coverageProfile")
            self.assertFalse(shared.fixture.archive_trace(manifest)["requiredCoverageComplete"])


if __name__ == "__main__":
    unittest.main()
