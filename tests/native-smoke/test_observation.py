import copy
import http.client
import json
from pathlib import Path
import socket
import struct
import tempfile
import unittest

import test_fixture as shared


fixture = shared.fixture
engine = shared.load("native_smoke_engine", Path(__file__).with_name("engine_http.py"))
IDS = [format(value, "064x") for value in (1, 2)]


class ObservationEvidenceTests(unittest.TestCase):
    def evidence(self):
        binding = shared.identity()
        baseline = {"binding": binding, "engineId": "native-smoke-engine", "contextName": "native-smoke-local", "endpoint": "unix:///owned/engine.sock",
                    "sessionId": "native-session", "fullIds": IDS, "sources": 2, "pipes": ["tty", "stdout"], "eventStatus": "following", "resourcePoints": 2,
                    "at": 1500, "sequence": 2, "generation": 1}
        restored = {"sessionId": "native-session", "hiddenAt": 2000, "restoredAt": 20000, "beforeGeneration": 1, "afterGeneration": 3,
                    "beforeLogSequence": 2, "afterLogSequence": 100, "hiddenResourcePoints": 2, "hiddenLogRows": 2, "hiddenEvents": 1, "renderedRows": 40, "visibleLogRows": 6,
                    "resourceReceipts": [{"fullId": value, "at": 8000} for value in IDS], "logReceipts": [{"fullId": value, "at": 9000} for value in IDS],
                    "eventReceipts": [{"fullId": IDS[0], "at": 10000}], "displayedInventoryAt": 17000,
                    "visibility": [{"state": "hidden", "at": 2000}, {"state": "visible", "at": 20000}]}
        report = {**shared.clear_report(), "steps": [shared.step("started observation-baseline", 1100),
            shared.step("captured native project observation baseline", 1500, baseline), shared.step("passed observation-baseline", 1600),
            shared.step("started observation-restore", 21000), shared.step("verified native background collection and restore", 22000, restored), shared.step("passed observation-restore", 23000)]}
        trace = [{"phase": "api-log-binding", "timeMs": 1200, "fullId": value, "binding": binding} for value in IDS]
        for words, at, pid in [(["container", "ls"], 16000, 41), (["container", "stats"], 7900, 42)]:
            trace.extend([{"phase": "start", "timeMs": at, "pid": pid, "args": ["--host", "unix:///owned/engine.sock", *words]},
                          {"phase": "end", "timeMs": at + 100, "pid": pid, "exitCode": 0}])
        trace += [{"phase": "stats-payload", "timeMs": 7950, "fullIds": IDS}, {"phase": "api-log-output", "timeMs": 8900, "producedAtMs": 8850, "fullId": IDS[0]},
                  {"phase": "api-health-event", "timeMs": 9900, "producedAtMs": 9850, "fullId": IDS[0]}]
        return {**binding, "fixtureRoot": "/owned"}, report, trace

    def test_observation_only_report_binds_without_legacy_cli_logs(self):
        manifest, report, trace = self.evidence()
        result = fixture.validate_ui(manifest, report, trace, now_ms=24000)
        self.assertEqual(result["completedProbes"], ["observation-baseline", "observation-restore"])
        self.assertTrue(result["accepted"])
        report["steps"] = report["steps"][:3]
        self.assertTrue(fixture.validate_ui(manifest, report, trace, now_ms=24000)["accepted"])

    def test_rejects_foreign_or_unbound_api_baseline(self):
        for fault in ["binary", "socket", "engine", "session", "source", "missing-stream", "foreign-emission", "missing-baseline"]:
            manifest, report, trace = copy.deepcopy(self.evidence())
            baseline = report["steps"][1]["detail"]
            if fault == "binary": baseline["binding"] = {**baseline["binding"], "binarySha256": "b" * 64}
            elif fault == "socket": baseline["endpoint"] = "unix:///other/engine.sock"
            elif fault == "engine": baseline["engineId"] = "other-engine"
            elif fault == "session": baseline["sessionId"] = ""
            elif fault == "source": baseline["fullIds"] = [IDS[0]]
            elif fault == "missing-stream": trace.pop(1)
            elif fault == "foreign-emission": trace[0]["binding"] = {**trace[0]["binding"], "runId": "other"}
            else: report["steps"] = report["steps"][3:]
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                fixture.validate_ui(manifest, report, trace, now_ms=24000)

    def test_rejects_catchup_after_restore_and_missing_native_background_evidence(self):
        for fault in ["session", "generation", "sequence", "visibility", "short-hidden", "late-resource", "late-log", "late-event", "unrendered", "stale-ui", "no-inventory", "no-stats", "wrong-stats", "no-log-output", "no-health-output"]:
            manifest, report, trace = copy.deepcopy(self.evidence())
            value = report["steps"][4]["detail"]
            if fault == "session": value["sessionId"] = "reconnected"
            elif fault == "generation": value["afterGeneration"] = 1
            elif fault == "sequence": value["afterLogSequence"] = 2
            elif fault == "visibility": value["visibility"] = []
            elif fault == "short-hidden": value["restoredAt"] = 9000
            elif fault.startswith("late-"): value[{"late-resource": "resourceReceipts", "late-log": "logReceipts", "late-event": "eventReceipts"}[fault]][0]["at"] = 20500
            elif fault == "unrendered": value["renderedRows"] = 0
            elif fault == "stale-ui": value["displayedInventoryAt"] = 1500
            elif fault in ["no-inventory", "no-stats"]: trace = [row for row in trace if row.get("pid") != (41 if fault == "no-inventory" else 42)]
            elif fault == "wrong-stats": next(row for row in trace if row["phase"] == "stats-payload")["fullIds"] = [IDS[0]]
            else: trace = [row for row in trace if row["phase"] != ("api-log-output" if fault == "no-log-output" else "api-health-event")]
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                fixture.validate_ui(manifest, report, trace, now_ms=24000)

    def test_dom_rows_without_visible_viewport_evidence_do_not_pass(self):
        for visible in [None, 0, -1, True, 41]:
            manifest, report, trace = copy.deepcopy(self.evidence())
            value = report["steps"][4]["detail"]
            value["visibleLogRows"] = visible
            with self.subTest(visible=visible), self.assertRaisesRegex(ValueError, "not visible inside the viewport"):
                fixture.validate_ui(manifest, report, trace, now_ms=24000)

    def test_owned_http_stream_emits_manifest_binding_for_tty_and_multiplex(self):
        with tempfile.TemporaryDirectory(prefix="obs-", dir="/tmp") as directory:
            root = Path(directory)
            fixture.write_json(root / "launch.json", {**shared.identity(), "fixtureRoot": str(root), "unrelated": "not-transmitted"})
            server = engine.EngineServer(root)
            try:
                for full_id in IDS:
                    connection = http.client.HTTPConnection("localhost", timeout=3)
                    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    connection.sock.settimeout(3)
                    connection.sock.connect(str(root / "engine.sock"))
                    try:
                        connection.request("GET", "/v1.47/containers/" + full_id + "/logs")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        if full_id == IDS[0]:
                            pipe, length = struct.unpack(">BxxxI", response.read(8))
                            self.assertEqual(pipe, 1)
                            header = response.read(length).decode()
                        else:
                            header = response.readline().decode()
                        self.assertEqual(json.loads(header.split("NATIVE_PROJECT_RUN ", 1)[1]), shared.identity())
                    finally:
                        connection.close()
            finally:
                server.close()
            emissions = [row for row in fixture.read_trace(root) if row["phase"] == "api-log-binding"]
            self.assertEqual({row["fullId"] for row in emissions}, set(IDS))
            self.assertTrue(all(row["binding"] == shared.identity() for row in emissions))


if __name__ == "__main__":
    unittest.main()
