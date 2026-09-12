"""Read-only HTTP Engine fixture on an owned Unix socket; never calls Docker."""
from http.server import BaseHTTPRequestHandler
import json
import os
import socket
import socketserver
import struct
import threading
import time
from urllib.parse import urlsplit


def launch_binding(root):
    manifest = json.loads((root / "launch.json").read_text())
    return {key: manifest[key] for key in ("runId", "binarySha256", "startedAtMs")}


def compose_containers(root):
    path = root / "compose-state.json"
    return {row["Id"]: row for row in json.loads(path.read_text()).get("containers", [])} if path.exists() else {}


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

    def json_response(self, data):
        payload = json.dumps(data).encode()
        self.send_response(200)
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

    def read_only_get(self):
        path = urlsplit(self.path).path
        if path in ("/v1.54/version", "/version"):
            self.json_response({"Version": "29.8.0", "ApiVersion": "1.54", "MinAPIVersion": "1.40", "Os": "linux", "Arch": "arm64"})
            return
        if path == "/v1.47/info":
            self.json_response({"ID": "native-smoke-engine", "OSType": "linux", "Architecture": "aarch64", "Name": "NATIVE_SMOKE_HARNESS"})
            return
        prefix = "/v1.47/containers/"
        identifier = path[len(prefix):-len("/logs")] if path.startswith(prefix) and path.endswith("/logs") else None
        events = path == "/v1.47/events"
        baseline_ids = [format(value, "064x") for value in (1, 2, 3)]
        if not events and identifier not in [*baseline_ids, *compose_containers(self.server.root)]:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json" if events else "application/vnd.docker.raw-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        sequence = 0
        while not self.server.stopping.is_set():
            if not events and identifier not in baseline_ids:
                row = compose_containers(self.server.root).get(identifier)
                if row is None or (sequence > 0 and row["State"] != "running"):
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    self.close_connection = True
                    record(self.server.root, phase="api-compose-log-ended", fullId=identifier)
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
                else:
                    if sequence == 1:
                        binding = launch_binding(self.server.root)
                        header = f"{timestamp} NATIVE_PROJECT_RUN {json.dumps(binding, separators=(',', ':'))}\n".encode()
                        if identifier != format(2, "064x"):
                            header = struct.pack(">BxxxI", 1, len(header)) + header
                        self.chunk(header)
                        record(self.server.root, phase="api-log-binding", fullId=identifier, binding=binding)
                    payload = f"{timestamp} NATIVE_PROJECT_LOG {sequence} 한글 fullId={identifier}\n".encode()
                    # Redis exercises TTY raw output; API uses multiplex frames.
                    if identifier != format(2, "064x"):
                        payload = struct.pack(">BxxxI", 1 if sequence % 2 else 2, len(payload)) + payload
                    self.chunk(payload)
                    record(self.server.root, phase="api-log-output", fullId=identifier, sequence=sequence, producedAtMs=now // 1_000_000)
            self.server.stopping.wait(0.25)
        self.close_connection = True
