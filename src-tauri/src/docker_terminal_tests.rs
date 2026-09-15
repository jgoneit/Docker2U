use super::*;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc as sync_channel,
    },
    thread,
    time::Instant,
};

#[test]
fn cumulative_acknowledgments_bound_bytes_and_ignore_duplicates() {
    let mut credits = Credits::default();
    for expected in 1..=16 {
        assert_eq!(credits.sent(CHUNK_BYTES), expected);
    }
    assert_eq!(credits.available(), 0);
    credits.acknowledge(8).unwrap();
    assert_eq!(credits.available(), WINDOW_BYTES / 2);
    credits.acknowledge(8).unwrap();
    credits.acknowledge(2).unwrap();
    assert_eq!(credits.available(), WINDOW_BYTES / 2);
    assert_eq!(
        credits.acknowledge(17).unwrap_err().code,
        "TerminalProtocol"
    );
    assert_eq!(credits.available(), WINDOW_BYTES / 2);
    credits.acknowledge(16).unwrap();
    assert_eq!(credits.available(), WINDOW_BYTES);
}

#[test]
fn invalid_terminal_sizes_cannot_allocate_large_buffers() {
    for (cols, rows) in [(0, 24), (80, 0), (501, 24), (80, 201)] {
        assert!(dimensions(cols, rows).is_err());
    }
    assert!(dimensions(80, 24).is_ok());
}

