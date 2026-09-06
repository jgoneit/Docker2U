import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load("native_smoke_fixture", REPO / "scripts/native-smoke-fixture.py")
docker = load("native_smoke_docker", Path(__file__).with_name("fake_docker.py"))


def identity():
    return {"runId": "test-owned-run", "binarySha256": "a" * 64, "startedAtMs": 1000}


def step(name, timestamp, detail=None):
    return {"name": name, "timeMs": timestamp, "detail": detail or {}}


def clear_report():
    return {"marker": "NATIVE_SMOKE_HARNESS", "binding": identity(), "mode": "worker", "nativeIpc": True,
            "status": "passed", "failures": [], "workerEvents": [], "steps": [
                step("started connection-clear", 1100), step("requested pending logs", 1200),
                step("cleared pending logs", 1500), step("native connection warning preserved after Clear", 4300),
                step("passed connection-clear", 4400)]}


def native_events():
    return [{"phase": "held-info", "pid": 41, "timeMs": 1300},
            {"phase": "engine-change-reply", "pid": 41, "timeMs": 4300}]


class FixtureIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve() / "owned"
        fixture.make_fixture(self.root)
        fixture.write_json(self.root / "launch.json", identity())
        self.environment = fixture.child_environment(self.root)
        self.host = ["--host", "unix://" + str(self.root / "engine.sock")]

    def cli(self, arguments):
        return subprocess.run([sys.executable, str(self.root / "docker"), *arguments], env=self.environment, capture_output=True, timeout=5)

    def test_dense_payload_is_exact_limit_and_launch_bound(self):
        payload = docker.dense_logs(identity())
        self.assertEqual(len(payload), 2 * 1024 * 1024)
        self.assertTrue(payload.endswith(docker.END))
        self.assertEqual(json.loads(payload.splitlines()[0].removeprefix(b"NATIVE_SMOKE_RUN ")), identity())
        result = self.cli(self.host + ["container", "logs", "--tail", "300", "--timestamps", format(1, "064x")])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, payload)
        row = next(row for row in fixture.read_trace(self.root) if row["phase"] == "logs-payload")
        self.assertEqual(row["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(row["aCount"], payload.lower().count(b"a"))

    def test_only_child_environment_and_owned_config_change(self):
        before = dict(os.environ)
        with patch.dict(os.environ, {"DOCKER_HOST": "unix:///real.sock", "DOCKER_CONTEXT": "real", "DOCKER_TLS_VERIFY": "1", "COLIMA_HOME": "/real-colima", "LIMA_HOME": "/real-lima"}):
            actual = fixture.child_environment(self.root)
            self.assertEqual(os.environ["DOCKER_HOST"], "unix:///real.sock")
            self.assertEqual(actual["HOME"], str(self.root / "home"))
            self.assertEqual(actual["DOCKER_CONFIG"], str(self.root / "docker-config"))
            self.assertEqual({key for key in actual if key.startswith("DOCKER_")}, {"DOCKER_CONFIG"})
            self.assertNotIn("COLIMA_HOME", actual)
            self.assertNotIn("LIMA_HOME", actual)
        self.assertEqual(dict(os.environ), before)
        config = json.loads((self.root / "home/Library/Application Support/io.github.jgoneit.docker2u/runtime.json").read_text())
        self.assertEqual(config, {"dockerPath": str(self.root / "docker")})
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_read_only_protocol_and_explicit_endpoint(self):
        cases = [(["--version"], b"Docker version"), (["context", "inspect"], b"native-smoke-local"),
                 (self.host + ["info", "--format", "{{json .}}"], b"native-smoke-engine"),
                 (self.host + ["version", "--format", "{{json .}}"], b'"Server"'),
                 (self.host + ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"], format(1, "064x").encode()),
                 (self.host + ["container", "inspect", "--format", docker.INSPECT_FORMAT, format(1, "064x"), format(2, "064x")], b"native-smoke-2")]
        for arguments, expected in cases:
            with self.subTest(arguments=arguments):
                result = self.cli(arguments)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(expected, result.stdout)

    def test_mutations_foreign_hosts_and_unknown_containers_are_rejected(self):
        cases = [self.host + ["container", action, format(1, "064x")] for action in ["start", "stop", "restart", "rm"]]
        cases += [["--host", "unix:///real.sock", "info", "--format", "{{json .}}"],
                  ["info", "--format", "{{json .}}"],
                  self.host + ["container", "logs", "--tail", "300", "--timestamps", "$(touch forbidden)"],
                  self.host + ["container", "inspect", "--format", "foreign-format", format(1, "064x")],
                  self.host + ["container", "inspect", "--format", docker.INSPECT_FORMAT, format(3, "064x")]]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                result = self.cli(arguments)
                self.assertEqual(result.returncode, 95)
                self.assertEqual(result.stdout, b"")

    def test_armed_info_failure_is_claimed_once_and_restores_identity(self):
        (self.root / "arm-engine-change").write_text("armed")
        with patch.object(docker.time, "sleep") as sleep:
            output = io.StringIO()
            with redirect_stdout(output):
                docker.run(self.root, self.host + ["info", "--format", "{{json .}}"])
            sleep.assert_called_once_with(3)
            self.assertEqual(json.loads(output.getvalue())["ID"], "changed-engine")
        output = io.StringIO()
        with redirect_stdout(output):
            docker.run(self.root, self.host + ["info", "--format", "{{json .}}"])
        self.assertEqual(json.loads(output.getvalue())["ID"], "native-smoke-engine")
        self.assertEqual([row["phase"] for row in fixture.read_trace(self.root)], ["held-info", "engine-change-reply"])

    def test_existing_directory_cannot_be_claimed_or_deleted(self):
        preserved = self.root / "user-data"
        preserved.write_text("preserve")
        with self.assertRaises(FileExistsError):
            fixture.serve(self.root, self.root / "absent.app", self.root / "evidence")
        self.assertEqual(preserved.read_text(), "preserve")

    def test_early_setup_error_removes_only_new_owned_directory(self):
        new_root = self.root.parent / "new-owned"
        # A missing binary fails after socket creation, before app launch.
        with self.assertRaises(FileNotFoundError):
            fixture.serve(new_root, self.root / "absent.app", self.root / "evidence")
        self.assertFalse(new_root.exists())
        self.assertTrue(self.root.exists())


class EvidenceValidationTests(unittest.TestCase):
    def test_accepts_same_pid_order_with_launch_and_binary_binding(self):
        result = fixture.validate_ui(identity(), clear_report(), native_events(), now_ms=5000)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["clearOrderProofs"][0]["nativePid"], 41)

    def test_rejects_another_launch_binary_or_clock_window(self):
        for key, value in [("runId", "another-run"), ("binarySha256", "b" * 64), ("startedAtMs", 999)]:
            report = clear_report()
            report["binding"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "exact native launch"):
                fixture.validate_ui(identity(), report, native_events(), now_ms=5000)
        report = clear_report()
        report["steps"][0]["timeMs"] = 999
        with self.assertRaisesRegex(ValueError, "outside this native launch"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_rejects_clear_before_request_or_native_hold_and_unrelated_reply(self):
        for transform in [lambda rows: rows[0].update(timeMs=1600), lambda rows: rows[1].update(pid=99), lambda rows: rows[1].update(timeMs=1400)]:
            events = native_events()
            transform(events)
            with self.assertRaisesRegex(ValueError, "Native order proof failed"):
                fixture.validate_ui(identity(), clear_report(), events, now_ms=5000)
        report = clear_report()
        report["steps"][1]["timeMs"] = 1550
        with self.assertRaisesRegex(ValueError, "out of order"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_failed_incomplete_or_non_native_ui_cannot_pass(self):
        for key, value in [("status", "running"), ("failures", ["earlier attempt failed"]), ("nativeIpc", False)]:
            report = clear_report()
            report[key] = value
            with self.assertRaisesRegex(ValueError, "incomplete or failed"):
                fixture.validate_ui(identity(), report, native_events(), now_ms=5000)
        report = clear_report()
        report["steps"].pop()
        with self.assertRaisesRegex(ValueError, "no complete probe"):
            fixture.validate_ui(identity(), report, native_events(), now_ms=5000)

    def test_status_and_stop_archival_preserve_verified_ui_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "fixture"
            root.mkdir()
            evidence = Path(directory) / "evidence"
            submissions = evidence / "ui-results"
            submissions.mkdir(parents=True)
            manifest = {**identity(), "fixtureRoot": str(root), "evidenceDirectory": str(evidence), "status": "running"}
            accepted = {"ui": clear_report(), "verification": fixture.validate_ui(identity(), clear_report(), native_events(), now_ms=5000)}
            fixture.write_json(submissions / "worker.json", accepted)
            (root / "trace.jsonl").write_text("\n".join(json.dumps(row) for row in native_events()) + "\n")
            self.assertEqual(fixture.archive_trace(manifest)["uiReports"], [accepted])
            manifest.update(status="stopped", finishedAtMs=5000)
            self.assertEqual(fixture.archive_trace(manifest)["uiReports"], [accepted])
            self.assertFalse(fixture.archive_trace(manifest)["requiredCoverageComplete"])

    def test_search_requires_real_payload_worker_and_visible_coordinates(self):
        coordinates = {"viewport": {"top": 100, "bottom": 300}, "match": {"top": 200, "bottom": 219}}
        report = {**clear_report(), "steps": [step("started search", 1100), step("2 MiB dense count", 1200, {"total": 2097000}),
                    step("last dense match visible", 1500, coordinates), step("latest marker visible", 1600, coordinates),
                    step("search backend verified", 1700), step("passed search", 1800)],
                  "workerEvents": [step("ready", 1100), step("result", 1200, {"total": 2097000}), step("located", 1400)]}
        events = [{"phase": "logs-payload", "pid": 41, "timeMs": 1050, "byteCount": 2097152, "aCount": 2097000}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for field in ["worker", "viewport", "payload"]:
            changed, trace = copy.deepcopy(report), copy.deepcopy(events)
            if field == "worker":
                changed["workerEvents"] = []
            elif field == "viewport":
                changed["steps"][2]["detail"]["match"]["bottom"] = 800
            else:
                trace[0]["byteCount"] = 1024
            with self.subTest(field=field), self.assertRaises(ValueError):
                fixture.validate_ui(identity(), changed, trace, now_ms=5000)

    def test_socket_probe_requires_removal_before_request_without_early_restore(self):
        report = {**clear_report(), "steps": [step("started socket", 1200), step("requested missing-socket logs", 1300), step("native SocketMissing verified", 1500), step("passed socket", 1600)]}
        events = [{"phase": "socket-off", "pid": 40, "timeMs": 1100}]
        self.assertTrue(fixture.validate_ui(identity(), report, events, now_ms=5000)["accepted"])
        for rows in [[], events + [{"phase": "socket-on", "pid": 40, "timeMs": 1400}]]:
            with self.assertRaisesRegex(ValueError, "socket was not removed"):
                fixture.validate_ui(identity(), report, rows, now_ms=5000)


if __name__ == "__main__":
    unittest.main()
