//! Bounded selected-container observations, independent of inventory authority.
use super::*;

const HEALTH_FAILURE_LIMIT: usize = 3;
const HEALTH_OUTPUT_LIMIT: usize = 4 * 1024;
// Do not return the complete inspect object, environment, command or labels.
const DETAILS_FORMAT: &str = r#"{"Id":{{json .Id}},"State":{{json .State.Status}},"ExitCode":{{json (index .State "ExitCode")}},"StartedAt":{{json (index .State "StartedAt")}},"FinishedAt":{{json (index .State "FinishedAt")}},"OOMKilled":{{json (index .State "OOMKilled")}},"RestartCount":{{json .RestartCount}},"HealthConfigured":{{$config := .Config}}{{if eq (printf "%T" $config) "map[string]interface {}"}}{{$health := index $config "Healthcheck"}}{{$healthType := printf "%T" $health}}{{if eq $healthType "<nil>"}}false{{else if eq $healthType "map[string]interface {}"}}{{$test := index $health "Test"}}{{$testType := printf "%T" $test}}{{if eq $testType "<nil>"}}false{{else if or (eq $testType "[]interface {}") (eq $testType "[]string")}}{{if eq (len $test) 0}}false{{else}}{{$kind := index $test 0}}{{if eq (printf "%T" $kind) "string"}}{{if or (eq $kind "CMD") (eq $kind "CMD-SHELL")}}true{{else if eq $kind "NONE"}}false{{else}}null{{end}}{{else}}null{{end}}{{end}}{{else}}null{{end}}{{else}}null{{end}}{{else}}null{{end}},"Health":{{with index .State "Health"}}{"Status":{{json .Status}},"FailingStreak":{{json .FailingStreak}},"Log":[{{range $i,$entry := .Log}}{{if $i}},{{end}}{"Start":{{json $entry.Start}},"End":{{json $entry.End}},"ExitCode":{{json $entry.ExitCode}},"Output":{{json $entry.Output}}}{{end}}]}{{else}}null{{end}},"NetworkMode":{{json (index .HostConfig "NetworkMode")}},"Ports":{{json (index .NetworkSettings "Ports")}},"Networks":{{with index .NetworkSettings "Networks"}}{ {{$first := true}}{{range $name,$network := .}}{{if not $first}},{{end}}{{$first = false}}{{json $name}}:{"Aliases":{{json $network.Aliases}},"IPAddress":{{json $network.IPAddress}},"GlobalIPv6Address":{{json $network.GlobalIPv6Address}}}{{end}} }{{else}}null{{end}}}"#;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetails {
    pub session_id: String,
    pub generation: u64,
    pub handle: String,
    pub full_id: String,
    pub observed_at: String,
    pub diagnostics: ContainerDiagnostics,
    pub connectivity: ContainerConnectivity,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDiagnostics {
    pub state: String,
    pub exit_code: Option<i32>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub oom_killed: Option<bool>,
    pub restart_count: Option<u64>,
    pub health_configured: Option<bool>,
    pub health_available: bool,
    pub health: Option<HealthDetails>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDetails {
    pub status: Option<String>,
    pub failing_streak: Option<u64>,
    pub recent_failures: Vec<HealthFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthFailure {
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: i32,
    pub output: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerConnectivity {
    pub network_mode: Option<String>,
    pub ports_available: bool,
    pub ports: Vec<PublishedPort>,
    pub networks_available: bool,
    pub networks: Vec<NetworkDetails>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    pub container_port: u16,
    pub protocol: String,
    pub bindings: Vec<PortBinding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub host_ip: String,
    pub host_port: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDetails {
    pub name: String,
    pub aliases: Vec<String>,
    pub ipv4_address: Option<String>,
    pub ipv6_address: Option<String>,
}

struct DetailsGuard(Arc<Mutex<State>>);
impl Drop for DetailsGuard {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .details_running = false;
    }
}

fn timestamp(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    // Docker uses year 1 for events that have never occurred.
    if parsed.timestamp() <= -62_135_596_800 {
        return None;
    }
    Some(text.into())
}

fn count(value: Option<&Value>) -> Option<u64> {
    value?
        .as_u64()
        .filter(|value| *value <= 9_007_199_254_740_991)
}

fn exit_code(value: Option<&Value>) -> Option<i32> {
    value?.as_i64()?.try_into().ok()
}

fn text(value: Option<&Value>) -> Option<String> {
    value?
        .as_str()
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn health(value: Option<&Value>) -> (bool, Option<HealthDetails>) {
    let Some(value) = value else {
        return (false, None);
    };
    if value.is_null() {
        return (true, None);
    }
    if !value.is_object() {
        return (false, None);
    }
    let status = text(value.get("Status")).map(|status| {
        if matches!(status.as_str(), "starting" | "healthy" | "unhealthy") {
            status
        } else {
            "unknown".into()
        }
    });
    // Missing or malformed history must not be presented as a known empty history.
    let history_available = match value.get("Log") {
        Some(Value::Null) => true,
        Some(Value::Array(entries)) => entries.iter().all(|entry| {
            exit_code(entry.get("ExitCode")).is_some()
                && entry.get("Output").is_some_and(Value::is_string)
        }),
        _ => false,
    };
    // Docker log order is oldest to newest. Return the most recent failures first.
    let recent_failures = value
        .get("Log")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter_map(|entry| {
            let code = exit_code(entry.get("ExitCode"))?;
            if code == 0 {
                return None;
            }
            let raw = entry.get("Output").and_then(Value::as_str).unwrap_or("");
            Some(HealthFailure {
                started_at: timestamp(entry.get("Start")),
                finished_at: timestamp(entry.get("End")),
                exit_code: code,
                output: process::plain_text(raw.as_bytes(), HEALTH_OUTPUT_LIMIT),
                truncated: raw.len() > HEALTH_OUTPUT_LIMIT,
            })
        })
        .take(HEALTH_FAILURE_LIMIT)
        .collect();
    (
        history_available,
        Some(HealthDetails {
            status,
            failing_streak: count(value.get("FailingStreak")),
            recent_failures,
        }),
    )
}

#[cfg(test)]
#[path = "docker_details_parser_tests.rs"]
mod parser_tests;

fn port_number(text: &str) -> Option<u16> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|port| *port > 0)
}

fn ports(value: Option<&Value>) -> (bool, Vec<PublishedPort>) {
    let Some(value) = value else {
        return (false, vec![]);
    };
    if value.is_null() {
        return (true, vec![]);
    }
    let Some(map) = value.as_object() else {
        return (false, vec![]);
    };
    let mut ports = Vec::with_capacity(map.len());
    for (key, bindings) in map {
        let Some((port, protocol)) = key.split_once('/') else {
            return (false, vec![]);
        };
        let Some(container_port) = port_number(port) else {
            return (false, vec![]);
        };
        if !matches!(protocol, "tcp" | "udp" | "sctp") {
            return (false, vec![]);
        }
        let bindings = if bindings.is_null() {
            vec![]
        } else {
            let Some(bindings) = bindings.as_array() else {
                return (false, vec![]);
            };
            let mut result = Vec::with_capacity(bindings.len());
            for binding in bindings {
                let Some(host_ip) = binding.get("HostIp").and_then(Value::as_str) else {
                    return (false, vec![]);
                };
                if !host_ip.is_empty() && host_ip.parse::<std::net::IpAddr>().is_err() {
                    return (false, vec![]);
                }
                let host_port = binding
                    .get("HostPort")
                    .and_then(Value::as_str)
                    .and_then(port_number);
                result.push(PortBinding {
                    host_ip: host_ip.into(),
                    host_port,
                });
            }
            result.sort_by(|a, b| {
                a.host_ip
                    .cmp(&b.host_ip)
                    .then(a.host_port.cmp(&b.host_port))
            });
            result
        };
        ports.push(PublishedPort {
            container_port,
            protocol: protocol.into(),
            bindings,
        });
    }
    ports.sort_by(|a, b| {
        a.container_port
            .cmp(&b.container_port)
            .then(a.protocol.cmp(&b.protocol))
    });
    (true, ports)
}

fn networks(value: Option<&Value>) -> (bool, Vec<NetworkDetails>) {
    let Some(value) = value else {
        return (false, vec![]);
    };
    if value.is_null() {
        return (true, vec![]);
    }
    let Some(map) = value.as_object() else {
        return (false, vec![]);
    };
    let mut networks = Vec::with_capacity(map.len());
    for (name, value) in map {
        if name.is_empty() || !value.is_object() {
            return (false, vec![]);
        }
        let mut aliases = match value.get("Aliases") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(values)) => {
                let Some(values) = values
                    .iter()
                    .map(|value| value.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
                else {
                    return (false, vec![]);
                };
                values
            }
            _ => return (false, vec![]),
        };
        aliases.retain(|alias| !alias.is_empty());
        aliases.sort();
        aliases.dedup();
        networks.push(NetworkDetails {
            name: name.clone(),
            aliases,
            ipv4_address: text(value.get("IPAddress"))
                .filter(|ip| ip.parse::<std::net::Ipv4Addr>().is_ok()),
            ipv6_address: text(value.get("GlobalIPv6Address"))
                .filter(|ip| ip.parse::<std::net::Ipv6Addr>().is_ok()),
        });
    }
    networks.sort_by(|a, b| a.name.cmp(&b.name));
    (true, networks)
}

fn parse_details(
    bytes: &[u8],
    session: &Session,
    handle: &str,
    full_id: &str,
) -> Result<ContainerDetails> {
    let rows = json_lines(bytes)?;
    if rows.len() != 1 || rows[0].get("Id").and_then(Value::as_str) != Some(full_id) {
        return Err(malformed(
            "Details did not match the requested full container ID",
        ));
    }
    let row = &rows[0];
    let state = required(row, "State")?;
    let state = if matches!(
        state,
        "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead"
    ) {
        state
    } else {
        "unknown"
    };
    let (health_available, health) = health(row.get("Health"));
    let (ports_available, ports) = ports(row.get("Ports"));
    let (networks_available, networks) = networks(row.get("Networks"));
    Ok(ContainerDetails {
        session_id: session.id.clone(),
        generation: session.generation,
        handle: handle.into(),
        full_id: full_id.into(),
        observed_at: chrono::Utc::now().to_rfc3339(),
        diagnostics: ContainerDiagnostics {
            state: state.into(),
            exit_code: exit_code(row.get("ExitCode")),
            started_at: timestamp(row.get("StartedAt")),
            finished_at: timestamp(row.get("FinishedAt")),
            oom_killed: row.get("OOMKilled").and_then(Value::as_bool),
            restart_count: count(row.get("RestartCount")),
            health_configured: row.get("HealthConfigured").and_then(Value::as_bool),
            health_available,
            health,
        },
        connectivity: ContainerConnectivity {
            network_mode: text(row.get("NetworkMode")),
            ports_available,
            ports,
            networks_available,
            networks,
        },
    })
}

impl Core {
    pub fn get_container_details(
        &self,
        id: &str,
        generation: u64,
        handle: &str,
    ) -> Result<ContainerDetails> {
        let (session, container, _reservation) = {
            let mut state = self.state.lock().unwrap();
            if state.details_running || state.refreshing || state.diagnosing || state.mutating {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            let session = state
                .session
                .as_ref()
                .filter(|session| session.id == id)
                .cloned()
                .ok_or_else(|| {
                    ApiError::new("StaleSession", "Reconnect before reading container details")
                })?;
            if session.stale || session.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before reading container details",
                ));
            }
            if session.generation != generation {
                return Err(ApiError::new("StaleHandle", "Select from the latest list"));
            }
            let container = session
                .handles
                .get(handle)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleHandle", "Select from the latest list"))?;
            state.details_running = true;
            (session, container, DetailsGuard(self.state.clone()))
        };
        let result = self
            .verify(&session.target)
            .and_then(|_| {
                self.docker(
                    &session.target,
                    &[
                        "container",
                        "inspect",
                        "--format",
                        DETAILS_FORMAT,
                        &container.full_id,
                    ],
                    15,
                )
            })
            .and_then(|bytes| parse_details(&bytes, &session, handle, &container.full_id));
        if let Err(error) = &result {
            self.invalidate_observation(id, error);
        }
        let state = self.state.lock().unwrap();
        let active = state
            .session
            .as_ref()
            .filter(|session| session.id == id)
            .ok_or_else(|| {
                ApiError::new(
                    "StaleSession",
                    "Container details belong to an older session",
                )
            })?;
        // Preserve a same-session connection failure so every reader can invalidate it.
        if result.as_ref().is_err_and(connection_invalidated) {
            return result;
        }
        if active.generation != generation
            || active.stale
            || active.needs_validation
            || state.mutating
            || state.refreshing
            || active
                .handles
                .get(handle)
                .is_none_or(|current| current.full_id != container.full_id)
        {
            return Err(ApiError::new(
                "StaleHandle",
                "Container details were superseded by another operation",
            ));
        }
        result
    }
}
