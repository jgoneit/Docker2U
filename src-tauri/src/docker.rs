//! The Rust-owned target, session and container identity boundary.
use crate::process::{self, Runner};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[path = "docker_compose.rs"]
mod compose;
#[path = "docker_details.rs"]
mod details;
#[path = "engine_reader.rs"]
mod engine_reader;
#[path = "docker_image_export.rs"]
mod image_export;
#[path = "docker_mounts.rs"]
mod mounts;
#[path = "docker_observation.rs"]
mod observation;
#[path = "docker_project_logs.rs"]
mod project_logs;
#[path = "docker_stats.rs"]
mod stats;
#[path = "docker_stream.rs"]
mod stream;
#[path = "docker_terminal.rs"]
mod terminal;
pub use compose::{
    ComposeAction, ComposeApplyPreview, ComposeOperation, ComposeOperationPreview,
    ComposeOperationRead, ComposeProject, ComposeProjectInput, ComposeProjectPreview,
    ComposeServiceSelection,
};
pub use details::ContainerDetails;
pub use image_export::{ImageExportDestination, ImageExportOperation, ImageExportPreview};
pub use mounts::MountInventory;
pub use observation::{ObservationHold, ObservationRead, ObservationScope};
pub use project_logs::{ProjectLogPage, ProjectLogQuery, StandaloneLogPage, StandaloneLogQuery};
pub use stats::StatsSnapshot;
pub use stream::{LogStreamChunk, LogStreamStarted};
pub use terminal::{TerminalDescriptor, TerminalEvent, TerminalShell, TerminalSink};

#[cfg(all(test, unix))]
#[path = "docker_live_compose_apply_test.rs"]
mod live_compose_apply_test;
#[cfg(all(test, unix))]
#[path = "docker_live_image_export_test.rs"]
mod live_image_export_test;
#[cfg(all(test, unix))]
#[path = "docker_tests.rs"]
mod tests;

const MINIMUM_MACOS_MAJOR: u32 = 14;
const INSPECT_FORMAT: &str = r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"StartedAt":{{json .State.StartedAt}},"Tty":{{json .Config.Tty}},"State":{{json .State.Status}},"HealthConfigured":{{$config := .Config}}{{if eq (printf "%T" $config) "map[string]interface {}"}}{{$health := index $config "Healthcheck"}}{{$healthType := printf "%T" $health}}{{if eq $healthType "<nil>"}}false{{else if eq $healthType "map[string]interface {}"}}{{$test := index $health "Test"}}{{$testType := printf "%T" $test}}{{if eq $testType "<nil>"}}false{{else if or (eq $testType "[]interface {}") (eq $testType "[]string")}}{{if eq (len $test) 0}}false{{else}}{{$kind := index $test 0}}{{if eq (printf "%T" $kind) "string"}}{{if or (eq $kind "CMD") (eq $kind "CMD-SHELL")}}true{{else if eq $kind "NONE"}}false{{else}}null{{end}}{{else}}null{{end}}{{end}}{{else}}null{{end}}{{else}}null{{end}}{{else}}null{{end}},"Health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"Ports":{{json (index .NetworkSettings "Ports")}},"ComposeProject":{{with index .Config.Labels "com.docker.compose.project"}}{{json .}}{{else}}null{{end}},"ComposeService":{{with index .Config.Labels "com.docker.compose.service"}}{{json .}}{{else}}null{{end}}}"#;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub command: Option<String>,
    pub stderr: Option<String>,
}
impl ApiError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            command: None,
            stderr: None,
        }
    }
}
type Result<T> = std::result::Result<T, ApiError>;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub status: String,
    pub session_id: Option<String>,
    pub context_name: Option<String>,
    pub endpoint: Option<String>,
    pub docker_path: Option<String>,
    pub docker_config_path: Option<String>,
    pub client_version: Option<String>,
    pub server_version: Option<String>,
    pub api_version: Option<String>,
    pub engine_id: Option<String>,
    pub os_type: Option<String>,
    pub architecture: Option<String>,
    pub mutation_allowed: bool,
    pub diagnostics: Vec<String>,
    pub error: Option<ApiError>,
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            status: "unavailable".into(),
            session_id: None,
            context_name: None,
            endpoint: None,
            docker_path: None,
            docker_config_path: None,
            client_version: None,
            server_version: None,
            api_version: None,
            engine_id: None,
            os_type: None,
            architecture: None,
            mutation_allowed: false,
            diagnostics: vec![],
            error: None,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub handle: String,
    pub full_id: String,
    pub short_id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub health: Option<String>,
    pub health_configured: Option<bool>,
    pub ports: Vec<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    #[serde(skip)]
    tty: bool,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
}
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerList {
    pub session_id: String,
    pub generation: u64,
    pub containers: Vec<Container>,
    pub refreshed_at: String,
    pub stale: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Logs {
    pub session_id: String,
    pub generation: u64,
    pub handle: String,
    pub text: String,
    pub truncated: bool,
    pub byte_count: usize,
    pub command: String,
    pub stderr: String,
}
#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Stop,
    Restart,
}
impl Action {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }
    fn allowed(self, state: &str) -> bool {
        match self {
            Self::Start => matches!(state, "created" | "exited"),
            _ => state == "running",
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mutation {
    pub outcome: String,
    pub message: String,
    pub command: String,
    pub stderr: String,
    pub reconciliation: String,
    pub mutation_blocked: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub observed_state: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkMutation {
    pub session_id: String,
    pub generation: u64,
    pub action: Action,
    pub items: Vec<BulkMutationItem>,
    pub mutation_blocked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkMutationItem {
    pub handle: String,
    pub full_id: String,
    pub name: String,
    pub outcome: String,
    pub message: String,
    pub result: Option<Mutation>,
    pub error: Option<ApiError>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeConfig {
    pub docker_path: Option<PathBuf>,
    pub colima_path: Option<PathBuf>,
    pub colima_home: Option<PathBuf>,
    pub lima_home: Option<PathBuf>,
    pub docker_config: Option<PathBuf>,
}
impl RuntimeConfig {
    fn load() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| ApiError::new("Configuration", "Home directory is unavailable"))?;
        let path = PathBuf::from(home)
            .join("Library/Application Support/io.github.jgoneit.docker2u/runtime.json");
        match std::fs::read(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(ApiError::new(
                "Configuration",
                format!("Cannot read native runtime configuration: {e}"),
            )),
            Ok(bytes) if bytes.len() <= 16 * 1024 => serde_json::from_slice(&bytes).map_err(|e| {
                ApiError::new(
                    "Configuration",
                    format!("Invalid native runtime configuration: {e}"),
                )
            }),
            Ok(_) => Err(ApiError::new(
                "Configuration",
                "Native runtime configuration exceeds 16 KiB",
            )),
        }
    }
    fn ignored_keys(&self) -> Vec<&'static str> {
        [
            ("colimaPath", &self.colima_path),
            ("colimaHome", &self.colima_home),
            ("limaHome", &self.lima_home),
            ("dockerConfig", &self.docker_config),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.as_ref().map(|_| key))
        .collect()
    }
}

// Only discovery receives ambient target/TLS inputs. The resolved config directory
// is shared with execution, but its currentContext can never override --host.
struct ConnectionInputs {
    docker_config: PathBuf,
    discovery_env: Vec<(String, String)>,
    execution_env: Vec<(String, String)>,
}
impl ConnectionInputs {
    fn from_env(environment: &HashMap<String, String>) -> Result<Self> {
        let config = environment
            .get("DOCKER_CONFIG")
            .filter(|value| !value.is_empty());
        let path = if let Some(config) = config {
            PathBuf::from(config)
        } else {
            let home = environment
                .get("HOME")
                .filter(|value| !value.is_empty())
                .ok_or_else(|| ApiError::new("Configuration", "Home directory is unavailable"))?;
            PathBuf::from(home).join(".docker")
        };
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|error| ApiError::new("Configuration", error.to_string()))?
                .join(path)
        };
        let docker_config = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if std::fs::symlink_metadata(&path).is_ok() {
                    return Err(ApiError::new(
                        "Configuration",
                        "Docker config directory is a broken symbolic link",
                    ));
                }
                path
            }
            Err(error) => {
                return Err(filesystem_error(
                    "Configuration",
                    "Docker config directory",
                    error,
                ));
            }
        };
        validate_docker_config(&docker_config)?;
        let execution_env = vec![(
            "DOCKER_CONFIG".into(),
            docker_config.to_string_lossy().into_owned(),
        )];
        let mut discovery_env = execution_env.clone();
        for key in [
            "DOCKER_CONTEXT",
            "DOCKER_HOST",
            "DOCKER_TLS",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
        ] {
            if let Some(value) = environment.get(key) {
                discovery_env.push((key.into(), value.clone()));
            }
        }
        Ok(Self {
            docker_config,
            discovery_env,
            execution_env,
        })
    }
}

