use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::{UnixListener, UnixStream as StdUnixStream},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};

#[test]
fn socket_identity_records_device_and_inode_and_detects_replacement() {
    let dir = std::env::temp_dir().join(format!("d2u-identity-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("endpoint");
    std::fs::write(&path, b"first inode").unwrap();
    let before = SocketIdentity::from_metadata(&path.metadata().unwrap());
    assert_eq!(
        before,
        SocketIdentity::from_metadata(&path.metadata().unwrap())
    );
    // Keep the original inode alive so the filesystem cannot reuse its number.
    std::fs::rename(&path, dir.join("old")).unwrap();
    std::fs::write(&path, b"replacement inode").unwrap();
    assert_ne!(
        before,
        SocketIdentity::from_metadata(&path.metadata().unwrap())
    );
    assert_eq!(
        SocketIdentity::capture(&path.canonicalize().unwrap())
            .unwrap_err()
            .code,
        "UnsupportedObservationEndpoint"
    );
    assert!(before.verify(&path).unwrap_err().invalidates_session);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn missing_socket_is_an_availability_error_before_collection_begins() {
    let missing = std::env::temp_dir().join(format!("d2u-missing-{}", uuid::Uuid::new_v4()));
    let error = SocketIdentity::capture(&missing).unwrap_err();
    assert_eq!(error.code, "SocketMissing");
    assert!(!error.invalidates_session);
}

#[test]
fn same_path_socket_replacement_invalidates_without_contacting_new_socket() {
    let fixture = Fixture::new(Mode::Quiet);
    let reader = fixture.reader();
    std::fs::rename(&fixture.target.socket_path, fixture.dir.join("old.sock")).unwrap();
    let _replacement = UnixListener::bind(&fixture.target.socket_path).unwrap();
    run_async(async {
        let error = reader.validate().await.unwrap_err();
        assert_eq!(error.code, "EnvironmentChanged");
        assert!(error.invalidates_session);
    });
    assert!(fixture.paths.lock().unwrap().is_empty());
}

#[derive(Clone, Copy)]
enum Mode {
    Mux,
    Tty,
    Quiet,
    WrongIdentity,
    NewMinimum,
    Retry,
    Denied,
    Event,
}
struct Fixture {
    dir: PathBuf,
    target: EngineTarget,
    stop: Arc<AtomicBool>,
    server: Option<thread::JoinHandle<()>>,
    paths: Arc<Mutex<Vec<(usize, String)>>>,
    opened: Arc<AtomicUsize>,
    closed: Arc<AtomicUsize>,
    peak_startups: Arc<AtomicUsize>,
}
impl Fixture {
    fn new(mode: Mode) -> Self {
        // Darwin's sockaddr_un has a short path budget; TMPDIR can already consume it.
        let dir = PathBuf::from("/tmp")
            .canonicalize()
            .unwrap()
            .join(format!("d2u-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let socket = dir.join("engine.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let seen = paths.clone();
        let opened = Arc::new(AtomicUsize::new(0));
        let opens = opened.clone();
        let closed = Arc::new(AtomicUsize::new(0));
        let closes = closed.clone();
        let startups = Arc::new(AtomicUsize::new(0));
        let peak_startups = Arc::new(AtomicUsize::new(0));
        let peak = peak_startups.clone();
        let server = thread::spawn(move || {
            let mut workers = Vec::new();
            let mut next_id = 0;
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let seen = seen.clone();
                        let opens = opens.clone();
                        let closes = closes.clone();
                        let startups = startups.clone();
                        let peak = peak.clone();
                        let id = next_id;
                        next_id += 1;
                        workers.push(thread::spawn(move || {
                            serve(stream, mode, id, seen, opens, closes, startups, peak)
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        let api = if matches!(mode, Mode::NewMinimum) {
            "1.50"
        } else {
            "1.47"
        };
        Self {
            dir,
            target: EngineTarget {
                socket_path: socket,
                fingerprint: EngineFingerprint {
                    id: "engine-id".into(),
                    server: "27.5.0".into(),
                    api: api.into(),
                    os: "linux".into(),
                    arch: "aarch64".into(),
                    name: "fixture".into(),
                },
            },
            stop,
            server: Some(server),
            paths,
            opened,
            closed,
            peak_startups,
        }
    }
    fn reader(&self) -> EngineReader {
        EngineReader::new(self.target.clone()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(server) = self.server.take() {
            server.join().unwrap();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn mux(pipe: u8, text: &[u8]) -> Vec<u8> {
    let mut bytes = vec![pipe, 0, 0, 0];
    bytes.extend_from_slice(&(text.len() as u32).to_be_bytes());
    bytes.extend_from_slice(text);
    bytes
}
#[allow(clippy::too_many_arguments)]
fn serve(
    mut stream: StdUnixStream,
    mode: Mode,
    id: usize,
    seen: Arc<Mutex<Vec<(usize, String)>>>,
    opens: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
    startups: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
) {
    // Darwin accepts inherit the listener's O_NONBLOCK flag. Each worker uses
    // blocking reads with a deadline so it can await the next keep-alive request.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut startup_active = false;
    loop {
        let mut first = String::new();
        if reader.read_line(&mut first).unwrap_or(0) == 0 {
            break;
        }
        if first.len() > 8192 {
            break;
        }
        let parts: Vec<_> = first.split_whitespace().collect();
        assert_eq!(parts[0], "GET");
        let path = parts[1].to_owned();
        seen.lock().unwrap().push((id, path.clone()));
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            if line == "\r\n" {
                break;
            }
        }
        if path.ends_with("/version") {
            let active = startups.fetch_add(1, Ordering::SeqCst) + 1;
            startup_active = true;
            peak.fetch_max(active, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(5));
            let (api, min) = if matches!(mode, Mode::NewMinimum) {
                ("1.50", "1.48")
            } else {
                ("1.47", "1.24")
            };
            let json = format!(
                r#"{{"Version":"27.5.0","ApiVersion":"{api}","MinAPIVersion":"{min}","Os":"linux","Arch":"aarch64"}}"#
            );
            if json_response(&mut stream, &json).is_err() {
                break;
            }
        } else if path.ends_with("/info") {
            let engine = if matches!(mode, Mode::WrongIdentity) {
                "replacement-engine"
            } else {
                "engine-id"
            };
            let json = format!(
                r#"{{"ID":"{engine}","OSType":"linux","Architecture":"aarch64","Name":"fixture","Ignored":{{"secret":"never returned"}}}}"#
            );
            if json_response(&mut stream, &json).is_err() {
                break;
            }
        } else {
            assert!(path.starts_with("/v1.47/containers/") || path.starts_with("/v1.47/events?"));
            if startup_active {
                startups.fetch_sub(1, Ordering::SeqCst);
                startup_active = false;
            }
            opens.fetch_add(1, Ordering::SeqCst);
            if matches!(mode, Mode::Retry | Mode::Denied) {
                let status = if matches!(mode, Mode::Retry) {
                    "503 Service Unavailable"
                } else {
                    "403 Forbidden"
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n");
                break;
            }
            if stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .is_err()
            {
                break;
            }
            if matches!(mode, Mode::Quiet) {
                let mut byte = [0];
                let _ = reader.read(&mut byte);
                closes.fetch_add(1, Ordering::SeqCst);
                break;
            }
            let body = match mode {
                Mode::Tty => "2026-09-11T10:00:00.123456789Z tty 한글\npartial".as_bytes().to_vec(),
                Mode::Event => format!(r#"{{"Type":"container","Action":"health_status: unhealthy","Actor":{{"ID":"{}","Attributes":{{"name":"api","token":"private"}}}},"timeNano":1789120800123456789}}
"#, "a".repeat(64)).into_bytes(),
                _ => {
                    let mut bytes = mux(1, "2026-09-11T10:00:00.123456789Z hello 한글\n".as_bytes());
                    bytes.extend(mux(2, b"2026-09-11T10:00:00.123456788Z error\n")); bytes
                }
            };
            let mut failed = false;
            for part in body.chunks(3) {
                if write!(stream, "{:X}\r\n", part.len())
                    .and_then(|_| stream.write_all(part))
                    .and_then(|_| stream.write_all(b"\r\n"))
                    .is_err()
                {
                    failed = true;
                    break;
                }
            }
            if !failed {
                let _ = stream.write_all(b"0\r\n\r\n");
            }
            break;
        }
    }
    if startup_active {
        startups.fetch_sub(1, Ordering::SeqCst);
    }
}
fn json_response(stream: &mut StdUnixStream, json: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        json.len(),
        json
    )
}
fn request(tty: bool) -> LogRequest {
    LogRequest {
        full_id: "a".repeat(64),
        tty,
        since: None,
        tail: 300,
    }
}
fn capture() -> (ReaderSink, Arc<Mutex<Vec<ReaderMessage>>>) {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let output = messages.clone();
    (
        Arc::new(move |message| output.lock().unwrap().push(message)),
        messages,
    )
}
fn run_async(work: impl Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(work);
}
async fn wait_for(predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !predicate() {
        assert!(Instant::now() < deadline, "fixture condition timed out");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
#[test]
fn verifies_identity_on_the_same_connection_then_decodes_http_and_docker_chunks() {
    let fixture = Fixture::new(Mode::Mux);
    run_async(async {
        let (sink, messages) = capture();
        let task = fixture.reader().spawn_logs(request(false), sink).unwrap();
        tokio::time::timeout(Duration::from_secs(3), task.join())
            .await
            .unwrap();
        let messages = messages.lock().unwrap();
        let rows: Vec<_> = messages
            .iter()
            .filter_map(|item| {
                if let ReaderMessage::Log(row) = item {
                    Some(row)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "hello 한글");
        assert_eq!(rows[1].stream, LogStreamKind::Stderr);
        assert_eq!(
            rows[0].timestamp.as_deref(),
            Some("2026-09-11T10:00:00.123456789Z")
        );
        assert!(matches!(
            messages.last(),
            Some(ReaderMessage::Status(ReaderStatus::Ended))
        ));
    });
    let paths = fixture.paths.lock().unwrap();
    assert_eq!(paths.len(), 3);
    assert!(paths.iter().all(|(id, _)| *id == paths[0].0));
    assert_eq!(paths[0].1, "/v1.47/version");
    assert_eq!(paths[1].1, "/v1.47/info");
    assert!(paths[2].1.contains("timestamps=1&follow=1&tail=300"));
}
#[test]
fn tty_returns_unmultiplexed_lines_and_flushes_eof() {
    let fixture = Fixture::new(Mode::Tty);
    run_async(async {
        let (sink, messages) = capture();
        fixture
            .reader()
            .spawn_logs(request(true), sink)
            .unwrap()
            .join()
            .await;
        let messages = messages.lock().unwrap();
        let rows: Vec<_> = messages
            .iter()
            .filter_map(|item| {
                if let ReaderMessage::Log(row) = item {
                    Some(row)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].stream, LogStreamKind::Tty);
        assert_eq!(rows[1].text, "partial");
    });
}

#[test]
fn log_timestamp_bounds_use_unix_seconds_and_preserve_nanoseconds() {
    let fixture = Fixture::new(Mode::Mux);
    run_async(async {
        let mut options = request(false);
        options.since = Some("2026-09-11T19:00:00.123456789+09:00".into());
        let (sink, messages) = capture();
        fixture
            .reader()
            .spawn_logs(options, sink)
            .unwrap()
            .join()
            .await;
        assert!(matches!(
            messages.lock().unwrap().last(),
            Some(ReaderMessage::Status(ReaderStatus::Ended))
        ));
    });
    let paths = fixture.paths.lock().unwrap();
    let logs = &paths
        .iter()
        .find(|(_, path)| path.contains("/logs?"))
        .unwrap()
        .1;
    assert!(logs.ends_with("&since=1789120800.123456789"), "{logs}");

    let mut numeric = String::new();
    add_since(&mut numeric, &Some("1789120800.123456789".into()));
    assert_eq!(numeric, "&since=1789120800.123456789");
}
#[test]
fn identity_mismatch_and_unsupported_api_never_dispatch_a_log_request() {
    for mode in [Mode::WrongIdentity, Mode::NewMinimum] {
        let fixture = Fixture::new(mode);
        run_async(async {
            let (sink, messages) = capture();
            fixture
                .reader()
                .spawn_logs(request(false), sink)
                .unwrap()
                .join()
                .await;
            let messages = messages.lock().unwrap();
            let error = messages
                .iter()
                .find_map(|message| {
                    if let ReaderMessage::Status(ReaderStatus::Failed(error)) = message {
                        Some(error)
                    } else {
                        None
                    }
                })
                .unwrap();
            if matches!(mode, Mode::WrongIdentity) {
                assert!(error.invalidates_session);
            } else {
                assert_eq!(error.code, "UnsupportedObservationApi");
            }
        });
        assert_eq!(fixture.opened.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn quiet_streams_cancel_promptly_and_share_a_64_source_limit_with_reserved_events() {
    let fixture = Fixture::new(Mode::Quiet);
    run_async(async {
        let reader = fixture.reader();
        let following = Arc::new(AtomicUsize::new(0));
        let count = following.clone();
        let sink: ReaderSink = Arc::new(move |message| {
            if matches!(message, ReaderMessage::Status(ReaderStatus::Following)) {
                count.fetch_add(1, Ordering::SeqCst);
            }
        });
        let mut tasks = Vec::new();
        for index in 0..64 {
            let mut options = request(false);
            options.full_id = format!("{index:064x}");
            tasks.push(reader.spawn_logs(options, sink.clone()).unwrap());
        }
        assert_eq!(
            reader
                .spawn_logs(request(false), sink.clone())
                .err()
                .unwrap()
                .code,
            "ObservationCapacity"
        );
        tasks.push(reader.spawn_events(None, sink.clone()).unwrap());
        assert!(reader.spawn_events(None, sink).is_err());
        wait_for(|| following.load(Ordering::SeqCst) == 65).await;
        assert!(fixture.peak_startups.load(Ordering::SeqCst) <= MAX_STARTS);
        for task in &tasks {
            task.cancel();
        }
        for task in tasks {
            tokio::time::timeout(Duration::from_secs(2), task.join())
                .await
                .unwrap();
        }
        wait_for(|| fixture.closed.load(Ordering::SeqCst) == 65).await;
        let task = reader.spawn_logs(request(false), Arc::new(|_| {})).unwrap();
        task.cancel();
        task.join().await;
    });
}
#[test]
fn transient_failures_retry_five_times_and_permission_failure_does_not_retry() {
    for mode in [Mode::Retry, Mode::Denied] {
        let fixture = Fixture::new(mode);
        run_async(async {
            let mut reader = fixture.reader();
            reader.retry_unit = Duration::from_millis(1);
            let (sink, messages) = capture();
            reader
                .spawn_logs(request(false), sink)
                .unwrap()
                .join()
                .await;
            let messages = messages.lock().unwrap();
            let delays: Vec<_> = messages
                .iter()
                .filter_map(|item| {
                    if let ReaderMessage::Status(ReaderStatus::Retrying { delay_seconds, .. }) =
                        item
                    {
                        Some(*delay_seconds)
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(
                delays,
                if matches!(mode, Mode::Retry) {
                    RETRY_SECONDS.to_vec()
                } else {
                    vec![]
                }
            );
            assert!(matches!(
                messages.last(),
                Some(ReaderMessage::Status(ReaderStatus::Failed(_)))
            ));
        });
        assert_eq!(
            fixture.opened.load(Ordering::SeqCst),
            if matches!(mode, Mode::Retry) { 6 } else { 1 },
            "requests observed by fixture: {:?}",
            fixture.paths.lock().unwrap()
        );
    }
}
#[test]
fn event_stream_filters_sensitive_attributes_and_keeps_exact_nanoseconds() {
    let fixture = Fixture::new(Mode::Event);
    run_async(async {
        let (sink, messages) = capture();
        let task = fixture.reader().spawn_events(None, sink).unwrap();
        wait_for(|| {
            messages
                .lock()
                .unwrap()
                .iter()
                .any(|message| matches!(message, ReaderMessage::Event(_)))
        })
        .await;
        task.cancel();
        task.join().await;
        let messages = messages.lock().unwrap();
        let event = messages
            .iter()
            .find_map(|message| {
                if let ReaderMessage::Event(event) = message {
                    Some(event)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(event.time_nano, 1789120800123456789);
        assert_eq!(event.attributes.len(), 1);
        assert_eq!(event.action, "health_status: unhealthy");
    });
}
#[test]
fn invalid_targets_and_request_injection_are_rejected_before_connect() {
    let fixture = Fixture::new(Mode::Quiet);
    let reader = fixture.reader();
    let mut options = request(false);
    options.full_id = "a/../../info".into();
    assert!(reader.spawn_logs(options, Arc::new(|_| {})).is_err());
    let mut options = request(false);
    options.since = Some("0&stdout=0".into());
    assert!(reader.spawn_logs(options, Arc::new(|_| {})).is_err());
    let mut target = fixture.target.clone();
    target.socket_path = PathBuf::from("relative.sock");
    assert!(EngineReader::new(target).is_err());
    assert!(fixture.paths.lock().unwrap().is_empty());
}
