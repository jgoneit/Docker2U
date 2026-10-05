"""Bounded synthetic Docker exec/TTY protocol; never evaluates or launches input."""
import codecs
import json
import re
import shlex
import socket
import threading
from urllib.parse import parse_qs, urlsplit

BASELINE_IDS = {format(value, "064x") for value in (1, 2, 3)}
PROMPT = b"\x1b[32mnative-smoke:$ \x1b[0m"
MAX_EXECS = 128
MAX_INPUT = 16 * 1024


def container_state(handler, identifier, containers):
    if identifier in BASELINE_IDS:
        return "running"
    row = containers(handler.server.root).get(identifier)
    return row.get("State") if row else None


def reject(handler, status, message):
    handler.json_response({"message": message}, status)


def read_json(handler):
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 0 < length <= MAX_INPUT or handler.headers.get("Transfer-Encoding"):
            raise ValueError("unbounded request")
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise ValueError("incomplete request")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value
    except (ValueError, UnicodeDecodeError):
        handler.close_connection = True
        reject(handler, 400, "Invalid synthetic exec request")
        return None


def inspect_exec(handler, exec_id):
    with handler.server.exec_lock:
        item = handler.server.execs.get(exec_id)
        if item is None:
            reject(handler, 404, "Unknown exec identity")
            return
        result = {"ID": exec_id, "ContainerID": item["fullId"], "Running": item["running"], "ExitCode": item["exitCode"], "Pid": 0}
    handler.json_response(result)


def dispatch(handler, method, containers, record):
    path = urlsplit(handler.path).path
    container = re.fullmatch(r"/v1\.47/containers/([a-f0-9]{64})/(exec|json)", path)
    execution = re.fullmatch(r"/v1\.47/exec/([a-f0-9]{64})/(start|resize|json)", path)
    if container and method == "GET" and container[2] == "json":
        state = container_state(handler, container[1], containers)
        if state is None:
            reject(handler, 404, "Unknown container identity")
        else:
            handler.json_response({"Id": container[1], "State": {"Status": state, "Running": state in ("running", "paused", "restarting"), "Paused": state == "paused", "Restarting": state == "restarting"}})
        return True
    if execution and method == "GET" and execution[2] == "json":
        inspect_exec(handler, execution[1])
        return True
    if method != "POST" or not (container and container[2] == "exec" or execution and execution[2] in ("start", "resize")):
        return False
    if container:
        create_exec(handler, container[1], containers, record)
    elif execution[2] == "resize":
        resize_exec(handler, execution[1], record)
    else:
        start_exec(handler, execution[1], containers, record)
    return True


def create_exec(handler, full_id, containers, record):
    body = read_json(handler)
    if body is None:
        return
    expected = {"AttachStdin", "AttachStdout", "AttachStderr", "Tty", "Cmd", "Env", "Privileged"}
    if set(body) - expected or any(body.get(key) is not True for key in ("AttachStdin", "AttachStdout", "AttachStderr", "Tty")) or body.get("Cmd") not in (["/bin/sh"], ["/bin/bash"]) or body.get("Env") != ["TERM=xterm-256color"] or body.get("Privileged", False) is not False:
        reject(handler, 400, "Only the fixed interactive fixture shells are supported")
        return
    state = container_state(handler, full_id, containers)
    if state != "running":
        reject(handler, 404 if state is None else 409, "Container identity is not running")
        return
    with handler.server.exec_lock:
        if len(handler.server.execs) >= MAX_EXECS:
            reject(handler, 409, "Synthetic exec registry is full")
            return
        handler.server.exec_counter += 1
        exec_id = format(1000 + handler.server.exec_counter, "064x")
        handler.server.execs[exec_id] = {"fullId": full_id, "shell": body["Cmd"][0], "started": False, "running": False, "exitCode": 0, "rows": 24, "cols": 80}
    record(handler.server.root, phase="api-terminal-created", execId=exec_id, fullId=full_id, shell=body["Cmd"][0])
    handler.json_response({"Id": exec_id}, 201)


def resize_exec(handler, exec_id, record):
    query = parse_qs(urlsplit(handler.path).query, keep_blank_values=True)
    try:
        if set(query) != {"h", "w"} or any(len(values) != 1 for values in query.values()):
            raise ValueError("invalid size")
        rows, cols = int(query["h"][0]), int(query["w"][0])
        if not 1 <= rows <= 1000 or not 1 <= cols <= 1000:
            raise ValueError("invalid size")
    except ValueError:
        reject(handler, 400, "Invalid terminal dimensions")
        return
    with handler.server.exec_lock:
        item = handler.server.execs.get(exec_id)
        if item is None or not item["running"]:
            reject(handler, 404 if item is None else 409, "Exec is not running")
            return
        item.update(rows=rows, cols=cols)
        full_id = item["fullId"]
    record(handler.server.root, phase="api-terminal-resized", execId=exec_id, fullId=full_id, rows=rows, cols=cols)
    handler.send_response(200)
    handler.send_header("Content-Length", "0")
    handler.end_headers()


