"""Protocol checks for the native fixture; no application or real Engine access."""
import http.client
import json
from pathlib import Path
import socket
import struct
import tempfile
import unittest

from engine_http import EngineServer


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=2)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class NativeEngineHTTPTests(unittest.TestCase):
    def setUp(self):
        # Keep Darwin's short sockaddr_un limit independent of the workspace path.
        self.temporary = tempfile.TemporaryDirectory(prefix="d2u-http-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binding = {"runId": "protocol-test", "binarySha256": "a" * 64, "startedAtMs": 1000}
        (self.root / "launch.json").write_text(json.dumps(self.binding))
        self.server = EngineServer(self.root)
        self.addCleanup(self.server.close)

    def connection(self):
        client = UnixHTTPConnection(self.root / "engine.sock")
        self.addCleanup(client.close)
        return client

    def test_identity_requests_reuse_the_stream_connection(self):
        client = self.connection()
        for path, key, value in [("/v1.54/version", "ApiVersion", "1.54"),
                                 ("/v1.47/info", "ID", "native-smoke-engine")]:
            client.request("GET", path)
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())[key], value)
        client.request("GET", "/v1.47/containers/" + format(1, "064x") + "/logs?follow=1")
        response = client.getresponse()
        self.assertEqual(response.status, 200)
        header = response.read(8)
        pipe, length = struct.unpack(">BxxxI", header)
        self.assertEqual(pipe, 1)
        binding = response.read(length).decode().split("NATIVE_PROJECT_RUN ", 1)[1]
        self.assertEqual(json.loads(binding), self.binding)
        pipe, length = struct.unpack(">BxxxI", response.read(8))
        self.assertEqual(pipe, 1)
        self.assertIn("한글", response.read(length).decode())

    def test_tty_log_is_not_multiplexed_and_health_ticks_are_json(self):
        (self.root / "follow-live").write_text("enabled\n")
        client = self.connection()
        client.request("GET", "/v1.47/containers/" + format(2, "064x") + "/logs?follow=1")
        response = client.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.readline().decode().split("NATIVE_PROJECT_RUN ", 1)[1]), self.binding)
        self.assertRegex(response.readline().decode(), r"^\d{4}-.*Z NATIVE_PROJECT_LOG 1 한글")
        event_client = self.connection()
        event_client.request("GET", "/v1.47/events")
        event_response = event_client.getresponse()
        event = json.loads(event_response.readline())
        self.assertEqual(event["Type"], "container")
        self.assertTrue(event["Action"].startswith("health_status:"))
        self.assertIsInstance(event["timeNano"], int)

    def test_mutating_http_method_is_rejected(self):
        client = self.connection()
        client.request("POST", "/v1.47/containers/" + format(1, "064x") + "/stop")
        response = client.getresponse()
        self.assertEqual(response.status, 501)
        response.read()


if __name__ == "__main__":
    unittest.main()
