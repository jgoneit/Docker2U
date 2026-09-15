"""Native terminal fixture tests over real owned Unix sockets; no Docker access."""
import copy
import json
from pathlib import Path
import socket
import tempfile
import time
import unittest

from compose_fixture import save_rows
from engine_http import EngineServer
from terminal_fixture import PROMPT
from test_engine_http import UnixHTTPConnection
import test_fixture as shared


class NativeTerminalFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="d2u-term-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "launch.json").write_text(json.dumps({"runId": "terminal-protocol", "binarySha256": "a" * 64, "startedAtMs": 1000}))
        self.server = EngineServer(self.root)
        self.addCleanup(self.server.close)
        self.full_id = format(1, "064x")

    def client(self):
        client = UnixHTTPConnection(self.root / "engine.sock")
        self.addCleanup(client.close)
        return client

    def request(self, method, path, body=None, client=None, headers=None):
        client = client or self.client()
        client.request(method, path, json.dumps(body) if body is not None else None, headers or {})
        response = client.getresponse()
        data = response.read()
        return response.status, json.loads(data) if data and response.headers.get("Content-Type", "").startswith("application/json") else data

    def create(self, full_id=None, client=None, **changes):
        body = {"AttachStdin": True, "AttachStdout": True, "AttachStderr": True, "Tty": True, "Cmd": ["/bin/sh"], "Env": ["TERM=xterm-256color"], "Privileged": False}
        body.update(changes)
        return self.request("POST", f"/v1.47/containers/{full_id or self.full_id}/exec", body, client)

    def start(self, exec_id, client=None, initial=b""):
        client = client or self.client()
        if client.sock is None:
            client.connect()
        body = b'{"Detach":false,"Tty":true}'
        client.sock.sendall(f"POST /v1.47/exec/{exec_id}/start HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive, Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body + initial)
        reader = client.sock.makefile("rb")
        self.addCleanup(reader.close)
        self.assertEqual(reader.readline().split()[1], b"101")
        headers = {}
        while True:
            line = reader.readline()
            if line == b"\r\n":
                break
            key, value = line.decode().split(":", 1)
            headers[key.lower()] = value.strip().lower()
        self.assertEqual(headers["upgrade"], "tcp")
        self.assertNotIn("transfer-encoding", headers)
        self.assertNotIn("content-length", headers)
        greeting = self.until_prompt(reader)
        self.assertIn(b"\x1b[36mNATIVE_TERMINAL_READY\x1b[0m", greeting)
        return client.sock, reader, greeting

    def until_prompt(self, reader):
        data = bytearray()
        while not data.endswith(PROMPT):
            chunk = reader.read(1)
            self.assertTrue(chunk, "Terminal stream ended before prompt")
            data.extend(chunk)
            self.assertLess(len(data), 128 * 1024, "Unbounded synthetic terminal output")
        return bytes(data)

    def command(self, terminal, value):
        sock, reader = terminal[:2]
        sock.sendall(value.encode() + b"\r")
        return self.until_prompt(reader).decode()

    def inspect(self, exec_id):
        status, value = self.request("GET", f"/v1.47/exec/{exec_id}/json")
        self.assertEqual(status, 200)
        return value

    def test_verified_keepalive_create_upgrade_unicode_resize_and_exit(self):
        client = self.client()
        self.assertEqual(self.request("GET", "/v1.54/version", client=client)[1]["ApiVersion"], "1.54")
        self.assertEqual(self.request("GET", "/v1.47/info", client=client)[1]["ID"], "native-smoke-engine")
        status, target = self.request("GET", f"/v1.47/containers/{self.full_id}/json", client=client)
        self.assertEqual((status, target["Id"], target["State"]["Running"]), (200, self.full_id, True))
        self.assertFalse(target["State"]["Paused"] or target["State"]["Restarting"])
        status, created = self.create(client=client)
        self.assertEqual(status, 201)
        exec_id = created["Id"]
        self.assertRegex(exec_id, r"^[0-9a-f]{64}$")
        self.assertFalse(self.inspect(exec_id)["Running"])
        terminal = self.start(exec_id, client, initial=b"pwd\r")
        self.assertIn(self.full_id.encode(), terminal[2])
        self.assertIn(b"/synthetic/container\r\n", self.until_prompt(terminal[1]))
        self.assertEqual(self.inspect(exec_id)["ContainerID"], self.full_id)
        self.assertTrue(self.inspect(exec_id)["Running"])
        # Split a UTF-8 code point across raw writes to exercise incremental input.
        payload = "echo 한글🙂".encode()
        terminal[0].sendall(payload[:6])
        time.sleep(0.01)
        terminal[0].sendall(payload[6:] + b"\r")
        self.assertIn("\r\n한글🙂\r\n", self.until_prompt(terminal[1]).decode())
        self.assertIn("\r\n24 80\r\n", self.command(terminal, "stty size"))
        self.assertEqual(self.request("POST", f"/v1.47/exec/{exec_id}/resize?h=37&w=113"), (200, b""))
        self.assertIn("\r\n37 113\r\n", self.command(terminal, "stty size"))
        terminal[0].sendall(b"exit 7\r")
        self.assertIn(b"exit\r\n", terminal[1].read())
        self.assertEqual((self.inspect(exec_id)["Running"], self.inspect(exec_id)["ExitCode"]), (False, 7))
        self.assertEqual(self.request("POST", f"/v1.47/exec/{exec_id}/resize?h=24&w=80")[0], 409)
        self.assertEqual(self.request("POST", f"/v1.47/exec/{exec_id}/start", {"Detach": False, "Tty": True}, headers={"Connection": "Upgrade", "Upgrade": "tcp"})[0], 409)

    def test_interrupt_backspace_crlf_and_shell_syntax_remain_inert(self):
        status, created = self.create(Cmd=["/bin/bash"])
        self.assertEqual(status, 201)
        terminal = self.start(created["Id"])
        terminal[0].sendall("echo 취소".encode() + b"\x03")
        self.assertIn(b"^C\r\n", self.until_prompt(terminal[1]))
        self.assertIn("\r\nnext\r\n", self.command(terminal, "echo next"))
        terminal[0].sendall("echo 한굴".encode() + b"\x7f" + "글\r\n".encode())
        self.assertIn("\r\n한글\r\n", self.until_prompt(terminal[1]).decode())
        self.assertIn("\r\n/synthetic/container\r\n", self.command(terminal, "pwd"))
        marker = self.root / "must-not-be-created"
        expression = f"$(touch {marker}); `touch {marker}`"
        self.assertIn(expression, self.command(terminal, "echo " + expression))
        self.assertIn("supports only", self.command(terminal, f"touch {marker}"))
        self.assertFalse(marker.exists())
        self.assertTrue(self.inspect(created["Id"])["Running"])
        terminal[0].sendall(b"\x04")
        self.assertIn(b"exit\r\n", terminal[1].read())
        self.assertFalse(self.inspect(created["Id"])["Running"])
        trace = [json.loads(line) for line in (self.root / "trace.jsonl").read_text().splitlines()]
        self.assertTrue(any(row["phase"] == "api-terminal-interrupted" for row in trace))
        self.assertTrue(any(row.get("commandKind") == "unsupported" for row in trace))
        self.assertNotIn("must-not-be-created", json.dumps(trace), "Trace must not record terminal command contents")

    def test_container_recreation_never_rebinds_an_exec_to_the_new_full_id(self):
        first, second = (format(value, "064x") for value in (101, 102))
        row = {"Id": first, "State": "running", "ComposeProject": "native-compose", "ComposeService": "api"}
        save_rows(self.root, [row])
        self.assertEqual(self.create(first)[0], 201)
        old_exec = self.create(first)[1]["Id"]
        save_rows(self.root, [{**row, "Id": second}])
        self.assertEqual(self.request("POST", f"/v1.47/exec/{old_exec}/start", {"Detach": False, "Tty": True}, headers={"Connection": "Upgrade", "Upgrade": "tcp"})[0], 409)
        self.assertEqual(self.create(first)[0], 404)
        current_exec = self.create(second)[1]["Id"]
        terminal = self.start(current_exec)
        self.assertIn(second.encode(), terminal[2])
        save_rows(self.root, [{**row, "Id": second, "State": "exited"}])
        self.assertEqual(terminal[1].read(), b"")
        self.assertEqual((self.inspect(current_exec)["ContainerID"], self.inspect(current_exec)["ExitCode"]), (second, 137))
        self.assertFalse(self.inspect(current_exec)["Running"])
        self.assertEqual(self.create(second)[0], 409)

    def test_malformed_or_unrelated_requests_never_allocate_or_start_execs(self):
        for changes in ({"Cmd": ["/bin/sh", "-c", "touch sentinel"]}, {"Privileged": True}, {"Tty": False}, {"AttachStdin": False}, {"WorkingDir": "/"}, {"Env": ["PATH=/host"]}):
            with self.subTest(changes=changes):
                self.assertEqual(self.create(**changes)[0], 400)
        self.assertEqual(self.server.execs, {})
        self.assertEqual(self.create("f" * 64)[0], 404)
        self.assertEqual(self.request("POST", f"/v1.47/containers/{self.full_id}/stop")[0], 501)
        self.assertEqual(self.request("GET", "/v1.47/exec/" + "f" * 64 + "/json")[0], 404)
        exec_id = self.create()[1]["Id"]
        self.assertEqual(self.request("POST", f"/v1.47/exec/{exec_id}/start", {"Detach": False, "Tty": True})[0], 400)
        self.assertFalse(self.inspect(exec_id)["Running"])
        terminal = self.start(exec_id)
        for size in ("h=0&w=80", "h=24&w=1001", "h=24&w=nan", "h=24&h=25&w=80", "h=24"):
            self.assertEqual(self.request("POST", f"/v1.47/exec/{exec_id}/resize?{size}")[0], 400)
        self.assertIn("\r\n24 80\r\n", self.command(terminal, "stty size"))

    def test_server_shutdown_closes_a_quiet_upgraded_connection(self):
        exec_id = self.create()[1]["Id"]
        terminal = self.start(exec_id)
        self.server.close()
        self.assertEqual(terminal[1].read(), b"")
        deadline = time.monotonic() + 1
        while self.server.execs[exec_id]["running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(self.server.execs[exec_id]["running"])


class NativeTerminalEvidenceTests(unittest.TestCase):
    def evidence(self):
        ids = [format(number, "064x") for number in (1, 2)]
        manifest = {**shared.identity(), "fixtureRoot": "/owned", "controllerPid": 41}
        baseline = {"binding": shared.identity(), "engineId": "native-smoke-engine", "contextName": "native-smoke-local",
                    "endpoint": "unix:///owned/engine.sock", "sessionId": "native-session", "fullIds": ids,
                    "sources": 2, "pipes": ["tty", "stdout"], "eventStatus": "following", "resourcePoints": 2,
                    "at": 1500, "sequence": 2, "generation": 1}
        identity = {"sessionId": "native-session", "terminalId": "native-terminal", "fullId": ids[0]}
        report = shared.clear_report()
        report["steps"] = [
            shared.step("started terminal-roundtrip", 1100),
            shared.step("captured native project observation baseline", 1500, baseline),
            shared.step("native terminal connected", 1800, {**identity, "startRequests": 1, "outputEvents": 2, "outputBytes": 100, "ackedSequence": 2, "running": True, "screenVisible": True, "ansiObserved": True}),
            shared.step("native terminal commands rendered", 2500, {**identity, "unicodeVisible": True, "interruptVisible": True, "sizeVisible": True, "resizeCols": 113, "resizeRows": 37, "outputEvents": 8, "outputBytes": 300, "ackedSequence": 6}),
            shared.step("native terminal retained across navigation", 3000, {**identity, "startRequests": 1, "sameEmulator": True, "switchedContainerId": ids[1], "hiddenOutputEvents": 2, "retainedOutputVisible": True}),
            shared.step("native terminal exited", 3500, {**identity, "status": "exited", "exitCode": 7, "startRequests": 1, "outputEvents": 12, "outputBytes": 500, "ackedSequence": 11}),
            shared.step("passed terminal-roundtrip", 3600),
        ]
        trace = [{"phase": "api-log-binding", "fullId": full_id, "binding": shared.identity(), "timeMs": 1200} for full_id in ids]
        for phase, timestamp, metadata in [
            ("created", 1600, {"shell": "/bin/sh"}), ("started", 1700, {}),
            ("command", 1900, {"commandKind": "echo"}), ("interrupted", 2000, {}),
            ("resized", 2100, {"rows": 37, "cols": 113}), ("command", 2200, {"commandKind": "stty-size"}),
            ("command", 2800, {"commandKind": "echo"}), ("command", 3200, {"commandKind": "exit"}),
            ("ended", 3400, {"exitCode": 7}),
        ]:
            trace.append({"phase": "api-terminal-" + phase, "pid": 41, "timeMs": timestamp, "fullId": ids[0], "execId": "a" * 64, **metadata})
        return manifest, report, trace

    def test_accepts_rendered_roundtrip_bound_to_one_real_native_exec(self):
        manifest, report, trace = self.evidence()
        result = shared.fixture.validate_ui(manifest, report, trace, now_ms=4000)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["completedProbes"], ["terminal-roundtrip"])
        self.assertFalse(result["metadataOnly"])

    def test_requires_launch_binding_and_exact_retained_native_identity(self):
        for fault in ["binding", "socket", "no-binding-stream", "no-baseline", "session", "terminal", "full-id", "navigation-id", "duplicate-step", "step-order"]:
            manifest, report, trace = copy.deepcopy(self.evidence())
            steps = report["steps"]
            if fault == "binding": steps[1]["detail"]["binding"]["runId"] = "foreign"
            elif fault == "socket": steps[1]["detail"]["endpoint"] = "unix:///foreign.sock"
            elif fault == "no-binding-stream": trace.pop(1)
            elif fault == "no-baseline": steps.pop(1)
            elif fault == "session": steps[2]["detail"]["sessionId"] = "another-session"
            elif fault == "terminal": steps[4]["detail"]["terminalId"] = "replacement"
            elif fault == "full-id": steps[3]["detail"]["fullId"] = format(2, "064x")
            elif fault == "navigation-id": steps[4]["detail"]["switchedContainerId"] = format(1, "064x")
            elif fault == "duplicate-step": steps.insert(3, copy.deepcopy(steps[2]))
            else: steps[2]["name"], steps[3]["name"] = steps[3]["name"], steps[2]["name"]
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=4000)

    def test_rejects_unrendered_unacknowledged_or_raw_payload_evidence(self):
        mutations = [(2, "screenVisible", False), (2, "ansiObserved", False), (3, "unicodeVisible", False),
                     (3, "interruptVisible", False), (3, "sizeVisible", False), (4, "sameEmulator", False),
                     (4, "retainedOutputVisible", False), (4, "hiddenOutputEvents", 0), (4, "startRequests", 2),
                     (3, "resizeRows", 24), (2, "outputEvents", True), (2, "outputBytes", float("nan")),
                     (2, "ackedSequence", 0), (3, "ackedSequence", 9), (3, "outputEvents", 2),
                     (5, "status", "disconnected"), (5, "exitCode", 0), (2, "rawInput", "unapproved")]
        for index, key, value in mutations:
            manifest, report, trace = copy.deepcopy(self.evidence())
            report["steps"][index]["detail"][key] = value
            with self.subTest(index=index, key=key), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=4000)

    def test_each_rendered_phase_requires_matching_native_fixture_trace(self):
        _, _, original = self.evidence()
        for index in range(2, len(original)):
            manifest, report, trace = copy.deepcopy(self.evidence())
            trace.pop(index)
            with self.subTest(removed=original[index]), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=4000)

    def test_rejects_foreign_duplicate_or_late_exec_trace(self):
        for fault in ["created-pid", "started-pid", "started-exec", "foreign-resize", "wrong-size", "late-hidden-echo", "early-exit", "wrong-exit", "duplicate-create", "duplicate-start"]:
            manifest, report, trace = copy.deepcopy(self.evidence())
            if fault == "created-pid": trace[2]["pid"] = 99
            elif fault == "started-pid": trace[3]["pid"] = 99
            elif fault == "started-exec": trace[3]["execId"] = "b" * 64
            elif fault == "foreign-resize": trace[6]["fullId"] = format(2, "064x")
            elif fault == "wrong-size": trace[6]["rows"] = 24
            elif fault == "late-hidden-echo": trace[8]["timeMs"] = 3500
            elif fault == "early-exit": trace[-1]["timeMs"] = 2800
            elif fault == "wrong-exit": trace[-1]["exitCode"] = 0
            else: trace.append(copy.deepcopy(trace[2 if fault == "duplicate-create" else 3]))
            with self.subTest(fault=fault), self.assertRaises(ValueError):
                shared.fixture.validate_ui(manifest, report, trace, now_ms=4000)


if __name__ == "__main__":
    unittest.main()
