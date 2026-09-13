//! Current-value resource samples; no inventory refresh or mutation authority.
use super::*;
use std::time::Instant;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub session_id: String,
    pub generation: u64,
    pub sampled_at: String,
    pub items: Vec<ContainerStats>,
    pub error: Option<ApiError>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub handle: String,
    pub full_id: String,
    pub cpu_percent: Option<f64>,
    pub memory_usage: Option<String>,
    pub memory_percent: Option<f64>,
    pub memory_usage_bytes: Option<f64>,
    pub memory_limit_bytes: Option<f64>,
    pub available: bool,
}

struct StatsGuard(Arc<Mutex<State>>);
impl Drop for StatsGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap().stats_running = false;
    }
}

fn percent(row: &Value, key: &str) -> Result<f64> {
    let text = required(row, key)?;
    text.strip_suffix('%')
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| malformed(format!("Invalid stats {key}")))
}

fn memory_quantity(text: &str) -> Option<f64> {
    let split = text.find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))?;
    let unit = text[split..].trim();
    if !matches!(
        unit,
        "B" | "kB"
            | "KB"
            | "MB"
            | "GB"
            | "TB"
            | "PB"
            | "EB"
            | "KiB"
            | "MiB"
            | "GiB"
            | "TiB"
            | "PiB"
            | "EiB"
    ) {
        return None;
    }
    text[..split]
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite() && *number >= 0.0)
}

// Docker's human-readable CLI quantity is rounded; these are plot values, not
// a claim that the CLI exposed an exact raw Engine byte counter.
fn memory_bytes(text: &str) -> Option<f64> {
    let quantity = memory_quantity(text)?;
    let split = text.find(|ch: char| !(ch.is_ascii_digit() || ch == '.'))?;
    let unit = text[split..].trim();
    let power = match unit {
        "B" => 0,
        "kB" | "KB" | "KiB" => 1,
        "MB" | "MiB" => 2,
        "GB" | "GiB" => 3,
        "TB" | "TiB" => 4,
        "PB" | "PiB" => 5,
        "EB" | "EiB" => 6,
        _ => return None,
    };
    let base: f64 = if unit.ends_with("iB") { 1024.0 } else { 1000.0 };
    let bytes = quantity * base.powi(power);
    (bytes.is_finite() && bytes <= 9_007_199_254_740_991.0).then_some(bytes)
}

fn parse_stats(
    bytes: &[u8],
    wanted: &[&Container],
) -> Result<HashMap<String, (f64, String, f64, bool)>> {
    let mut values = HashMap::new();
    for row in json_lines(bytes)? {
        let id = required(&row, "ID")?;
        if !valid_id(id)
            || !wanted.iter().any(|container| container.full_id == id)
            || values.contains_key(id)
        {
            return Err(malformed(
                "Stats returned an unexpected or duplicate full ID",
            ));
        }
        let cpu = percent(&row, "CPUPerc")?;
        let memory_percent = percent(&row, "MemPerc")?;
        let memory = required(&row, "MemUsage")?;
        let (used, limit) = memory
            .split_once(" / ")
            .ok_or_else(|| malformed("Invalid memory usage"))?;
        memory_bytes(used).ok_or_else(|| malformed("Invalid memory usage"))?;
        let limit = memory_bytes(limit).ok_or_else(|| malformed("Invalid memory limit"))?;
        // A stopped-container race can produce a CLI placeholder of 0B / 0B.
        values.insert(id.into(), (cpu, memory.into(), memory_percent, limit > 0.0));
    }
    Ok(values)
}

