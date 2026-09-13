//! Session-owned background observations. WebView visibility only affects rendering.
use super::engine_reader::{
    EngineFingerprint, EngineReader, EngineTarget, ReaderMessage, ReaderStatus, StreamTask,
};
use super::*;
use std::{
    collections::VecDeque,
    sync::{
        Condvar,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Instant,
};

const RETENTION_SECONDS: i64 = 30 * 60;
const RESOURCE_LIMIT: usize = 100_000;
const RESOURCE_LIMIT_PER_CONTAINER: usize = 360;
const EVENT_LIMIT: usize = 10_000;
const INVENTORY_INTERVAL: Duration = Duration::from_secs(10);
const STATS_INTERVAL: Duration = Duration::from_secs(5);

fn collection_interrupted(monotonic: Duration, wall: chrono::Duration) -> bool {
    monotonic > Duration::from_secs(30)
        || wall > chrono::Duration::seconds(30)
        || wall < chrono::Duration::zero()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ObservationScope {
    All,
    None,
    Project { name: String },
}

impl ObservationScope {
    fn contains(&self, container: &Container) -> bool {
        match self {
            Self::All => true,
            Self::None => container.compose_project.is_none(),
            Self::Project { name } => container.compose_project.as_ref() == Some(name),
        }
    }
    fn validate(&self) -> Result<()> {
        if let Self::Project { name } = self {
            if name.trim().is_empty() || name.len() > 4096 || name.contains('\0') {
                return Err(ApiError::new(
                    "InvalidSelection",
                    "Invalid project observation scope",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePoint {
    pub sequence: u64,
    pub full_id: String,
    pub sampled_at: String,
    pub cpu_percent: Option<f64>,
    pub memory_usage_bytes: Option<f64>,
    pub memory_limit_bytes: Option<f64>,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationEvent {
    pub sequence: u64,
    pub full_id: Option<String>,
    pub name: Option<String>,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub kind: String,
    pub occurred_at: String,
    pub observed_at: String,
    pub detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRead {
    pub session_id: String,
    pub sequence: u64,
    pub scope: ObservationScope,
    pub inventory: Option<ContainerList>,
    pub resources: Vec<ResourcePoint>,
    pub events: Vec<ObservationEvent>,
    pub resource_truncated: bool,
    pub event_truncated: bool,
    pub resource_retained_from: Option<String>,
    pub event_retained_from: Option<String>,
    pub inventory_error: Option<ApiError>,
    pub stats_error: Option<ApiError>,
    pub event_error: Option<ApiError>,
    pub event_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationHold {
    pub session_id: String,
    pub hold_id: String,
    pub inventory: ContainerList,
}

struct Store {
    scope: ObservationScope,
    scope_revision: u64,
    sequence: u64,
    inventory: Option<ContainerList>,
    resources: VecDeque<ResourcePoint>,
    resource_limits_dirty: bool,
    events: VecDeque<ObservationEvent>,
    // Bounded dedup keys survive overlap on an event subscription restart.
    event_keys: VecDeque<String>,
    event_key_set: HashSet<String>,
    resource_truncated: bool,
    event_truncated: bool,
    inventory_error: Option<ApiError>,
    stats_error: Option<ApiError>,
    event_error: Option<ApiError>,
    event_status: String,
    event_gap_open: bool,
    event_cursor: Option<String>,
    refresh_requested: u64,
    refresh_completed: u64,
    refresh_wanted: bool,
    fetching: bool,
    holds: HashSet<String>,
}

impl Store {
    fn new(scope: ObservationScope, inventory: Option<ContainerList>) -> Self {
        Self {
            scope,
            scope_revision: 0,
            sequence: 0,
            inventory,
            resources: VecDeque::new(),
            resource_limits_dirty: true,
            events: VecDeque::new(),
            event_keys: VecDeque::new(),
            event_key_set: HashSet::new(),
            resource_truncated: false,
            event_truncated: false,
            inventory_error: None,
            stats_error: None,
            event_error: None,
            event_status: "starting".into(),
            event_gap_open: false,
            event_cursor: None,
            refresh_requested: 0,
            refresh_completed: 0,
            refresh_wanted: false,
            fetching: false,
            holds: HashSet::new(),
        }
    }
    fn advance(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }
    fn set_scope(&mut self, scope: ObservationScope) {
        if self.scope == scope {
            return;
        }
        let observed = self
            .resources
            .iter()
            .map(|point| &point.full_id)
            .collect::<HashSet<_>>();
        let leaving = self.inventory.as_ref().map_or_else(Vec::new, |inventory| {
            inventory
                .containers
                .iter()
                .filter(|container| {
                    container.state == "running"
                        && self.scope.contains(container)
                        && !scope.contains(container)
                        && observed.contains(&container.full_id)
                })
                .map(|container| container.full_id.clone())
                .collect::<Vec<_>>()
        });
        self.scope = scope;
        self.scope_revision += 1;
        let now = chrono::Utc::now();
        for full_id in leaving {
            let sequence = self.advance();
            self.resources.push_back(ResourcePoint {
                sequence,
                full_id,
                sampled_at: now.to_rfc3339(),
                cpu_percent: None,
                memory_usage_bytes: None,
                memory_limit_bytes: None,
                available: false,
            });
            self.resource_limits_dirty = true;
        }
        self.prune(now);
    }
    fn prune(&mut self, now: chrono::DateTime<chrono::Utc>) {
        let cutoff = now - chrono::Duration::seconds(RETENTION_SECONDS);
        let old = |text: &str| {
            chrono::DateTime::parse_from_rfc3339(text).map_or(true, |time| time < cutoff)
        };
        while self
            .resources
            .front()
            .is_some_and(|point| old(&point.sampled_at))
        {
            self.resources.pop_front();
        }
        while self
            .events
            .front()
            .is_some_and(|event| old(&event.observed_at))
        {
            self.events.pop_front();
        }
        if self.resource_limits_dirty {
            let mut counts = HashMap::<String, usize>::new();
            for point in &self.resources {
                *counts.entry(point.full_id.clone()).or_default() += 1;
            }
            let before = self.resources.len();
            self.resources.retain(|point| {
                let count = counts.get_mut(&point.full_id).unwrap();
                if *count > RESOURCE_LIMIT_PER_CONTAINER {
                    *count -= 1;
                    false
                } else {
                    true
                }
            });
            self.resource_truncated |= before != self.resources.len();
            self.resource_limits_dirty = false;
        }
        while self.resources.len() > RESOURCE_LIMIT {
            self.resources.pop_front();
            self.resource_truncated = true;
        }
        while self.events.len() > EVENT_LIMIT {
            self.events.pop_front();
            self.event_truncated = true;
        }
        while self.event_keys.len() > EVENT_LIMIT {
            if let Some(key) = self.event_keys.pop_front() {
                self.event_key_set.remove(&key);
            }
        }
    }
    fn gap(&mut self, detail: &str) {
        let now = chrono::Utc::now().to_rfc3339();
        let sequence = self.advance();
        self.events.push_back(ObservationEvent {
            sequence,
            full_id: None,
            name: None,
            compose_project: None,
            compose_service: None,
            kind: "gap".into(),
            occurred_at: now.clone(),
            observed_at: now,
            detail: Some(detail.into()),
        });
    }
    fn open_event_gap_once(&mut self, detail: &str) {
        if !self.event_gap_open {
            self.gap(detail);
            self.event_gap_open = true;
        }
    }
    fn record_stats(&mut self, snapshot: &StatsSnapshot) {
        self.resource_limits_dirty |= !snapshot.items.is_empty();
        for item in &snapshot.items {
            let sequence = self.advance();
            self.resources.push_back(ResourcePoint {
                sequence,
                full_id: item.full_id.clone(),
                sampled_at: snapshot.sampled_at.clone(),
                cpu_percent: item.cpu_percent,
                memory_usage_bytes: item.memory_usage_bytes,
                memory_limit_bytes: item.memory_limit_bytes,
                available: item.available,
            });
        }
        self.stats_error = snapshot.error.clone();
        self.prune(chrono::Utc::now());
    }
}

pub(super) struct ObservationService {
    pub(super) session_id: String,
    store: Mutex<Store>,
    wake: Condvar,
    cancelled: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    event_task: Mutex<Option<StreamTask>>,
    validation_task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ObservationService {
    pub(super) fn request_inventory_refresh(&self) {
        self.store.lock().unwrap().refresh_requested += 1;
        self.wake.notify_all();
    }
    pub(super) fn invalidate(&self, error: &ApiError) {
        {
            let mut store = self.store.lock().unwrap();
            if let Some(inventory) = store.inventory.as_mut() {
                inventory.stale = true;
            }
            store.inventory_error = Some(error.clone());
            store.event_error = Some(error.clone());
            store.event_status = "stopped".into();
            store.open_event_gap_once("The Engine connection requires reconnection");
        }
        self.cancel();
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        // Wait for an already-publishing callback. New callbacks recheck the
        // cancellation flag after taking this same store lock.
        drop(self.store.lock().unwrap());
        if let Some(task) = self.event_task.lock().unwrap().take() {
            task.cancel();
        }
        if let Some(task) = self.validation_task.lock().unwrap().take() {
            task.abort();
        }
        self.wake.notify_all();
    }
    fn install_event_task(&self, task: StreamTask) -> bool {
        let mut slot = self.event_task.lock().unwrap();
        if self.cancelled() {
            task.cancel();
            return false;
        }
        *slot = Some(task);
        true
    }
    fn install_validation_task(&self, task: tauri::async_runtime::JoinHandle<()>) -> bool {
        let mut slot = self.validation_task.lock().unwrap();
        if self.cancelled() {
            task.abort();
            return false;
        }
        *slot = Some(task);
        true
    }
    fn install_worker(&self, worker: JoinHandle<()>) -> bool {
        let mut slot = self.worker.lock().unwrap();
        if self.cancelled() {
            drop(slot);
            let _ = worker.join();
            return false;
        }
        *slot = Some(worker);
        true
    }
    fn stop(&self) {
        self.cancel();
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
    fn read(&self, after: u64) -> ObservationRead {
        let mut store = self.store.lock().unwrap();
        store.prune(chrono::Utc::now());
        ObservationRead {
            session_id: self.session_id.clone(),
            sequence: store.sequence,
            scope: store.scope.clone(),
            inventory: store.inventory.clone(),
            resources: store
                .resources
                .iter()
                .filter(|point| point.sequence > after)
                .cloned()
                .collect(),
            events: store
                .events
                .iter()
                .filter(|event| event.sequence > after)
                .cloned()
                .collect(),
            resource_truncated: store.resource_truncated,
            event_truncated: store.event_truncated,
            resource_retained_from: store
                .resources
                .front()
                .map(|point| point.sampled_at.clone()),
            event_retained_from: store.events.front().map(|event| event.observed_at.clone()),
            inventory_error: store.inventory_error.clone(),
            stats_error: store.stats_error.clone(),
            event_error: store.event_error.clone(),
            event_status: store.event_status.clone(),
        }
    }
    pub(super) fn refresh(&self, core: &Core) -> Result<ContainerList> {
        if core.active(&self.session_id)?.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before refreshing observations",
            ));
        }
        let mut store = self.store.lock().unwrap();
        store.refresh_requested += 1;
        let request = store.refresh_requested;
        self.wake.notify_all();
        let deadline = Instant::now() + Duration::from_secs(60);
        while store.refresh_completed < request && !self.cancelled() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ApiError::new(
                    "TimedOut",
                    "Inventory refresh is still in progress",
                ));
            }
            store = self.wake.wait_timeout(store, remaining).unwrap().0;
        }
        if self.cancelled() {
            return Err(ApiError::new("StaleSession", "Observation session ended"));
        }
        if let Some(error) = &store.inventory_error {
            return Err(error.clone());
        }
        store
            .inventory
            .clone()
            .ok_or_else(|| ApiError::new("NeedsValidation", "Inventory is not available yet"))
    }
    fn event_message(&self, core: &Core, message: ReaderMessage) {
        if self.cancelled() || core.active(&self.session_id).is_err() {
            return;
        }
        let mut invalidate = None;
        let mut started = None;
        let mut store = self.store.lock().unwrap();
        if self.cancelled() {
            return;
        }
        match message {
            ReaderMessage::Event(event) => {
                let kind = event.action.as_str();
                if !matches!(
                    kind,
                    "create"
                        | "destroy"
                        | "start"
                        | "die"
                        | "restart"
                        | "oom"
                        | "pause"
                        | "unpause"
                        | "stop"
                        | "kill"
                ) && !matches!(
                    kind,
                    "health_status"
                        | "health_status: starting"
                        | "health_status: healthy"
                        | "health_status: unhealthy"
                ) {
                    return;
                }
                if !valid_id(&event.full_id) {
                    return;
                }
                let key = format!("{}:{}:{}", event.time_nano, event.full_id, event.action);
                if !store.event_key_set.insert(key.clone()) {
                    return;
                }
                store.event_keys.push_back(key);
                if kind == "start" {
                    started = Some(event.full_id.clone());
                }
                let now = chrono::Utc::now().to_rfc3339();
                let occurred = chrono::DateTime::from_timestamp(
                    event.time_nano.div_euclid(1_000_000_000),
                    event.time_nano.rem_euclid(1_000_000_000) as u32,
                )
                .map(|date| date.to_rfc3339())
                .unwrap_or_else(|| now.clone());
                if store
                    .event_cursor
                    .as_ref()
                    .and_then(|cursor| chrono::DateTime::parse_from_rfc3339(cursor).ok())
                    .is_none_or(|cursor| {
                        chrono::DateTime::parse_from_rfc3339(&occurred)
                            .is_ok_and(|time| time > cursor)
                    })
                {
                    store.event_cursor = Some(occurred.clone());
                }
                let container = store.inventory.as_ref().and_then(|inventory| {
                    inventory
                        .containers
                        .iter()
                        .find(|container| container.full_id == event.full_id)
                });
                let attr = |key: &str| {
                    event
                        .attributes
                        .get(key)
                        .filter(|value| value.len() <= 4096)
                        .cloned()
                };
                let name =
                    attr("name").or_else(|| container.map(|container| container.name.clone()));
                let project = attr("com.docker.compose.project")
                    .or_else(|| container.and_then(|container| container.compose_project.clone()));
                let service = attr("com.docker.compose.service")
                    .or_else(|| container.and_then(|container| container.compose_service.clone()));
                let detail = attr("exitCode")
                    .and_then(|code| code.parse::<i32>().ok())
                    .map(|code| format!("exitCode={code}"));
                let in_resource_scope = match &store.scope {
                    ObservationScope::All => true,
                    ObservationScope::None => project.is_none(),
                    ObservationScope::Project { name } => project.as_ref() == Some(name),
                };
                if in_resource_scope
                    && matches!(
                        kind,
                        "die" | "stop" | "pause" | "destroy" | "start" | "restart"
                    )
                {
                    let sequence = store.advance();
                    store.resources.push_back(ResourcePoint {
                        sequence,
                        full_id: event.full_id.clone(),
                        sampled_at: now.clone(),
                        cpu_percent: None,
                        memory_usage_bytes: None,
                        memory_limit_bytes: None,
                        available: false,
                    });
                    store.resource_limits_dirty = true;
                }
                let sequence = store.advance();
                store.events.push_back(ObservationEvent {
                    sequence,
                    full_id: Some(event.full_id),
                    name,
                    compose_project: project,
                    compose_service: service,
                    kind: event.action,
                    occurred_at: occurred,
                    observed_at: now,
                    detail,
                });
                store.refresh_wanted = true;
            }
            ReaderMessage::Status(status) => match status {
                ReaderStatus::Connecting => {
                    store.event_status = "starting".into();
                }
                ReaderStatus::Following => {
                    store.event_gap_open = false;
                    store.event_status = "following".into();
                    store.event_error = None;
                }
                ReaderStatus::Retrying { .. } => {
                    store.open_event_gap_once("Event stream interrupted; recovery may omit events");
                    store.event_status = "retrying".into();
                }
                ReaderStatus::Ended => {
                    store.event_status = "stopped".into();
                    store.open_event_gap_once("Event stream ended");
                }
                ReaderStatus::Failed(error) => {
                    let failure = ApiError::new(&error.code, &error.message);
                    store.event_status = "error".into();
                    store.event_error = Some(failure.clone());
                    store.open_event_gap_once("Event collection failed");
                    if error.invalidates_session {
                        invalidate = Some(failure);
                    }
                }
            },
            ReaderMessage::Log(_) => {}
        }
        store.prune(chrono::Utc::now());
        drop(store);
        if let Some(full_id) = started {
            core.mark_project_log_started(&self.session_id, &full_id);
        }
        if let Some(error) = invalidate {
            core.invalidate_observation(&self.session_id, &error);
        }
        self.wake.notify_all();
    }
    fn run(self: Arc<Self>, core: Core) {
        let mut next_inventory = Instant::now();
        let mut next_stats = Instant::now();
        let mut stats_first = false;
        let mut scope_revision = 0;
        let mut last_loop = Instant::now();
        let mut last_wall = chrono::Utc::now();
        loop {
            if self.cancelled() {
                return;
            }
            let wall = chrono::Utc::now();
            if collection_interrupted(last_loop.elapsed(), wall - last_wall) {
                self.store
                    .lock()
                    .unwrap()
                    .gap("Observation was delayed; resource samples may be missing");
                next_inventory = Instant::now();
                next_stats = Instant::now();
            }
            last_loop = Instant::now();
            last_wall = wall;
            let session = match core.active(&self.session_id) {
                Ok(session) => session,
                Err(_) => return,
            };
            if session.needs_validation {
                // This flag can be set by paths outside the event reader. Use
                // the shared cancellation boundary, including project logs and
                // the validator, without holding the observation store lock.
                core.invalidate_session_observations(
                    &self.session_id,
                    &ApiError::new(
                        "NeedsValidation",
                        "Reconnect before continuing observations",
                    ),
                );
                return;
            }
            let operations_busy = {
                let state = core.state.lock().unwrap();
                state.refreshing
                    || state.mutating
                    || state.diagnosing
                    || state.stats_running
                    || state.details_running
                    || state.stream_starting
            };
            let mut store = self.store.lock().unwrap();
            store.prune(chrono::Utc::now());
            if store.scope_revision != scope_revision {
                scope_revision = store.scope_revision;
                next_stats = Instant::now();
            }
            let manual = store.refresh_requested > store.refresh_completed;
            let inventory_due = manual
                || (store.holds.is_empty()
                    && ((store.refresh_wanted
                        && Instant::now() + Duration::from_secs(8) >= next_inventory)
                        || Instant::now() >= next_inventory));
            let can_collect = !operations_busy;
            if can_collect && inventory_due && !stats_first {
                store.fetching = true;
                store.refresh_wanted = false;
                drop(store);
                let result = core.fetch_observed_inventory(&self.session_id);
                let mut store = self.store.lock().unwrap();
                store.fetching = false;
                if result.as_ref().is_err_and(|error| error.code == "Busy") {
                    self.wake.notify_all();
                    continue;
                }
                if self.cancelled() {
                    self.wake.notify_all();
                    return;
                }
                match result {
                    Ok(inventory) => {
                        store.inventory = Some(inventory);
                        store.inventory_error = None;
                        store.advance();
                        stats_first = true;
                        next_stats = Instant::now();
                    }
                    Err(error) => {
                        if let Some(inventory) = store.inventory.as_mut() {
                            inventory.stale = true;
                        }
                        store.inventory_error = Some(error);
                    }
                }
                store.refresh_completed = store.refresh_requested;
                next_inventory = Instant::now() + INVENTORY_INTERVAL;
                self.wake.notify_all();
                continue;
            }
            if can_collect && !session.stale && Instant::now() >= next_stats {
                let inventory = store.inventory.clone();
                let scope = store.scope.clone();
                let sampled_scope_revision = store.scope_revision;
                drop(store);
                if let Some(inventory) = inventory {
                    let containers: Vec<_> = inventory
                        .containers
                        .iter()
                        .filter(|container| {
                            container.state == "running" && scope.contains(container)
                        })
                        .collect();
                    if !containers.is_empty() {
                        let handles: Vec<_> = containers
                            .iter()
                            .map(|container| container.handle.clone())
                            .collect();
                        let result = core.get_container_stats(
                            &self.session_id,
                            inventory.generation,
                            &handles,
                        );
                        let mut store = self.store.lock().unwrap();
                        // A sample dispatched before a project switch must not
                        // reconnect the graph after its collection boundary.
                        if self.cancelled() || store.scope_revision != sampled_scope_revision {
                            continue;
                        }
                        match result {
                            Ok(snapshot) => store.record_stats(&snapshot),
                            Err(error) => {
                                let sampled_at = chrono::Utc::now().to_rfc3339();
                                for container in containers {
                                    let sequence = store.advance();
                                    store.resources.push_back(ResourcePoint {
                                        sequence,
                                        full_id: container.full_id.clone(),
                                        sampled_at: sampled_at.clone(),
                                        cpu_percent: None,
                                        memory_usage_bytes: None,
                                        memory_limit_bytes: None,
                                        available: false,
                                    });
                                    store.resource_limits_dirty = true;
                                }
                                store.stats_error = Some(error);
                                store.prune(chrono::Utc::now());
                            }
                        }
                    } else {
                        self.store.lock().unwrap().stats_error = None;
                    }
                }
                stats_first = false;
                next_stats = Instant::now() + STATS_INTERVAL;
                continue;
            }
            // An empty or stale inventory must not prevent its next recovery read.
            if session.stale {
                stats_first = false;
            }
            drop(
                self.wake
                    .wait_timeout(store, Duration::from_millis(100))
                    .unwrap(),
            );
        }
    }
}

impl Core {
    pub(super) fn observation_reader(&self, id: &str) -> Result<EngineReader> {
        let session = self.active(id)?;
        if session.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before reading the Engine",
            ));
        }
        let mut cached = self.engine_reader.lock().unwrap();
        let session = self.active(id)?;
        if session.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before reading the Engine",
            ));
        }
        if let Some((session_id, reader)) =
            cached.as_ref().filter(|(session_id, _)| session_id == id)
        {
            let _ = session_id;
            return Ok(reader.clone());
        }
        let target = &session.target;
        let fingerprint = &target.fingerprint;
        let reader = EngineReader::new(EngineTarget {
            socket_path: PathBuf::from(target.endpoint.strip_prefix("unix://").ok_or_else(
                || ApiError::new("RemoteEndpoint", "A local Unix socket is required"),
            )?),
            fingerprint: EngineFingerprint {
                id: fingerprint.id.clone(),
                server: fingerprint.server.clone(),
                api: fingerprint.api.clone(),
                os: fingerprint.os.clone(),
                arch: fingerprint.arch.clone(),
                name: fingerprint.name.clone(),
            },
        })
        .map_err(|error| ApiError::new(&error.code, &error.message))?;
        *cached = Some((id.into(), reader.clone()));
        Ok(reader)
    }
    pub fn configure_observation(
        &self,
        id: &str,
        scope: ObservationScope,
    ) -> Result<ObservationRead> {
        scope.validate()?;
        let session = self.active(id)?;
        if session.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before observing this session",
            ));
        }
        let mut current = self.observation.lock().unwrap();
        // Shutdown and reconnect revoke the session before taking this slot.
        // Recheck inside publication so an earlier snapshot cannot restore it.
        let session = self.active(id)?;
        if session.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before observing this session",
            ));
        }
        if let Some(service) = current
            .as_ref()
            .filter(|service| service.session_id == id && !service.cancelled())
        {
            let mut store = service.store.lock().unwrap();
            store.set_scope(scope);
            drop(store);
            service.wake.notify_all();
            return Ok(service.read(0));
        }
        if let Some(previous) = current.take() {
            previous.cancel();
        }
        let service = Arc::new(ObservationService {
            session_id: id.into(),
            store: Mutex::new(Store::new(scope, session.inventory)),
            wake: Condvar::new(),
            cancelled: AtomicBool::new(false),
            worker: Mutex::new(None),
            event_task: Mutex::new(None),
            validation_task: Mutex::new(None),
        });
        *current = Some(service.clone());
        drop(current);
        match self.observation_reader(id) {
            Ok(reader) => {
                // One API identity validator per session, irrespective of the
                // number of project log streams. CLI observations keep their
                // existing dispatch-time CLI/config validation.
                let checking = reader.clone();
                let weak = Arc::downgrade(&service);
                let validation_core = self.clone();
                let validator = tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(STATS_INTERVAL).await;
                        let Some(service) = weak.upgrade() else {
                            return;
                        };
                        if service.cancelled() {
                            return;
                        }
                        if let Err(error) = checking.validate().await {
                            if service.cancelled() {
                                return;
                            }
                            if error.invalidates_session {
                                validation_core.invalidate_observation(
                                    &service.session_id,
                                    &ApiError::new(&error.code, &error.message),
                                );
                                return;
                            }
                        }
                    }
                });
                if !service.install_validation_task(validator) {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
                let weak = Arc::downgrade(&service);
                let core = self.clone();
                match reader.spawn_events(
                    None,
                    Arc::new(move |message| {
                        if let Some(service) = weak.upgrade() {
                            service.event_message(&core, message);
                        }
                    }),
                ) {
                    Ok(task) => {
                        if !service.install_event_task(task) {
                            return Err(ApiError::new("StaleSession", "Observation session ended"));
                        }
                    }
                    Err(error) => {
                        let mut store = service.store.lock().unwrap();
                        if service.cancelled() {
                            return Err(ApiError::new("StaleSession", "Observation session ended"));
                        }
                        store.event_status = "error".into();
                        store.open_event_gap_once("Event collection could not start");
                        store.event_error = Some(ApiError::new(&error.code, &error.message));
                    }
                }
            }
            Err(error) => {
                let mut store = service.store.lock().unwrap();
                if service.cancelled() {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
                store.event_status = "error".into();
                store.open_event_gap_once("Event collection could not start");
                store.event_error = Some(error);
            }
        }
        let running = service.clone();
        let core = self.clone();
        match thread::Builder::new()
            .name("docker2u-observation".into())
            .spawn(move || running.run(core))
        {
            Ok(worker) => {
                if !service.install_worker(worker) {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
            }
            Err(error) => {
                service.cancel();
                let mut current = self.observation.lock().unwrap();
                if current
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &service))
                {
                    current.take();
                }
                return Err(ApiError::new("StartFailed", error.to_string()));
            }
        }
        Ok(service.read(0))
    }
    pub fn retry_observation_events(&self, id: &str) -> Result<ObservationRead> {
        if self.active(id)?.needs_validation {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before resuming events",
            ));
        }
        let service = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "NeedsValidation",
                    "Start observations before resuming events",
                )
            })?;
        if service.cancelled() {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before resuming observations",
            ));
        }
        let since = {
            let mut store = service.store.lock().unwrap();
            if !matches!(store.event_status.as_str(), "error" | "stopped") {
                drop(store);
                return Ok(service.read(0));
            }
            store.event_status = "starting".into();
            store.event_error = None;
            store.open_event_gap_once(
                "Event collection was manually resumed; the interrupted interval may be incomplete",
            );
            store.event_cursor.clone()
        };
        let previous = service.event_task.lock().unwrap().take();
        if let Some(previous) = previous {
            previous.cancel();
            tauri::async_runtime::block_on(previous.join());
        }
        let reader = match self.observation_reader(id) {
            Ok(reader) => reader,
            Err(error) => {
                let mut store = service.store.lock().unwrap();
                if service.cancelled() {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
                store.event_status = "error".into();
                store.open_event_gap_once("Event collection could not resume");
                store.event_error = Some(error.clone());
                return Err(error);
            }
        };
        let weak = Arc::downgrade(&service);
        let core = self.clone();
        match reader.spawn_events(
            since,
            Arc::new(move |message| {
                if let Some(service) = weak.upgrade() {
                    service.event_message(&core, message);
                }
            }),
        ) {
            Ok(task) => {
                if !service.install_event_task(task) {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
            }
            Err(error) => {
                let mut store = service.store.lock().unwrap();
                if service.cancelled() {
                    return Err(ApiError::new("StaleSession", "Observation session ended"));
                }
                store.event_status = "error".into();
                store.open_event_gap_once("Event collection could not resume");
                store.event_error = Some(ApiError::new(&error.code, &error.message));
            }
        }
        Ok(service.read(0))
    }
    pub fn read_observation(&self, id: &str, after_sequence: u64) -> Result<ObservationRead> {
        self.active(id)?;
        let service = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "NeedsValidation",
                    "Start observations before reading history",
                )
            })?;
        Ok(service.read(after_sequence))
    }
    pub fn hold_observation(&self, id: &str) -> Result<ObservationHold> {
        self.active(id)?;
        let service = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "NeedsValidation",
                    "Start observations before reserving the inventory",
                )
            })?;
        let hold_id = uuid::Uuid::new_v4().to_string();
        let mut store = service.store.lock().unwrap();
        store.holds.insert(hold_id.clone());
        let deadline = Instant::now() + Duration::from_secs(60);
        while (store.fetching || store.refresh_requested > store.refresh_completed)
            && !service.cancelled()
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                store.holds.remove(&hold_id);
                return Err(ApiError::new("TimedOut", "Inventory reservation timed out"));
            }
            store = service.wake.wait_timeout(store, remaining).unwrap().0;
        }
        let inventory = store.inventory.clone().filter(|inventory| !inventory.stale);
        if service.cancelled() || inventory.is_none() {
            store.holds.remove(&hold_id);
            return Err(ApiError::new(
                "NeedsValidation",
                "Refresh before reserving the inventory",
            ));
        }
        Ok(ObservationHold {
            session_id: id.into(),
            hold_id,
            inventory: inventory.unwrap(),
        })
    }
    pub fn release_observation_hold(&self, id: &str, hold_id: &str) -> Result<()> {
        if let Some(service) = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned()
        {
            service.store.lock().unwrap().holds.remove(hold_id);
            service.wake.notify_all();
        }
        Ok(())
    }
    pub(super) fn cancel_observation(&self) {
        if let Some(service) = self.observation.lock().unwrap().as_ref() {
            service.cancel();
        }
    }
    pub(super) fn invalidate_session_observations(&self, id: &str, error: &ApiError) {
        self.cancel_mount_reads(Some(id));
        self.cancel_compose_session(id);
        let service = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == id)
            .cloned();
        if let Some(service) = service {
            service.invalidate(error);
        }
        self.invalidate_project_logs(id, error);
    }
    pub(super) fn stop_observation(&self) {
        let service = self.observation.lock().unwrap().take();
        if let Some(service) = service {
            service.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    fn pending_service() -> Arc<ObservationService> {
        Arc::new(ObservationService {
            session_id: "session".into(),
            store: Mutex::new(Store::new(ObservationScope::All, None)),
            wake: Condvar::new(),
            cancelled: AtomicBool::new(false),
            worker: Mutex::new(None),
            event_task: Mutex::new(None),
            validation_task: Mutex::new(None),
        })
    }

    #[test]
    fn event_retry_connecting_failure_and_manual_resume_record_one_interruption() {
        let engine = PendingEngine::new();
        let core = Core::default();
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
            target: engine.target.clone(),
        });
        let service = pending_service();
        *core.observation.lock().unwrap() = Some(service.clone());
        service.event_message(&core, ReaderMessage::Status(ReaderStatus::Following));
        for attempt in 1..=5 {
            service.event_message(&core, ReaderMessage::Status(ReaderStatus::Connecting));
            service.event_message(
                &core,
                ReaderMessage::Status(ReaderStatus::Retrying {
                    attempt,
                    delay_seconds: 1,
                }),
            );
        }
        let failure = || {
            ReaderMessage::Status(ReaderStatus::Failed(super::engine_reader::ReaderError {
                code: "ObservationTransport".into(),
                message: "fixture".into(),
                transient: true,
                invalidates_session: false,
            }))
        };
        service.event_message(&core, failure());
        assert_eq!(service.read(0).events.len(), 1);
        core.retry_observation_events("session").unwrap();
        assert_eq!(service.read(0).events.len(), 1);
        // Stop the pending transport before injecting a deterministic recovery.
        if let Some(task) = service.event_task.lock().unwrap().take() {
            task.cancel();
            tauri::async_runtime::block_on(task.join());
        }
        service.event_message(&core, ReaderMessage::Status(ReaderStatus::Following));
        service.event_message(&core, failure());
        assert_eq!(service.read(0).events.len(), 2);
        // A separate resource-observation delay remains a separate record.
        service
            .store
            .lock()
            .unwrap()
            .gap("Observation was delayed; resource samples may be missing");
        assert_eq!(service.read(0).events.len(), 3);
        service.invalidate(&ApiError::new("NeedsValidation", "fixture"));
        service.invalidate(&ApiError::new("NeedsValidation", "fixture"));
        assert_eq!(service.read(0).events.len(), 3);
        core.shutdown();
    }

    #[test]
    fn failed_event_start_and_repeated_resume_do_not_create_new_gaps() {
        let engine = PendingEngine::new();
        let core = Core::default();
        let mut target = engine.target.clone();
        target.endpoint = "tcp://fixture:2375".into();
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
            target,
        });
        let service = pending_service();
        *core.observation.lock().unwrap() = Some(service.clone());
        service.store.lock().unwrap().event_status = "error".into();
        for _ in 0..2 {
            assert_eq!(
                core.retry_observation_events("session").unwrap_err().code,
                "RemoteEndpoint"
            );
        }
        assert_eq!(service.read(0).events.len(), 1);
        core.shutdown();
    }

    struct PendingEngine {
        directory: PathBuf,
        _listener: UnixListener,
        target: Target,
        reader: EngineReader,
    }
    impl PendingEngine {
        fn new() -> Self {
            let directory = Path::new("/tmp")
                .canonicalize()
                .unwrap()
                .join(format!("d2u-lifecycle-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let socket = directory.join("engine.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let fingerprint = Fingerprint {
                id: "engine".into(),
                server: "27.5.0".into(),
                api: "1.47".into(),
                os: "linux".into(),
                arch: "aarch64".into(),
                name: "fixture".into(),
            };
            let reader = EngineReader::new(EngineTarget {
                socket_path: socket.clone(),
                fingerprint: EngineFingerprint {
                    id: fingerprint.id.clone(),
                    server: fingerprint.server.clone(),
                    api: fingerprint.api.clone(),
                    os: fingerprint.os.clone(),
                    arch: fingerprint.arch.clone(),
                    name: fingerprint.name.clone(),
                },
            })
            .unwrap();
            Self {
                directory,
                _listener: listener,
                reader,
                target: Target {
                    docker: "/fixture/docker".into(),
                    client_version: "fixture".into(),
                    endpoint: format!("unix://{}", socket.display()),
                    env: vec![],
                    docker_config: "/fixture/config".into(),
                    fingerprint,
                },
            }
        }
    }
    impl Drop for PendingEngine {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    struct Dropped(mpsc::Sender<()>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            let _ = self.0.send(());
        }
    }
    fn pending_validator() -> (tauri::async_runtime::JoinHandle<()>, mpsc::Receiver<()>) {
        let (started_tx, started_rx) = mpsc::channel();
        let (dropped_tx, dropped_rx) = mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let _signal = Dropped(dropped_tx);
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        (task, dropped_rx)
    }
    fn assert_event_slot_released(reader: &EngineReader) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(task) = reader.spawn_events(None, Arc::new(|_| {})) {
                task.cancel();
                tauri::async_runtime::block_on(task.join());
                return;
            }
            assert!(
                Instant::now() < deadline,
                "event permit survived cancellation"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn cancelled_service_rejects_late_event_validator_and_worker_installation() {
        let engine = PendingEngine::new();
        let service = pending_service();
        let event = engine.reader.spawn_events(None, Arc::new(|_| {})).unwrap();
        let (validator, dropped) = pending_validator();
        let (worker_done, finished) = mpsc::channel();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(30));
            worker_done.send(()).unwrap();
        });
        // Force the race ordering: task creation completed, then stop returned,
        // and only afterward does the configuring caller publish its handles.
        service.stop();
        assert!(!service.install_event_task(event));
        assert!(!service.install_validation_task(validator));
        assert!(!service.install_worker(worker));
        assert!(finished.try_recv().is_ok(), "rejected worker was detached");
        dropped.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_event_slot_released(&engine.reader);
        assert!(service.event_task.lock().unwrap().is_none());
        assert!(service.validation_task.lock().unwrap().is_none());
        assert!(service.worker.lock().unwrap().is_none());
    }

    #[test]
    fn needs_validation_fallback_cancels_project_event_and_validator_collectors() {
        let engine = PendingEngine::new();
        let core = Core::default();
        let now = chrono::Utc::now().to_rfc3339();
        let container = Container {
            handle: "handle".into(),
            full_id: "a".repeat(64),
            short_id: "a".repeat(12),
            name: "api".into(),
            image: "fixture".into(),
            state: "running".into(),
            health: None,
            health_configured: None,
            ports: vec![],
            created_at: now.clone(),
            started_at: Some(now.clone()),
            tty: false,
            compose_project: Some("orders".into()),
            compose_service: Some("api".into()),
        };
        let inventory = ContainerList {
            session_id: "session".into(),
            generation: 1,
            containers: vec![container.clone()],
            refreshed_at: now,
            stale: false,
        };
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            generation: 1,
            handles: [(container.handle.clone(), container)].into(),
            stale: false,
            needs_validation: false,
            inventory: Some(inventory),
            target: engine.target.clone(),
        });
        *core.engine_reader.lock().unwrap() = Some(("session".into(), engine.reader.clone()));
        core.configure_project_logs("session", "orders", None)
            .unwrap();
        let service = pending_service();
        *core.observation.lock().unwrap() = Some(service.clone());
        let event = engine.reader.spawn_events(None, Arc::new(|_| {})).unwrap();
        assert!(service.install_event_task(event));
        let (validator, dropped) = pending_validator();
        assert!(service.install_validation_task(validator));
        core.state
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .needs_validation = true;
        // The worker must take the fallback without dispatching any CLI work.
        service.clone().run(core.clone());
        assert!(service.cancelled());
        dropped.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_event_slot_released(&engine.reader);
        let query = ProjectLogQuery {
            project: "orders".into(),
            source_ids: vec![],
            keyword: String::new(),
            offset: None,
            limit: 10,
            after_sequence: None,
            through_sequence: None,
            anchor_row_id: None,
        };
        let logs = core.query_project_logs("session", &query).unwrap();
        assert_eq!(
            logs.error.as_ref().map(|error| error.code.as_str()),
            Some("NeedsValidation")
        );
        assert!(logs.sources.iter().all(|source| source.status == "error"));
        assert!(logs.rows.is_empty());
        let before = service.read(0).sequence;
        service.event_message(
            &core,
            ReaderMessage::Event(engine_reader::EngineEventRecord {
                time_nano: chrono::Utc::now().timestamp_nanos_opt().unwrap(),
                action: "die".into(),
                full_id: "a".repeat(64),
                attributes: Default::default(),
            }),
        );
        assert_eq!(
            service.read(0).sequence,
            before,
            "late events appended after cancellation"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut tasks = Vec::new();
            for index in 0..64 {
                let request = engine_reader::LogRequest {
                    full_id: format!("{index:064x}"),
                    tty: false,
                    since: None,
                    tail: 1,
                };
                if let Ok(task) = engine.reader.spawn_logs(request, Arc::new(|_| {})) {
                    tasks.push(task);
                }
            }
            let released = tasks.len() == 64;
            for task in &tasks {
                task.cancel();
            }
            tauri::async_runtime::block_on(async {
                for task in tasks {
                    task.join().await;
                }
            });
            if released {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "project log permit survived invalidation"
            );
            thread::sleep(Duration::from_millis(5));
        }
        core.shutdown();
    }

    #[test]
    fn interruptions_include_suspend_and_backward_clock_changes() {
        assert!(!collection_interrupted(
            Duration::from_secs(5),
            chrono::Duration::seconds(5)
        ));
        assert!(collection_interrupted(
            Duration::from_millis(100),
            chrono::Duration::minutes(2)
        ));
        assert!(collection_interrupted(
            Duration::from_secs(31),
            chrono::Duration::seconds(5)
        ));
        assert!(collection_interrupted(
            Duration::from_millis(100),
            chrono::Duration::seconds(-1)
        ));
    }
    #[test]
    fn retention_and_limits_do_not_fabricate_resource_values() {
        let mut store = Store::new(ObservationScope::All, None);
        let now = chrono::Utc::now();
        for index in 0..=RESOURCE_LIMIT {
            let sequence = store.advance();
            store.resources.push_back(ResourcePoint {
                sequence,
                full_id: format!("{index:064x}"),
                sampled_at: now.to_rfc3339(),
                cpu_percent: None,
                memory_usage_bytes: None,
                memory_limit_bytes: None,
                available: false,
            });
            if index == 0 {
                store.resources.back_mut().unwrap().sampled_at =
                    (now - chrono::Duration::minutes(31)).to_rfc3339();
            }
        }
        store.prune(now);
        assert_eq!(store.resources.len(), RESOURCE_LIMIT);
        assert!(!store.resource_truncated);
        store
            .resources
            .push_back(store.resources.back().unwrap().clone());
        store.resource_limits_dirty = true;
        store.prune(now);
        assert!(store.resource_truncated);
        assert!(
            store
                .resources
                .iter()
                .all(|point| !point.available && point.cpu_percent.is_none())
        );
        store.prune(now + chrono::Duration::minutes(31));
        assert!(store.resources.is_empty());
    }
    #[test]
    fn container_limit_keeps_recent_samples_and_gaps_independently() {
        let mut store = Store::new(ObservationScope::All, None);
        let now = chrono::Utc::now();
        for index in 0..=RESOURCE_LIMIT_PER_CONTAINER {
            for full_id in ["a".repeat(64), "b".repeat(64)] {
                let sequence = store.advance();
                store.resources.push_back(ResourcePoint {
                    sequence,
                    full_id,
                    sampled_at: (now
                        - chrono::Duration::seconds((RESOURCE_LIMIT_PER_CONTAINER - index) as i64))
                    .to_rfc3339(),
                    cpu_percent: (index % 2 == 0).then_some(1.0),
                    memory_usage_bytes: None,
                    memory_limit_bytes: None,
                    available: index % 2 == 0,
                });
            }
        }
        store.prune(now);
        assert!(store.resource_truncated);
        assert_eq!(store.resources.len(), RESOURCE_LIMIT_PER_CONTAINER * 2);
        assert_eq!(store.resources.front().unwrap().sequence, 3);
        for full_id in ["a".repeat(64), "b".repeat(64)] {
            let points: Vec<_> = store
                .resources
                .iter()
                .filter(|p| p.full_id == full_id)
                .collect();
            assert_eq!(points.len(), RESOURCE_LIMIT_PER_CONTAINER);
            assert!(points.iter().any(|point| !point.available));
            assert_eq!(points.last().unwrap().sampled_at, now.to_rfc3339());
        }
    }
    #[test]
    fn scope_changes_split_only_previously_observed_running_sources_that_leave() {
        let now = chrono::Utc::now().to_rfc3339();
        let containers = (0..4)
            .map(|index| Container {
                handle: index.to_string(),
                full_id: format!("{index:064x}"),
                short_id: format!("{index:012x}"),
                name: index.to_string(),
                image: "fixture".into(),
                state: if index == 2 { "exited" } else { "running" }.into(),
                health: None,
                health_configured: None,
                ports: vec![],
                created_at: now.clone(),
                started_at: None,
                tty: false,
                compose_project: Some(if index == 1 { "other" } else { "orders" }.into()),
                compose_service: None,
            })
            .collect::<Vec<_>>();
        let mut store = Store::new(
            ObservationScope::Project {
                name: "orders".into(),
            },
            Some(ContainerList {
                session_id: "session".into(),
                generation: 1,
                containers: containers.clone(),
                refreshed_at: now.clone(),
                stale: false,
            }),
        );
        for container in containers.iter().take(3) {
            let sequence = store.advance();
            store.resources.push_back(ResourcePoint {
                sequence,
                full_id: container.full_id.clone(),
                sampled_at: now.clone(),
                cpu_percent: Some(1.0),
                memory_usage_bytes: Some(1024.0),
                memory_limit_bytes: Some(2048.0),
                available: true,
            });
        }
        store.set_scope(ObservationScope::Project {
            name: "other".into(),
        });
        assert_eq!(
            store.resources.len(),
            4,
            "ignore exited, never observed and outside old scope sources"
        );
        let gap = store.resources.back().unwrap();
        assert_eq!(gap.full_id, containers[0].full_id);
        assert!(!gap.available);
        assert_eq!(gap.cpu_percent, None);
        assert_eq!(gap.memory_usage_bytes, None);
        assert_eq!(store.scope_revision, 1);
        store.set_scope(ObservationScope::Project {
            name: "other".into(),
        });
        assert_eq!(
            store.resources.len(),
            4,
            "same scope does not add another boundary"
        );
        store.set_scope(ObservationScope::Project {
            name: "orders".into(),
        });
        assert_eq!(store.resources.len(), 5);
        assert_eq!(
            store.resources.back().unwrap().full_id,
            containers[1].full_id
        );
        assert!(
            !store.resources[3].available,
            "returning promptly must retain the first collection gap"
        );
    }

    #[test]
    fn scope_is_independent_from_search_or_state_filters() {
        let container = Container {
            handle: "h".into(),
            full_id: "a".repeat(64),
            short_id: "a".repeat(12),
            name: "api".into(),
            image: "app".into(),
            state: "exited".into(),
            health: None,
            health_configured: None,
            ports: vec![],
            created_at: String::new(),
            started_at: None,
            tty: false,
            compose_project: Some("orders".into()),
            compose_service: Some("api".into()),
        };
        assert!(
            ObservationScope::Project {
                name: "orders".into()
            }
            .contains(&container)
        );
        assert!(!ObservationScope::None.contains(&container));
        assert!(
            !ObservationScope::Project {
                name: "other".into()
            }
            .contains(&container)
        );
    }

    #[test]
    fn events_keep_rapid_transitions_deduplicate_overlap_and_retain_recovery_gaps() {
        let core = Core::default();
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
            target: Target {
                docker: "/fixture/docker".into(),
                client_version: "fixture".into(),
                endpoint: "unix:///fixture/engine.sock".into(),
                env: vec![],
                docker_config: "/fixture/config".into(),
                fingerprint: Fingerprint {
                    id: "engine".into(),
                    server: "1".into(),
                    api: "1.54".into(),
                    os: "linux".into(),
                    arch: "arm64".into(),
                    name: "fixture".into(),
                },
            },
        });
        let service = ObservationService {
            session_id: "session".into(),
            store: Mutex::new(Store::new(ObservationScope::All, None)),
            wake: Condvar::new(),
            cancelled: AtomicBool::new(false),
            worker: Mutex::new(None),
            event_task: Mutex::new(None),
            validation_task: Mutex::new(None),
        };
        let message = |action: &str, nanos| {
            ReaderMessage::Event(engine_reader::EngineEventRecord {
                time_nano: nanos,
                action: action.into(),
                full_id: "a".repeat(64),
                attributes: [
                    ("name".into(), "api".into()),
                    ("com.docker.compose.project".into(), "orders".into()),
                ]
                .into(),
            })
        };
        service.event_message(&core, message("die", 1_700_000_000_000_000_001));
        service.event_message(&core, message("start", 1_700_000_000_000_000_002));
        service.event_message(&core, message("die", 1_700_000_000_000_000_001));
        service.event_message(&core, message("exec_start", 1_700_000_000_000_000_003));
        let observed = service.read(0);
        assert_eq!(observed.events.len(), 2);
        assert_eq!(observed.events[0].kind, "die");
        assert_eq!(observed.events[1].kind, "start");
        assert_ne!(
            observed.events[0].occurred_at,
            observed.events[1].occurred_at
        );
        assert_eq!(
            observed.events[0].compose_project.as_deref(),
            Some("orders")
        );
        assert_eq!(observed.resources.len(), 2);
        assert!(observed.resources.iter().all(|point| !point.available));
        service.event_message(
            &core,
            ReaderMessage::Status(ReaderStatus::Retrying {
                attempt: 1,
                delay_seconds: 1,
            }),
        );
        service.event_message(&core, ReaderMessage::Status(ReaderStatus::Following));
        let resumed = service.read(observed.sequence);
        assert_eq!(resumed.event_status, "following");
        assert_eq!(resumed.events.len(), 1);
        assert_eq!(resumed.events[0].kind, "gap");
        assert!(resumed.resources.is_empty());
        service.store.lock().unwrap().scope = ObservationScope::Project {
            name: "another-project".into(),
        };
        service.event_message(&core, message("die", 1_700_000_000_000_000_004));
        let outside_scope = service.read(resumed.sequence);
        assert_eq!(
            outside_scope.events.len(),
            1,
            "events still cover the Engine"
        );
        assert!(
            outside_scope.resources.is_empty(),
            "resource gaps follow the collection scope"
        );
    }
}