fn filesystem_error(default: &str, subject: &str, error: std::io::Error) -> ApiError {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        "PermissionDenied"
    } else {
        default
    };
    ApiError::new(code, format!("Cannot access {subject}: {error}"))
}

fn validate_docker_config(directory: &Path) -> Result<()> {
    use std::io::Read;
    if directory.exists() && !directory.is_dir() {
        return Err(ApiError::new(
            "Configuration",
            "Docker config path is not a directory",
        ));
    }
    let path = directory.join("config.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(filesystem_error(
                "Configuration",
                "Docker config.json",
                error,
            ));
        }
        Ok(_) => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) => {
            return Err(filesystem_error(
                "Configuration",
                "Docker config.json",
                error,
            ));
        }
    };
    if !file
        .metadata()
        .map_err(|error| filesystem_error("Configuration", "Docker config.json", error))?
        .is_file()
    {
        return Err(ApiError::new(
            "Configuration",
            "Docker config.json is not a regular file",
        ));
    }
    // Never return config contents: this file can contain credentials.
    let mut bytes = Vec::new();
    file.take(process::STDOUT_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| filesystem_error("Configuration", "Docker config.json", error))?;
    if bytes.len() > process::STDOUT_LIMIT {
        return Err(ApiError::new(
            "Configuration",
            "Docker config.json exceeds the read limit",
        ));
    }
    let valid = serde_json::from_slice::<Value>(&bytes).is_ok_and(|value| value.is_object());
    if !valid {
        return Err(ApiError::new(
            "Configuration",
            "Docker config.json must contain a valid JSON object",
        ));
    }
    Ok(())
}

