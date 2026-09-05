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

#[cfg(all(test, unix))]
#[path = "docker_tests.rs"]
mod tests;

const CONTEXT: &str = "colima-docker2u";
const APPROVED_MACOS_VERSION: &str = "26.5.2";
const INSPECT_FORMAT: &str = r#"{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"State":{{json .State.Status}},"Health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},"Ports":{{json (index .NetworkSettings "Ports")}}}"#;

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
    pub profile: String,
    pub endpoint: Option<String>,
    pub docker_path: Option<String>,
    pub colima_path: Option<String>,
    pub client_version: Option<String>,
    pub runtime_version: Option<String>,
    pub server_version: Option<String>,
    pub api_version: Option<String>,
    pub engine_id: Option<String>,
    pub os_type: Option<String>,
    pub architecture: Option<String>,
    pub mutation_allowed: bool,
    pub diagnostics: Vec<String>,
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            status: "unavailable".into(),
            session_id: None,
            profile: CONTEXT.into(),
            endpoint: None,
            docker_path: None,
            colima_path: None,
            client_version: None,
            runtime_version: None,
            server_version: None,
            api_version: None,
            engine_id: None,
            os_type: None,
            architecture: None,
            mutation_allowed: false,
            diagnostics: vec![],
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
    pub ports: Vec<String>,
    pub created_at: String,
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
#[derive(Debug, Deserialize, Clone, Copy)]
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
    fn env(&self) -> Result<Vec<(String, String)>> {
        let mut env = vec![];
        for (name, value) in [
            ("COLIMA_HOME", &self.colima_home),
            ("LIMA_HOME", &self.lima_home),
            ("DOCKER_CONFIG", &self.docker_config),
        ] {
            if let Some(path) = value {
                if !path.is_absolute() || !path.is_dir() {
                    return Err(ApiError::new(
                        "Configuration",
                        format!("{name} must be an existing absolute directory"),
                    ));
                }
                env.push((name.into(), path.to_string_lossy().into_owned()));
            }
        }
        let mut paths = self
            .colima_path
            .as_ref()
            .and_then(|p| p.parent())
            .map(|p| vec![p.to_path_buf()])
            .unwrap_or_default();
        paths.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .map(PathBuf::from),
        );
        env.push((
            "PATH".into(),
            std::env::join_paths(paths)
                .map_err(|e| ApiError::new("Configuration", e.to_string()))?
                .to_string_lossy()
                .into_owned(),
        ));
        Ok(env)
    }
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
            paths.push(PathBuf::from(home).join(".local/bin").join(name));
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
        "CliMissing",
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
    colima: PathBuf,
    endpoint: String,
    env: Vec<(String, String)>,
    config: RuntimeConfig,
    fingerprint: Fingerprint,
}
#[derive(Clone)]
struct Session {
    id: String,
    target: Target,
    generation: u64,
    handles: HashMap<String, Container>,
    stale: bool,
    needs_validation: bool,
}
#[derive(Default)]
struct State {
    session: Option<Session>,
    epoch: u64,
    refreshing: bool,
    diagnosing: bool,
    mutations: HashSet<String>,
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
    #[cfg(test)]
    config: Option<RuntimeConfig>,
    #[cfg(test)]
    mutation_timeout: Option<Duration>,
    #[cfg(test)]
    host: Option<Result<HostInfo>>,
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).into()).collect()
}
fn malformed(message: impl Into<String>) -> ApiError {
    ApiError::new("MalformedOutput", message)
}
fn parse_macos_version(bytes: &[u8]) -> Result<String> {
    let version = std::str::from_utf8(bytes)
        .map_err(|_| malformed("Host macOS version is not UTF-8"))?
        .trim();
    let parts: Vec<_> = version.split('.').collect();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
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
    if host.os != "macos"
        || host.architecture != "aarch64"
        || host.version.as_deref() != Some(APPROVED_MACOS_VERSION)
    {
        return Err(ApiError::new(
            "UnsupportedRuntime",
            format!(
                "This local alpha requires macOS {APPROVED_MACOS_VERSION} on ARM64; detected {} {} ({})",
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
        self.runner.shutdown();
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

    fn checked(
        &self,
        path: &Path,
        arguments: &[String],
        env: &[(String, String)],
        timeout: u64,
    ) -> Result<Vec<u8>> {
        let command = command_label(path, arguments);
        let out = self
            .runner
            .run(path, arguments, env, Duration::from_secs(timeout), false)
            .map_err(|e| ApiError {
                code: "StartFailed".into(),
                message: e,
                command: Some(command.clone()),
                stderr: None,
            })?;
        let code = if out.interrupted || out.code.is_none() {
            Some("TimedOut")
        } else if out.truncated {
            Some("OutputLimitExceeded")
        } else if out.code != Some(0) {
            Some("CommandFailed")
        } else {
            None
        };
        if let Some(code) = code {
            return Err(ApiError {
                code: code.into(),
                message: format!("Command could not complete ({code})"),
                command: Some(command),
                stderr: Some(process::plain_text(&out.stderr, process::STDERR_LIMIT)),
            });
        }
        Ok(out.stdout)
    }
    fn docker(&self, target: &Target, arguments: &[&str], timeout: u64) -> Result<Vec<u8>> {
        let mut all = args(&["--host", &target.endpoint]);
        all.extend(args(arguments));
        self.checked(&target.docker, &all, &target.env, timeout)
    }
    fn runtime_endpoint(
        &self,
        docker: &Path,
        colima: &Path,
        config: &RuntimeConfig,
        env: &[(String, String)],
    ) -> Result<String> {
        let data = self.checked(colima, &args(&["status", "docker2u", "--json"]), env, 10)?;
        let status: Value =
            serde_json::from_slice(&data).map_err(|e| malformed(format!("Colima status: {e}")))?;
        if !required(&status, "runtime")?.eq_ignore_ascii_case("docker") {
            return Err(ApiError::new(
                "UnsupportedRuntime",
                "The docker2u Colima profile must use Docker",
            ));
        }
        let arch = required(&status, "arch")?;
        if !matches!(arch, "aarch64" | "arm64") {
            return Err(ApiError::new(
                "UnsupportedRuntime",
                "This local alpha requires an ARM64 Colima profile",
            ));
        }
        if required(&status, "driver")? != "macOS Virtualization.Framework"
            || status.get("cpu").and_then(Value::as_u64) != Some(2)
            || status.get("memory").and_then(Value::as_u64) != Some(4 * 1024 * 1024 * 1024)
        {
            return Err(ApiError::new(
                "UnsupportedRuntime",
                "This local alpha requires the VZ Colima profile with 2 CPUs and 4 GiB memory",
            ));
        }
        let data = self.checked(docker, &args(&["context", "inspect", CONTEXT]), env, 10)?;
        let contexts: Vec<Value> = serde_json::from_slice(&data)
            .map_err(|e| malformed(format!("Context inspect: {e}")))?;
        if contexts.len() != 1 || required(&contexts[0], "Name")? != CONTEXT {
            return Err(malformed("Expected exactly the colima-docker2u context"));
        }
        let endpoint = contexts[0]
            .pointer("/Endpoints/docker/Host")
            .and_then(Value::as_str)
            .ok_or_else(|| malformed("Context has no Docker endpoint"))?;
        let socket = endpoint
            .strip_prefix("unix://")
            .filter(|s| s.starts_with('/') && !s.contains('\0'))
            .ok_or_else(|| {
                ApiError::new(
                    "RemoteEndpoint",
                    "Only the development profile's local Unix socket is allowed",
                )
            })?;
        let base = config
            .colima_home
            .clone()
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".colima")))
            .ok_or_else(|| ApiError::new("Configuration", "Home directory unavailable"))?;
        let expected = base
            .join("docker2u/docker.sock")
            .canonicalize()
            .map_err(|e| {
                ApiError::new(
                    "Disconnected",
                    format!("Development profile socket unavailable: {e}"),
                )
            })?;
        let actual = Path::new(socket).canonicalize().map_err(|e| {
            ApiError::new("Disconnected", format!("Context socket unavailable: {e}"))
        })?;
        if expected != actual {
            return Err(ApiError::new(
                "EndpointMismatch",
                "Context does not point to the docker2u profile socket",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            if !actual
                .metadata()
                .map_err(|e| ApiError::new("Disconnected", e.to_string()))?
                .file_type()
                .is_socket()
            {
                return Err(ApiError::new(
                    "EndpointMismatch",
                    "The profile endpoint is not a Unix socket",
                ));
            }
        }
        let reported = required(&status, "docker_socket")?
            .strip_prefix("unix://")
            .ok_or_else(|| {
                ApiError::new(
                    "EndpointMismatch",
                    "Colima did not report a local Docker socket",
                )
            })?;
        if Path::new(reported).canonicalize().ok().as_ref() != Some(&actual) {
            return Err(ApiError::new(
                "EndpointMismatch",
                "Colima status and context sockets differ",
            ));
        }
        Ok(format!("unix://{}", actual.display()))
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
        Ok(Fingerprint {
            id: required(&info, "ID")?.into(),
            server: required(server, "Version")?.into(),
            api: required(server, "ApiVersion")?.into(),
            os: required(&info, "OSType")?.into(),
            arch: required(&info, "Architecture")?.into(),
            name: required(&info, "Name")?.into(),
        })
    }
    fn verify(&self, target: &Target) -> Result<()> {
        let client = self.checked(&target.docker, &args(&["--version"]), &target.env, 5)?;
        let runtime = self.checked(&target.colima, &args(&["version"]), &target.env, 5)?;
        if !String::from_utf8_lossy(&client).starts_with("Docker version 29.8.0,")
            || !String::from_utf8_lossy(&runtime)
                .lines()
                .any(|line| line.trim() == "colima version v0.10.3")
        {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "CLI or Colima version changed. Reconnect before another operation.",
            ));
        }
        let endpoint =
            self.runtime_endpoint(&target.docker, &target.colima, &target.config, &target.env)?;
        if endpoint != target.endpoint || self.fingerprint(target)? != target.fingerprint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "Runtime identity changed. Reconnect before another operation.",
            ));
        }
        Ok(())
    }

    pub fn get_environment(&self) -> Result<Environment> {
        let epoch = {
            let mut state = self.state.lock().unwrap();
            if !state.mutations.is_empty() || state.diagnosing || state.refreshing {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            state.epoch += 1;
            state.session = None;
            state.diagnosing = true;
            state.epoch
        };
        let mut result = Environment::default();
        let target = self.diagnose(&mut result);
        let mut state = self.state.lock().unwrap();
        state.diagnosing = false;
        if state.epoch != epoch {
            return Err(ApiError::new(
                "StaleSession",
                "Environment check was superseded",
            ));
        }
        match target {
            Ok(target) => {
                let id = uuid::Uuid::new_v4().to_string();
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
                });
            }
            Err(error) => {
                if matches!(
                    error.code.as_str(),
                    "UnsupportedRuntime" | "RemoteEndpoint" | "EndpointMismatch"
                ) {
                    result.status = "unsupported".into();
                }
                result.diagnostics.push(error.message);
                if let Some(stderr) = error.stderr.filter(|s| !s.is_empty()) {
                    result.diagnostics.push(stderr);
                }
            }
        }
        Ok(result)
    }
    fn diagnose(&self, result: &mut Environment) -> Result<Target> {
        #[cfg(test)]
        let config = self
            .config
            .clone()
            .map(Ok)
            .unwrap_or_else(RuntimeConfig::load)?;
        #[cfg(not(test))]
        let config = RuntimeConfig::load()?;
        let docker = discover("docker", &config.docker_path)?;
        result.docker_path = Some(docker.display().to_string());
        let env = config.env()?;
        let client = self.checked(&docker, &args(&["--version"]), &env, 5)?;
        let client = std::str::from_utf8(&client)
            .map_err(|_| malformed("Docker version is not UTF-8"))?
            .trim();
        let client_version = client
            .strip_prefix("Docker version ")
            .and_then(|s| s.split(',').next())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| malformed("Not a Docker CLI version response"))?
            .to_owned();
        result.client_version = Some(client_version.clone());
        let colima = discover("colima", &config.colima_path)?;
        result.colima_path = Some(colima.display().to_string());
        let runtime = self.checked(&colima, &args(&["version"]), &env, 5)?;
        let runtime =
            std::str::from_utf8(&runtime).map_err(|_| malformed("Colima version is not UTF-8"))?;
        let runtime_version = runtime
            .lines()
            .find_map(|s| s.strip_prefix("colima version "))
            .ok_or_else(|| malformed("Not a Colima version response"))?
            .trim()
            .trim_start_matches('v')
            .to_owned();
        result.runtime_version = Some(runtime_version.clone());
        let endpoint = self.runtime_endpoint(&docker, &colima, &config, &env)?;
        result.endpoint = Some(endpoint.clone());
        let empty = Fingerprint {
            id: String::new(),
            server: String::new(),
            api: String::new(),
            os: String::new(),
            arch: String::new(),
            name: String::new(),
        };
        let mut target = Target {
            docker,
            colima,
            endpoint,
            env,
            config,
            fingerprint: empty,
        };
        let fingerprint = self.fingerprint(&target)?;
        result.server_version = Some(fingerprint.server.clone());
        result.api_version = Some(fingerprint.api.clone());
        result.engine_id = Some(fingerprint.id.clone());
        result.os_type = Some(fingerprint.os.clone());
        result.architecture = Some(fingerprint.arch.clone());
        // A deliberately narrow local alpha contract; additional combinations require validation.
        if client_version != "29.8.0"
            || runtime_version != "0.10.3"
            || fingerprint.server != "29.5.2"
            || fingerprint.api != "1.54"
            || fingerprint.os != "linux"
            || !matches!(fingerprint.arch.as_str(), "aarch64" | "arm64")
            || fingerprint.name != CONTEXT
        {
            return Err(ApiError::new(
                "UnsupportedRuntime",
                "This alpha requires Docker CLI 29.8.0, Colima 0.10.3, and the Linux ARM64 colima-docker2u Engine 29.5.2/API 1.54",
            ));
        }
        validate_host(&self.detect_host()?)?;
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
                    ports,
                    created_at: created.into(),
                });
            }
        }
        containers.sort_by(|a, b| a.name.cmp(&b.name).then(a.full_id.cmp(&b.full_id)));
        Ok(containers)
    }

    pub fn list_containers(&self, id: &str) -> Result<ContainerList> {
        let session = {
            let mut state = self.state.lock().unwrap();
            if state.refreshing || state.diagnosing || !state.mutations.is_empty() {
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
        match fetched {
            Ok(containers) => {
                active.generation += 1;
                active.stale = false;
                active.handles = containers
                    .iter()
                    .map(|c| (c.handle.clone(), c.clone()))
                    .collect();
                Ok(ContainerList {
                    session_id: id.into(),
                    generation: active.generation,
                    containers,
                    refreshed_at: chrono::Utc::now().to_rfc3339(),
                    stale: false,
                })
            }
            Err(error) => {
                active.stale = true;
                if matches!(
                    error.code.as_str(),
                    "EnvironmentChanged" | "Disconnected" | "EndpointMismatch" | "RemoteEndpoint"
                ) {
                    active.needs_validation = true;
                }
                Err(error)
            }
        }
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
        self.verify(&session.target)?;
        let arguments = args(&[
            "--host",
            &session.target.endpoint,
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
        let (session, container) = {
            let mut state = self.state.lock().unwrap();
            if state.refreshing || state.diagnosing {
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
            if !state.mutations.insert(container.full_id.clone()) {
                return Err(ApiError::new(
                    "Busy",
                    "Recovery for this container is already running",
                ));
            }
            (session, container)
        };
        let result = self.perform_mutation(&session, &container, action);
        let mut state = self.state.lock().unwrap();
        state.mutations.remove(&container.full_id);
        if let Some(active) = state.session.as_mut().filter(|s| s.id == id) {
            // Every action requires a fresh full list; failed reconciliation requires a new session.
            active.stale = true;
            match &result {
                Ok(result) if result.mutation_blocked => active.needs_validation = true,
                Err(_) => active.needs_validation = true,
                _ => {}
            }
        }
        result
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
        let arguments = args(&[
            "--host",
            &session.target.endpoint,
            "container",
            action.name(),
            &container.full_id,
        ]);
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
