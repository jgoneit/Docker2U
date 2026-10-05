//! Mutating exec transport. No arbitrary HTTP path or Engine target crosses IPC.
//! The observation reader remains independently read-only.
use super::super::{ApiError, Fingerprint, Result, Target, valid_id};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response, StatusCode, body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::PathBuf,
    time::Duration,
};
use tokio::net::UnixStream;

const TIMEOUT: Duration = Duration::from_secs(10);
const JSON_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub(in crate::docker) struct ExecTarget {
    socket: PathBuf,
    device: u64,
    inode: u64,
    fingerprint: Fingerprint,
}

pub(super) type ExecIo = TokioIo<hyper::upgrade::Upgraded>;

fn transport() -> ApiError {
    ApiError::new(
        "TerminalTransport",
        "The terminal connection was interrupted; it was not restarted",
    )
}
fn protocol(message: &str) -> ApiError {
    ApiError::new("TerminalProtocol", message)
}
fn identity() -> ApiError {
    ApiError::new(
        "EnvironmentChanged",
        "The pinned Engine changed; reconnect before continuing",
    )
}

fn api_version(value: &str) -> Result<(u32, u32)> {
    let Some((major, minor)) = value.split_once('.') else {
        return Err(protocol("Malformed Engine API version"));
    };
    Ok((
        major
            .parse()
            .map_err(|_| protocol("Malformed Engine API version"))?,
        minor
            .parse()
            .map_err(|_| protocol("Malformed Engine API version"))?,
    ))
}
fn arch(value: &str) -> &str {
    match value {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        _ => value,
    }
}

impl ExecTarget {
    pub(in crate::docker) fn new(target: &Target) -> Result<Self> {
        let socket = PathBuf::from(target.endpoint.strip_prefix("unix://").ok_or_else(|| {
            ApiError::new(
                "RemoteEndpoint",
                "Terminal requires the pinned local Unix socket",
            )
        })?);
        let actual = socket.canonicalize().map_err(|_| identity())?;
        if socket != actual || !socket.is_absolute() {
            return Err(identity());
        }
        let metadata = socket.metadata().map_err(|_| identity())?;
        if !metadata.file_type().is_socket() {
            return Err(identity());
        }
        Ok(Self {
            socket,
            device: metadata.dev(),
            inode: metadata.ino(),
            fingerprint: target.fingerprint.clone(),
        })
    }
    fn verify_socket(&self) -> Result<()> {
        if self.socket.canonicalize().map_err(|_| identity())? != self.socket {
            return Err(identity());
        }
        let metadata = self.socket.metadata().map_err(|_| identity())?;
        if !metadata.file_type().is_socket()
            || metadata.dev() != self.device
            || metadata.ino() != self.inode
        {
            return Err(identity());
        }
        Ok(())
    }
    async fn connect(&self) -> Result<Connection> {
        self.verify_socket()?;
        let socket = tokio::time::timeout(TIMEOUT, UnixStream::connect(&self.socket))
            .await
            .map_err(|_| transport())?
            .map_err(|_| transport())?;
        self.verify_socket()?;
        let mut builder = http1::Builder::new();
        builder.max_buf_size(32 * 1024).max_headers(64);
        let (sender, connection) = builder
            .handshake(TokioIo::new(socket))
            .await
            .map_err(|_| transport())?;
        let driver = tokio::spawn(async move {
            let _ = connection.with_upgrades().await;
        });
        let mut connection = Connection {
            sender,
            driver,
            api: String::new(),
        };
        let version = connection
            .json("GET", &format!("/v{}/version", self.fingerprint.api), None)
            .await?;
        let fp = &self.fingerprint;
        if version["Version"].as_str() != Some(&fp.server)
            || version["ApiVersion"].as_str() != Some(&fp.api)
            || version["Os"].as_str() != Some(&fp.os)
            || arch(version["Arch"].as_str().unwrap_or("")) != arch(&fp.arch)
        {
            return Err(identity());
        }
        let maximum = api_version(&fp.api)?;
        let minimum = api_version(
            version["MinAPIVersion"]
                .as_str()
                .ok_or_else(|| protocol("Missing minimum API version"))?,
        )?;
        let negotiated = maximum.min((1, 47));
        if minimum > maximum || negotiated < minimum.max((1, 40)) {
            return Err(ApiError::new(
                "UnsupportedTerminalApi",
                "Terminal requires a shared Engine API version between 1.40 and 1.47",
            ));
        }
        connection.api = format!("{}.{}", negotiated.0, negotiated.1);
        let info = connection
            .json("GET", &format!("/v{}/info", connection.api), None)
            .await?;
        if info["ID"].as_str() != Some(&fp.id)
            || info["OSType"].as_str() != Some(&fp.os)
            || info["Architecture"].as_str() != Some(&fp.arch)
            || info["Name"].as_str() != Some(&fp.name)
        {
            return Err(identity());
        }
        self.verify_socket()?;
        Ok(connection)
    }
    pub(super) async fn start(&self, container: &str, shell: &str) -> Result<(String, ExecIo)> {
        if !valid_id(container) {
            return Err(protocol("Invalid terminal container ID"));
        }
        let mut connection = self.connect().await?;
        let inspection = connection
            .json(
                "GET",
                &format!("/v{}/containers/{container}/json", connection.api),
                None,
            )
            .await?;
        if inspection["Id"].as_str() != Some(container) {
            return Err(identity());
        }
        if inspection["State"]["Running"].as_bool() != Some(true)
            || inspection["State"]["Paused"].as_bool() == Some(true)
            || inspection["State"]["Restarting"].as_bool() == Some(true)
        {
            return Err(ApiError::new(
                "TerminalUnavailable",
                "Terminal requires a running, unpaused container",
            ));
        }
        let created = connection
            .json(
                "POST",
                &format!("/v{}/containers/{container}/exec", connection.api),
                Some(json!({
                    "AttachStdin": true, "AttachStdout": true, "AttachStderr": true,
                    "Tty": true, "Privileged": false, "Cmd": [shell], "Env": ["TERM=xterm-256color"]
                })),
            )
            .await?;
        let id = created["Id"]
            .as_str()
            .filter(|id| valid_id(id))
            .ok_or_else(|| protocol("Malformed exec ID"))?
            .to_owned();
        self.verify_socket()?;
        let request = Request::post(format!("/v{}/exec/{id}/start", connection.api))
            .header("Host", "docker")
            .header("Content-Type", "application/json")
            .header("Connection", "Upgrade")
            .header("Upgrade", "tcp")
            .body(Full::new(Bytes::from_static(
                b"{\"Detach\":false,\"Tty\":true}",
            )))
            .map_err(|_| protocol("Invalid exec start request"))?;
        let response = tokio::time::timeout(TIMEOUT, connection.sender.send_request(request))
            .await
            .map_err(|_| {
                ApiError::new(
                    "TerminalStartUnknown",
                    "Exec start timed out; it may have started and was not retried",
                )
            })?
            .map_err(|_| {
                ApiError::new(
                    "TerminalStartUnknown",
                    "Exec start response was lost; it may have started and was not retried",
                )
            })?;
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            if response.status().is_success() {
                return Err(ApiError::new(
                    "TerminalStartUnknown",
                    "The Engine did not upgrade the terminal connection; exec may have started and was not retried",
                ));
            }
            return Err(response_error(response).await);
        }
        let io = tokio::time::timeout(TIMEOUT, hyper::upgrade::on(response))
            .await
            .map_err(|_| transport())?
            .map_err(|_| transport())?;
        Ok((id, TokioIo::new(io)))
    }
    pub(super) async fn resize(&self, exec: &str, rows: u16, cols: u16) -> Result<()> {
        let mut connection = self.connect().await?;
        connection
            .request(
                "POST",
                &format!("/v{}/exec/{exec}/resize?h={rows}&w={cols}", connection.api),
                None,
            )
            .await?;
        Ok(())
    }
    pub(super) async fn validate(&self) -> Result<()> {
        self.connect().await.map(|_| ())
    }
    pub(super) async fn inspect(&self, exec: &str, container: &str) -> Result<Option<i32>> {
        let mut connection = self.connect().await?;
        let info = connection
            .json(
                "GET",
                &format!("/v{}/exec/{exec}/json", connection.api),
                None,
            )
            .await?;
        if info["ContainerID"].as_str() != Some(container) {
            return Err(identity());
        }
        match info["Running"].as_bool() {
            Some(true) => Ok(None),
            Some(false) => info["ExitCode"]
                .as_i64()
                .and_then(|code| i32::try_from(code).ok())
                .map(Some)
                .ok_or_else(|| protocol("Malformed exec exit code")),
            None => Err(protocol("Malformed exec state")),
        }
    }
}

