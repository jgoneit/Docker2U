//! Session-owned project logs: bounded retention, stable source identity and paged views.
use super::engine_reader::{
    LogRecord, LogRequest, LogStreamKind, ReaderMessage, ReaderStatus, StreamTask,
};
use super::*;
use chrono::Utc;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

const MAX_SOURCES: usize = 64;
const MAX_ROWS: usize = 100_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;
const SOURCE_BYTES: usize = 1024 * 1024;
const PAGE_BYTES: usize = 2 * 1024 * 1024;
const RETENTION_SECONDS: i64 = 30 * 60;

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
}
#[derive(Default)]
struct LogRing {
    rows: BTreeMap<OrderKey, StoredRow>,
    arrival: VecDeque<(i64, OrderKey)>,
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
        self.bytes = self.bytes.saturating_sub(stored.bytes);
        let source = &stored.row.source_id;
        if let Some(bytes) = self.source_bytes.get_mut(source) {
            *bytes = bytes.saturating_sub(stored.bytes);
        }
        if let Some(order) = self.source_order.get_mut(source) {
            order.remove(key);
            if order.is_empty() {
                self.source_order.remove(source);
                self.source_bytes.remove(source);
            }
        }
        if dropped {
            *self.dropped.entry(stored.project).or_default() += 1;
            *self.source_dropped.entry(source.clone()).or_default() += 1;
        }
    }
    fn expire(&mut self, now: i64) {
        let cutoff = now.saturating_sub(RETENTION_SECONDS * 1_000_000_000);
        // Late/replayed Docker timestamps do not receive another thirty minutes
        // of retention just because this connection delivered them recently.
        while let Some(key) = self
            .rows
            .first_key_value()
            .filter(|(key, _)| key.0 < cutoff)
            .map(|(key, _)| key.clone())
        {
            self.remove(&key, false);
        }
        while self.arrival.front().is_some_and(|(time, _)| *time < cutoff) {
            let (_, key) = self.arrival.pop_front().unwrap();
            self.remove(&key, false);
        }
        // Eviction tombstones must not accumulate when a noisy source fills its quota.
        if self.arrival.len() > self.rows.len().saturating_mul(2).saturating_add(1024) {
            self.arrival.retain(|(_, key)| self.rows.contains_key(key));
        }
    }
    fn append(&mut self, project: &str, source: &ProjectLogSource, log: LogRecord) {
        self.sequence += 1;
        let received = nanos(&log.received_at).unwrap_or_else(now_nanos);
        let order = log.timestamp.as_deref().and_then(nanos).unwrap_or(received);
        let key = (order, source.full_id.clone(), self.sequence);
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
        // Charge retained fields and the three ordered/arrival index keys too,
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
            + 3 * (std::mem::size_of::<OrderKey>() + source.full_id.len())
            + 128;
        self.bytes += bytes;
        *self.source_bytes.entry(source.full_id.clone()).or_default() += bytes;
        self.source_order
            .entry(source.full_id.clone())
            .or_default()
            .insert(key.clone());
        self.arrival.push_back((received, key.clone()));
        self.rows.insert(
            key,
            StoredRow {
                project: project.into(),
                row,
                bytes,
            },
        );
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
}

impl ProjectLogManager {
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
            if self.active(id)?.needs_validation {
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
            manager.error = None;
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
            if self.active(id)?.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Reconnect before resuming logs",
                ));
            }
            let project = manager
                .project
                .clone()
                .ok_or_else(|| ApiError::new("InvalidSelection", "Select a Compose project"))?;
            let tasks = manager
                .sources
                .values_mut()
                .filter_map(|source| {
                    if matches!(source.view.status.as_str(), "error" | "ended" | "retrying") {
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
                    if let Some(task) = source.task.take() {
                        source.view.coverage_gaps += 1;
                        stops.push(task);
                    }
                    source.view.status = "idle".into();
                    source.run = None;
                } else if source.run != run || source.view.status == "idle" {
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
        let reader = match self.observation_reader(id) {
            Ok(reader) => reader,
            Err(error) => {
                let mut manager = self.project_logs.lock().unwrap();
                if manager.session_id == id {
                    manager.error = Some(error.clone());
                    for (container, token) in starts {
                        if let Some(source) = manager
                            .sources
                            .get_mut(&container.full_id)
                            .filter(|source| source.token == token)
                        {
                            source.view.status = "error".into();
                            source.view.error = Some(error.clone());
                        }
                    }
                }
                return;
            }
        };
        for (container, token) in starts {
            {
                let manager = self.project_logs.lock().unwrap();
                if manager.session_id != id
                    || manager.error.is_some()
                    || !manager
                        .sources
                        .get(&container.full_id)
                        .is_some_and(|source| {
                            source.token == token
                                && source.view.selected
                                && source.view.status != "removed"
                        })
                {
                    continue;
                }
            }
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
                                source.task.take()
                            })
                            .collect::<Vec<_>>()
                    };
                    drop(tasks);
                }
            });
            let since =
                Some((Utc::now() - chrono::Duration::seconds(RETENTION_SECONDS)).to_rfc3339());
            let result = reader.spawn_logs(
                LogRequest {
                    full_id: container.full_id.clone(),
                    tty: container.tty,
                    since,
                    tail: 300,
                },
                sink,
            );
            let mut manager = self.project_logs.lock().unwrap();
            if manager.session_id != id || manager.error.is_some() {
                drop(manager);
                drop(result);
                continue;
            }
            let Some(source) = manager
                .sources
                .get_mut(&container.full_id)
                .filter(|source| {
                    source.token == token && source.view.selected && source.view.status != "removed"
                })
            else {
                drop(manager);
                drop(result);
                continue;
            };
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
    fn noisy_source_quota_preserves_other_source_and_expiry_releases_rows() {
        let mut ring = LogRing::default();
        let time = Utc::now().to_rfc3339();
        ring.append("p", &source("quiet"), log(&time, "keep"));
        for _ in 0..40 {
            ring.append("p", &source("noisy"), log(&time, &"x".repeat(64 * 1024)));
        }
        assert!(ring.bytes < SOURCE_BYTES + 1024);
        assert!(ring.rows.values().any(|stored| stored.row.text == "keep"));
        assert!(ring.dropped["p"] > 0);
        ring.expire(now_nanos() + (RETENTION_SECONDS + 1) * 1_000_000_000);
        assert!(ring.rows.is_empty());
        assert_eq!(ring.bytes, 0);
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
    fn late_old_timestamp_expires_even_when_received_now() {
        let mut ring = LogRing::default();
        let old = (Utc::now() - chrono::Duration::minutes(31)).to_rfc3339();
        ring.append("p", &source("a"), log(&old, "expired replay"));
        assert!(ring.rows.is_empty());
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