def start_exec(handler, exec_id, containers, record):
    body = read_json(handler)
    if body is None:
        return
    upgrade_tokens = {token.strip().lower() for token in handler.headers.get("Connection", "").split(",")}
    if set(body) != {"Detach", "Tty"} or body.get("Detach") is not False or body.get("Tty") is not True or "upgrade" not in upgrade_tokens or handler.headers.get("Upgrade", "").lower() != "tcp":
        reject(handler, 400, "A raw TCP upgrade with TTY attachment is required")
        return
    with handler.server.exec_lock:
        item = handler.server.execs.get(exec_id)
        if item is None:
            reject(handler, 404, "Unknown exec identity")
            return
        if item["started"] or container_state(handler, item["fullId"], containers) != "running":
            reject(handler, 409, "Exec already started or its container is no longer running")
            return
        item.update(started=True, running=True)
        full_id = item["fullId"]
    handler.send_response(101)
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Upgrade", "tcp")
    handler.send_header("Content-Type", "application/vnd.docker.raw-stream")
    handler.end_headers()
    handler.wfile.flush()
    handler.close_connection = True
    record(handler.server.root, phase="api-terminal-started", execId=exec_id, fullId=full_id)
    done = threading.Event()

    def watch_container():
        while not done.wait(0.05):
            if handler.server.stopping.is_set() or container_state(handler, full_id, containers) != "running":
                with handler.server.exec_lock:
                    item.update(running=False, exitCode=137)
                try:
                    handler.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                return

    watcher = threading.Thread(target=watch_container, daemon=True)
    watcher.start()
    try:
        handler.wfile.write(b"\x1b[36mNATIVE_TERMINAL_READY\x1b[0m fullId=" + full_id.encode() + b"\r\n" + PROMPT)
        handler.wfile.flush()
        read_terminal(handler, exec_id, item, record)
    finally:
        done.set()
        watcher.join(timeout=0.2)
        with handler.server.exec_lock:
            item["running"] = False
            exit_code = item["exitCode"]
        record(handler.server.root, phase="api-terminal-ended", execId=exec_id, fullId=full_id, exitCode=exit_code)


def read_terminal(handler, exec_id, item, record):
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    line = ""
    previous_cr = False
    while not handler.server.stopping.is_set():
        raw = handler.rfile.read1(4096)
        if not raw:
            return
        for char in decoder.decode(raw):
            if char == "\n" and previous_cr:
                previous_cr = False
                continue
            previous_cr = char == "\r"
            if char == "\x03":
                line = ""
                handler.wfile.write(b"^C\r\n" + PROMPT)
                record(handler.server.root, phase="api-terminal-interrupted", execId=exec_id, fullId=item["fullId"])
            elif char == "\x04" and not line:
                handler.wfile.write(b"exit\r\n")
                return
            elif char in ("\x7f", "\b"):
                if line:
                    line = line[:-1]
                    handler.wfile.write(b"\b \b")
            elif char in ("\r", "\n"):
                handler.wfile.write(b"\r\n")
                output, exit_code, kind = execute_fixed(line, item, handler.server.exec_lock)
                line = ""
                handler.wfile.write(output.encode())
                record(handler.server.root, phase="api-terminal-command", execId=exec_id, fullId=item["fullId"], commandKind=kind)
                if exit_code is not None:
                    with handler.server.exec_lock:
                        item["exitCode"] = exit_code
                    return
                handler.wfile.write(PROMPT)
            elif char >= " " and char != "\x7f":
                line += char
                handler.wfile.write(char.encode())
                if len(line) >= MAX_INPUT:
                    line = ""
                    handler.wfile.write(b"\r\nSynthetic input limit reached\r\n" + PROMPT)
            handler.wfile.flush()


def execute_fixed(line, item, lock):
    """Tokenization is inert: shell operators and substitutions stay plain text."""
    try:
        words = shlex.split(line)
    except ValueError:
        return "Synthetic command has unmatched quotes\r\n", None, "invalid"
    if not words:
        return "", None, "empty"
    if words[0] == "echo":
        return " ".join(words[1:]) + "\r\n", None, "echo"
    if words == ["pwd"]:
        return "/synthetic/container\r\n", None, "pwd"
    if words == ["stty", "size"]:
        with lock:
            return f"{item['rows']} {item['cols']}\r\n", None, "stty-size"
    if words[0] == "exit" and len(words) <= 2:
        try:
            exit_code = int(words[1]) % 256 if len(words) == 2 else 0
        except ValueError:
            return "Synthetic exit requires an integer\r\n", None, "invalid"
        return "exit\r\n", exit_code, "exit"
    return "Synthetic fixture supports only echo, pwd, stty size, exit and Ctrl-C\r\n", None, "unsupported"