fn local_endpoint(endpoint: &str) -> Result<String> {
    let socket = endpoint
        .strip_prefix("unix://")
        .filter(|path| path.starts_with('/') && !path.contains('\0'))
        .ok_or_else(|| {
            ApiError::new(
                "RemoteEndpoint",
                "Only an absolute local Unix socket is supported",
            )
        })?;
    let actual = Path::new(socket)
        .canonicalize()
        .map_err(|error| filesystem_error("SocketMissing", "Docker socket", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if !actual
            .metadata()
            .map_err(|error| filesystem_error("SocketMissing", "Docker socket", error))?
            .file_type()
            .is_socket()
        {
            return Err(ApiError::new(
                "EndpointMismatch",
                "Docker endpoint is not a Unix socket",
            ));
        }
    }
    Ok(format!("unix://{}", actual.display()))
}

fn discover(name: &str, configured: &Option<PathBuf>) -> Result<PathBuf> {
    let candidates = if let Some(path) = configured {
        vec![path.clone()]
    } else {
        let mut paths: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .filter(|p| p.is_absolute())
                .map(|p| p.join(name))
                .collect();
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(&home).join(".local/bin").join(name));
            if name == "docker" {
                paths.push(PathBuf::from(home).join(".docker/bin/docker"));
            }
        }
        paths.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(|p| Path::new(p).join(name)),
        );
        if name == "docker" {
            paths.push("/Applications/Docker.app/Contents/Resources/bin/docker".into());
        }
        paths
    };
    for path in candidates {
        if !path.is_absolute() {
            continue;
        }
        if let Ok(path) = path.canonicalize() {
            if let Ok(meta) = path.metadata() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                        return Ok(path);
                    }
                }
            }
        }
    }
    Err(ApiError::new(
        "CliNotFound",
        format!(
            "{name} CLI not found. Install an independent CLI or configure its absolute path in the native runtime.json."
        ),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    id: String,
    server: String,
    api: String,
    os: String,
    arch: String,
    name: String,
}
#[derive(Clone)]
struct Target {
    docker: PathBuf,
    client_version: String,
    endpoint: String,
    env: Vec<(String, String)>,
    docker_config: PathBuf,
    fingerprint: Fingerprint,
}
impl Target {
    fn engine_args(&self, arguments: &[&str]) -> Vec<String> {
        let mut all = args(&["--host", &self.endpoint]);
        all.extend(args(arguments));
        all
    }
}
#[derive(Clone)]
struct Session {
    id: String,
    target: Target,
    generation: u64,
    handles: HashMap<String, Container>,
    stale: bool,
    needs_validation: bool,
    inventory: Option<ContainerList>,
}
#[derive(Default)]
struct State {
    session: Option<Session>,
    epoch: u64,
    closing: bool,
    refreshing: bool,
    diagnosing: bool,
    mutating: bool,
    compose_operation: Option<String>,
    stats_running: bool,
    details_running: bool,
    stream_starting: bool,
    log_stream: Option<stream::ActiveLogStream>,
}

/// Owns the global mutation reservation without holding a mutex during CLI work.
/// An interrupted worker fails closed and still releases the reservation.
struct MutationGuard {
    state: Arc<Mutex<State>>,
    session_id: String,
    needs_validation: bool,
}

impl MutationGuard {
    fn finish(mut self, needs_validation: bool) {
        self.needs_validation = needs_validation;
    }
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.mutating = false;
        if let Some(session) = state
            .session
            .as_mut()
            .filter(|session| session.id == self.session_id)
        {
            session.stale = true;
            session.needs_validation |= self.needs_validation;
        }
    }
}
#[derive(Clone, Debug)]
struct HostInfo {
    os: String,
    architecture: String,
    version: Option<String>,
}
#[derive(Clone, Default)]
pub struct Core {
    runner: Runner,
    state: Arc<Mutex<State>>,
    observation: Arc<Mutex<Option<Arc<observation::ObservationService>>>>,
    engine_reader: Arc<Mutex<Option<(String, engine_reader::EngineReader)>>>,
    project_logs: Arc<Mutex<project_logs::ProjectLogManager>>,
    compose_registry: Arc<Mutex<compose::ComposeRegistry>>,
    compose_operations: Arc<Mutex<compose::ComposeOperationManager>>,
    mount_inventory: Arc<Mutex<mounts::MountInventoryManager>>,
    image_exports: Arc<Mutex<image_export::ImageExportManager>>,
    terminals: Arc<Mutex<terminal::TerminalManager>>,
    #[cfg(test)]
    config: Option<RuntimeConfig>,
    #[cfg(test)]
    mutation_timeout: Option<Duration>,
    #[cfg(test)]
    mount_timeout: Option<Duration>,
    #[cfg(test)]
    image_export_timeout: Option<Duration>,
    #[cfg(test)]
    image_export_directory_sync: Option<Arc<dyn Fn() -> std::io::Result<()> + Send + Sync>>,
    #[cfg(test)]
    mount_output_limit: Option<usize>,
    #[cfg(test)]
    host: Option<Result<HostInfo>>,
    #[cfg(test)]
    launch_env: Option<HashMap<String, String>>,
    #[cfg(test)]
    log_registration_barrier: Option<Arc<std::sync::Barrier>>,
    #[cfg(test)]
    compose_pre_spawn_barriers: Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>,
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).into()).collect()
}
fn malformed(message: impl Into<String>) -> ApiError {
    ApiError::new("MalformedOutput", message)
}
fn compose_label(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}
fn connection_invalidated(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "EnvironmentChanged"
            | "Disconnected"
            | "SocketMissing"
            | "PermissionDenied"
            | "Configuration"
            | "EndpointMismatch"
            | "RemoteEndpoint"
            | "UnsupportedObservationEndpoint"
    )
}
fn parse_macos_version(bytes: &[u8]) -> Result<String> {
    let version = std::str::from_utf8(bytes)
        .map_err(|_| malformed("Host macOS version is not UTF-8"))?
        .trim();
    let parts: Vec<_> = version.split('.').collect();
    if !(2..=3).contains(&parts.len())
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || part.parse::<u32>().is_err()
        })
    {
        return Err(malformed("Host macOS version is missing or malformed"));
    }
    Ok(version.to_owned())
}
fn validate_host(host: &HostInfo) -> Result<()> {
    if host.os == "macos" && host.architecture == "aarch64" && host.version.is_none() {
        return Err(ApiError::new(
            "HostDetection",
            "Host macOS version could not be determined",
        ));
    }
    let major = host
        .version
        .as_deref()
        .and_then(|version| version.split('.').next())
        .and_then(|major| major.parse::<u32>().ok());
    if host.os != "macos"
        || host.architecture != "aarch64"
        || !major.is_some_and(|major| major >= MINIMUM_MACOS_MAJOR)
    {
        return Err(ApiError::new(
            "UnsupportedRuntime",
            format!(
                "Docker2U requires macOS 14 or later on ARM64; detected {} {} ({})",
                host.os,
                host.version.as_deref().unwrap_or("version unavailable"),
                host.architecture,
            ),
        ));
    }
    Ok(())
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| malformed(format!("Missing or invalid {key}")))
}
fn json_lines(bytes: &[u8]) -> Result<Vec<Value>> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| malformed("Structured output is not UTF-8"))?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).map_err(|e| malformed(format!("Invalid JSON line: {e}")))
        })
        .collect()
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn command_label(path: &Path, args: &[String]) -> String {
    std::iter::once(path.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|s| format!("'{}'", s.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Core {
    pub fn shutdown(&self) {
        // Retire authority before taking the collection slots. A configure call
        // that already cloned a session must recheck it under its slot lock, so
        // it cannot publish a new collector after shutdown has drained that slot.
        {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            state.epoch += 1;
            state.session = None;
        }
        self.cancel_observation();
        self.cancel_all_terminals();
        self.cancel_mount_reads(None);
        self.cancel_all_image_exports_and_wait();
        self.cancel_all_compose_and_wait();
        self.cancel_project_logs();
        self.cancel_log_stream();
        self.runner.shutdown();
        self.stop_observation();
        self.engine_reader.lock().unwrap().take();
    }

    fn detect_host(&self) -> Result<HostInfo> {
        #[cfg(test)]
        if let Some(host) = &self.host {
            return host.clone();
        }
        let mut host = HostInfo {
            os: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            version: None,
        };
        if host.os == "macos" && host.architecture == "aarch64" {
            let output = self
                .checked(
                    Path::new("/usr/bin/sw_vers"),
                    &args(&["-productVersion"]),
                    &[],
                    5,
                )
                .map_err(|mut error| {
                    error.message =
                        format!("Cannot determine host macOS version: {}", error.message);
                    error
                })?;
            host.version = Some(parse_macos_version(&output)?);
        }
        Ok(host)
    }

    fn checked_output(
        &self,
        path: &Path,
        arguments: &[String],
        env: &[(String, String)],
        timeout: u64,
    ) -> Result<process::Output> {
        let command = command_label(path, arguments);
        let out = self
            .runner
            .run(path, arguments, env, Duration::from_secs(timeout), false)
            .map_err(|error| ApiError {
                code: "StartFailed".into(),
                message: error,
                command: Some(command.clone()),
                stderr: None,
            })?;
        let stderr = process::plain_text(&out.stderr, process::STDERR_LIMIT);
        let code = if out.interrupted || out.code.is_none() {
            Some("TimedOut")
        } else if out.truncated {
            Some("OutputLimitExceeded")
        } else if out.code != Some(0) {
            Some(
                if stderr.to_ascii_lowercase().contains("permission denied") {
                    "PermissionDenied"
                } else {
                    "CommandFailed"
                },
            )
        } else {
            None
        };
        if let Some(code) = code {
            return Err(ApiError {
                code: code.into(),
                message: format!("Command could not complete ({code})"),
                command: Some(command),
                stderr: Some(stderr),
            });
        }
        Ok(out)
    }
    fn checked(
        &self,
        path: &Path,
        arguments: &[String],
        env: &[(String, String)],
        timeout: u64,
    ) -> Result<Vec<u8>> {
        self.checked_output(path, arguments, env, timeout)
            .map(|output| output.stdout)
    }
    fn docker(&self, target: &Target, arguments: &[&str], timeout: u64) -> Result<Vec<u8>> {
        self.checked(
            &target.docker,
            &target.engine_args(arguments),
            &target.env,
            timeout,
        )
    }
    fn client_version(&self, docker: &Path, env: &[(String, String)]) -> Result<String> {
        let data = self.checked(docker, &args(&["--version"]), env, 5)?;
        let version = std::str::from_utf8(&data)
            .map_err(|_| malformed("Docker version is not UTF-8"))?
            .trim()
            .strip_prefix("Docker version ")
            .and_then(|value| value.split(',').next())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| malformed("Not a Docker CLI version response"))?;
        Ok(version.to_owned())
    }
    fn selected_context(
        &self,
        docker: &Path,
        env: &[(String, String)],
    ) -> Result<(String, String)> {
        let arguments = args(&["context", "inspect"]);
        let output = self
            .checked_output(docker, &arguments, env, 10)
            .map_err(|mut error| {
                if error.code == "CommandFailed" {
                    error.code = "ContextSelection".into();
                }
                error
            })?;
        // The CLI can print a configuration warning and silently use defaults with
        // exit zero. Do not accept that as an unambiguous target selection.
        if !output.stderr.is_empty() {
            return Err(ApiError { code: "ContextSelection".into(), message: "Docker CLI reported a warning while selecting the connection; resolve it before reconnecting".into(), command: Some(command_label(docker, &arguments)), stderr: Some(process::plain_text(&output.stderr, process::STDERR_LIMIT)) });
        }
        let contexts: Vec<Value> = serde_json::from_slice(&output.stdout)
            .map_err(|_| malformed("Invalid context inspect JSON"))?;
        if contexts.len() != 1 {
            return Err(malformed("Expected exactly one current Docker context"));
        }
        let name = required(&contexts[0], "Name")?.to_owned();
        let endpoint = contexts[0]
            .pointer("/Endpoints/docker/Host")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| malformed("Context has no Docker endpoint"))?;
        Ok((name, endpoint.to_owned()))
    }
    fn fingerprint(&self, target: &Target) -> Result<Fingerprint> {
        let info: Value = serde_json::from_slice(&self.docker(
            target,
            &["info", "--format", "{{json .}}"],
            10,
        )?)
        .map_err(|e| malformed(e.to_string()))?;
        let version: Value = serde_json::from_slice(&self.docker(
            target,
            &["version", "--format", "{{json .}}"],
            10,
        )?)
        .map_err(|e| malformed(e.to_string()))?;
        let server = version
            .get("Server")
            .ok_or_else(|| malformed("Missing Docker Server version"))?;
        let api = required(server, "ApiVersion")?;
        let parts: Vec<_> = api.split('.').collect();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part.bytes().all(|byte| byte.is_ascii_digit())
                    || part.parse::<u32>().is_err()
            })
        {
            return Err(malformed("Invalid Docker Server API version"));
        }
        Ok(Fingerprint {
            id: required(&info, "ID")?.into(),
            server: required(server, "Version")?.into(),
            api: api.into(),
            os: required(&info, "OSType")?.into(),
            arch: required(&info, "Architecture")?.into(),
            name: required(&info, "Name")?.into(),
        })
    }
    fn verify(&self, target: &Target) -> Result<()> {
        validate_docker_config(&target.docker_config)?;
        if local_endpoint(&target.endpoint)? != target.endpoint
            || self.client_version(&target.docker, &target.env)? != target.client_version
            || self.fingerprint(target)? != target.fingerprint
        {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "CLI or Engine identity changed. Reconnect before another operation.",
            ));
        }
        Ok(())
    }

    pub fn get_environment(&self) -> Result<Environment> {
        let epoch = {
            let mut state = self.state.lock().unwrap();
            if state.closing {
                return Err(ApiError::new(
                    "StaleSession",
                    "The application is shutting down",
                ));
            }
            if state.mutating || state.diagnosing || state.refreshing {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            state.epoch += 1;
            state.session = None;
            state.diagnosing = true;
            state.epoch
        };
        // Reserve reconnection before retiring workers so a Busy result cannot
        // stop a still-current background observer or race a new mutation.
        self.cancel_all_terminals();
        self.cancel_mount_reads(None);
        self.cancel_all_image_exports_and_wait();
        self.cancel_all_compose_and_wait();
        self.stop_observation();
        self.cancel_project_logs();
        self.engine_reader.lock().unwrap().take();
        self.cancel_log_stream();
        let mut result = Environment::default();
        let target = self.diagnose(&mut result).and_then(|target| {
            let terminal_target = terminal::ExecTarget::new(&target)?;
            Ok((target, terminal_target))
        });
        let mut state = self.state.lock().unwrap();
        state.diagnosing = false;
        if state.epoch != epoch {
            return Err(ApiError::new(
                "StaleSession",
                "Environment check was superseded",
            ));
        }
        match target {
            Ok((target, terminal_target)) => {
                let id = uuid::Uuid::new_v4().to_string();
                self.terminals.lock().unwrap().bind(&id, terminal_target);
                result.session_id = Some(id.clone());
                result.status = "ready".into();
                result.mutation_allowed = true;
                state.session = Some(Session {
                    id,
                    target,
                    generation: 0,
                    handles: HashMap::new(),
                    stale: true,
                    needs_validation: false,
                    inventory: None,
                });
            }
            Err(error) => {
                if matches!(
                    error.code.as_str(),
                    "UnsupportedRuntime" | "RemoteEndpoint" | "EndpointMismatch"
                ) {
                    result.status = "unsupported".into();
                }
                result.error = Some(error);
            }
        }
        Ok(result)
    }
    fn connection_environment(&self) -> Result<HashMap<String, String>> {
        #[cfg(test)]
        if let Some(environment) = &self.launch_env {
            return Ok(environment.clone());
        }
        let mut environment = HashMap::new();
        for key in [
            "HOME",
            "DOCKER_CONFIG",
            "DOCKER_CONTEXT",
            "DOCKER_HOST",
            "DOCKER_TLS",
            "DOCKER_TLS_VERIFY",
            "DOCKER_CERT_PATH",
        ] {
            match std::env::var(key) {
                Ok(value) => {
                    environment.insert(key.into(), value);
                }
                Err(std::env::VarError::NotPresent) => {}
                Err(_) => {
                    return Err(ApiError::new(
                        "Configuration",
                        format!("{key} is not valid UTF-8"),
                    ));
                }
            }
        }
        Ok(environment)
    }
    fn diagnose(&self, result: &mut Environment) -> Result<Target> {
        validate_host(&self.detect_host()?)?;
        #[cfg(test)]
        let config = self
            .config
            .clone()
            .map(Ok)
            .unwrap_or_else(RuntimeConfig::load)?;
        #[cfg(not(test))]
        let config = RuntimeConfig::load()?;
        let ignored = config.ignored_keys();
        if !ignored.is_empty() {
            result.diagnostics.push(format!("Legacy runtime.json settings are ignored: {}. Docker CLI settings now select the connection; no settings files were changed.", ignored.join(", ")));
        }
        let docker = discover("docker", &config.docker_path)?;
        result.docker_path = Some(docker.display().to_string());
        let inputs = ConnectionInputs::from_env(&self.connection_environment()?)?;
        result.docker_config_path = Some(inputs.docker_config.display().to_string());
        let client_version = self.client_version(&docker, &inputs.execution_env)?;
        result.client_version = Some(client_version.clone());
        let (context_name, endpoint) = self.selected_context(&docker, &inputs.discovery_env)?;
        result.context_name = Some(context_name);
        result.endpoint = Some(endpoint.clone());
        let endpoint = local_endpoint(&endpoint)?;
        result.endpoint = Some(endpoint.clone());
        let mut target = Target {
            docker,
            client_version,
            endpoint,
            env: inputs.execution_env,
            docker_config: inputs.docker_config,
            fingerprint: Fingerprint {
                id: String::new(),
                server: String::new(),
                api: String::new(),
                os: String::new(),
                arch: String::new(),
                name: String::new(),
            },
        };
        let fingerprint = self.fingerprint(&target)?;
        result.server_version = Some(fingerprint.server.clone());
        result.api_version = Some(fingerprint.api.clone());
        result.engine_id = Some(fingerprint.id.clone());
        result.os_type = Some(fingerprint.os.clone());
        result.architecture = Some(fingerprint.arch.clone());
        if fingerprint.os != "linux" {
            return Err(ApiError::new(
                "UnsupportedRuntime",
                "This release supports local Linux Docker Engines",
            ));
        }
        target.fingerprint = fingerprint;
        Ok(target)
    }
    fn active(&self, id: &str) -> Result<Session> {
        self.state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| ApiError::new("StaleSession", "Reconnect and refresh this environment"))
    }
    fn inspect(&self, target: &Target, ids: &[String]) -> Result<Vec<Container>> {
        let mut containers = Vec::new();
        let mut seen = HashSet::new();
        for chunk in ids.chunks(100) {
            let mut arguments = vec!["container", "inspect", "--format", INSPECT_FORMAT];
            arguments.extend(chunk.iter().map(String::as_str));
            let rows = json_lines(&self.docker(target, &arguments, 15)?)?;
            if rows.len() != chunk.len() {
                return Err(malformed(
                    "Inspect row count does not match the requested IDs",
                ));
            }
            for row in rows {
                let id = required(&row, "Id")?;
                if !valid_id(id)
                    || !chunk.iter().any(|wanted| wanted == id)
                    || !seen.insert(id.to_owned())
                {
                    return Err(malformed(
                        "Inspect returned an unexpected or duplicate full ID",
                    ));
                }
                let state = required(&row, "State")?;
                let state = if matches!(
                    state,
                    "created"
                        | "running"
                        | "paused"
                        | "restarting"
                        | "removing"
                        | "exited"
                        | "dead"
                ) {
                    state
                } else {
                    "unknown"
                };
                let health = match row.get("Health") {
                    Some(Value::Null) => "none",
                    Some(Value::String(s))
                        if matches!(s.as_str(), "starting" | "healthy" | "unhealthy") =>
                    {
                        s
                    }
                    Some(Value::String(_)) => "unknown",
                    _ => return Err(malformed("Invalid Health field")),
                };
                let mut ports = Vec::new();
                match row.get("Ports") {
                    Some(Value::Object(map)) => {
                        for (port, bindings) in map {
                            if bindings.is_null() {
                                ports.push(port.clone());
                                continue;
                            }
                            let bindings = bindings
                                .as_array()
                                .ok_or_else(|| malformed("Invalid port bindings"))?;
                            for binding in bindings {
                                ports.push(format!(
                                    "{}:{} → {}",
                                    required(binding, "HostIp")?,
                                    required(binding, "HostPort")?,
                                    port
                                ));
                            }
                        }
                    }
                    Some(Value::Null) => {}
                    _ => return Err(malformed("Invalid Ports field")),
                }
                ports.sort();
                let created = required(&row, "Created")?;
                chrono::DateTime::parse_from_rfc3339(created)
                    .map_err(|_| malformed("Invalid creation timestamp"))?;
                containers.push(Container {
                    handle: uuid::Uuid::new_v4().to_string(),
                    full_id: id.into(),
                    short_id: id[..12].into(),
                    name: required(&row, "Name")?.trim_start_matches('/').into(),
                    image: required(&row, "Image")?.into(),
                    state: state.into(),
                    health: Some(health.into()),
                    health_configured: row.get("HealthConfigured").and_then(Value::as_bool),
                    ports,
                    created_at: created.into(),
                    started_at: row
                        .get("StartedAt")
                        .and_then(Value::as_str)
                        .filter(|value| {
                            chrono::DateTime::parse_from_rfc3339(value)
                                .is_ok_and(|value| value.timestamp() > -62_135_596_800)
                        })
                        .map(str::to_owned),
                    tty: row.get("Tty").and_then(Value::as_bool).unwrap_or(false),
                    compose_project: compose_label(&row, "ComposeProject"),
                    compose_service: compose_label(&row, "ComposeService"),
                });
            }
        }
        containers.sort_by(|a, b| a.name.cmp(&b.name).then(a.full_id.cmp(&b.full_id)));
        Ok(containers)
    }

    pub fn list_containers(&self, id: &str) -> Result<ContainerList> {
        let service = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned();
        if let Some(service) = service {
            return service.refresh(self);
        }
        self.fetch_inventory(id)
    }

    fn fetch_inventory(&self, id: &str) -> Result<ContainerList> {
        self.fetch_inventory_inner(id, false)
    }

    fn fetch_observed_inventory(&self, id: &str) -> Result<ContainerList> {
        self.fetch_inventory_inner(id, true)
    }

    fn fetch_inventory_inner(&self, id: &str, wait_readers: bool) -> Result<ContainerList> {
        let session = {
            let mut state = self.state.lock().unwrap();
            if state.refreshing
                || state.diagnosing
                || state.mutating
                || (wait_readers
                    && (state.stats_running || state.details_running || state.stream_starting))
            {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            let session = state
                .session
                .as_ref()
                .filter(|s| s.id == id)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before refreshing"))?;
            state.refreshing = true;
            session
        };
        let fetched = (|| {
            self.verify(&session.target)?;
            let rows = json_lines(&self.docker(
                &session.target,
                &[
                    "container",
                    "ls",
                    "--all",
                    "--no-trunc",
                    "--format",
                    "{{json .}}",
                ],
                15,
            )?)?;
            let mut ids = Vec::new();
            let mut unique = HashSet::new();
            for row in rows {
                let id = required(&row, "ID")?;
                if !valid_id(id) || !unique.insert(id.to_owned()) {
                    return Err(malformed("Invalid or duplicate container ID"));
                }
                ids.push(id.to_owned());
            }
            self.inspect(&session.target, &ids)
        })();
        let mut state = self.state.lock().unwrap();
        state.refreshing = false;
        let active = state
            .session
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or_else(|| {
                ApiError::new("StaleSession", "Refresh belongs to a previous environment")
            })?;
        let result = match fetched {
            Ok(containers) => {
                active.generation += 1;
                active.stale = false;
                active.handles = containers
                    .iter()
                    .map(|c| (c.handle.clone(), c.clone()))
                    .collect();
                let snapshot = ContainerList {
                    session_id: id.into(),
                    generation: active.generation,
                    containers,
                    refreshed_at: chrono::Utc::now().to_rfc3339(),
                    stale: false,
                };
                active.inventory = Some(snapshot.clone());
                Ok(snapshot)
            }
            Err(error) => {
                active.stale = true;
                if connection_invalidated(&error) {
                    active.needs_validation = true;
                }
                Err(error)
            }
        };
        drop(state);
        if let Ok(snapshot) = &result {
            self.reconcile_terminals(snapshot);
            self.sync_project_log_inventory(snapshot);
        } else if let Err(error) = &result {
            self.invalidate_observation(id, error);
        }
        self.reconcile_log_stream();
        result
    }
    pub fn get_recent_logs(&self, id: &str, handle: &str) -> Result<Logs> {
        let session = self.active(id)?;
        let container = session.handles.get(handle).ok_or_else(|| {
            ApiError::new("StaleHandle", "Select the container from the latest list")
        })?;
        if matches!(container.state.as_str(), "unknown" | "removing") {
            return Err(ApiError::new(
                "ActionUnavailable",
                "Logs are unavailable for this state",
            ));
        }
        if let Err(error) = self.verify(&session.target) {
            self.invalidate_observation(id, &error);
            return Err(error);
        }
        let arguments = session.target.engine_args(&[
            "container",
            "logs",
            "--tail",
            "300",
            "--timestamps",
            &container.full_id,
        ]);
        let command = command_label(&session.target.docker, &arguments);
        let out = self
            .runner
            .run(
                &session.target.docker,
                &arguments,
                &session.target.env,
                Duration::from_secs(15),
                true,
            )
            .map_err(|e| ApiError::new("StartFailed", e))?;
        let active = self.active(id)?;
        if active.generation != session.generation || !active.handles.contains_key(handle) {
            return Err(ApiError::new(
                "StaleHandle",
                "Log response belongs to an older list",
            ));
        }
        if out.code != Some(0) || out.interrupted {
            return Err(ApiError {
                code: if out.interrupted {
                    "TimedOut"
                } else {
                    "CommandFailed"
                }
                .into(),
                message: "Recent logs could not be read".into(),
                command: Some(command),
                stderr: Some(process::plain_text(&out.stderr, process::STDERR_LIMIT)),
            });
        }
        let text = process::plain_text(&out.logs, process::LOG_LIMIT);
        let truncated =
            out.truncated || String::from_utf8_lossy(&out.logs).len() > process::LOG_LIMIT;
        Ok(Logs {
            session_id: id.into(),
            generation: session.generation,
            handle: handle.into(),
            byte_count: text.len(),
            text,
            truncated,
            command,
            stderr: String::new(),
        })
    }
    pub fn mutate_container(&self, id: &str, handle: &str, action: Action) -> Result<Mutation> {
        let (session, container, reservation) = {
            let mut state = self.state.lock().unwrap();
            if state.refreshing
                || state.diagnosing
                || state.mutating
                || state.compose_operation.is_some()
            {
                return Err(ApiError::new(
                    "Busy",
                    "Wait for the current environment operation",
                ));
            }
            let session = state
                .session
                .as_ref()
                .filter(|s| s.id == id)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before recovery"))?;
            if session.stale || session.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before recovery",
                ));
            }
            let container = session.handles.get(handle).cloned().ok_or_else(|| {
                ApiError::new("StaleHandle", "Select a container from the latest list")
            })?;
            if !action.allowed(&container.state) {
                return Err(ApiError::new(
                    "ActionUnavailable",
                    "This action is unavailable for the current state",
                ));
            }
            let reservation = MutationGuard {
                state: self.state.clone(),
                session_id: id.into(),
                needs_validation: true,
            };
            state.mutating = true;
            (session, container, reservation)
        };
        let result = self.perform_mutation(&session, &container, action);
        reservation.finish(match &result {
            Ok(result) => result.mutation_blocked,
            Err(_) => true,
        });
        self.reconcile_log_stream();
        result
    }

    pub fn mutate_containers(
        &self,
        id: &str,
        generation: u64,
        handles: &[String],
        action: Action,
    ) -> Result<BulkMutation> {
        let (session, containers, reservation) = {
            let mut state = self.state.lock().unwrap();
            if state.refreshing
                || state.diagnosing
                || state.mutating
                || state.compose_operation.is_some()
            {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            let session = state
                .session
                .as_ref()
                .filter(|session| session.id == id)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before recovery"))?;
            if session.stale || session.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before recovery",
                ));
            }
            if session.generation != generation {
                return Err(ApiError::new("StaleHandle", "Select from the latest list"));
            }
            if handles.is_empty() || handles.len() > session.handles.len() {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Select containers from the current list",
                ));
            }
            let mut seen = HashSet::new();
            let mut containers = Vec::with_capacity(handles.len());
            // Validate the complete request before reserving or dispatching any action.
            // Request order is the visible list order frozen by the selection UI.
            for handle in handles {
                if !seen.insert(handle) {
                    return Err(ApiError::new(
                        "InvalidSelection",
                        "A container was selected more than once",
                    ));
                }
                let container = session.handles.get(handle).cloned().ok_or_else(|| {
                    ApiError::new("StaleHandle", "Select containers from the latest list")
                })?;
                containers.push(container);
            }
            let reservation = MutationGuard {
                state: self.state.clone(),
                session_id: id.into(),
                needs_validation: true,
            };
            state.mutating = true;
            (session, containers, reservation)
        };

        let mut items = Vec::with_capacity(containers.len());
        let mut aborted = false;
        let mut mutation_blocked = false;
        for container in containers {
            let mut item = BulkMutationItem {
                handle: container.handle.clone(),
                full_id: container.full_id.clone(),
                name: container.name.clone(),
                outcome: "notExecuted".into(),
                message: "Not executed because an earlier operation requires review.".into(),
                result: None,
                error: None,
            };
            // Eligibility belongs to the accepted list, even if runtime state later changes.
            if !action.allowed(&container.state) {
                item.outcome = "skipped".into();
                item.message = "This action was unavailable in the selected list state.".into();
            } else if !aborted {
                match self.perform_mutation(&session, &container, action) {
                    Ok(result) => {
                        aborted = result.outcome == "resultUnknown" || result.mutation_blocked;
                        mutation_blocked |= result.mutation_blocked;
                        item.outcome = result.outcome.clone();
                        item.message = result.message.clone();
                        item.result = Some(result);
                    }
                    Err(error) => {
                        item.message = error.message.clone();
                        if error.code == "StateChanged" {
                            item.outcome = "skipped".into();
                        } else {
                            aborted = true;
                            mutation_blocked = true;
                        }
                        item.error = Some(error);
                    }
                }
            }
            items.push(item);
        }
        reservation.finish(mutation_blocked);
        self.reconcile_log_stream();
        Ok(BulkMutation {
            session_id: id.into(),
            generation,
            action,
            items,
            mutation_blocked,
        })
    }

    fn perform_mutation(
        &self,
        session: &Session,
        container: &Container,
        action: Action,
    ) -> Result<Mutation> {
        self.verify(&session.target)?;
        let current = self.inspect(&session.target, std::slice::from_ref(&container.full_id))?;
        if !action.allowed(&current[0].state) {
            return Err(ApiError::new(
                "StateChanged",
                "Container state changed. Refresh before recovery.",
            ));
        }
        // Re-check state immediately before spawn, after all external validation.
        let active = self.active(&session.id)?;
        if active.generation != session.generation
            || active.needs_validation
            || active.stale
            || !active.handles.contains_key(&container.handle)
        {
            return Err(ApiError::new(
                "StaleHandle",
                "Recovery target was superseded",
            ));
        }
        let arguments =
            session
                .target
                .engine_args(&["container", action.name(), &container.full_id]);
        self.disconnect_terminal_targets(&session.id, std::slice::from_ref(&container.full_id));
        let command = command_label(&session.target.docker, &arguments);
        #[cfg(test)]
        let timeout = self.mutation_timeout.unwrap_or(Duration::from_secs(30));
        #[cfg(not(test))]
        let timeout = Duration::from_secs(30);
        let output = self
            .runner
            .run(
                &session.target.docker,
                &arguments,
                &session.target.env,
                timeout,
                false,
            )
            .map_err(|e| ApiError::new("StartFailed", e))?;
        let stderr = process::plain_text(&output.stderr, process::STDERR_LIMIT);
        // A transport failure may happen after the daemon accepted the operation.
        let uncertain = output.interrupted
            || output.code.is_none()
            || output.truncated
            || (output.code != Some(0) && !stderr.contains("Error response from daemon:"));
        let outcome = if uncertain {
            "resultUnknown"
        } else if output.code == Some(0) {
            "succeeded"
        } else {
            "failed"
        };
        // Validate the same endpoint/fingerprint before exact-ID reconciliation.
        let reconciliation = self
            .verify(&session.target)
            .and_then(|_| self.inspect(&session.target, std::slice::from_ref(&container.full_id)));
        let observed_state = reconciliation
            .as_ref()
            .ok()
            .and_then(|rows| rows.first())
            .map(|c| c.state.clone());
        let mutation_blocked = reconciliation.is_err();
        Ok(Mutation { outcome:outcome.into(), message:match outcome { "succeeded"=>"Command completed; current state was queried again.", "failed"=>"The Engine returned an error; inspect the current state.", _=>"The command result is unknown. It was not retried; current state is reported separately." }.into(), command, stderr, reconciliation:if mutation_blocked {"failed"} else {"succeeded"}.into(), mutation_blocked, exit_code:output.code, duration_ms:output.duration_ms, observed_state })
    }
}