#[test]
fn shell_selection_is_an_enum_not_an_arbitrary_command() {
    assert_eq!(
        serde_json::from_str::<TerminalShell>("\"sh\"").unwrap(),
        TerminalShell::Sh
    );
    assert!(serde_json::from_str::<TerminalShell>("\"sh -c arbitrary\"").is_err());
    assert!(serde_json::from_str::<TerminalShell>("\"/usr/bin/env\"").is_err());
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    WrongEngine,
    Denied,
    LostStart,
    MissingShell,
    Flood,
    BlockStart,
    SlowResize,
    Duplex,
}
#[derive(Clone, Debug)]
struct RequestRecord {
    method: String,
    path: String,
    body: Value,
}
struct Server {
    mode: Mode,
    stop: AtomicBool,
    release: AtomicBool,
    next: AtomicUsize,
    requests: Mutex<Vec<RequestRecord>>,
    execs: Mutex<HashMap<String, (String, bool)>>,
}
struct Fixture {
    core: Core,
    server: Arc<Server>,
    root: PathBuf,
    socket: PathBuf,
    thread: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    fn new(mode: Mode) -> Self {
        let root = PathBuf::from("/tmp").join(format!("d2u-term-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let socket = root.join("e.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = Arc::new(Server {
            mode,
            stop: AtomicBool::new(false),
            release: AtomicBool::new(false),
            next: AtomicUsize::new(100),
            requests: Mutex::new(vec![]),
            execs: Mutex::new(HashMap::new()),
        });
        let serve = server.clone();
        let worker = thread::spawn(move || {
            let mut connections = vec![];
            while !serve.stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = serve.clone();
                        connections.push(thread::spawn(move || serve_connection(stream, state)));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        let core = Core::default();
        let target = Target {
            docker: PathBuf::from("/unused/docker"),
            client_version: "test".into(),
            endpoint: format!("unix://{}", socket.display()),
            env: vec![],
            docker_config: root.clone(),
            fingerprint: Fingerprint {
                id: "engine-id".into(),
                server: "27.0.0".into(),
                api: "1.47".into(),
                os: "linux".into(),
                arch: "aarch64".into(),
                name: "terminal-engine".into(),
            },
        };
        core.terminals
            .lock()
            .unwrap()
            .bind("session", ExecTarget::new(&target).unwrap());
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            target,
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
        });
        Self {
            core,
            server,
            root,
            socket,
            thread: Some(worker),
        }
    }
    fn add(&self, number: u32, project: Option<&str>, service: Option<&str>) -> Container {
        let id = format!("{number:064x}");
        let container = Container {
            handle: format!("handle-{number}"),
            full_id: id.clone(),
            short_id: id[..12].into(),
            name: format!("container-{number}"),
            image: "test".into(),
            state: "running".into(),
            health: None,
            health_configured: None,
            ports: vec![],
            created_at: "now".into(),
            started_at: None,
            tty: false,
            compose_project: project.map(str::to_owned),
            compose_service: service.map(str::to_owned),
        };
        self.core
            .state
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .handles
            .insert(container.handle.clone(), container.clone());
        container
    }
    fn start(
        &self,
        container: &Container,
    ) -> (TerminalDescriptor, sync_channel::Receiver<TerminalEvent>) {
        let (sink, events) = sync_channel::channel();
        let descriptor = self
            .core
            .start_container_terminal(
                "session",
                1,
                &container.handle,
                TerminalShell::Sh,
                80,
                24,
                Arc::new(move |event| {
                    let _ = sink.send(event);
                    Ok(())
                }),
            )
            .unwrap();
        (descriptor, events)
    }
    fn paths(&self) -> Vec<RequestRecord> {
        self.server.requests.lock().unwrap().clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.release.store(true, Ordering::Release);
        self.core.shutdown();
        self.server.stop.store(true, Ordering::Release);
        if let Some(worker) = self.thread.take() {
            worker.join().unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
fn response(stream: &mut UnixStream, status: &str, body: Value) -> std::io::Result<()> {
    let body = body.to_string();
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}
fn serve_connection(stream: UnixStream, server: Arc<Server>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        if server.stop.load(Ordering::Acquire) {
            return;
        }
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(_) => return,
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 3 {
            return;
        }
        let (method, path) = (parts[0].to_owned(), parts[1].to_owned());
        let mut length = 0;
        let mut upgrade = false;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).is_err() {
                return;
            }
            if header == "\r\n" {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                if name.eq_ignore_ascii_case("upgrade") {
                    upgrade = value.trim() == "tcp";
                }
            }
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let body = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
        server.requests.lock().unwrap().push(RequestRecord {
            method: method.clone(),
            path: path.clone(),
            body: body.clone(),
        });
        let result = if path.ends_with("/version") {
            response(
                reader.get_mut(),
                "200 OK",
                json!({"Version":"27.0.0","ApiVersion":"1.47","MinAPIVersion":"1.40","Os":"linux","Arch":"arm64"}),
            )
        } else if path.ends_with("/info") {
            response(
                reader.get_mut(),
                "200 OK",
                json!({"ID":if server.mode == Mode::WrongEngine {"different"} else {"engine-id"},"OSType":"linux","Architecture":"aarch64","Name":"terminal-engine"}),
            )
        } else if path.contains("/containers/") && path.ends_with("/json") {
            let container = path.split('/').nth(3).unwrap();
            response(
                reader.get_mut(),
                "200 OK",
                json!({"Id":container,"State":{"Running":true,"Paused":false,"Restarting":false}}),
            )
        } else if path.ends_with("/exec") {
            let container = path.split('/').nth(3).unwrap().to_owned();
            let id = format!("{:064x}", server.next.fetch_add(1, Ordering::AcqRel));
            server
                .execs
                .lock()
                .unwrap()
                .insert(id.clone(), (container, false));
            response(reader.get_mut(), "201 Created", json!({"Id":id}))
        } else if path.contains("/resize?") {
            while server.mode == Mode::SlowResize
                && path.ends_with("h=32&w=100")
                && !server.release.load(Ordering::Acquire)
                && !server.stop.load(Ordering::Acquire)
            {
                thread::sleep(Duration::from_millis(2));
            }
            response(reader.get_mut(), "200 OK", json!({}))
        } else if path.contains("/exec/") && path.ends_with("/json") {
            let id = path.split('/').nth(3).unwrap();
            let entries = server.execs.lock().unwrap();
            let (container, running) = entries.get(id).unwrap();
            response(
                reader.get_mut(),
                "200 OK",
                json!({"ID":id,"ContainerID":container,"Running":running,"ExitCode":7}),
            )
        } else if path.ends_with("/start") {
            assert!(upgrade);
            if server.mode == Mode::LostStart {
                return;
            }
            if server.mode == Mode::Denied {
                response(
                    reader.get_mut(),
                    "403 Forbidden",
                    json!({"message":"denied"}),
                )
            } else if server.mode == Mode::MissingShell {
                response(
                    reader.get_mut(),
                    "500 Internal Server Error",
                    json!({"message":"exec: /bin/sh: no such file or directory"}),
                )
            } else {
                while server.mode == Mode::BlockStart
                    && !server.release.load(Ordering::Acquire)
                    && !server.stop.load(Ordering::Acquire)
                {
                    thread::sleep(Duration::from_millis(2));
                }
                let id = path.split('/').nth(3).unwrap().to_owned();
                server.execs.lock().unwrap().get_mut(&id).unwrap().1 = true;
                if reader.get_mut().write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n").is_err() { return; }
                if matches!(server.mode, Mode::Flood | Mode::Duplex) {
                    reader.get_mut().set_write_timeout(None).unwrap();
                }
                let greeting = if matches!(server.mode, Mode::Flood | Mode::Duplex) {
                    vec![b'x'; WINDOW_BYTES * 3]
                } else {
                    b"\x1b[32mREADY\x1b[0m\r\n".to_vec()
                };
                if reader.get_mut().write_all(&greeting).is_err() {
                    return;
                }
                let mut bytes = [0; CHUNK_BYTES];
                while !server.stop.load(Ordering::Acquire) {
                    match reader.read(&mut bytes) {
                        Ok(0) => break,
                        Ok(count) => {
                            if bytes[..count] == *b"exit\n" {
                                break;
                            }
                            if reader.get_mut().write_all(&bytes[..count]).is_err() {
                                break;
                            }
                        }
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
                server.execs.lock().unwrap().get_mut(&id).unwrap().1 = false;
                return;
            }
        } else {
            response(
                reader.get_mut(),
                "404 Not Found",
                json!({"message":"unexpected test path"}),
            )
        };
        if result.is_err() {
            return;
        }
    }
}
fn until(
    events: &sync_channel::Receiver<TerminalEvent>,
    predicate: impl Fn(&TerminalEvent) -> bool,
) -> TerminalEvent {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("terminal event deadline");
        if predicate(&event) {
            return event;
        }
    }
}
fn running(events: &sync_channel::Receiver<TerminalEvent>) {
    until(
        events,
        |event| matches!(event, TerminalEvent::Status { terminal } if terminal.status == TerminalStatus::Running),
    );
}

#[test]
fn socket_exec_preserves_ansi_input_resize_exit_and_exact_target() {
    let fixture = Fixture::new(Mode::Normal);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    running(&events);
    let event = until(&events, |event| {
        matches!(event, TerminalEvent::Output { .. })
    });
    if let TerminalEvent::Output {
        bytes, sequence, ..
    } = event
    {
        assert_eq!(bytes, b"\x1b[32mREADY\x1b[0m\r\n");
        fixture
            .core
            .ack_container_terminal("session", &terminal.terminal_id, sequence)
            .unwrap();
    }
    tauri::async_runtime::block_on(async {
        fixture
            .core
            .write_container_terminal(
                "session",
                &terminal.terminal_id,
                "한글\u{3}".as_bytes().to_vec(),
            )
            .await
            .unwrap();
        fixture
            .core
            .resize_container_terminal("session", &terminal.terminal_id, 100, 32)
            .await
            .unwrap();
    });
    let echoed = until(&events, |event| {
        matches!(event, TerminalEvent::Output { .. })
    });
    if let TerminalEvent::Output { bytes, .. } = echoed {
        assert_eq!(bytes, "한글\u{3}".as_bytes());
    }
    tauri::async_runtime::block_on(fixture.core.write_container_terminal(
        "session",
        &terminal.terminal_id,
        b"exit\n".to_vec(),
    ))
    .unwrap();
    let exited = until(
        &events,
        |event| matches!(event, TerminalEvent::Status { terminal } if terminal.status == TerminalStatus::Exited),
    );
    if let TerminalEvent::Status { terminal } = exited {
        assert_eq!(terminal.exit_code, Some(7));
    }
    let requests = fixture.paths();
    let create = requests
        .iter()
        .find(|request| request.path.ends_with("/exec"))
        .unwrap();
    assert_eq!(create.method, "POST");
    assert!(create.path.contains(&container.full_id));
    assert_eq!(
        create.body,
        json!({"AttachStdin":true,"AttachStdout":true,"AttachStderr":true,"Tty":true,"Privileged":false,"Cmd":["/bin/sh"],"Env":["TERM=xterm-256color"]})
    );
    assert!(
        requests
            .iter()
            .any(|request| request.path.ends_with("/resize?h=32&w=100"))
    );
    assert!(
        tauri::async_runtime::block_on(fixture.core.write_container_terminal(
            "session",
            &terminal.terminal_id,
            vec![1]
        ))
        .is_err()
    );
}

#[test]
fn generation_refresh_keeps_terminal_but_replaced_id_does_not() {
    let fixture = Fixture::new(Mode::Normal);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    running(&events);
    let mut replacement = container.clone();
    replacement.handle = "new-handle".into();
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .generation = 2;
    let mut snapshot = ContainerList {
        session_id: "session".into(),
        generation: 2,
        containers: vec![replacement.clone()],
        refreshed_at: "now".into(),
        stale: false,
    };
    fixture.core.reconcile_terminals(&snapshot);
    tauri::async_runtime::block_on(fixture.core.write_container_terminal(
        "session",
        &terminal.terminal_id,
        b"still connected".to_vec(),
    ))
    .unwrap();
    replacement.full_id = format!("{:064x}", 2);
    snapshot.containers = vec![replacement];
    fixture.core.reconcile_terminals(&snapshot);
    assert_eq!(
        fixture
            .core
            .terminal("session", &terminal.terminal_id, false)
            .unwrap()
            .snapshot()
            .status,
        TerminalStatus::Disconnected
    );
}

#[test]
fn eight_retained_slots_refuse_ninth_and_explicit_close_frees_slot() {
    let fixture = Fixture::new(Mode::Normal);
    let mut terminals = vec![];
    for number in 1..=8 {
        let container = fixture.add(number, None, None);
        let (terminal, events) = fixture.start(&container);
        running(&events);
        fixture
            .core
            .disconnect_container_terminal("session", &terminal.terminal_id)
            .unwrap();
        terminals.push(terminal);
    }
    let ninth = fixture.add(9, None, None);
    let error = fixture
        .core
        .start_container_terminal(
            "session",
            1,
            &ninth.handle,
            TerminalShell::Sh,
            80,
            24,
            Arc::new(|_| Ok(())),
        )
        .unwrap_err();
    assert_eq!(error.code, "TerminalLimitReached");
    fixture
        .core
        .close_container_terminal("session", &terminals[0].terminal_id)
        .unwrap();
    let (_, events) = fixture.start(&ninth);
    running(&events);
}

#[test]
fn closed_display_channel_revokes_input_and_duplicate_start_is_refused() {
    let fixture = Fixture::new(Mode::Normal);
    let container = fixture.add(1, None, None);
    let terminal = fixture
        .core
        .start_container_terminal(
            "session",
            1,
            &container.handle,
            TerminalShell::Sh,
            80,
            24,
            Arc::new(|_| {
                Err(ApiError::new(
                    "TerminalChannelClosed",
                    "display unavailable",
                ))
            }),
        )
        .unwrap();
    let error = fixture
        .core
        .start_container_terminal(
            "session",
            1,
            &container.handle,
            TerminalShell::Sh,
            80,
            24,
            Arc::new(|_| Ok(())),
        )
        .unwrap_err();
    assert_eq!(error.code, "TerminalAlreadyOpen");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let terminal = fixture
            .core
            .terminal("session", &terminal.terminal_id, false)
            .unwrap()
            .snapshot();
        if terminal.status == TerminalStatus::Disconnected {
            assert_eq!(terminal.error.unwrap().code, "TerminalChannelClosed");
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        tauri::async_runtime::block_on(fixture.core.write_container_terminal(
            "session",
            &terminal.terminal_id,
            vec![3]
        ))
        .unwrap_err()
        .code,
        "TerminalClosed"
    );
}

#[test]
fn output_credit_stalls_socket_read_and_disconnect_still_completes() {
    let fixture = Fixture::new(Mode::Flood);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    running(&events);
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut count, mut sequence) = (0, 0);
    while count < WINDOW_BYTES {
        match events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| panic!("output stalled after {count} bytes: {error}"))
        {
            TerminalEvent::Output {
                bytes,
                sequence: seq,
                ..
            } => {
                assert!(bytes.len() <= CHUNK_BYTES);
                count += bytes.len();
                sequence = seq;
            }
            event => panic!("unexpected event after {count} bytes: {event:?}"),
        }
    }
    assert_eq!(count, WINDOW_BYTES);
    assert!(events.recv_timeout(Duration::from_millis(100)).is_err());
    fixture
        .core
        .ack_container_terminal("session", &terminal.terminal_id, sequence)
        .unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(2)).unwrap(),
        TerminalEvent::Output { .. }
    ));
    let start = Instant::now();
    fixture
        .core
        .disconnect_container_terminal("session", &terminal.terminal_id)
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn slow_resize_does_not_block_keyboard_or_output() {
    let fixture = Fixture::new(Mode::SlowResize);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    running(&events);
    let core = fixture.core.clone();
    let id = terminal.terminal_id.clone();
    let resize = tauri::async_runtime::spawn(async move {
        core.resize_container_terminal("session", &id, 100, 32)
            .await
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while !fixture
        .paths()
        .iter()
        .any(|request| request.path.ends_with("h=32&w=100"))
    {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    tauri::async_runtime::block_on(fixture.core.write_container_terminal(
        "session",
        &terminal.terminal_id,
        b"keyboard-during-resize".to_vec(),
    ))
    .unwrap();
    until(
        &events,
        |event| matches!(event, TerminalEvent::Output { bytes, .. } if bytes == b"keyboard-during-resize"),
    );
    fixture.server.release.store(true, Ordering::Release);
    tauri::async_runtime::block_on(resize).unwrap().unwrap();
}

#[test]
fn simultaneous_output_pressure_and_pending_input_make_progress() {
    let fixture = Fixture::new(Mode::Duplex);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    running(&events);
    let core = fixture.core.clone();
    let id = terminal.terminal_id.clone();
    let input = tauri::async_runtime::spawn(async move {
        // The peer writes its entire 768 KiB burst before reading any input.
        // This exceeds both Unix socket buffers while output still needs ACKs.
        for _ in 0..16 {
            core.write_container_terminal("session", &id, vec![b'i'; CHUNK_BYTES])
                .await?;
        }
        Ok::<_, ApiError>(())
    });
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut bytes = 0;
    while bytes < WINDOW_BYTES * 3 {
        match events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("full duplex progress")
        {
            TerminalEvent::Output {
                bytes: chunk,
                sequence,
                ..
            } => {
                bytes += chunk.len();
                fixture
                    .core
                    .ack_container_terminal("session", &terminal.terminal_id, sequence)
                    .unwrap();
            }
            event => panic!("unexpected terminal transition: {event:?}"),
        }
    }
    tauri::async_runtime::block_on(input).unwrap().unwrap();
}

#[test]
fn engine_mismatch_never_creates_exec_and_failed_start_never_retries() {
    for (mode, expected) in [
        (Mode::WrongEngine, "EnvironmentChanged"),
        (Mode::Denied, "TerminalDenied"),
        (Mode::LostStart, "TerminalStartUnknown"),
        (Mode::MissingShell, "TerminalShellUnavailable"),
    ] {
        let fixture = Fixture::new(mode);
        let container = fixture.add(1, None, None);
        let (_, events) = fixture.start(&container);
        let failed = until(
            &events,
            |event| matches!(event, TerminalEvent::Status { terminal } if terminal.error.is_some()),
        );
        if let TerminalEvent::Status { terminal } = failed {
            assert_eq!(terminal.error.unwrap().code, expected);
        }
        assert_eq!(
            fixture
                .paths()
                .iter()
                .filter(|request| request.path.ends_with("/start"))
                .count(),
            usize::from(mode != Mode::WrongEngine)
        );
        if mode == Mode::WrongEngine {
            assert!(
                !fixture
                    .paths()
                    .iter()
                    .any(|request| request.method == "POST")
            );
        }
    }
}

#[test]
fn socket_replacement_is_rejected_before_exec() {
    let fixture = Fixture::new(Mode::Normal);
    std::fs::rename(&fixture.socket, fixture.root.join("old.sock")).unwrap();
    let _replacement = UnixListener::bind(&fixture.socket).unwrap();
    let container = fixture.add(1, None, None);
    let (_, events) = fixture.start(&container);
    let failed = until(
        &events,
        |event| matches!(event, TerminalEvent::Status { terminal } if terminal.error.is_some()),
    );
    if let TerminalEvent::Status { terminal } = failed {
        assert_eq!(terminal.error.unwrap().code, "EnvironmentChanged");
    }
    assert!(fixture.paths().is_empty());
}

#[test]
fn target_and_compose_invalidation_preserve_other_terminals() {
    let fixture = Fixture::new(Mode::Normal);
    let one = fixture.add(1, Some("project"), Some("web"));
    let two = fixture.add(2, Some("project"), Some("db"));
    let three = fixture.add(3, None, None);
    let (one, events) = fixture.start(&one);
    running(&events);
    let (two, events) = fixture.start(&two);
    running(&events);
    let (three, events) = fixture.start(&three);
    running(&events);
    fixture
        .core
        .disconnect_compose_terminals("session", "project", Some(&["web".into()]));
    assert_eq!(
        fixture
            .core
            .terminal("session", &one.terminal_id, false)
            .unwrap()
            .snapshot()
            .status,
        TerminalStatus::Disconnected
    );
    assert_eq!(
        fixture
            .core
            .terminal("session", &two.terminal_id, false)
            .unwrap()
            .snapshot()
            .status,
        TerminalStatus::Running
    );
    fixture
        .core
        .disconnect_terminal_targets("session", &[three.container_id]);
    assert_eq!(
        fixture
            .core
            .terminal("session", &three.terminal_id, false)
            .unwrap()
            .snapshot()
            .status,
        TerminalStatus::Disconnected
    );
    assert_eq!(
        fixture
            .core
            .terminal("session", &two.terminal_id, false)
            .unwrap()
            .snapshot()
            .status,
        TerminalStatus::Running
    );
}

#[test]
fn shutdown_during_start_cannot_publish_a_late_running_terminal() {
    let fixture = Fixture::new(Mode::BlockStart);
    let container = fixture.add(1, None, None);
    let (terminal, events) = fixture.start(&container);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !fixture
        .paths()
        .iter()
        .any(|request| request.path.ends_with("/start"))
    {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(2));
    }
    fixture.core.shutdown();
    fixture.server.release.store(true, Ordering::Release);
    assert!(fixture.core.terminals.lock().unwrap().terminals.is_empty());
    assert_eq!(
        fixture
            .core
            .ack_container_terminal("session", &terminal.terminal_id, 0)
            .unwrap_err()
            .code,
        "StaleSession"
    );
    assert!(!events.try_iter().any(|event| matches!(event, TerminalEvent::Status { terminal } if terminal.status == TerminalStatus::Running)));
}

#[test]
#[ignore = "Requires DOCKER2U_REAL_TERMINAL_TEST=1 and an explicitly owned DOCKER2U_REAL_TERMINAL_CONTAINER_ID"]
fn real_terminal_owned_container_input_resize_and_normal_exit() {
    assert_eq!(
        std::env::var("DOCKER2U_REAL_TERMINAL_TEST").as_deref(),
        Ok("1")
    );
    let id = std::env::var("DOCKER2U_REAL_TERMINAL_CONTAINER_ID")
        .expect("Explicit owned full container ID required");
    assert!(valid_id(&id));
    let core = Core::default();
    struct Cleanup(Core);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.shutdown();
        }
    }
    let _cleanup = Cleanup(core.clone());
    let environment = core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    let session = core
        .active(environment.session_id.as_deref().unwrap())
        .unwrap();
    let inspection: Vec<Value> = serde_json::from_slice(
        &core
            .docker(&session.target, &["container", "inspect", &id], 15)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(inspection[0]["Id"].as_str(), Some(id.as_str()));
    assert!(
        inspection[0]["Config"]["Labels"]["io.github.jgoneit.docker2u.validation"]
            .as_str()
            .is_some_and(|owner| owner.starts_with("d2u-terminal-")),
        "Only the parent-created terminal validation fixture is allowed"
    );
    let inventory = core.list_containers(&session.id).unwrap();
    let container = inventory
        .containers
        .iter()
        .find(|container| container.full_id == id)
        .expect("Owned target is in current inventory");
    let (sender, events) = sync_channel::channel();
    let terminal = core
        .start_container_terminal(
            &session.id,
            inventory.generation,
            &container.handle,
            TerminalShell::Sh,
            80,
            24,
            Arc::new(move |event| {
                let _ = sender.send(event);
                Ok(())
            }),
        )
        .unwrap();
    running(&events);
    tauri::async_runtime::block_on(async {
        core.resize_container_terminal(&session.id, &terminal.terminal_id, 101, 31)
            .await
            .unwrap();
        core.write_container_terminal(
            &session.id,
            &terminal.terminal_id,
            b"echo D2U_TERMINAL_LIVE_MARKER\nstty size\n".to_vec(),
        )
        .await
        .unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("31 101") {
        match events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("live terminal output")
        {
            TerminalEvent::Output {
                bytes, sequence, ..
            } => {
                output.extend(bytes);
                core.ack_container_terminal(&session.id, &terminal.terminal_id, sequence)
                    .unwrap();
            }
            TerminalEvent::Status { terminal } => {
                assert_eq!(terminal.status, TerminalStatus::Running, "{terminal:?}")
            }
        }
    }
    assert!(String::from_utf8_lossy(&output).contains("\nD2U_TERMINAL_LIVE_MARKER"));
    // A readonly inventory refresh regenerates UI handles; the running terminal
    // remains bound to its original full ID and accepts exit afterwards.
    core.list_containers(&session.id).unwrap();
    tauri::async_runtime::block_on(core.write_container_terminal(
        &session.id,
        &terminal.terminal_id,
        b"exit 0\n".to_vec(),
    ))
    .unwrap();
    let exited = until(
        &events,
        |event| matches!(event, TerminalEvent::Status { terminal } if terminal.status == TerminalStatus::Exited || terminal.status == TerminalStatus::Disconnected),
    );
    if let TerminalEvent::Status { terminal } = exited {
        assert_eq!(terminal.status, TerminalStatus::Exited, "{terminal:?}");
        assert_eq!(terminal.exit_code, Some(0));
    }
    core.close_container_terminal(&session.id, &terminal.terminal_id)
        .unwrap();
    println!(
        "Owned terminal exec: input, 31x101 resize, generation refresh, exit 0 verified; no container lifecycle mutation"
    );
}
