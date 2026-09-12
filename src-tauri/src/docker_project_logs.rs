//! Session-owned project logs: bounded retention, stable source identity and paged views.
use super::engine_reader::{
    LogRecord, LogRequest, LogStreamKind, ReaderMessage, ReaderStatus, StreamTask,
};
use super::*;
use chrono::Utc;
use std::collections::{BTreeMap, BTreeSet};

const MAX_SOURCES: usize = 64;
const MAX_ROWS: usize = 100_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const SOURCE_BYTES: usize = 1024 * 1024;
const PAGE_BYTES: usize = 2 * 1024 * 1024;
const RETENTION_SECONDS: i64 = 30 * 60;
const INITIAL_TAIL_ROWS: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLogRow {
    pub row_id: String,
    pub sequence: u64,
    pub source_id: String,
    pub full_id: String,
    pub service_name: Option<String>,
    pub container_name: String,
    pub timestamp: Option<String>,
    pub received_at: String,
    pub pipe: String,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLogSource {
    pub source_id: String,
    pub full_id: String,
    pub service_name: Option<String>,
    pub container_name: String,
    pub selected: bool,
    pub status: String,
    pub error: Option<ApiError>,
    pub dropped_rows: u64,
    pub coverage_gaps: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLogQuery {
    pub project: String,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub keyword: String,
    pub offset: Option<usize>,
    #[serde(default = "page_size")]
    pub limit: usize,
    pub through_sequence: Option<u64>,
    #[serde(default)]
    pub anchor_row_id: Option<String>,
}
fn page_size() -> usize {
    500
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLogPage {
    pub session_id: String,
    pub project: String,
    pub revision: u64,
    pub max_sequence: u64,
    pub rows: Vec<ProjectLogRow>,
    pub sources: Vec<ProjectLogSource>,
    pub total_rows: usize,
    pub offset: usize,
    pub dropped_rows: u64,
    pub coverage_gaps: u64,
    pub needs_selection: bool,
    pub retained_from: Option<String>,
    pub retained_to: Option<String>,
    pub anchor_lost: bool,
    pub error: Option<ApiError>,
}

type OrderKey = (i64, String, u64);
struct StoredRow {
    project: String,
    row: ProjectLogRow,
    bytes: usize,
    retention_time: i64,
    source_sequence: u64,
}
#[derive(Default)]
struct LogRing {
    rows: BTreeMap<OrderKey, StoredRow>,
    expiry: BTreeMap<(i64, u64), OrderKey>,
    source_tail: HashMap<String, BTreeMap<u64, OrderKey>>,
    source_sequence: HashMap<String, u64>,
    source_order: HashMap<String, BTreeSet<OrderKey>>,
    source_bytes: HashMap<String, usize>,
    dropped: HashMap<String, u64>,
    source_dropped: HashMap<String, u64>,
    bytes: usize,
    sequence: u64,
}
fn nanos(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp_nanos_opt()
}
fn now_nanos() -> i64 {
    Utc::now().timestamp_nanos_opt().unwrap_or(i64::MAX)
}

impl LogRing {
    fn remove(&mut self, key: &OrderKey, dropped: bool) {
        let Some(stored) = self.rows.remove(key) else {
            return;
        };
        self.expiry.remove(&(stored.retention_time, key.2));
        self.bytes = self.bytes.saturating_sub(stored.bytes);
        let source = &stored.row.source_id;
        if let Some(tail) = self.source_tail.get_mut(source) {
            tail.remove(&stored.source_sequence);
        }
        if let Some(bytes) = self.source_bytes.get_mut(source) {
            *bytes = bytes.saturating_sub(stored.bytes);
        }
        if let Some(order) = self.source_order.get_mut(source) {
            order.remove(key);
            if order.is_empty() {
                self.source_order.remove(source);
                self.source_bytes.remove(source);
                self.source_tail.remove(source);
                self.source_sequence.remove(source);
            }
        }
        if dropped {
            *self.dropped.entry(stored.project).or_default() += 1;
            *self.source_dropped.entry(source.clone()).or_default() += 1;
        }
    }
    fn expire(&mut self, now: i64) {
        let cutoff = now.saturating_sub(RETENTION_SECONDS * 1_000_000_000);
        // Age limits additional history, while each source keeps its most
        // recently received tail even if a quiet container last wrote days ago.
        while let Some((&(time, _), _)) = self.expiry.first_key_value() {
            if time >= cutoff {
                break;
            }
            let (_, key) = self.expiry.pop_first().unwrap();
            let in_tail = self.rows.get(&key).is_some_and(|stored| {
                self.source_tail
                    .get(&stored.row.source_id)
                    .is_some_and(|tail| tail.contains_key(&stored.source_sequence))
            });
            if !in_tail {
                self.remove(&key, false);
            }
        }
    }
    fn append(&mut self, project: &str, source: &ProjectLogSource, log: LogRecord) {
        self.sequence += 1;
        let received = nanos(&log.received_at).unwrap_or_else(now_nanos);
        let order = log.timestamp.as_deref().and_then(nanos).unwrap_or(received);
        let key = (order, source.full_id.clone(), self.sequence);
        // Future timestamps cannot extend age retention beyond received age.
        let retention_time = order.min(received);
        let pipe = match log.stream {
            LogStreamKind::Stdout => "stdout",
            LogStreamKind::Stderr => "stderr",
            LogStreamKind::Tty => "tty",
        };
        let row = ProjectLogRow {
            row_id: format!("{}:{}", source.full_id, self.sequence),
            sequence: self.sequence,
            source_id: source.source_id.clone(),
            full_id: source.full_id.clone(),
            service_name: source.service_name.clone(),
            container_name: source.container_name.clone(),
            timestamp: log.timestamp,
            received_at: log.received_at,
            pipe: pipe.into(),
            text: log.text,
            truncated: log.truncated,
        };
        // Charge retained fields and all ordered, expiry and tail index keys too,
        // so numerous short rows cannot evade the byte budget via metadata.
        let bytes = std::mem::size_of::<ProjectLogRow>()
            + row.text.capacity()
            + row.row_id.capacity()
            + row.source_id.capacity()
            + row.full_id.capacity()
            + row.container_name.capacity()
            + row.service_name.as_ref().map_or(0, String::capacity)
            + row.timestamp.as_ref().map_or(0, String::capacity)
            + row.received_at.capacity()
            + row.pipe.capacity()
            + project.len()
            + 4 * (std::mem::size_of::<OrderKey>() + source.full_id.len())
            + 128;
        self.bytes += bytes;
        *self.source_bytes.entry(source.full_id.clone()).or_default() += bytes;
        self.source_order
            .entry(source.full_id.clone())
            .or_default()
            .insert(key.clone());
        self.expiry
            .insert((retention_time, self.sequence), key.clone());
        let source_sequence = self
            .source_sequence
            .entry(source.full_id.clone())
            .or_default();
        *source_sequence += 1;
        let source_sequence = *source_sequence;
        let tail = self.source_tail.entry(source.full_id.clone()).or_default();
        tail.insert(source_sequence, key.clone());
        // Quota eviction must not reset the last-300-arrivals boundary.
        let tail_cutoff = source_sequence.saturating_sub(INITIAL_TAIL_ROWS as u64);
        let displaced = tail
            .first_key_value()
            .is_some_and(|(sequence, _)| *sequence <= tail_cutoff)
            .then(|| tail.pop_first().unwrap().1);
        self.rows.insert(
            key,
            StoredRow {
                project: project.into(),
                row,
                bytes,
                retention_time,
                source_sequence,
            },
        );
        // Expired tail rows have already left the expiry index. Recheck the row
        // when a newer arrival displaces it from the protected tail.
        if let Some(key) = displaced {
            let cutoff = received.saturating_sub(RETENTION_SECONDS * 1_000_000_000);
            if let Some(stored) = self.rows.get(&key) {
                if stored.retention_time < cutoff {
                    self.remove(&key, false);
                } else {
                    // A backwards clock may make a previously expired tail row
                    // young again. Restore its age index when protection ends.
                    self.expiry.insert((stored.retention_time, key.2), key);
                }
            }
        }
        while self.source_bytes.get(&source.full_id).copied().unwrap_or(0) > SOURCE_BYTES {
            let key = self
                .source_order
                .get(&source.full_id)
                .and_then(|order| order.first())
                .cloned();
            if let Some(key) = key {
                self.remove(&key, true);
            } else {
                break;
            }
        }
        while self.bytes > MAX_BYTES || self.rows.len() > MAX_ROWS {
            if let Some(key) = self.rows.first_key_value().map(|(key, _)| key.clone()) {
                self.remove(&key, true);
            } else {
                break;
            }
        }
        self.expire(received);
    }
}

type DuplicateKey = (Option<String>, String, String);
struct Source {
    view: ProjectLogSource,
    run: Option<String>,
    token: u64,
    pending_start: Option<u64>,
    task: Option<StreamTask>,
    overlap: HashMap<DuplicateKey, usize>,
    last_seen: i64,
}
#[derive(Default)]
pub(super) struct ProjectLogManager {
    session_id: String,
    project: Option<String>,
    explicit: Option<HashSet<String>>,
    sources: HashMap<String, Source>,
    ring: LogRing,
    revision: u64,
    token: u64,
    needs_selection: bool,
    error: Option<ApiError>,
    archived_gaps: HashMap<String, u64>,
    #[cfg(test)]
    start_registration_barrier: Option<Arc<std::sync::Barrier>>,
}

impl Source {
    fn owns_start(&self, token: u64) -> bool {
        self.token == token
            && self.pending_start == Some(token)
            && self.view.selected
            && self.view.status != "removed"
    }
}

impl ProjectLogManager {
    fn needs_reconnect(&self) -> bool {
        self.error
            .as_ref()
            .is_some_and(|error| connection_invalidated(error) || error.code == "NeedsValidation")
    }
    fn archive_coverage(&mut self) {
        if let Some(project) = &self.project {
            let gaps = self
                .sources
                .values()
                .map(|source| source.view.coverage_gaps + u64::from(source.task.is_some()))
                .sum::<u64>();
            *self.archived_gaps.entry(project.clone()).or_default() += gaps;
        }
    }
    fn overlap(&self, full_id: &str) -> HashMap<DuplicateKey, usize> {
        let mut values = HashMap::new();
        for row in self
            .ring
            .rows
            .values()
            .rev()
            .filter(|stored| stored.row.full_id == full_id)
            .take(2000)
        {
            let row = &row.row;
            if row.timestamp.is_some() {
                *values
                    .entry((row.timestamp.clone(), row.pipe.clone(), row.text.clone()))
                    .or_default() += 1;
            }
        }
        values
    }
    fn receive(&mut self, id: &str, full_id: &str, token: u64, message: ReaderMessage) {
        if self.session_id != id
            || self.error.is_some()
            || !self
                .sources
                .get(full_id)
                .is_some_and(|source| source.token == token)
        {
            return;
        }
        self.revision += 1;
        match message {
            ReaderMessage::Log(log) => {
                let source = self.sources.get_mut(full_id).unwrap();
                if !source.view.selected || source.view.status == "removed" {
                    return;
                }
                let pipe = match log.stream {
                    LogStreamKind::Stdout => "stdout",
                    LogStreamKind::Stderr => "stderr",
                    LogStreamKind::Tty => "tty",
                };
                let duplicate = (log.timestamp.clone(), pipe.to_string(), log.text.clone());
                if let Some(count) = source.overlap.get_mut(&duplicate) {
                    if *count > 0 {
                        *count -= 1;
                        return;
                    }
                }
                if let Some(project) = &self.project {
                    self.ring.append(project, &source.view, log);
                }
            }
            ReaderMessage::Status(status) => {
                let overlap =
                    matches!(status, ReaderStatus::Retrying { .. }).then(|| self.overlap(full_id));
                let source = self.sources.get_mut(full_id).unwrap();
                if source.view.status == "removed" || !source.view.selected {
                    return;
                }
                match status {
                    ReaderStatus::Connecting => source.view.status = "starting".into(),
                    ReaderStatus::Following => {
                        source.view.status = "following".into();
                        source.view.error = None;
                    }
                    ReaderStatus::Retrying {
                        attempt,
                        delay_seconds,
                    } => {
                        source.view.status = "retrying".into();
                        source.view.coverage_gaps += 1;
                        source.view.error = Some(ApiError::new(
                            "LogCoverageGap",
                            format!(
                                "Log stream interrupted; retry {attempt}/5 in {delay_seconds}s. Retained output may contain a gap"
                            ),
                        ));
                        source.overlap = overlap.unwrap_or_default();
                    }
                    ReaderStatus::Ended => source.view.status = "ended".into(),
                    ReaderStatus::Failed(error) => {
                        source.view.status = "error".into();
                        source.view.error = Some(ApiError::new(&error.code, &error.message));
                    }
                }
            }
            ReaderMessage::Event(_) => {}
        }
    }
    fn prune(&mut self) {
        let previous_count = self.ring.rows.len();
        self.ring.expire(now_nanos());
        self.ring.source_dropped.retain(|id, _| {
            self.ring.source_order.contains_key(id) || self.sources.contains_key(id)
        });
        let projects = self
            .ring
            .rows
            .values()
            .map(|stored| &stored.project)
            .collect::<HashSet<_>>();
        self.ring
            .dropped
            .retain(|project, _| projects.contains(project));
        self.archived_gaps.retain(|project, _| {
            self.project.as_ref() == Some(project) || projects.contains(project)
        });
        let cutoff = now_nanos().saturating_sub(RETENTION_SECONDS * 1_000_000_000);
        self.sources.retain(|id, source| {
            source.view.status != "removed"
                || source.last_seen >= cutoff
                || self.ring.source_order.contains_key(id)
        });
        if previous_count != self.ring.rows.len() {
            self.revision += 1;
        }
    }

    fn page(&mut self, query: &ProjectLogQuery) -> ProjectLogPage {
        self.prune();
        let active_project = self.project.as_deref() == Some(&query.project);
        let needle = query.keyword.to_lowercase();
        let source_ids = query.source_ids.iter().collect::<HashSet<_>>();
        let matches = self
            .ring
            .rows
            .values()
            .filter(|stored| {
                stored.project == query.project
                    && query
                        .through_sequence
                        .is_none_or(|sequence| stored.row.sequence <= sequence)
                    && (source_ids.is_empty() || source_ids.contains(&stored.row.source_id))
                    && (needle.is_empty() || stored.row.text.to_lowercase().contains(&needle))
            })
            .collect::<Vec<_>>();
        let total = matches.len();
        let limit = query.limit.clamp(1, 500);
        let anchored = query.anchor_row_id.as_ref().and_then(|anchor| {
            matches
                .iter()
                .position(|stored| &stored.row.row_id == anchor)
        });
        let offset = if let Some(offset) = anchored.or(query.offset) {
            offset.min(total.saturating_sub(1))
        } else {
            // A byte-limited latest page must end at the newest row, including
            // when only a few long lines fit in the IPC payload.
            let mut bytes = 0usize;
            let count = matches
                .iter()
                .rev()
                .take(limit)
                .take_while(|stored| {
                    bytes += stored.bytes;
                    bytes <= PAGE_BYTES
                })
                .count();
            total.saturating_sub(count)
        };
        let mut bytes = 0usize;
        let rows = matches
            .iter()
            .skip(offset)
            .take(limit)
            .take_while(|stored| {
                bytes += stored.bytes;
                bytes <= PAGE_BYTES
            })
            .map(|stored| stored.row.clone())
            .collect();
        let mut sources = self
            .sources
            .values()
            .filter(|_| active_project)
            .map(|source| {
                let mut view = source.view.clone();
                view.dropped_rows = self
                    .ring
                    .source_dropped
                    .get(&view.source_id)
                    .copied()
                    .unwrap_or(0);
                view
            })
            .collect::<Vec<_>>();
        sources.sort_by(|a, b| {
            (&a.service_name, &a.container_name, &a.full_id).cmp(&(
                &b.service_name,
                &b.container_name,
                &b.full_id,
            ))
        });
        ProjectLogPage {
            session_id: self.session_id.clone(),
            project: query.project.clone(),
            revision: self.revision,
            max_sequence: self.ring.sequence,
            rows,
            coverage_gaps: sources
                .iter()
                .map(|source| source.coverage_gaps)
                .sum::<u64>()
                + self.archived_gaps.get(&query.project).copied().unwrap_or(0),
            sources,
            total_rows: total,
            offset,
            dropped_rows: self.ring.dropped.get(&query.project).copied().unwrap_or(0),
            needs_selection: active_project && self.needs_selection,
            retained_from: matches.first().map(|stored| {
                stored
                    .row
                    .timestamp
                    .clone()
                    .unwrap_or_else(|| stored.row.received_at.clone())
            }),
            retained_to: matches.last().map(|stored| {
                stored
                    .row
                    .timestamp
                    .clone()
                    .unwrap_or_else(|| stored.row.received_at.clone())
            }),
            anchor_lost: query.anchor_row_id.is_some() && anchored.is_none(),
            error: active_project.then(|| self.error.clone()).flatten(),
        }
    }
}

fn latest_query(project: String) -> ProjectLogQuery {
    ProjectLogQuery {
        project,
        source_ids: Vec::new(),
        keyword: String::new(),
        offset: None,
        limit: 500,
        through_sequence: None,
        anchor_row_id: None,
    }
}

/// Called only by synchronous Core workers, never from a stream callback.
/// Cancellation releases all socket permits before a replacement fanout starts.
fn retire(tasks: Vec<StreamTask>) {
    for task in &tasks {
        task.cancel();
    }
    if !tasks.is_empty() {
        tauri::async_runtime::block_on(async move {
            for task in tasks {
                task.join().await;
            }
        });
    }
}

impl Core {
    /// An Engine start is authoritative even if an older CLI omits StartedAt.
    /// The inventory scheduler will reconcile and reopen the source off-runtime.
    pub(super) fn mark_project_log_started(&self, id: &str, full_id: &str) {
        let mut manager = self.project_logs.lock().unwrap();
        if manager.session_id != id {
            return;
        }
        if let Some(source) = manager.sources.get_mut(full_id) {
            source.run = None;
        }
    }
    /// May be called from a Tokio stream callback. Never wait for that task here.
    pub(super) fn invalidate_project_logs(&self, id: &str, error: &ApiError) {
        let tasks = {
            let mut manager = self.project_logs.lock().unwrap();
            if manager.session_id != id {
                return;
            }
            manager.error = Some(error.clone());
            manager.revision += 1;
            manager
                .sources
                .values_mut()
                .filter_map(|source| {
                    source.view.status = "error".into();
                    source.pending_start = None;
                    source.view.error = Some(error.clone());
                    source.view.coverage_gaps += 1;
                    source.task.take()
                })
                .collect::<Vec<_>>()
        };
        for task in &tasks {
            task.cancel();
        }
        drop(tasks);
    }

    pub(super) fn cancel_project_logs(&self) {
        let mut previous = std::mem::take(&mut *self.project_logs.lock().unwrap());
        retire(
            previous
                .sources
                .drain()
                .filter_map(|(_, source)| source.task)
                .collect(),
        );
    }

    pub fn stop_project_logs(&self, id: &str) -> Result<()> {
        self.active(id)?;
        let tasks = {
            let mut manager = self.project_logs.lock().unwrap();
            manager.archive_coverage();
            manager.project = None;
            manager
                .sources
                .drain()
                .filter_map(|(_, source)| source.task)
                .collect::<Vec<_>>()
        };
        retire(tasks);
        Ok(())
    }

    pub fn configure_project_logs(
        &self,
        id: &str,
        project: &str,
        handles: Option<Vec<String>>,
    ) -> Result<ProjectLogPage> {
        let session = self.active(id)?;
        #[cfg(test)]
        if let Some(barrier) = &self.log_registration_barrier {
            barrier.wait();
            barrier.wait();
        }
        if project.is_empty() || project.len() > 4096 {
            return Err(ApiError::new(
                "InvalidSelection",
                "Select a Compose project",
            ));
        }
        let explicit = if let Some(handles) = handles {
            if handles.len() > MAX_SOURCES {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Select at most 64 containers",
                ));
            }
            let mut full_ids = HashSet::new();
            for handle in handles {
                let container = session.handles.get(&handle).ok_or_else(|| {
                    ApiError::new("StaleHandle", "Select from the latest container list")
                })?;
                if container.compose_project.as_deref() != Some(project)
                    || !full_ids.insert(container.full_id.clone())
                {
                    return Err(ApiError::new(
                        "InvalidSelection",
                        "Log sources must be unique members of the selected project",
                    ));
                }
            }
            Some(full_ids)
        } else {
            None
        };
        let old = {
            let mut manager = self.project_logs.lock().unwrap();
            // Pair registration with shutdown/reconnect's session retirement.
            // Never publish a manager using a session cloned before retirement.
            if self.active(id)?.needs_validation
                || (manager.session_id == id && manager.needs_reconnect())
            {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Reconnect before collecting logs",
                ));
            }
            let mut old = Vec::new();
            if manager.session_id != id {
                old.extend(
                    manager
                        .sources
                        .drain()
                        .filter_map(|(_, source)| source.task),
                );
                *manager = ProjectLogManager {
                    session_id: id.into(),
                    ..Default::default()
                };
            }
            let changed = manager.project.as_deref() != Some(project);
            if changed {
                manager.archive_coverage();
            }
            manager.project = Some(project.into());
            manager.explicit = explicit;
            if manager.error.take().is_some() && !changed {
                for source in manager.sources.values_mut() {
                    source.token = 0;
                    source.pending_start = None;
                    source.run = None;
                    source.view.status = "idle".into();
                    if let Some(task) = source.task.take() {
                        old.push(task);
                    }
                }
            }
            if changed {
                old.extend(
                    manager
                        .sources
                        .drain()
                        .filter_map(|(_, source)| source.task),
                );
            }
            old
        };
        retire(old);
        self.cancel_log_stream();
        self.sync_project_log_containers(id, session.handles.values().cloned().collect());
        self.query_project_logs(id, &latest_query(project.into()))
    }

    pub fn retry_project_logs(&self, id: &str) -> Result<ProjectLogPage> {
        let session = self.active(id)?;
        let (project, tasks) = {
            let mut manager = self.project_logs.lock().unwrap();
            if self.active(id)?.needs_validation || manager.needs_reconnect() {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Reconnect before resuming logs",
                ));
            }
            if manager.session_id != id {
                return Err(ApiError::new(
                    "StaleSession",
                    "Project logs belong to a previous session",
                ));
            }
            let project = manager
                .project
                .clone()
                .ok_or_else(|| ApiError::new("InvalidSelection", "Select a Compose project"))?;
            // Retriable collection failures must not suppress the replacement starts.
            manager.error = None;
            let tasks = manager
                .sources
                .values_mut()
                .filter_map(|source| {
                    if matches!(
                        source.view.status.as_str(),
                        "error" | "ended" | "retrying" | "starting"
                    ) {
                        // Fence callbacks and registrations from an earlier start
                        // before dropping the lock to retire its transport.
                        source.token = 0;
                        source.pending_start = None;
                        source.run = None;
                        source.view.status = "idle".into();
                        source.task.take()
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            (project, tasks)
        };
        retire(tasks);
        self.sync_project_log_containers(id, session.handles.values().cloned().collect());
        self.query_project_logs(id, &latest_query(project))
    }

    pub fn query_project_logs(&self, id: &str, query: &ProjectLogQuery) -> Result<ProjectLogPage> {
        self.active(id)?;
        // The live fanout cap does not cap retained source IDs after recreation.
        if query.keyword.len() > 4096
            || query.project.len() > 4096
            || query.source_ids.len() > MAX_ROWS
            || query.source_ids.iter().any(|id| !valid_id(id))
        {
            return Err(ApiError::new("InvalidSelection", "Log filter is too large"));
        }
        let mut manager = self.project_logs.lock().unwrap();
        if manager.session_id != id {
            return Err(ApiError::new(
                "StaleSession",
                "Project logs belong to a previous session",
            ));
        }
        Ok(manager.page(query))
    }

    pub(super) fn sync_project_log_inventory(&self, inventory: &ContainerList) {
        self.sync_project_log_containers(&inventory.session_id, inventory.containers.clone());
    }

    fn sync_project_log_containers(&self, id: &str, containers: Vec<Container>) {
        let (starts, stops) = {
            let mut manager = self.project_logs.lock().unwrap();
            if manager.session_id != id {
                return;
            }
            manager.prune();
            let Some(project) = manager.project.clone() else {
                return;
            };
            let mut candidates = containers
                .into_iter()
                .filter(|container| container.compose_project.as_deref() == Some(&project))
                .collect::<Vec<_>>();
            candidates.sort_by(|a, b| a.full_id.cmp(&b.full_id));
            manager.needs_selection = manager.explicit.is_none() && candidates.len() > MAX_SOURCES;
            let mut starts = Vec::new();
            let mut stops = Vec::new();
            let collection_error = manager.error.clone();
            let present = candidates
                .iter()
                .map(|container| container.full_id.clone())
                .collect::<HashSet<_>>();
            for source in manager.sources.values_mut() {
                if !present.contains(&source.view.full_id) {
                    source.view.status = "removed".into();
                    source.view.selected = false;
                    source.run = None;
                    source.token = 0;
                    source.pending_start = None;
                    if let Some(task) = source.task.take() {
                        source.view.coverage_gaps += 1;
                        stops.push(task);
                    }
                }
            }
            for container in candidates {
                let selected = !manager.needs_selection
                    && manager
                        .explicit
                        .as_ref()
                        .is_none_or(|ids| ids.contains(&container.full_id));
                let readable = matches!(
                    container.state.as_str(),
                    "created" | "running" | "paused" | "restarting" | "exited" | "dead"
                );
                let source = manager
                    .sources
                    .entry(container.full_id.clone())
                    .or_insert_with(|| Source {
                        view: ProjectLogSource {
                            source_id: container.full_id.clone(),
                            full_id: container.full_id.clone(),
                            service_name: container.compose_service.clone(),
                            container_name: container.name.clone(),
                            selected,
                            status: "idle".into(),
                            error: None,
                            dropped_rows: 0,
                            coverage_gaps: 0,
                        },
                        run: None,
                        token: 0,
                        pending_start: None,
                        task: None,
                        overlap: HashMap::new(),
                        last_seen: now_nanos(),
                    });
                source.last_seen = now_nanos();
                source.view.service_name = container.compose_service.clone();
                source.view.container_name = container.name.clone();
                source.view.selected = selected;
                let run = container
                    .started_at
                    .clone()
                    .or_else(|| Some(container.created_at.clone()));
                if !selected || !readable {
                    source.token = 0;
                    source.pending_start = None;
                    if let Some(task) = source.task.take() {
                        source.view.coverage_gaps += 1;
                        stops.push(task);
                    }
                    source.view.status = "idle".into();
                    source.run = None;
                } else if let Some(error) = &collection_error {
                    // Keep inventory identity current while a collection-wide
                    // error blocks starts; do not leave a phantom reservation.
                    source.token = 0;
                    source.pending_start = None;
                    source.run = None;
                    source.view.status = "error".into();
                    source.view.error = Some(error.clone());
                    if let Some(task) = source.task.take() {
                        stops.push(task);
                    }
                } else if source.run != run
                    || source.view.status == "idle"
                    || (source.view.status == "starting"
                        && source.task.is_none()
                        && source.pending_start.is_none())
                {
                    if let Some(task) = source.task.take() {
                        source.view.coverage_gaps += 1;
                        stops.push(task);
                    }
                    source.run = run;
                    source.view.status = "starting".into();
                    source.view.error = None;
                    manager.token += 1;
                    let token = manager.token;
                    let overlap = manager.overlap(&container.full_id);
                    let source = manager.sources.get_mut(&container.full_id).unwrap();
                    source.token = token;
                    source.pending_start = Some(token);
                    source.overlap = overlap;
                    starts.push((container, token));
                }
            }
            manager.revision += 1;
            (starts, stops)
        };
        retire(stops);
        if starts.is_empty() {
            return;
        }
        #[cfg(test)]
        let registration_barrier = self
            .project_logs
            .lock()
            .unwrap()
            .start_registration_barrier
            .take();
        #[cfg(test)]
        if let Some(barrier) = registration_barrier {
            barrier.wait();
            barrier.wait();
        }
        let reader = match self.observation_reader(id) {
            Ok(reader) => reader,
            Err(error) => {
                let mut manager = self.project_logs.lock().unwrap();
                if manager.session_id == id
                    && manager.error.is_none()
                    && starts.iter().any(|(container, token)| {
                        manager
                            .sources
                            .get(&container.full_id)
                            .is_some_and(|source| source.owns_start(*token))
                    })
                {
                    manager.error = Some(error.clone());
                    // This manager-wide error prevents every pending start. None
                    // may retain an abandoned reservation when configuration retries.
                    for source in manager.sources.values_mut() {
                        if source.pending_start.take().is_some() {
                            source.view.status = "error".into();
                            source.view.error = Some(error.clone());
                        }
                    }
                }
                return;
            }
        };
        for (container, token) in starts {
            let weak = Arc::downgrade(&self.project_logs);
            let state = Arc::downgrade(&self.state);
            let observation = Arc::downgrade(&self.observation);
            let session_id = id.to_string();
            let full_id = container.full_id.clone();
            let sink = Arc::new(move |message: ReaderMessage| {
                let Some(manager) = weak.upgrade() else {
                    return;
                };
                let invalidates = match &message {
                    ReaderMessage::Status(ReaderStatus::Failed(error))
                        if error.invalidates_session =>
                    {
                        Some(ApiError::new(&error.code, &error.message))
                    }
                    _ => None,
                };
                {
                    let mut manager = manager.lock().unwrap();
                    if manager.session_id != session_id
                        || manager.error.is_some()
                        || !manager.sources.get(&full_id).is_some_and(|source| {
                            source.token == token
                                && source.view.selected
                                && source.view.status != "removed"
                        })
                    {
                        return;
                    }
                    manager.receive(&session_id, &full_id, token, message);
                }
                if let Some(error) = invalidates {
                    if let Some(state) = state.upgrade() {
                        if let Some(session) = state
                            .lock()
                            .unwrap()
                            .session
                            .as_mut()
                            .filter(|session| session.id == session_id)
                        {
                            session.stale = true;
                            session.needs_validation = true;
                        }
                    }
                    let service = observation.upgrade().and_then(|observation| {
                        observation
                            .lock()
                            .unwrap()
                            .as_ref()
                            .filter(|service| service.session_id == session_id)
                            .cloned()
                    });
                    if let Some(service) = service {
                        service.invalidate(&error);
                    }
                    let tasks = {
                        let mut manager = manager.lock().unwrap();
                        if manager.session_id != session_id {
                            return;
                        }
                        manager.error = Some(error);
                        manager
                            .sources
                            .values_mut()
                            .filter_map(|source| {
                                source.view.status = "error".into();
                                source.pending_start = None;
                                source.task.take()
                            })
                            .collect::<Vec<_>>()
                    };
                    drop(tasks);
                }
            });
            // spawn_logs does not await or invoke the sink synchronously. Publish
            // its task under the same lock as the reservation check so a retry
            // cannot cancel a reservation and then receive its late registration.
            let mut manager = self.project_logs.lock().unwrap();
            if manager.session_id != id || manager.error.is_some() {
                continue;
            }
            let Some(source) = manager
                .sources
                .get_mut(&container.full_id)
                .filter(|source| source.owns_start(token))
            else {
                continue;
            };
            let result = reader.spawn_logs(
                LogRequest {
                    full_id: container.full_id.clone(),
                    tty: container.tty,
                    // Start from Docker's latest output, including quiet sources.
                    // EngineReader advances its timestamp cursor on reconnects.
                    since: None,
                    tail: INITIAL_TAIL_ROWS as u16,
                },
                sink,
            );
            source.pending_start = None;
            match result {
                Ok(task) => source.task = Some(task),
                Err(error) => {
                    source.view.status = "error".into();
                    source.view.error = Some(ApiError::new(&error.code, &error.message));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(id: &str) -> ProjectLogSource {
        ProjectLogSource {
            source_id: id.into(),
            full_id: id.into(),
            service_name: Some("api".into()),
            container_name: id.into(),
            selected: true,
            status: "following".into(),
            error: None,
            dropped_rows: 0,
            coverage_gaps: 0,
        }
    }
    fn log(timestamp: &str, text: &str) -> LogRecord {
        LogRecord {
            timestamp: Some(timestamp.into()),
            received_at: Utc::now().to_rfc3339(),
            stream: LogStreamKind::Stdout,
            text: text.into(),
            truncated: false,
        }
    }
    #[test]
    fn late_rows_sort_at_nanosecond_precision_and_pause_excludes_new_sequences() {
        let mut manager = ProjectLogManager {
            session_id: "session".into(),
            ..Default::default()
        };
        let time = Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        manager.ring.append(
            "project",
            &source("b"),
            log(&format!("{time}.000000003Z"), "third"),
        );
        manager.ring.append(
            "project",
            &source("a"),
            log(&format!("{time}.000000001Z"), "first"),
        );
        let mut query = latest_query("project".into());
        query.through_sequence = Some(2);
        manager.ring.append(
            "project",
            &source("a"),
            log(&format!("{time}.000000002Z"), "second"),
        );
        assert_eq!(
            manager
                .page(&query)
                .rows
                .iter()
                .map(|row| row.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "third"]
        );
        query.through_sequence = None;
        assert_eq!(
            manager
                .page(&query)
                .rows
                .iter()
                .map(|row| row.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "second", "third"]
        );
    }
    #[test]
    fn filtering_anchor_and_project_boundaries_are_applied_before_paging() {
        let mut manager = ProjectLogManager::default();
        let time = Utc::now().to_rfc3339();
        for (project, id, text) in [
            ("p", "a", "Error first"),
            ("p", "b", "ERROR second"),
            ("other", "a", "error private"),
        ] {
            manager.ring.append(project, &source(id), log(&time, text));
        }
        let mut query = latest_query("p".into());
        query.keyword = "error".into();
        query.source_ids = vec!["b".into()];
        let page = manager.page(&query);
        assert_eq!(page.total_rows, 1);
        assert_eq!(page.rows[0].text, "ERROR second");
        query.source_ids.clear();
        query.anchor_row_id = Some(page.rows[0].row_id.clone());
        assert_eq!(manager.page(&query).offset, 1);
    }
    #[test]
    fn noisy_source_quota_preserves_quiet_tail_after_expiry() {
        let mut ring = LogRing::default();
        let time = Utc::now().to_rfc3339();
        ring.append("p", &source("quiet"), log(&time, "keep"));
        for _ in 0..40 {
            ring.append("p", &source("noisy"), log(&time, &"x".repeat(64 * 1024)));
        }
        assert!(ring.bytes < SOURCE_BYTES + 1024);
        assert!(ring.rows.values().any(|stored| stored.row.text == "keep"));
        assert!(ring.dropped["p"] > 0);
        assert!(
            ring.source_tail
                .values()
                .flat_map(|tail| tail.values())
                .all(|key| ring.rows.contains_key(key))
        );
        ring.expire(now_nanos() + (RETENTION_SECONDS + 1) * 1_000_000_000);
        assert!(ring.rows.values().any(|stored| stored.row.text == "keep"));
        assert!(ring.bytes < SOURCE_BYTES + 1024);
        assert!(ring.expiry.is_empty());
        assert!(
            ring.source_tail
                .values()
                .all(|tail| tail.len() <= INITIAL_TAIL_ROWS)
        );
    }

    #[test]
    fn quota_eviction_does_not_extend_the_last_300_arrivals_boundary() {
        let mut ring = LogRing::default();
        let now = Utc::now();
        ring.append("p", &source("a"), log(&now.to_rfc3339(), "first arrival"));
        let old = (now - chrono::Duration::days(5)).to_rfc3339();
        for _ in 0..INITIAL_TAIL_ROWS {
            ring.append("p", &source("a"), log(&old, &"x".repeat(64 * 1024)));
        }
        assert!(
            ring.rows
                .values()
                .any(|stored| stored.row.text == "first arrival")
        );
        ring.expire(
            (now + chrono::Duration::minutes(31))
                .timestamp_nanos_opt()
                .unwrap(),
        );
        assert!(
            !ring
                .rows
                .values()
                .any(|stored| stored.row.text == "first arrival")
        );
        assert!(!ring.rows.is_empty());
        assert!(ring.bytes <= SOURCE_BYTES);
        assert!(
            ring.source_tail
                .values()
                .flat_map(|tail| tail.values())
                .all(|key| ring.rows.contains_key(key))
        );
    }

    #[test]
    fn latest_byte_limited_page_ends_at_newest_row() {
        let mut manager = ProjectLogManager::default();
        let time = Utc::now().to_rfc3339();
        for index in 0..48 {
            manager.ring.append(
                "p",
                &source(&format!("a{index:02}")),
                log(&time, &format!("{index}:{}", "x".repeat(60 * 1024))),
            );
        }
        let page = manager.page(&latest_query("p".into()));
        assert_eq!(page.offset + page.rows.len(), page.total_rows);
        assert!(page.rows.last().unwrap().text.starts_with("47:"));
        assert!(
            page.rows
                .iter()
                .map(|row| row.text.len() + 256)
                .sum::<usize>()
                <= PAGE_BYTES
        );
    }

    #[test]
    fn overlap_preserves_repeated_occurrences_and_untimestamped_rows() {
        let mut manager = ProjectLogManager {
            session_id: "s".into(),
            project: Some("p".into()),
            ..Default::default()
        };
        let time = Utc::now().to_rfc3339();
        for _ in 0..2 {
            manager
                .ring
                .append("p", &source("a"), log(&time, "repeated"));
        }
        let overlap = manager.overlap("a");
        manager.sources.insert(
            "a".into(),
            Source {
                view: source("a"),
                run: None,
                token: 7,
                pending_start: None,
                task: None,
                overlap,
                last_seen: now_nanos(),
            },
        );
        for _ in 0..3 {
            manager.receive("s", "a", 7, ReaderMessage::Log(log(&time, "repeated")));
        }
        let mut untimed = log(&time, "untimed");
        untimed.timestamp = None;
        manager.receive("s", "a", 7, ReaderMessage::Log(untimed.clone()));
        manager.sources.get_mut("a").unwrap().overlap = manager.overlap("a");
        manager.receive("s", "a", 7, ReaderMessage::Log(untimed));
        let page = manager.page(&latest_query("p".into()));
        assert_eq!(
            page.rows
                .iter()
                .filter(|row| row.text == "repeated")
                .count(),
            3
        );
        assert_eq!(
            page.rows.iter().filter(|row| row.text == "untimed").count(),
            2
        );
    }

    #[test]
    fn invalidated_manager_rejects_late_rows_and_status_callbacks() {
        let mut manager = ProjectLogManager {
            session_id: "s".into(),
            project: Some("p".into()),
            error: Some(ApiError::new("NeedsValidation", "reconnect")),
            ..Default::default()
        };
        manager.sources.insert(
            "a".into(),
            Source {
                view: source("a"),
                run: None,
                token: 7,
                pending_start: None,
                task: None,
                overlap: HashMap::new(),
                last_seen: now_nanos(),
            },
        );
        manager.receive(
            "s",
            "a",
            7,
            ReaderMessage::Log(log(&Utc::now().to_rfc3339(), "late")),
        );
        manager.receive("s", "a", 7, ReaderMessage::Status(ReaderStatus::Following));
        assert!(manager.ring.rows.is_empty());
        assert_eq!(manager.revision, 0);
        assert_eq!(manager.error.as_ref().unwrap().code, "NeedsValidation");
    }

    #[test]
    fn sixty_four_sources_obey_global_row_and_byte_caps() {
        let mut manager = ProjectLogManager::default();
        let time = Utc::now().to_rfc3339();
        let sources = (0..64)
            .map(|index| source(&format!("{index:064x}")))
            .collect::<Vec<_>>();
        for index in 0..100_128 {
            manager
                .ring
                .append("p", &sources[index % 64], log(&time, "Error"));
        }
        assert!(manager.ring.rows.len() <= MAX_ROWS);
        assert!(manager.ring.bytes <= MAX_BYTES);
        // With equal Docker timestamps the global byte cap may evict all rows
        // from some sources. Collection coverage is independent of retention.
        assert!(!manager.ring.source_order.is_empty());
        assert!(manager.ring.source_order.len() <= 64);
        let payload = "x".repeat(64 * 1024);
        for index in 0..1024 {
            manager
                .ring
                .append("p", &sources[index % 64], log(&time, &payload));
        }
        assert!(manager.ring.bytes <= MAX_BYTES);
        assert!(
            manager
                .ring
                .source_bytes
                .values()
                .all(|bytes| *bytes <= SOURCE_BYTES)
        );
        assert!(manager.ring.dropped["p"] > 0);
        assert!(
            manager
                .ring
                .source_tail
                .values()
                .all(|tail| tail.len() <= INITIAL_TAIL_ROWS)
        );
        assert!(
            manager
                .ring
                .source_tail
                .values()
                .flat_map(|tail| tail.values())
                .all(|key| manager.ring.rows.contains_key(key))
        );
        assert!(
            manager
                .ring
                .expiry
                .values()
                .all(|key| manager.ring.rows.contains_key(key))
        );
        let mut query = latest_query("p".into());
        query.source_ids = vec![sources[63].full_id.clone()];
        let page = manager.page(&query);
        assert!(
            page.rows
                .iter()
                .all(|row| row.full_id == sources[63].full_id)
        );
        assert_eq!(page.offset + page.rows.len(), page.total_rows);
    }

    #[test]
    fn quiet_sources_keep_their_latest_received_tail_independently_of_timestamp_age() {
        let mut ring = LogRing::default();
        let now = Utc::now();
        let old = (now - chrono::Duration::days(5)).to_rfc3339();
        ring.append("p", &source("quiet"), log(&old, "only output"));
        for index in 0..350 {
            ring.append("p", &source("a"), log(&old, &format!("line {index}")));
        }
        ring.expire(
            (now + chrono::Duration::days(1))
                .timestamp_nanos_opt()
                .unwrap(),
        );
        let retained = ring
            .rows
            .values()
            .filter(|stored| stored.row.source_id == "a")
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), INITIAL_TAIL_ROWS);
        assert_eq!(retained.first().unwrap().row.text, "line 50");
        assert_eq!(retained.last().unwrap().row.text, "line 349");
        assert!(
            retained
                .iter()
                .all(|stored| stored.row.timestamp.as_deref() == Some(old.as_str()))
        );
        assert!(
            ring.rows
                .values()
                .any(|stored| stored.row.text == "only output")
        );
        assert!(ring.dropped.is_empty());
        assert!(ring.expiry.is_empty());
    }

    #[test]
    fn recent_extra_history_expires_but_late_arrivals_enter_the_protected_tail() {
        let mut ring = LogRing::default();
        let now = Utc::now();
        let time = now.to_rfc3339();
        for index in 0..350 {
            ring.append("p", &source("a"), log(&time, &format!("line {index}")));
        }
        assert_eq!(ring.rows.len(), 350);
        let old = (now - chrono::Duration::days(2)).to_rfc3339();
        ring.append("p", &source("a"), log(&old, "late old timestamp"));
        assert_eq!(ring.rows.len(), 351);
        ring.expire(
            (now + chrono::Duration::minutes(31))
                .timestamp_nanos_opt()
                .unwrap(),
        );
        assert_eq!(ring.rows.len(), INITIAL_TAIL_ROWS);
        assert_eq!(
            ring.rows.first_key_value().unwrap().1.row.text,
            "late old timestamp"
        );
        assert_eq!(
            ring.rows.values().map(|stored| stored.row.sequence).min(),
            Some(52)
        );
        assert!(ring.dropped.is_empty());
    }

    #[test]
    fn future_timestamps_and_out_of_order_received_times_use_received_age_for_extra_rows() {
        let mut ring = LogRing::default();
        let now = Utc::now();
        let future = (now + chrono::Duration::days(5)).to_rfc3339();
        for index in 0..302 {
            let mut entry = log(&future, &format!("line {index}"));
            entry.received_at = if index == 1 {
                now
            } else {
                now + chrono::Duration::minutes(20)
            }
            .to_rfc3339();
            ring.append("p", &source("a"), entry);
        }
        ring.expire(
            (now + chrono::Duration::minutes(31))
                .timestamp_nanos_opt()
                .unwrap(),
        );
        assert_eq!(ring.rows.len(), 301);
        assert!(!ring.rows.values().any(|stored| stored.row.text == "line 1"));
        assert!(ring.rows.values().any(|stored| stored.row.text == "line 0"));
        ring.expire(
            (now + chrono::Duration::minutes(51))
                .timestamp_nanos_opt()
                .unwrap(),
        );
        assert_eq!(ring.rows.len(), INITIAL_TAIL_ROWS);
        assert!(!ring.rows.values().any(|stored| stored.row.text == "line 0"));
        assert!(ring.expiry.is_empty());
    }

    #[test]
    fn displaced_tail_returns_to_age_index_after_a_backwards_received_time() {
        let mut ring = LogRing::default();
        let now = Utc::now();
        let time = now.to_rfc3339();
        for index in 0..INITIAL_TAIL_ROWS {
            ring.append("p", &source("a"), log(&time, &format!("line {index}")));
        }
        let later = (now + chrono::Duration::minutes(31))
            .timestamp_nanos_opt()
            .unwrap();
        ring.expire(later);
        assert!(ring.expiry.is_empty());
        ring.append("p", &source("a"), log(&time, "clock moved backwards"));
        ring.expire(later);
        assert_eq!(ring.rows.len(), INITIAL_TAIL_ROWS);
        assert!(!ring.rows.values().any(|stored| stored.row.text == "line 0"));
    }

    #[test]
    fn removed_source_tail_is_released_on_eviction_and_session_reset() {
        let (core, containers) = core_with_project();
        let old = Utc::now() - chrono::Duration::days(5);
        {
            let mut manager = core.project_logs.lock().unwrap();
            manager.session_id = "s".into();
            manager.project = Some("p".into());
            for container in containers.iter().take(2) {
                let mut view = source(&container.full_id);
                view.status = "removed".into();
                manager
                    .ring
                    .append("p", &view, log(&old.to_rfc3339(), "old retained"));
                manager.sources.insert(
                    container.full_id.clone(),
                    Source {
                        view,
                        run: None,
                        token: 0,
                        pending_start: None,
                        task: None,
                        overlap: HashMap::new(),
                        last_seen: old.timestamp_nanos_opt().unwrap(),
                    },
                );
            }
            manager.prune();
            assert_eq!(manager.sources.len(), 2);
            let key = manager.ring.source_order[&containers[0].full_id]
                .first()
                .unwrap()
                .clone();
            manager.ring.remove(&key, true);
            manager.prune();
            assert_eq!(manager.sources.len(), 1);
            assert!(
                !manager
                    .ring
                    .source_tail
                    .contains_key(&containers[0].full_id)
            );
        }
        core.cancel_project_logs();
        let manager = core.project_logs.lock().unwrap();
        assert!(manager.ring.rows.is_empty());
        assert!(manager.ring.expiry.is_empty());
        assert!(manager.ring.source_tail.is_empty());
        assert!(manager.ring.source_order.is_empty());
        assert!(manager.ring.source_bytes.is_empty());
        assert!(manager.ring.source_sequence.is_empty());
        assert!(manager.sources.is_empty());
        assert_eq!(manager.ring.bytes, 0);
    }

    #[test]
    fn switching_projects_preserves_coverage_without_leaking_active_sources() {
        let mut manager = ProjectLogManager {
            session_id: "s".into(),
            project: Some("old".into()),
            ..Default::default()
        };
        let mut view = source("a");
        view.coverage_gaps = 2;
        manager
            .ring
            .append("old", &view, log(&Utc::now().to_rfc3339(), "retained"));
        manager.sources.insert(
            "a".into(),
            Source {
                view,
                run: None,
                token: 1,
                pending_start: None,
                task: None,
                overlap: HashMap::new(),
                last_seen: now_nanos(),
            },
        );
        manager.archive_coverage();
        manager.sources.clear();
        manager.project = Some("new".into());
        manager.needs_selection = true;
        manager.error = Some(ApiError::new(
            "ObservationDenied",
            "new project source failed",
        ));
        let old = manager.page(&latest_query("old".into()));
        assert_eq!(old.rows[0].text, "retained");
        assert_eq!(old.coverage_gaps, 2);
        assert!(old.sources.is_empty());
        assert!(!old.needs_selection);
        assert!(old.error.is_none());
    }

    fn core_with_project() -> (Core, Vec<Container>) {
        let core = Core::default();
        let containers = (0..65)
            .map(|index| Container {
                handle: format!("h{index}"),
                full_id: format!("{index:064x}"),
                short_id: format!("{index:012x}"),
                name: format!("api-{index}"),
                image: "fixture".into(),
                state: "running".into(),
                health: None,
                ports: vec![],
                created_at: Utc::now().to_rfc3339(),
                started_at: None,
                tty: false,
                compose_project: Some("p".into()),
                compose_service: Some("api".into()),
            })
            .collect::<Vec<_>>();
        core.state.lock().unwrap().session = Some(Session {
            id: "s".into(),
            generation: 1,
            handles: containers
                .iter()
                .map(|item| (item.handle.clone(), item.clone()))
                .collect(),
            stale: false,
            needs_validation: false,
            inventory: None,
            target: Target {
                docker: PathBuf::new(),
                client_version: String::new(),
                endpoint: format!(
                    "unix:///private/tmp/d2u-absent-{}.sock",
                    uuid::Uuid::new_v4()
                ),
                env: vec![],
                docker_config: PathBuf::new(),
                fingerprint: Fingerprint {
                    id: "fixture".into(),
                    server: "27.5.0".into(),
                    api: "1.47".into(),
                    os: "linux".into(),
                    arch: "aarch64".into(),
                    name: "fixture".into(),
                },
            },
        });
        (core, containers)
    }

    #[test]
    fn initial_stream_requests_latest_tail_without_since_and_retains_historical_backlog() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::os::unix::net::UnixListener;
        use std::sync::mpsc;
        use std::time::Instant;

        struct SocketDirectory(PathBuf);
        impl Drop for SocketDirectory {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let directory = SocketDirectory(
            Path::new("/tmp")
                .canonicalize()
                .unwrap()
                .join(format!("d2u-log-tail-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir(&directory.0).unwrap();
        let socket = directory.0.join("engine.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (core, containers) = core_with_project();
        {
            let mut state = core.state.lock().unwrap();
            let session = state.session.as_mut().unwrap();
            session.target.endpoint = format!("unix://{}", socket.display());
            session.handles.retain(|handle, _| handle == "h0");
            session.handles.get_mut("h0").unwrap().tty = true;
        }
        let old = (Utc::now() - chrono::Duration::days(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
        let old_sent = old.clone();
        let full_id = containers[0].full_id.clone();
        let (follow, followed) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(Instant::now() < deadline, "no Engine connection");
                std::thread::sleep(Duration::from_millis(5));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            for expected in ["/v1.47/version", "/v1.47/info", "logs"] {
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut headers = String::new();
                loop {
                    headers.clear();
                    reader.read_line(&mut headers).unwrap();
                    if headers == "\r\n" {
                        break;
                    }
                    assert!(!headers.is_empty(), "incomplete Engine request");
                }
                if expected == "logs" {
                    assert_eq!(
                        first.trim(),
                        format!(
                            "GET /v1.47/containers/{full_id}/logs?stdout=1&stderr=1&timestamps=1&follow=1&tail=300 HTTP/1.1"
                        )
                    );
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                        .unwrap();
                    let backlog = (0..INITIAL_TAIL_ROWS)
                        .map(|index| format!("{old_sent} historical {index}\n"))
                        .collect::<String>();
                    write!(stream, "{:X}\r\n{}\r\n", backlog.len(), backlog).unwrap();
                    // Keep the stream open so the test controls when new output arrives.
                    followed.recv_timeout(Duration::from_secs(5)).unwrap();
                    let live = format!("{} fresh output\n", Utc::now().to_rfc3339());
                    write!(stream, "{:X}\r\n{}\r\n", live.len(), live).unwrap();
                    let mut byte = [0];
                    let _ = reader.read(&mut byte);
                } else {
                    assert_eq!(first.trim(), format!("GET {expected} HTTP/1.1"));
                    let body = if expected == "/v1.47/version" {
                        r#"{"Version":"27.5.0","ApiVersion":"1.47","MinAPIVersion":"1.24","Os":"linux","Arch":"aarch64"}"#
                    } else {
                        r#"{"ID":"fixture","OSType":"linux","Architecture":"aarch64","Name":"fixture"}"#
                    };
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
                }
            }
        });
        core.configure_project_logs("s", "p", None).unwrap();
        let wait_for_rows = |sequence| {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let page = core
                    .query_project_logs("s", &latest_query("p".into()))
                    .unwrap();
                if page.max_sequence >= sequence {
                    break page;
                }
                assert!(
                    Instant::now() < deadline,
                    "historical log stream timed out: {:?}",
                    page.error
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        };
        let backlog = wait_for_rows(INITIAL_TAIL_ROWS as u64);
        assert_eq!(backlog.total_rows, INITIAL_TAIL_ROWS);
        assert!(
            backlog
                .rows
                .iter()
                .all(|row| row.timestamp.as_deref() == Some(old.as_str()))
        );
        assert_eq!(backlog.rows[0].text, "historical 0");
        assert_eq!(backlog.sources[0].status, "following");
        follow.send(()).unwrap();
        let live = wait_for_rows(INITIAL_TAIL_ROWS as u64 + 1);
        assert_eq!(live.total_rows, INITIAL_TAIL_ROWS);
        assert_eq!(live.rows[0].text, "historical 1");
        assert_eq!(live.rows.last().unwrap().text, "fresh output");
        core.shutdown();
        server.join().unwrap();
    }

    struct RecoveryEngine {
        core: Core,
        container: Container,
        directory: PathBuf,
        stopped: Arc<std::sync::atomic::AtomicBool>,
        server: Option<std::thread::JoinHandle<()>>,
        opened: Arc<std::sync::atomic::AtomicUsize>,
        closed: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl RecoveryEngine {
        fn new(hold_first_headers: bool, quiet: bool) -> Self {
            use std::io::{BufRead, BufReader, Read, Write};
            use std::os::unix::net::UnixListener;
            use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
            let directory = Path::new("/tmp")
                .canonicalize()
                .unwrap()
                .join(format!("d2u-log-recovery-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let socket = directory.join("engine.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            listener.set_nonblocking(true).unwrap();
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = stopped.clone();
            let opened = Arc::new(AtomicUsize::new(0));
            let opens = opened.clone();
            let closed = Arc::new(AtomicUsize::new(0));
            let closes = closed.clone();
            let server = std::thread::spawn(move || {
                let mut workers = Vec::new();
                while !stop.load(Ordering::Acquire) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    };
                    let opens = opens.clone();
                    let closes = closes.clone();
                    workers.push(std::thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
                        stream.set_write_timeout(Some(Duration::from_secs(8))).unwrap();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        loop {
                            let mut first = String::new();
                            if reader.read_line(&mut first).unwrap_or(0) == 0 { return; }
                            let path = first.split_whitespace().nth(1).unwrap().to_owned();
                            loop {
                                let mut header = String::new();
                                if reader.read_line(&mut header).unwrap_or(0) == 0 { return; }
                                if header == "\r\n" { break; }
                            }
                            if path.contains("/logs?") {
                                let number = opens.fetch_add(1, Ordering::SeqCst);
                                if !hold_first_headers || number > 0 {
                                    if stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").is_err() { return; }
                                    if !quiet {
                                        let body = format!("{} restored output\n", Utc::now().to_rfc3339());
                                        if write!(stream, "{:X}\r\n{}\r\n", body.len(), body).is_err() { return; }
                                    }
                                }
                                // Neither a waiting startup nor a quiet following
                                // stream closes itself; the owning Core must cancel it.
                                let mut byte = [0];
                                let _ = reader.read(&mut byte);
                                closes.fetch_add(1, Ordering::SeqCst);
                                return;
                            }
                            let body = if path.ends_with("/version") {
                                r#"{"Version":"27.5.0","ApiVersion":"1.47","MinAPIVersion":"1.24","Os":"linux","Arch":"aarch64"}"#
                            } else {
                                assert!(path.ends_with("/info"));
                                r#"{"ID":"fixture","OSType":"linux","Architecture":"aarch64","Name":"fixture"}"#
                            };
                            if write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).is_err() { return; }
                        }
                    }));
                }
                for worker in workers {
                    worker.join().unwrap();
                }
            });
            let (core, _) = core_with_project();
            let container = {
                let mut state = core.state.lock().unwrap();
                let session = state.session.as_mut().unwrap();
                session.target.endpoint = format!("unix://{}", socket.display());
                session.handles.retain(|handle, _| handle == "h0");
                let container = session.handles.get_mut("h0").unwrap();
                container.tty = true;
                container.clone()
            };
            Self {
                core,
                container,
                directory,
                stopped,
                server: Some(server),
                opened,
                closed,
            }
        }
        fn seed(&self, status: &str, error: Option<ApiError>) {
            let mut manager = self.core.project_logs.lock().unwrap();
            manager.session_id = "s".into();
            manager.project = Some("p".into());
            manager.token = 41;
            manager.error = error.clone();
            let mut view = source(&self.container.full_id);
            view.status = status.into();
            view.error = error;
            manager.sources.insert(
                self.container.full_id.clone(),
                Source {
                    view,
                    run: Some(self.container.created_at.clone()),
                    token: 41,
                    pending_start: None,
                    task: None,
                    overlap: HashMap::new(),
                    last_seen: now_nanos(),
                },
            );
        }
        fn wait_for(&self, predicate: impl Fn(&ProjectLogPage) -> bool) -> ProjectLogPage {
            let deadline = std::time::Instant::now() + Duration::from_secs(4);
            loop {
                let page = self
                    .core
                    .query_project_logs("s", &latest_query("p".into()))
                    .unwrap();
                if predicate(&page) {
                    return page;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "recovery fixture timed out"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        fn log_requests(&self) -> usize {
            self.opened.load(std::sync::atomic::Ordering::SeqCst)
        }
    }
    impl Drop for RecoveryEngine {
        fn drop(&mut self) {
            self.core.shutdown();
            self.stopped
                .store(true, std::sync::atomic::Ordering::Release);
            self.server.take().unwrap().join().unwrap();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn retry_and_reconfigure_clear_recoverable_manager_errors_before_registering_sources() {
        for reconfigure in [false, true] {
            let fixture = RecoveryEngine::new(false, false);
            fixture.seed(
                "error",
                Some(ApiError::new(
                    "ObservationTransport",
                    "temporary reader failure",
                )),
            );
            if reconfigure {
                fixture.core.configure_project_logs("s", "p", None).unwrap();
            } else {
                fixture.core.retry_project_logs("s").unwrap();
            }
            let page = fixture.wait_for(|page| page.total_rows == 1);
            assert!(page.error.is_none());
            assert_eq!(page.sources[0].status, "following");
            assert_eq!(fixture.log_requests(), 1);
            let manager = fixture.core.project_logs.lock().unwrap();
            let source = &manager.sources[&fixture.container.full_id];
            assert!(source.pending_start.is_none());
            assert!(source.task.is_some());
        }
    }

    #[test]
    fn reconnect_required_errors_cannot_be_cleared_by_retry_or_reconfigure() {
        for code in ["EnvironmentChanged", "SocketMissing", "NeedsValidation"] {
            let fixture = RecoveryEngine::new(false, false);
            fixture.seed("error", Some(ApiError::new(code, "reconnect required")));
            assert_eq!(
                fixture.core.retry_project_logs("s").unwrap_err().code,
                "NeedsValidation"
            );
            assert_eq!(
                fixture
                    .core
                    .configure_project_logs("s", "p", None)
                    .unwrap_err()
                    .code,
                "NeedsValidation"
            );
            assert_eq!(fixture.log_requests(), 0);
            assert_eq!(
                fixture
                    .core
                    .project_logs
                    .lock()
                    .unwrap()
                    .error
                    .as_ref()
                    .unwrap()
                    .code,
                code
            );
        }
        let fixture = RecoveryEngine::new(false, false);
        fixture.seed("starting", None);
        fixture
            .core
            .state
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .needs_validation = true;
        assert_eq!(
            fixture.core.retry_project_logs("s").unwrap_err().code,
            "NeedsValidation"
        );
        assert_eq!(fixture.log_requests(), 0);
    }

    #[test]
    fn inventory_repairs_an_unowned_start_without_restarting_a_following_source() {
        let fixture = RecoveryEngine::new(false, false);
        fixture.seed("starting", None);
        fixture
            .core
            .sync_project_log_containers("s", vec![fixture.container.clone()]);
        fixture.wait_for(|page| page.total_rows == 1);
        let token =
            fixture.core.project_logs.lock().unwrap().sources[&fixture.container.full_id].token;
        for _ in 0..4 {
            fixture
                .core
                .sync_project_log_containers("s", vec![fixture.container.clone()]);
        }
        assert_eq!(fixture.log_requests(), 1);
        assert_eq!(
            fixture.core.project_logs.lock().unwrap().sources[&fixture.container.full_id].token,
            token
        );
    }

    #[test]
    fn retry_supersedes_a_reserved_start_and_inventory_does_not_duplicate_it() {
        let fixture = RecoveryEngine::new(false, false);
        fixture.seed("idle", None);
        let barrier = Arc::new(std::sync::Barrier::new(2));
        fixture
            .core
            .project_logs
            .lock()
            .unwrap()
            .start_registration_barrier = Some(barrier.clone());
        let configuring = fixture.core.clone();
        let first = std::thread::spawn(move || configuring.configure_project_logs("s", "p", None));
        barrier.wait();
        let reserved =
            fixture.core.project_logs.lock().unwrap().sources[&fixture.container.full_id].token;
        fixture
            .core
            .sync_project_log_containers("s", vec![fixture.container.clone()]);
        assert_eq!(
            fixture.core.project_logs.lock().unwrap().sources[&fixture.container.full_id]
                .pending_start,
            Some(reserved)
        );
        assert_eq!(fixture.log_requests(), 0);
        let retry = fixture.core.retry_project_logs("s");
        barrier.wait();
        first.join().unwrap().unwrap();
        retry.unwrap();
        fixture.wait_for(|page| page.total_rows == 1);
        let mut manager = fixture.core.project_logs.lock().unwrap();
        let current = &manager.sources[&fixture.container.full_id];
        assert!(current.token > reserved);
        assert!(current.pending_start.is_none());
        assert!(current.task.is_some());
        manager.receive(
            "s",
            &fixture.container.full_id,
            reserved,
            ReaderMessage::Log(log(&Utc::now().to_rfc3339(), "obsolete start")),
        );
        assert!(
            !manager
                .ring
                .rows
                .values()
                .any(|row| row.row.text == "obsolete start")
        );
        drop(manager);
        assert_eq!(fixture.log_requests(), 1);
    }

    #[test]
    fn explicit_retry_cancels_a_start_waiting_for_headers_and_registers_a_replacement() {
        let fixture = RecoveryEngine::new(true, false);
        fixture.core.configure_project_logs("s", "p", None).unwrap();
        fixture
            .wait_for(|page| fixture.log_requests() == 1 && page.sources[0].status == "starting");
        fixture.core.retry_project_logs("s").unwrap();
        let page = fixture.wait_for(|page| page.total_rows == 1);
        assert_eq!(page.sources[0].status, "following");
        assert_eq!(fixture.log_requests(), 2);
        assert_eq!(fixture.closed.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn explicit_retry_keeps_a_quiet_connected_stream() {
        let fixture = RecoveryEngine::new(false, true);
        fixture.core.configure_project_logs("s", "p", None).unwrap();
        fixture.wait_for(|page| page.sources[0].status == "following");
        for _ in 0..4 {
            fixture.core.retry_project_logs("s").unwrap();
        }
        assert_eq!(fixture.log_requests(), 1);
        let page = fixture
            .core
            .query_project_logs("s", &latest_query("p".into()))
            .unwrap();
        assert_eq!(page.total_rows, 0);
        assert_eq!(page.sources[0].status, "following");
    }

    #[test]
    fn over_capacity_requires_explicit_unique_sources_and_never_selects_recreations() {
        let (core, containers) = core_with_project();
        let all = core.configure_project_logs("s", "p", None).unwrap();
        assert!(all.needs_selection);
        assert_eq!(all.sources.len(), 65);
        assert!(all.sources.iter().all(|source| !source.selected));
        assert!(
            core.configure_project_logs("s", "p", Some(vec!["h0".into(), "h0".into()]))
                .is_err()
        );
        let chosen = core
            .configure_project_logs("s", "p", Some(vec!["h0".into()]))
            .unwrap();
        assert_eq!(
            chosen
                .sources
                .iter()
                .filter(|source| source.selected)
                .count(),
            1
        );
        let mut replacement = containers.clone();
        replacement[0].full_id = "f".repeat(64);
        core.sync_project_log_containers("s", replacement);
        let after = core
            .query_project_logs("s", &latest_query("p".into()))
            .unwrap();
        assert!(after.sources.iter().all(|source| !source.selected));
        let mut retained_filter = latest_query("p".into());
        retained_filter.source_ids = after
            .sources
            .iter()
            .map(|source| source.full_id.clone())
            .collect();
        assert!(retained_filter.source_ids.len() > MAX_SOURCES);
        assert!(core.query_project_logs("s", &retained_filter).is_ok());
        assert!(after.sources.iter().any(|source| source.full_id == containers[0].full_id && source.status == "removed"));
        assert!(
            core.query_project_logs("previous-session", &latest_query("p".into()))
                .is_err()
        );
        core.shutdown();
    }

    #[test]
    fn shutdown_rejects_a_log_registration_with_a_previously_cloned_session() {
        let (mut core, _) = core_with_project();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        core.log_registration_barrier = Some(barrier.clone());
        let configuring = core.clone();
        let pending =
            std::thread::spawn(move || configuring.configure_project_logs("s", "p", None));
        barrier.wait(); // configure has cloned the active session, but owns no slot yet.
        core.shutdown();
        barrier.wait();
        assert_eq!(pending.join().unwrap().unwrap_err().code, "StaleSession");
        let manager = core.project_logs.lock().unwrap();
        assert!(manager.session_id.is_empty());
        assert!(manager.sources.is_empty());
        drop(manager);
        assert!(core.state.lock().unwrap().session.is_none());
        assert_eq!(core.get_environment().unwrap_err().code, "StaleSession");
        assert!(core.observation.lock().unwrap().is_none());
        assert!(core.engine_reader.lock().unwrap().is_none());
    }
}
