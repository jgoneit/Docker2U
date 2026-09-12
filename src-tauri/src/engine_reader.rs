//! Read-only Engine streams on the exact Unix socket selected by Core.
//! This module owns transport, never inventory, operation authority, or retention.
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Request, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    future::{Future, poll_fn},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::PathBuf,
    sync::Arc,
    task::Poll,
    time::Duration,
};
use tokio::{
    net::UnixStream,
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    task::JoinHandle,
};

#[path = "engine_decoder.rs"]
mod decoder;
use decoder::{EventDecoder, LogDecoder};

const MAX_LOGS: usize = 64;
const MAX_STARTS: usize = 4;
const JSON_LIMIT: usize = 1024 * 1024;
const RETRY_SECONDS: [u64; 5] = [1, 2, 5, 10, 30];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub(super) struct EngineFingerprint {
    pub id: String,
    pub server: String,
    pub api: String,
    pub os: String,
    pub arch: String,
    pub name: String,
}
#[derive(Debug, Clone)]
pub(super) struct EngineTarget {
    pub socket_path: PathBuf,
    pub fingerprint: EngineFingerprint,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReaderError {
    pub code: String,
    pub message: String,
    pub transient: bool,
    pub invalidates_session: bool,
}
impl ReaderError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            transient: false,
            invalidates_session: false,
        }
    }
    fn transport() -> Self {
        Self {
            transient: true,
            ..Self::new(
                "ObservationTransport",
                "The Engine observation connection was interrupted",
            )
        }
    }
    fn identity() -> Self {
        Self {
            invalidates_session: true,
            ..Self::new(
                "EnvironmentChanged",
                "The Engine identity changed; reconnect before continuing",
            )
        }
    }
    fn protocol(message: &str) -> Self {
        Self::new("ObservationProtocol", message)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogStreamKind {
    Stdout,
    Stderr,
    Tty,
}
#[derive(Debug, Clone)]
pub(super) struct LogRecord {
    pub timestamp: Option<String>,
    pub received_at: String,
    pub stream: LogStreamKind,
    pub text: String,
    pub truncated: bool,
}
#[derive(Debug, Clone)]
pub(super) struct EngineEventRecord {
    pub time_nano: i64,
    pub action: String,
    pub full_id: String,
    pub attributes: BTreeMap<String, String>,
}
#[derive(Debug, Clone)]
pub(super) enum ReaderStatus {
    Connecting,
    Following,
    Retrying { attempt: u8, delay_seconds: u64 },
    Ended,
    Failed(ReaderError),
}
#[derive(Debug, Clone)]
pub(super) enum ReaderMessage {
    Log(LogRecord),
    Event(EngineEventRecord),
    Status(ReaderStatus),
}
pub(super) type ReaderSink = Arc<dyn Fn(ReaderMessage) + Send + Sync>;
#[derive(Debug, Clone)]
pub(super) struct LogRequest {
    pub full_id: String,
    pub tty: bool,
    pub since: Option<String>,
    pub tail: u16,
}

/// Drop/cancel never blocks the caller or acquires a Core lock.
pub(super) struct StreamTask {
    cancel: watch::Sender<bool>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}
impl StreamTask {
    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }
    pub async fn join(mut self) {
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for StreamTask {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Clone)]
pub(super) struct EngineReader {
    target: Arc<EngineTarget>,
    socket_identity: SocketIdentity,
    logs: Arc<Semaphore>,
    events: Arc<Semaphore>,
    starts: Arc<Semaphore>,
    validation: Arc<Semaphore>,
    #[cfg(test)]
    retry_unit: Duration,
}
#[derive(Clone)]
enum StreamRequest {
    Logs(LogRequest),
    Events(Option<String>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
}
impl SocketIdentity {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
    fn capture(path: &std::path::Path) -> Result<Self, ReaderError> {
        let actual = path.canonicalize().map_err(|_| {
            ReaderError::new("SocketMissing", "The pinned Engine socket is unavailable")
        })?;
        if actual != path {
            return Err(ReaderError::identity());
        }
        let metadata = actual.metadata().map_err(|_| {
            ReaderError::new("SocketMissing", "The pinned Engine socket is unavailable")
        })?;
        if !metadata.file_type().is_socket() {
            return Err(ReaderError::new(
                "UnsupportedObservationEndpoint",
                "Engine observation requires a Unix socket",
            ));
        }
        Ok(Self::from_metadata(&metadata))
    }
    fn verify(self, path: &std::path::Path) -> Result<(), ReaderError> {
        let actual = Self::capture(path).map_err(|mut error| {
            error.invalidates_session = true;
            error
        })?;
        if actual != self {
            return Err(ReaderError::identity());
        }
        Ok(())
    }
}

impl EngineReader {
    pub fn new(target: EngineTarget) -> Result<Self, ReaderError> {
        if !target.socket_path.is_absolute()
            || target.fingerprint.id.is_empty()
            || parse_api(&target.fingerprint.api).is_none()
        {
            return Err(ReaderError::protocol(
                "The pinned observation target is invalid",
            ));
        }
        let socket_identity = SocketIdentity::capture(&target.socket_path)?;
        Ok(Self {
            target: Arc::new(target),
            socket_identity,
            logs: Arc::new(Semaphore::new(MAX_LOGS)),
            events: Arc::new(Semaphore::new(1)),
            starts: Arc::new(Semaphore::new(MAX_STARTS)),
            validation: Arc::new(Semaphore::new(2)),
            #[cfg(test)]
            retry_unit: Duration::from_secs(1),
        })
    }
    pub async fn validate(&self) -> Result<(), ReaderError> {
        let _slot = self
            .validation
            .acquire()
            .await
            .map_err(|_| ReaderError::transport())?;
        Connection::verified(&self.target, self.socket_identity)
            .await
            .map(|_| ())
    }
    pub fn spawn_logs(
        &self,
        request: LogRequest,
        sink: ReaderSink,
    ) -> Result<StreamTask, ReaderError> {
        if !valid_id(&request.full_id)
            || request.tail == 0
            || request.tail > 2000
            || !valid_since(&request.since)
        {
            return Err(ReaderError::new(
                "InvalidSelection",
                "The log source or retrieval bounds are invalid",
            ));
        }
        let permit = self.logs.clone().try_acquire_owned().map_err(|_| {
            ReaderError::new(
                "ObservationCapacity",
                "Select at most 64 concurrent log sources",
            )
        })?;
        self.spawn(StreamRequest::Logs(request), sink, permit)
    }
    pub fn spawn_events(
        &self,
        since: Option<String>,
        sink: ReaderSink,
    ) -> Result<StreamTask, ReaderError> {
        if !valid_since(&since) {
            return Err(ReaderError::protocol("The event cursor is invalid"));
        }
        let permit = self.events.clone().try_acquire_owned().map_err(|_| {
            ReaderError::new(
                "ObservationCapacity",
                "The session already has an event stream",
            )
        })?;
        self.spawn(StreamRequest::Events(since), sink, permit)
    }
    fn spawn(
        &self,
        request: StreamRequest,
        sink: ReaderSink,
        permit: OwnedSemaphorePermit,
    ) -> Result<StreamTask, ReaderError> {
        let (cancel, mut receiver) = watch::channel(false);
        let reader = self.clone();
        let task = tauri::async_runtime::spawn(async move {
            let _permit = permit;
            // Dropping the transport future also aborts its Hyper connection task.
            let cancel = cancelled(&mut receiver);
            let work = reader.run(request, sink);
            let mut cancel = std::pin::pin!(cancel);
            let mut work = std::pin::pin!(work);
            poll_fn(|context| {
                if cancel.as_mut().poll(context).is_ready() {
                    return Poll::Ready(());
                }
                work.as_mut().poll(context)
            })
            .await;
        });
        Ok(StreamTask {
            cancel,
            task: Some(task),
        })
    }
    async fn run(&self, mut request: StreamRequest, sink: ReaderSink) {
        let mut retry = 0;
        loop {
            sink(ReaderMessage::Status(ReaderStatus::Connecting));
            match self.read_once(&mut request, &sink).await {
                Ok(()) => {
                    sink(ReaderMessage::Status(ReaderStatus::Ended));
                    return;
                }
                Err(error)
                    if error.transient
                        && !error.invalidates_session
                        && retry < RETRY_SECONDS.len() =>
                {
                    let delay_seconds = RETRY_SECONDS[retry];
                    retry += 1;
                    sink(ReaderMessage::Status(ReaderStatus::Retrying {
                        attempt: retry as u8,
                        delay_seconds,
                    }));
                    #[cfg(test)]
                    let delay = self.retry_unit * delay_seconds as u32;
                    #[cfg(not(test))]
                    let delay = Duration::from_secs(delay_seconds);
                    tokio::time::sleep(delay).await;
                }
                Err(error) => {
                    sink(ReaderMessage::Status(ReaderStatus::Failed(error)));
                    return;
                }
            }
        }
    }
    async fn read_once(
        &self,
        request: &mut StreamRequest,
        sink: &ReaderSink,
    ) -> Result<(), ReaderError> {
        // A slot is held through connect, identity reads, and stream headers only.
        let startup = self
            .starts
            .acquire()
            .await
            .map_err(|_| ReaderError::transport())?;
        let (mut connection, api) =
            Connection::verified(&self.target, self.socket_identity).await?;
        let path = match request {
            StreamRequest::Logs(options) => {
                let mut path = format!(
                    "/v{api}/containers/{}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail={}",
                    options.full_id, options.tail
                );
                add_since(&mut path, &options.since);
                path
            }
            StreamRequest::Events(since) => {
                // No labels, commands, exec events, or arbitrary attributes are requested.
                let filters = r#"{"type":["container"],"event":["create","start","stop","die","restart","kill","oom","pause","unpause","destroy","rename","health_status"]}"#;
                let mut path = format!("/v{api}/events?filters={}", encode_query(filters));
                add_since(&mut path, since);
                path
            }
        };
        let mut body = connection.get(&path).await?;
        drop(startup);
        sink(ReaderMessage::Status(ReaderStatus::Following));
        match request {
            StreamRequest::Logs(options) => {
                let mut decoder = LogDecoder::new(options.tty);
                while let Some(frame) = body.frame().await {
                    let frame = frame.map_err(|_| ReaderError::transport())?;
                    if let Ok(data) = frame.into_data() {
                        decoder.push(&data, false, &mut |record: LogRecord| {
                            if let Some(timestamp) = &record.timestamp {
                                advance_cursor(&mut options.since, timestamp);
                            }
                            sink(ReaderMessage::Log(record));
                        })?;
                    }
                    tokio::task::yield_now().await;
                }
                decoder.push(&[], true, &mut |record: LogRecord| {
                    if let Some(timestamp) = &record.timestamp {
                        advance_cursor(&mut options.since, timestamp);
                    }
                    sink(ReaderMessage::Log(record));
                })?;
                Ok(())
            }
            StreamRequest::Events(since) => {
                let mut decoder = EventDecoder::default();
                while let Some(frame) = body.frame().await {
                    let frame = frame.map_err(|_| ReaderError::transport())?;
                    if let Ok(data) = frame.into_data() {
                        decoder.push(&data, false, &mut |record: EngineEventRecord| {
                            *since = Some(format!(
                                "{}.{:09}",
                                record.time_nano.div_euclid(1_000_000_000),
                                record.time_nano.rem_euclid(1_000_000_000)
                            ));
                            sink(ReaderMessage::Event(record));
                        })?;
                    }
                    tokio::task::yield_now().await;
                }
                decoder.push(&[], true, &mut |record| sink(ReaderMessage::Event(record)))?;
                // Unlike completed container output, an event stream must keep running.
                Err(ReaderError::transport())
            }
        }
    }
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}
fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn parse_api(value: &str) -> Option<(u32, u32)> {
    let (major, minor) = value.split_once('.')?;
    if major.is_empty()
        || minor.is_empty()
        || !major
            .bytes()
            .chain(minor.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some((major.parse().ok()?, minor.parse().ok()?))
}
fn equivalent_arch(left: &str, right: &str) -> bool {
    fn normalize(value: &str) -> &str {
        match value {
            "aarch64" | "arm64" => "arm64",
            "x86_64" | "amd64" => "amd64",
            other => other,
        }
    }
    normalize(left) == normalize(right)
}
fn valid_since(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|value| {
        if value.is_empty() || value.len() > 64 {
            return false;
        }
        chrono::DateTime::parse_from_rfc3339(value).is_ok() || {
            let (seconds, nanos) = value.split_once('.').unwrap_or((value, ""));
            !seconds.is_empty()
                && seconds.parse::<u64>().is_ok()
                && seconds.bytes().all(|b| b.is_ascii_digit())
                && nanos.len() <= 9
                && nanos.bytes().all(|b| b.is_ascii_digit())
        }
    })
}
fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}
fn add_since(path: &mut String, since: &Option<String>) {
    if let Some(since) = since {
        // Unlike the CLI, the Engine logs endpoint parses Unix timestamps only.
        // Convert the internal RFC3339 cursor without reducing its nanoseconds.
        let wire = chrono::DateTime::parse_from_rfc3339(since)
            .map(|stamp| {
                format!(
                    "{}.{:09}",
                    stamp.timestamp(),
                    stamp.timestamp_subsec_nanos()
                )
            })
            .unwrap_or_else(|_| since.clone());
        path.push_str("&since=");
        path.push_str(&encode_query(&wire));
    }
}
fn advance_cursor(since: &mut Option<String>, timestamp: &str) {
    // One second of bounded overlap lets the store reconcile simultaneous pipe output.
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(timestamp) {
        let Some(overlap_start) = parsed.checked_sub_signed(chrono::Duration::seconds(1)) else {
            return;
        };
        let next = overlap_start
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let newer = since
            .as_ref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_none_or(|old| overlap_start > old);
        if newer {
            *since = Some(next);
        }
    }
}

struct Connection {
    sender: http1::SendRequest<Empty<Bytes>>,
    driver: JoinHandle<()>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Version {
    version: String,
    api_version: String,
    #[serde(rename = "MinAPIVersion")]
    min_api_version: String,
    os: String,
    arch: String,
}
#[derive(Deserialize)]
struct Info {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "OSType")]
    os: String,
    #[serde(rename = "Architecture")]
    arch: String,
    #[serde(rename = "Name")]
    name: String,
}
impl Connection {
    async fn verified(
        target: &EngineTarget,
        socket_identity: SocketIdentity,
    ) -> Result<(Self, String), ReaderError> {
        socket_identity.verify(&target.socket_path)?;
        let socket =
            tokio::time::timeout(CONNECT_TIMEOUT, UnixStream::connect(&target.socket_path))
                .await
                .map_err(|_| ReaderError::transport())?
                .map_err(|_| ReaderError::transport())?;
        // A same-path socket replacement must fail even when it reports the same Engine ID.
        socket_identity.verify(&target.socket_path)?;
        let mut builder = http1::Builder::new();
        builder.max_buf_size(32 * 1024).max_headers(64);
        let (sender, connection) = builder
            .handshake(TokioIo::new(socket))
            .await
            .map_err(|_| ReaderError::transport())?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut connection = Self { sender, driver };
        // The already verified CLI maximum is safe for this bootstrap request.
        // No unversioned endpoint, network fallback, redirect, or new connection.
        let version: Version = connection
            .json(&format!("/v{}/version", target.fingerprint.api))
            .await?;
        let server_max = parse_api(&version.api_version)
            .ok_or_else(|| ReaderError::protocol("The Engine API version is malformed"))?;
        let server_min = parse_api(&version.min_api_version)
            .ok_or_else(|| ReaderError::protocol("The Engine minimum API version is malformed"))?;
        let fingerprint = &target.fingerprint;
        if version.version != fingerprint.server
            || version.api_version != fingerprint.api
            || version.os != fingerprint.os
            || !equivalent_arch(&version.arch, &fingerprint.arch)
        {
            return Err(ReaderError::identity());
        }
        let negotiated = server_max.min((1, 47));
        if server_min > server_max || negotiated < server_min.max((1, 40)) {
            return Err(ReaderError::new(
                "UnsupportedObservationApi",
                "Engine observation requires a shared API version between 1.40 and 1.47",
            ));
        }
        let api = format!("{}.{}", negotiated.0, negotiated.1);
        let info: Info = connection.json(&format!("/v{api}/info")).await?;
        if info.id != fingerprint.id
            || info.os != fingerprint.os
            || info.arch != fingerprint.arch
            || info.name != fingerprint.name
        {
            return Err(ReaderError::identity());
        }
        socket_identity.verify(&target.socket_path)?;
        Ok((connection, api))
    }
    async fn get(&mut self, path: &str) -> Result<Incoming, ReaderError> {
        let request = Request::get(path)
            .header("Host", "docker")
            .header("Accept-Encoding", "identity")
            .body(Empty::<Bytes>::new())
            .map_err(|_| ReaderError::protocol("The observation request is invalid"))?;
        let response = tokio::time::timeout(HEADER_TIMEOUT, self.sender.send_request(request))
            .await
            .map_err(|_| ReaderError::transport())?
            .map_err(|_| ReaderError::transport())?;
        let status = response.status();
        if status != hyper::StatusCode::OK {
            let (code, message, transient) = match status.as_u16() {
                404 => (
                    "LogSourceUnavailable",
                    "The observed source no longer exists",
                    false,
                ),
                401 | 403 => (
                    "ObservationDenied",
                    "The Engine denied this observation",
                    false,
                ),
                502 | 503 | 504 => (
                    "ObservationUnavailable",
                    "The Engine observation endpoint is temporarily unavailable",
                    true,
                ),
                500 => (
                    "ObservationUnavailable",
                    "The Engine could not read this source; its logging driver may not support reading",
                    false,
                ),
                _ => (
                    "ObservationProtocol",
                    "The Engine returned an unsupported observation response",
                    false,
                ),
            };
            return Err(ReaderError {
                transient,
                ..ReaderError::new(code, message)
            });
        }
        Ok(response.into_body())
    }
    async fn json<T: for<'de> Deserialize<'de>>(&mut self, path: &str) -> Result<T, ReaderError> {
        let body = self.get(path).await?;
        tokio::time::timeout(HEADER_TIMEOUT, async {
            let mut body = body;
            let mut bytes = Vec::new();
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame.map_err(|_| ReaderError::transport())?.into_data() {
                    if bytes.len().saturating_add(data.len()) > JSON_LIMIT {
                        return Err(ReaderError::protocol(
                            "Engine identity response exceeded its size limit",
                        ));
                    }
                    bytes.extend_from_slice(&data);
                }
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| ReaderError::protocol("The Engine identity response is malformed"))
        })
        .await
        .map_err(|_| ReaderError::transport())?
    }
}

#[cfg(test)]
#[path = "engine_reader_tests.rs"]
mod tests;