struct Connection {
    sender: http1::SendRequest<Full<Bytes>>,
    driver: tokio::task::JoinHandle<()>,
    api: String,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.driver.abort();
    }
}
impl Connection {
    async fn request(
        &mut self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response<Incoming>> {
        let body = body.map(|value| value.to_string()).unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("Host", "docker")
            .header("Content-Type", "application/json")
            .header("Accept-Encoding", "identity")
            .body(Full::new(Bytes::from(body)))
            .map_err(|_| protocol("Invalid terminal request"))?;
        let response = tokio::time::timeout(TIMEOUT, self.sender.send_request(request))
            .await
            .map_err(|_| transport())?
            .map_err(|_| transport())?;
        if !response.status().is_success() {
            return Err(response_error(response).await);
        }
        Ok(response)
    }
    async fn json(&mut self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let response = self.request(method, path, body).await?;
        let bytes = read_body(response.into_body(), JSON_LIMIT).await?;
        serde_json::from_slice(&bytes).map_err(|_| protocol("Malformed terminal Engine response"))
    }
}
async fn read_body(mut body: Incoming, limit: usize) -> Result<Vec<u8>> {
    tokio::time::timeout(TIMEOUT, async {
        let mut bytes = Vec::new();
        while let Some(frame) = body.frame().await {
            if let Ok(data) = frame.map_err(|_| transport())?.into_data() {
                if bytes.len().saturating_add(data.len()) > limit {
                    return Err(protocol("Terminal response exceeded its size limit"));
                }
                bytes.extend_from_slice(&data);
            }
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| transport())?
}
async fn response_error(response: Response<Incoming>) -> ApiError {
    let status = response.status();
    let bytes = read_body(response.into_body(), 16 * 1024)
        .await
        .unwrap_or_default();
    let message = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("The Engine rejected the terminal request ({status})"));
    let code = match status.as_u16() {
        401 | 403 => "TerminalDenied",
        404 => "TerminalUnavailable",
        409 => "TerminalUnavailable",
        _ if message.contains("executable file not found")
            || message.contains("no such file or directory") =>
        {
            "TerminalShellUnavailable"
        }
        _ => "TerminalEngineError",
    };
    ApiError::new(code, message)
}
