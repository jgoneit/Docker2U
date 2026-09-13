//! Lazy, bounded mount metadata for the current Engine inventory. Never opens mount paths.
use super::*;
use crate::process::ProcessOptions;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const MOUNTS_FORMAT: &str = r#"{"Id":{{json .Id}},"Mounts":[{{range $i,$mount := .Mounts}}{{if $i}},{{end}}{"Type":{{json $mount.Type}},"Source":{{json $mount.Source}},"Destination":{{json $mount.Destination}},"RW":{{json $mount.RW}},"Name":{{json $mount.Name}}}{{end}}]}"#;
const TOTAL_BYTES: usize = 8 * 1024 * 1024;
const FIELD_BYTES: usize = 16 * 1024;
const MOUNTS_PER_CONTAINER: usize = 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountInventory {
    pub session_id: String,
    pub observed_at: String,
    pub coverage: String,
    pub containers: Vec<ContainerMounts>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMounts {
    pub full_id: String,
    pub mounts_available: bool,
    pub mounts: Vec<Mount>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    #[serde(rename = "type")]
    pub kind: String,
    pub source: Option<String>,
    pub destination: Option<String>,
    pub read_only: Option<bool>,
    pub volume_name: Option<String>,
}

struct Cache {
    ids: Vec<String>,
    snapshot: MountInventory,
}
struct ActiveRead {
    session_id: String,
    cancel: Arc<AtomicBool>,
}
#[derive(Default)]
pub(super) struct MountInventoryManager {
    cache: Option<Cache>,
    active: Option<ActiveRead>,
}
struct ReadGuard(Arc<Mutex<MountInventoryManager>>, Arc<AtomicBool>);
impl Drop for ReadGuard {
    fn drop(&mut self) {
        let mut manager = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if manager
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(&active.cancel, &self.1))
        {
            manager.active = None;
        }
    }
}
struct Budget {
    remaining: usize,
    options: ProcessOptions,
}
fn unavailable(id: &str) -> ContainerMounts {
    ContainerMounts {
        full_id: id.into(),
        mounts_available: false,
        mounts: vec![],
    }
}
fn inventory_ids(session: &Session) -> Vec<String> {
    let mut ids: Vec<_> = session
        .handles
        .values()
        .map(|c| c.full_id.clone())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
fn mount_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= FIELD_BYTES && !text.contains('\0'))
        .map(str::to_owned)
}
fn parse_mounts(bytes: &[u8], ids: &[String]) -> Result<Vec<ContainerMounts>> {
    let rows = json_lines(bytes)?;
    let mut seen = HashSet::new();
    if rows.len() != ids.len() {
        return Err(malformed(
            "Mount rows did not match the requested container IDs",
        ));
    }
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let id = required(&row, "Id")?;
        if !valid_id(id) || !ids.iter().any(|wanted| wanted == id) || !seen.insert(id.to_owned()) {
            return Err(malformed(
                "Mount metadata returned an unexpected or duplicate full ID",
            ));
        }
        let Some(mounts) = row
            .get("Mounts")
            .and_then(Value::as_array)
            .filter(|mounts| mounts.len() <= MOUNTS_PER_CONTAINER)
        else {
            result.push(unavailable(id));
            continue;
        };
        if mounts.iter().any(|mount| !mount.is_object()) {
            result.push(unavailable(id));
            continue;
        }
        let mut parsed = Vec::with_capacity(mounts.len());
        for mount in mounts {
            let kind = mount_text(mount.get("Type"));
            let source = mount_text(mount.get("Source"));
            let destination = mount_text(mount.get("Destination"));
            let read_only = mount.get("RW").and_then(Value::as_bool).map(|rw| !rw);
            let volume_name = mount_text(mount.get("Name"));
            parsed.push(Mount {
                kind: kind.unwrap_or_else(|| "unknown".into()),
                source,
                destination,
                read_only,
                volume_name,
            });
        }
        result.push(ContainerMounts {
            full_id: id.into(),
            mounts_available: true,
            mounts: parsed,
        });
    }
    Ok(result)
}