impl Core {
    pub fn get_container_stats(
        &self,
        id: &str,
        generation: u64,
        handles: &[String],
    ) -> Result<StatsSnapshot> {
        let (session, containers, _reservation) =
            {
                let mut state = self.state.lock().unwrap();
                if state.stats_running || state.refreshing || state.diagnosing || state.mutating {
                    return Err(ApiError::new("Busy", "An operation is still in progress"));
                }
                let session = state
                    .session
                    .as_ref()
                    .filter(|session| session.id == id)
                    .cloned()
                    .ok_or_else(|| {
                        ApiError::new("StaleSession", "Reconnect before sampling resources")
                    })?;
                if session.stale || session.needs_validation {
                    return Err(ApiError::new(
                        "NeedsValidation",
                        "Refresh or reconnect before sampling resources",
                    ));
                }
                if session.generation != generation {
                    return Err(ApiError::new("StaleHandle", "Select from the latest list"));
                }
                let mut unique = HashSet::new();
                let mut containers = Vec::with_capacity(handles.len().min(session.handles.len()));
                for handle in handles {
                    if !unique.insert(handle) {
                        return Err(ApiError::new(
                            "InvalidSelection",
                            "Duplicate resource target",
                        ));
                    }
                    containers.push(session.handles.get(handle).cloned().ok_or_else(|| {
                        ApiError::new("StaleHandle", "Select from the latest list")
                    })?);
                }
                state.stats_running = true;
                (session, containers, StatsGuard(self.state.clone()))
            };
        let mut items: Vec<_> = containers
            .iter()
            .map(|container| ContainerStats {
                handle: container.handle.clone(),
                full_id: container.full_id.clone(),
                cpu_percent: None,
                memory_usage: None,
                memory_percent: None,
                memory_usage_bytes: None,
                memory_limit_bytes: None,
                available: false,
            })
            .collect();
        let running: Vec<_> = containers
            .iter()
            .filter(|container| container.state == "running")
            .collect();
        let mut error = None;
        // Never dispatch stats without IDs: Docker would subscribe to every container.
        if !running.is_empty() {
            if let Err(failure) = self.verify(&session.target) {
                self.invalidate_observation(id, &failure);
                return Err(failure);
            }
            let deadline = Instant::now() + Duration::from_secs(15);
            for chunk in running.chunks(100) {
                if self.active(id)?.generation != generation {
                    return Err(ApiError::new(
                        "StaleHandle",
                        "Resource sample belongs to an older list",
                    ));
                }
                let seconds = deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
                    .min(10);
                if seconds == 0 {
                    error = Some(ApiError::new(
                        "TimedOut",
                        "Resource sampling exceeded its collection budget",
                    ));
                    break;
                }
                let mut arguments = vec![
                    "container",
                    "stats",
                    "--no-stream",
                    "--no-trunc",
                    "--format",
                    "{{json .}}",
                ];
                arguments.extend(chunk.iter().map(|container| container.full_id.as_str()));
                let sampled = self
                    .docker(&session.target, &arguments, seconds)
                    .and_then(|bytes| parse_stats(&bytes, chunk));
                match sampled {
                    Ok(values) => {
                        for item in &mut items {
                            if let Some((cpu, memory, percent, available)) =
                                values.get(&item.full_id)
                            {
                                if *available {
                                    item.cpu_percent = Some(*cpu);
                                    item.memory_usage = Some(memory.clone());
                                    item.memory_percent = Some(*percent);
                                    if let Some((used, limit)) = memory.split_once(" / ") {
                                        item.memory_usage_bytes = memory_bytes(used);
                                        item.memory_limit_bytes = memory_bytes(limit);
                                    }
                                    item.available = true;
                                }
                            }
                        }
                    }
                    Err(failure) => {
                        self.invalidate_observation(id, &failure);
                        if connection_invalidated(&failure) {
                            return Err(failure);
                        }
                        // The CLI can fail a complete chunk when one container disappeared.
                        // Do not fan out into unbounded single-container retries.
                        error.get_or_insert(failure);
                    }
                }
            }
        }
        let state = self.state.lock().unwrap();
        let active = state
            .session
            .as_ref()
            .filter(|session| session.id == id)
            .ok_or_else(|| {
                ApiError::new(
                    "StaleSession",
                    "Resource sample belongs to an older session",
                )
            })?;
        if active.generation != generation
            || active.stale
            || active.needs_validation
            || state.mutating
            || state.refreshing
        {
            return Err(ApiError::new(
                "StaleHandle",
                "Resource sample was superseded by another operation",
            ));
        }
        Ok(StatsSnapshot {
            session_id: id.into(),
            generation,
            sampled_at: chrono::Utc::now().to_rfc3339(),
            items,
            error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_cli_memory_units_without_inventing_precise_raw_values() {
        assert_eq!(memory_bytes("12.5MiB"), Some(13_107_200.0));
        assert_eq!(memory_bytes("12.5MB"), Some(12_500_000.0));
        assert_eq!(memory_bytes("2GiB"), Some(2_147_483_648.0));
        assert_eq!(memory_bytes("0B"), Some(0.0));
        assert_eq!(memory_bytes("NaNMiB"), None);
        assert_eq!(memory_bytes("100000000000EiB"), None);
        assert_eq!(memory_bytes("-1MiB"), None);
    }

    fn target() -> Container {
        Container {
            handle: "opaque".into(),
            full_id: "a".repeat(64),
            short_id: "a".repeat(12),
            name: "api".into(),
            image: "fixture".into(),
            state: "running".into(),
            health: None,
            health_configured: None,
            ports: vec![],
            created_at: "2026-09-07T00:00:00Z".into(),
            started_at: None,
            tty: false,
            compose_project: None,
            compose_service: None,
        }
    }

    #[test]
    fn stats_values_preserve_multicore_cpu_and_cli_memory_semantics() {
        assert_eq!(
            percent(&serde_json::json!({"CPUPerc":"250.25%"}), "CPUPerc").unwrap(),
            250.25
        );
        for value in ["NaN%", "inf%", "-1%", "10", "oops%"] {
            assert!(percent(&serde_json::json!({"CPUPerc":value}), "CPUPerc").is_err());
        }
        assert_eq!(memory_quantity("12.5MiB"), Some(12.5));
        assert_eq!(memory_quantity("0B"), Some(0.0));
        assert_eq!(memory_quantity("3<script>"), None);
    }

    #[test]
    fn stats_json_accepts_only_unique_requested_full_ids_and_preserves_missing_values() {
        let container = target();
        let row = serde_json::json!({"ID":container.full_id,"CPUPerc":"250.25%","MemUsage":"12.5MiB / 2GiB","MemPerc":"0.61%"}).to_string();
        let values = parse_stats(row.as_bytes(), &[&container]).unwrap();
        assert_eq!(
            values[&container.full_id],
            (250.25, "12.5MiB / 2GiB".into(), 0.61, true)
        );
        assert!(parse_stats(format!("{row}\n{row}").as_bytes(), &[&container]).is_err());
        assert!(
            parse_stats(
                row.replace(&container.full_id, &"b".repeat(64)).as_bytes(),
                &[&container]
            )
            .is_err()
        );
        assert!(
            parse_stats(
                row.replace(&container.full_id, "aaaaaaaaaaaa").as_bytes(),
                &[&container]
            )
            .is_err()
        );
        assert!(parse_stats(b"", &[&container]).unwrap().is_empty());
        let stopped = row.replace("12.5MiB / 2GiB", "0B / 0B");
        assert!(!parse_stats(stopped.as_bytes(), &[&container]).unwrap()[&container.full_id].3);
        assert!(parse_stats(b"{broken", &[&container]).is_err());
    }
}
