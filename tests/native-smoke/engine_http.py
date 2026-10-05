"""Synthetic HTTP Engine on an owned Unix socket; never calls Docker or a shell."""
from http.server import BaseHTTPRequestHandler
import importlib.util
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import threading
import time
from urllib.parse import urlsplit

_terminal_spec = importlib.util.spec_from_file_location("native_terminal", Path(__file__).with_name("terminal_fixture.py"))
terminal = importlib.util.module_from_spec(_terminal_spec)
_terminal_spec.loader.exec_module(terminal)
_standalone_spec = importlib.util.spec_from_file_location("native_standalone", Path(__file__).with_name("standalone_fixture.py"))
standalone = importlib.util.module_from_spec(_standalone_spec)
_standalone_spec.loader.exec_module(standalone)


def launch_binding(root):
    manifest = json.loads((root / "launch.json").read_text())
    return {key: manifest[key] for key in ("runId", "binarySha256", "startedAtMs")}


def compose_containers(root):
    path = root / "compose-state.json"
    rows = json.loads(path.read_text()).get("containers", []) if path.exists() else []
    return {row["Id"]: row for row in rows + standalone.rows(root)}


def record(root, **event):
    event.update(pid=os.getpid(), timeMs=time.time_ns() // 1_000_000)
    descriptor = os.open(root / "trace.jsonl", os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, (json.dumps(event, separators=(",", ":")) + "\n").encode())
    finally:
        os.close(descriptor)


class EngineServer(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 80

    def __init__(self, root):
        self.root = root
        self.stopping = threading.Event()
        self.connections = set()
        self.connection_lock = threading.Lock()
        self.exec_lock = threading.Lock()
        self.execs = {}
        self.exec_counter = 0
        super().__init__(str(root / "engine.sock"), EngineHandler)
        self.worker = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.worker.start()

    def close(self):
        self.stopping.set()
        self.shutdown()
        with self.connection_lock:
            for connection in self.connections:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        self.server_close()
        self.worker.join(timeout=2)


class EngineHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        with self.server.connection_lock:
            self.server.connections.add(self.connection)

    def finish(self):
        with self.server.connection_lock:
            self.server.connections.discard(self.connection)
        super().finish()

    def log_message(self, *_args):
        pass

    def json_response(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def chunk(self, payload):
        self.wfile.write(f"{len(payload):x}\r\n".encode() + payload + b"\r\n")
        self.wfile.flush()

    def do_GET(self):
        try:
            self.read_only_get()
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def do_POST(self):
        try:
            if not terminal.dispatch(self, "POST", compose_containers, record):
                self.send_error(501)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True

    def read_only_get(self):
        path = urlsplit(self.path).path
        if terminal.dispatch(self, "GET", compose_containers, record):
            return
        if path in ("/v1.54/version", "/version"):
            self.json_response({"Version": "29.8.0", "ApiVersion": "1.54", "MinAPIVersion": "1.40", "Os": "linux", "Arch": "arm64"})
            return
        if path == "/v1.47/info":
            self.json_response({"ID": "native-smoke-engine", "OSType": "linux", "Architecture": "aarch64", "Name": "NATIVE_SMOKE_HARNESS"})
            return
        prefix = "/v1.47/containers/"
        identifier = path[len(prefix):-len("/logs")] if path.startswith(prefix) and path.endswith("/logs") else None
        events = path == "/v1.47/events"
        baseline_ids = [format(value, "064x") for value in ((1, 2) if standalone.enabled(self.server.root) else (1, 2, 3))]
        if not events and identifier not in [*baseline_ids, *compose_containers(self.server.root)]:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if events else "application/vnd.docker.raw-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        sequence = 0
        scenario_event = 0
        while not self.server.stopping.is_set():
            if events and standalone.enabled(self.server.root):
                for event in standalone.state(self.server.root)["events"][scenario_event:]:
                    self.chunk((json.dumps(event) + "\n").encode())
                    scenario_event += 1
                    record(self.server.root, phase="api-standalone-event", fullId=event["Actor"]["ID"], action=event["Action"], producedAtMs=event["timeNano"] // 1_000_000)
            if not events and identifier not in baseline_ids:
                row = compose_containers(self.server.root).get(identifier)
                if row is None or (sequence > 0 and row["State"] != "running"):
                    phase = "api-standalone-log-ended" if standalone.enabled(self.server.root) and identifier in [format(value, "064x") for value in (3, 4, 5)] else "api-compose-log-ended"
                    record(self.server.root, phase=phase, fullId=identifier)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    self.close_connection = True
                    return
            if sequence == 0 or (self.server.root / "follow-live").exists():
                sequence += 1
                now = time.time_ns()
                timestamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now // 1_000_000_000)) + f".{now % 1_000_000_000:09d}Z"
                if events:
                    if sequence > 1:
                        action = "health_status: healthy" if sequence % 2 else "health_status: unhealthy"
                        payload = (json.dumps({"Type": "container", "Action": action, "Actor": {"ID": format(1, "064x"), "Attributes": {"name": "native-smoke-1", "com.docker.compose.project": "native-smoke-project", "com.docker.compose.service": "api"}}, "timeNano": now}) + "\n").encode()
                        self.chunk(payload)
                        record(self.server.root, phase="api-health-event", fullId=format(1, "064x"), sequence=sequence, action=action, producedAtMs=now // 1_000_000)
                        for item in standalone.rows(self.server.root):
                            payload = {"Type": "container", "Action": action, "Actor": {"ID": item["Id"], "Attributes": {"name": item["Name"].lstrip("/")}}, "timeNano": now}
                            self.chunk((json.dumps(payload) + "\n").encode())
                            record(self.server.root, phase="api-standalone-event", fullId=item["Id"], sequence=sequence, action=action, producedAtMs=now // 1_000_000)
                else:
                    if sequence == 1:
                        binding = launch_binding(self.server.root)
                        header = f"{timestamp} NATIVE_PROJECT_RUN {json.dumps(binding, separators=(',', ':'))}\n".encode()
                        if identifier not in (format(2, "064x"), format(4, "064x")):
                            header = struct.pack(">BxxxI", 1, len(header)) + header
                        self.chunk(header)
                        record(self.server.root, phase="api-log-binding", fullId=identifier, binding=binding)
                    payload = f"{timestamp} NATIVE_PROJECT_LOG {sequence} 한글 fullId={identifier}\n".encode()
                    # Redis exercises TTY raw output; API uses multiplex frames.
                    if identifier not in (format(2, "064x"), format(4, "064x")):
                        payload = struct.pack(">BxxxI", 1 if sequence % 2 else 2, len(payload)) + payload
                    self.chunk(payload)
                    record(self.server.root, phase="api-log-output", fullId=identifier, sequence=sequence, producedAtMs=now // 1_000_000)
            self.server.stopping.wait(0.25)
        self.close_connection = True