impl Core {
    pub(super) fn cancel_mount_reads(&self, session_id: Option<&str>) {
        let mut manager = self.mount_inventory.lock().unwrap();
        if let Some(active) = manager
            .active
            .as_ref()
            .filter(|active| session_id.is_none_or(|id| active.session_id == id))
        {
            active.cancel.store(true, Ordering::Release);
        }
        if manager
            .cache
            .as_ref()
            .is_some_and(|cache| session_id.is_none_or(|id| cache.snapshot.session_id == id))
        {
            manager.cache = None;
        }
    }
    fn mount_capture(
        &self,
        target: &Target,
        arguments: &[&str],
        budget: &mut Budget,
    ) -> Result<Vec<u8>> {
        if budget.remaining == 0 {
            return Err(ApiError::new(
                "OutputLimitExceeded",
                "Mount metadata exceeded its size limit",
            ));
        }
        budget.options.capture_limit = Some(budget.remaining);
        let arguments = if arguments == ["--version"] {
            args(arguments)
        } else {
            target.engine_args(arguments)
        };
        let output = self
            .runner
            .run_with_options(
                &target.docker,
                &arguments,
                &target.env,
                &budget.options,
                false,
            )
            .map_err(|_| {
                ApiError::new("MountReadUnavailable", "Mount metadata could not be read")
            })?;
        if output.interrupted || output.code.is_none() {
            return Err(ApiError::new(
                if output.timed_out {
                    "TimedOut"
                } else {
                    "Cancelled"
                },
                "Mount metadata collection was interrupted",
            ));
        }
        let retained = output.stdout.len().saturating_add(output.stderr.len());
        let exceeded = output.truncated || retained > budget.remaining;
        budget.remaining = budget.remaining.saturating_sub(retained);
        if exceeded {
            return Err(ApiError::new(
                "OutputLimitExceeded",
                "Mount metadata exceeded its size limit",
            ));
        }
        if output.code != Some(0) {
            let denied = String::from_utf8_lossy(&output.stderr)
                .to_ascii_lowercase()
                .contains("permission denied");
            return Err(ApiError::new(
                if denied {
                    "PermissionDenied"
                } else {
                    "MountReadUnavailable"
                },
                "The Engine could not read mount metadata",
            ));
        }
        Ok(output.stdout)
    }
    fn verify_mount_target(&self, target: &Target, budget: &mut Budget) -> Result<()> {
        validate_docker_config(&target.docker_config)?;
        if local_endpoint(&target.endpoint)? != target.endpoint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "The Engine endpoint changed",
            ));
        }
        let version = self.mount_capture(target, &["--version"], budget)?;
        let client = std::str::from_utf8(&version)
            .ok()
            .map(str::trim)
            .and_then(|text| text.strip_prefix("Docker version "))
            .and_then(|text| text.split(',').next())
            .filter(|text| !text.is_empty())
            .ok_or_else(|| malformed("Docker client version is malformed"))?;
        let info: Value = serde_json::from_slice(&self.mount_capture(
            target,
            &["info", "--format", "{{json .}}"],
            budget,
        )?)
        .map_err(|_| malformed("Engine identity response is malformed"))?;
        let version: Value = serde_json::from_slice(&self.mount_capture(
            target,
            &["version", "--format", "{{json .}}"],
            budget,
        )?)
        .map_err(|_| malformed("Engine version response is malformed"))?;
        let server = version
            .get("Server")
            .ok_or_else(|| malformed("Engine version response is incomplete"))?;
        let fingerprint = &target.fingerprint;
        if client != target.client_version
            || required(&info, "ID")? != fingerprint.id
            || required(&info, "OSType")? != fingerprint.os
            || required(&info, "Architecture")? != fingerprint.arch
            || required(&info, "Name")? != fingerprint.name
            || required(server, "Version")? != fingerprint.server
            || required(server, "ApiVersion")? != fingerprint.api
        {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "CLI or Engine identity changed. Reconnect before reading mounts",
            ));
        }
        Ok(())
    }
    pub fn get_mount_inventory(&self, session_id: &str, refresh: bool) -> Result<MountInventory> {
        let (session, ids, cancel, _guard) = {
            let state = self.state.lock().unwrap();
            let session = state
                .session
                .as_ref()
                .filter(|s| s.id == session_id)
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before reading mounts"))?;
            if state.closing
                || session.stale
                || session.needs_validation
                || session.inventory.is_none()
            {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before reading mounts",
                ));
            }
            let ids = inventory_ids(session);
            let mut manager = self.mount_inventory.lock().unwrap();
            if manager.active.is_some() {
                return Err(ApiError::new(
                    "Busy",
                    "Mount metadata collection is already in progress",
                ));
            }
            if !refresh {
                if let Some(cache) = manager
                    .cache
                    .as_ref()
                    .filter(|cache| cache.snapshot.session_id == session_id && cache.ids == ids)
                {
                    return Ok(cache.snapshot.clone());
                }
            }
            manager.cache = None;
            let cancel = Arc::new(AtomicBool::new(false));
            manager.active = Some(ActiveRead {
                session_id: session_id.into(),
                cancel: cancel.clone(),
            });
            (
                session.clone(),
                ids,
                cancel.clone(),
                ReadGuard(self.mount_inventory.clone(), cancel),
            )
        };
        let timeout = Duration::from_secs(30);
        #[cfg(test)]
        let timeout = self.mount_timeout.unwrap_or(timeout);
        let remaining = TOTAL_BYTES;
        #[cfg(test)]
        let remaining = self.mount_output_limit.unwrap_or(remaining);
        let mut budget = Budget {
            remaining,
            options: ProcessOptions {
                deadline: Some(Instant::now() + timeout),
                cancel: cancel.clone(),
                ..ProcessOptions::default()
            },
        };
        let collected = (|| {
            self.verify_mount_target(&session.target, &mut budget)?;
            let mut containers: HashMap<String, ContainerMounts> =
                ids.iter().map(|id| (id.clone(), unavailable(id))).collect();
            for chunk in ids.chunks(100) {
                let mut arguments = vec!["container", "inspect", "--format", MOUNTS_FORMAT];
                arguments.extend(chunk.iter().map(String::as_str));
                match self
                    .mount_capture(&session.target, &arguments, &mut budget)
                    .and_then(|bytes| parse_mounts(&bytes, chunk))
                {
                    Ok(rows) => {
                        containers.extend(rows.into_iter().map(|row| (row.full_id.clone(), row)))
                    }
                    Err(error) if connection_invalidated(&error) => return Err(error),
                    Err(error)
                        if matches!(
                            error.code.as_str(),
                            "TimedOut" | "Cancelled" | "OutputLimitExceeded"
                        ) =>
                    {
                        break;
                    }
                    Err(_) => {}
                }
                if cancel.load(Ordering::Acquire)
                    || budget
                        .options
                        .deadline
                        .is_some_and(|deadline| Instant::now() >= deadline)
                {
                    break;
                }
            }
            Ok(containers)
        })();
        if let Err(error) = &collected {
            self.invalidate_observation(session_id, error);
        }
        let state = self.state.lock().unwrap();
        let active = state
            .session
            .as_ref()
            .filter(|s| s.id == session_id)
            .ok_or_else(|| {
                ApiError::new(
                    "StaleSession",
                    "Mount metadata belongs to an older connection",
                )
            })?;
        if let Err(error) = &collected {
            if connection_invalidated(error) {
                return Err(error.clone());
            }
        }
        if active.stale
            || active.needs_validation
            || state.closing
            || cancel.load(Ordering::Acquire)
        {
            return Err(ApiError::new(
                "NeedsValidation",
                "Refresh or reconnect before reading mounts",
            ));
        }
        let mut collected = collected?;
        let current_ids = inventory_ids(active);
        let containers: Vec<_> = current_ids
            .iter()
            .map(|id| collected.remove(id).unwrap_or_else(|| unavailable(id)))
            .collect();
        let complete = current_ids == ids && containers.iter().all(|row| row.mounts_available);
        let snapshot = MountInventory {
            session_id: session_id.into(),
            observed_at: chrono::Utc::now().to_rfc3339(),
            coverage: if complete { "complete" } else { "partial" }.into(),
            containers,
        };
        // Nullable fields and placeholders add IPC overhead beyond the CLI bytes.
        // Never return a truncated list that could imply missing shared users.
        if serde_json::to_vec(&snapshot)
            .map_err(|_| malformed("Mount inventory could not be encoded"))?
            .len()
            > TOTAL_BYTES
        {
            return Err(ApiError::new(
                "OutputLimitExceeded",
                "Mount inventory exceeded its size limit",
            ));
        }
        if complete {
            self.mount_inventory.lock().unwrap().cache = Some(Cache {
                ids,
                snapshot: snapshot.clone(),
            });
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
#[path = "docker_mounts_parser_tests.rs"]
mod tests;
