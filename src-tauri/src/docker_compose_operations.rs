use super::*;

const OPERATION_BYTES: usize = 2 * 1024 * 1024;
const TOTAL_BYTES: usize = 8 * 1024 * 1024;
const OPERATION_COUNT: usize = 10;
const READ_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ComposeAction {
    Up,
    Stop,
}
impl ComposeAction {
    fn command(self) -> &'static [&'static str] {
        match self {
            Self::Up => &["up", "--detach"],
            Self::Stop => &["stop"],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store(id: &str) -> OperationStore {
        OperationStore {
            operation: ComposeOperation {
                id: id.into(),
                session_id: "session".into(),
                project_id: "project".into(),
                project_name: "demo".into(),
                action: ComposeAction::Up,
                phase: "finished".into(),
                outcome: Some("succeeded".into()),
                cancel_requested: false,
                exit_code: Some(0),
                started_at: "now".into(),
                finished_at: Some("then".into()),
                reconciliation: "succeeded".into(),
                observed_containers: Some(1),
                error: None,
            },
            output: VecDeque::new(),
            bytes: 0,
            sequence: 0,
            lost: false,
        }
    }
    fn job(id: &str) -> Arc<OperationRecord> {
        Arc::new(OperationRecord {
            store: Mutex::new(store(id)),
            execution_cancel: Arc::new(AtomicBool::new(false)),
            reconciliation_cancel: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            request_id: id.into(),
            prepare_id: id.into(),
            launch_registered: AtomicBool::new(true),
        })
    }
    #[test]
    fn compose_replay_preserves_unicode_and_reports_evicted_output() {
        let mut store = store("job");
        store.append(&"로그🙂\n".repeat(300_000), false);
        assert!(store.bytes <= OPERATION_BYTES);
        let first = store.read(0);
        assert!(first.truncated);
        assert!(first.oldest_sequence > 1);
        assert!(first.text.len() <= READ_BYTES);
        assert_eq!(first.text, store.read(0).text);
        let mut sequence = 0;
        let mut bytes = 0;
        loop {
            let read = store.read(sequence);
            if read.text.is_empty() {
                break;
            }
            assert!(read.next_sequence > sequence);
            sequence = read.next_sequence;
            bytes += read.text.len();
        }
        assert_eq!(bytes, store.bytes);
        assert_eq!(sequence, store.sequence);
        assert_eq!(store.operation.outcome.as_deref(), Some("succeeded"));
    }
    #[test]
    fn compose_output_global_limit_and_recent_count_preserve_active_job() {
        let mut manager = ComposeOperationManager::default();
        let active = job("active");
        active.store.lock().unwrap().operation.phase = "running".into();
        manager.jobs.push_back(active.clone());
        for index in 0..12 {
            let job = job(&index.to_string());
            job.store
                .lock()
                .unwrap()
                .append(&"x".repeat(OPERATION_BYTES), false);
            manager.jobs.push_back(job);
            manager.prune();
        }
        assert_eq!(manager.jobs.len(), OPERATION_COUNT);
        assert!(manager.jobs.iter().any(|job| Arc::ptr_eq(job, &active)));
        assert!(
            manager
                .jobs
                .iter()
                .map(|job| job.store.lock().unwrap().bytes)
                .sum::<usize>()
                <= TOTAL_BYTES
        );
        let newest = manager.jobs.back().unwrap().store.lock().unwrap();
        assert_eq!(newest.bytes, OPERATION_BYTES);
        assert_eq!(newest.operation.exit_code, Some(0));
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeOperationPreview {
    pub prepare_id: String,
    pub project: ComposeProject,
    pub action: ComposeAction,
    pub compose_version: String,
    pub services: Vec<ComposeServicePreview>,
    pub existing_containers: usize,
    pub recreate_possible: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeOperation {
    pub id: String,
    pub session_id: String,
    pub project_id: String,
    pub project_name: String,
    pub action: ComposeAction,
    pub phase: String,
    pub outcome: Option<String>,
    pub cancel_requested: bool,
    pub exit_code: Option<i32>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub reconciliation: String,
    pub observed_containers: Option<usize>,
    pub error: Option<ApiError>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeOperationRead {
    pub operation: ComposeOperation,
    pub text: String,
    pub oldest_sequence: u64,
    pub next_sequence: u64,
    pub truncated: bool,
}
struct OperationStore {
    operation: ComposeOperation,
    output: VecDeque<(u64, String)>,
    bytes: usize,
    sequence: u64,
    lost: bool,
}
impl OperationStore {
    fn append(&mut self, text: &str, truncated: bool) {
        self.lost |= truncated;
        let mut rest = text;
        while !rest.is_empty() {
            let mut end = rest.len().min(8192);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            self.sequence += 1;
            self.output.push_back((self.sequence, rest[..end].into()));
            self.bytes += end;
            rest = &rest[end..];
        }
        while self.bytes > OPERATION_BYTES {
            self.evict_row();
        }
    }
    fn evict_row(&mut self) -> bool {
        if let Some((_, text)) = self.output.pop_front() {
            self.bytes -= text.len();
            self.lost = true;
            true
        } else {
            false
        }
    }
    fn read(&self, after: u64) -> ComposeOperationRead {
        let oldest = self
            .output
            .front()
            .map(|(seq, _)| *seq)
            .unwrap_or(self.sequence + 1);
        let mut text = String::new();
        let mut next = after.min(self.sequence);
        for (sequence, row) in &self.output {
            if *sequence > after {
                if !text.is_empty() && text.len() + row.len() > READ_BYTES {
                    break;
                }
                text.push_str(row);
                next = *sequence;
            }
        }
        ComposeOperationRead {
            operation: self.operation.clone(),
            text,
            oldest_sequence: oldest,
            next_sequence: next,
            truncated: self.lost || after.saturating_add(1) < oldest,
        }
    }
}
struct OperationRecord {
    store: Mutex<OperationStore>,
    execution_cancel: Arc<AtomicBool>,
    reconciliation_cancel: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    request_id: String,
    prepare_id: String,
    launch_registered: AtomicBool,
}
impl OperationRecord {
    fn snapshot(&self) -> ComposeOperation {
        self.store.lock().unwrap().operation.clone()
    }
    fn cancel(&self, all: bool) {
        let mut store = self.store.lock().unwrap();
        if store.operation.phase == "finished" {
            return;
        }
        store.operation.cancel_requested = true;
        self.execution_cancel.store(true, Ordering::Release);
        if all || store.operation.phase == "reconciling" {
            self.reconciliation_cancel.store(true, Ordering::Release);
        }
    }
    fn join(&self) {
        while !self.launch_registered.load(Ordering::Acquire) {
            thread::sleep(Duration::from_millis(1));
        }
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
    fn fail_before_start(&self, error: ApiError) {
        let mut store = self.store.lock().unwrap();
        store.operation.outcome = Some(
            if store.operation.cancel_requested || self.execution_cancel.load(Ordering::Acquire) {
                "cancelledBeforeStart"
            } else {
                "failed"
            }
            .into(),
        );
        store.operation.error = Some(error);
        store.operation.reconciliation = "skipped".into();
        store.operation.phase = "finished".into();
        store.operation.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }
}
#[derive(Clone)]
struct PreparedOperation {
    session: Session,
    project: ComposeProject,
    validated: ValidatedProject,
    action: ComposeAction,
    created: Instant,
}
#[derive(Default)]
struct ValidationControl {
    cancel: Arc<AtomicBool>,
    readers: Mutex<usize>,
    wake: std::sync::Condvar,
}
pub(super) struct ComposeValidationGuard {
    control: Arc<ValidationControl>,
}
impl ComposeValidationGuard {
    pub(super) fn token(&self) -> Arc<AtomicBool> {
        self.control.cancel.clone()
    }
}
impl Drop for ComposeValidationGuard {
    fn drop(&mut self) {
        *self.control.readers.lock().unwrap() -= 1;
        self.control.wake.notify_all();
    }
}
#[derive(Default)]
pub(in super::super) struct ComposeOperationManager {
    prepared: HashMap<String, PreparedOperation>,
    jobs: VecDeque<Arc<OperationRecord>>,
    validation_tokens: HashMap<String, Arc<ValidationControl>>,
}
impl ComposeOperationManager {
    pub(in super::super) fn cancel_session(&mut self, session_id: &str) {
        self.prepared.retain(|_, p| p.session.id != session_id);
        if let Some(control) = self.validation_tokens.get(session_id) {
            control.cancel.store(true, Ordering::Release);
        }
        for job in &self.jobs {
            if job.snapshot().session_id == session_id {
                job.cancel(true);
            }
        }
    }
    pub(super) fn has_active_project(&self, id: &str) -> bool {
        self.jobs.iter().any(|job| {
            let op = job.snapshot();
            op.project_id == id && op.phase != "finished"
        })
    }
    fn prune(&mut self) {
        self.prepared
            .retain(|_, p| p.created.elapsed() < PREVIEW_TTL);
        while self.prepared.len() >= PREVIEW_LIMIT {
            if let Some(key) = self
                .prepared
                .iter()
                .min_by_key(|(key, p)| (p.created, *key))
                .map(|(key, _)| key.clone())
            {
                self.prepared.remove(&key);
            }
        }
        while self.jobs.len() > OPERATION_COUNT {
            if let Some(index) = self
                .jobs
                .iter()
                .position(|job| job.snapshot().phase == "finished")
            {
                self.jobs.remove(index);
            } else {
                break;
            }
        }
        let mut total: usize = self
            .jobs
            .iter()
            .map(|job| job.store.lock().unwrap().bytes)
            .sum();
        for job in &self.jobs {
            let mut store = job.store.lock().unwrap();
            while total > TOTAL_BYTES {
                let before = store.bytes;
                if !store.evict_row() {
                    break;
                }
                total -= before - store.bytes;
            }
        }
    }
}
struct ComposeReservation {
    core: Core,
    operation_id: String,
    session_id: String,
    job: Arc<OperationRecord>,
}
impl Drop for ComposeReservation {
    fn drop(&mut self) {
        {
            let mut store = self.job.store.lock().unwrap_or_else(|e| e.into_inner());
            if store.operation.phase != "finished" {
                store.operation.phase = "finished".into();
                store.operation.outcome = Some("resultUnknown".into());
                store.operation.error = Some(ApiError::new(
                    "WorkerFailed",
                    "The Compose worker was interrupted; inspect the current project state",
                ));
                store.operation.finished_at = Some(chrono::Utc::now().to_rfc3339());
                store.operation.reconciliation = "failed".into();
            }
        }
        let mut state = self.core.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.compose_operation.as_deref() == Some(&self.operation_id) {
            state.compose_operation = None;
        }
        if let Some(session) = state.session.as_mut().filter(|s| s.id == self.session_id) {
            if self.job.snapshot().reconciliation == "failed" {
                session.stale = true;
            }
        }
    }
}

impl Core {
    pub(super) fn compose_validation_guard(
        &self,
        session_id: &str,
    ) -> Result<ComposeValidationGuard> {
        let state = self.state.lock().unwrap();
        if state.closing
            || !state
                .session
                .as_ref()
                .is_some_and(|session| session.id == session_id && !session.needs_validation)
        {
            return Err(ApiError::new(
                "StaleSession",
                "Reconnect before validating Compose",
            ));
        }
        let mut manager = self.compose_operations.lock().unwrap();
        let control = manager
            .validation_tokens
            .entry(session_id.into())
            .or_default()
            .clone();
        *control.readers.lock().unwrap() += 1;
        Ok(ComposeValidationGuard { control })
    }
    pub fn prepare_compose_operation(
        &self,
        session_id: &str,
        project_id: &str,
        expected_revision: u64,
        action: ComposeAction,
    ) -> Result<ComposeOperationPreview> {
        let project = self.registered_compose_project(project_id, expected_revision)?;
        let session = self.active(session_id)?;
        let (input, proofs) = normalize_input(project.input())?;
        let validation = self.compose_validation_guard(session_id)?;
        let validated = self.validate_compose(
            &session,
            input,
            proofs,
            validation.token(),
            Instant::now() + Duration::from_secs(30),
        )?;
        self.registered_compose_project(project_id, expected_revision)?;
        let preview = ComposeOperationPreview {
            prepare_id: uuid::Uuid::new_v4().to_string(),
            project: project.clone(),
            action,
            compose_version: validated.compose_version.clone(),
            services: validated.services.clone(),
            existing_containers: validated.existing_containers,
            recreate_possible: action == ComposeAction::Up && validated.existing_containers > 0,
        };
        let mut manager = self.compose_operations.lock().unwrap();
        manager.prune();
        manager.prepared.insert(
            preview.prepare_id.clone(),
            PreparedOperation {
                session,
                project,
                validated,
                action,
                created: Instant::now(),
            },
        );
        Ok(preview)
    }
    fn registered_compose_project(
        &self,
        project_id: &str,
        revision: u64,
    ) -> Result<ComposeProject> {
        let registry = self.compose_registry.lock().unwrap();
        registry.ready()?;
        registry
            .projects
            .iter()
            .find(|p| p.id == project_id && p.revision == revision)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "RegistrationChanged",
                    "Reload the registered project before continuing",
                )
            })
    }
    pub fn start_compose_operation(
        &self,
        session_id: &str,
        prepare_id: &str,
        request_id: &str,
    ) -> Result<ComposeOperation> {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(ApiError::new(
                "InvalidRequest",
                "A bounded operation request ID is required",
            ));
        }
        let (prepared, job) = {
            let mut state = self.state.lock().unwrap();
            let active = state
                .session
                .as_ref()
                .filter(|s| s.id == session_id)
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before using Compose"))?;
            if active.needs_validation || active.stale || state.closing {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Reconnect before using Compose",
                ));
            }
            let mut manager = self.compose_operations.lock().unwrap();
            manager.prune();
            if let Some(job) = manager
                .jobs
                .iter()
                .find(|job| job.request_id == request_id && job.snapshot().session_id == session_id)
            {
                if job.prepare_id != prepare_id {
                    return Err(ApiError::new(
                        "InvalidRequest",
                        "This request ID was already used for a different operation",
                    ));
                }
                return Ok(job.snapshot());
            }
            if state.compose_operation.is_some()
                || state.mutating
                || state.diagnosing
                || state.refreshing
            {
                return Err(ApiError::new(
                    "Busy",
                    "Another environment change is in progress",
                ));
            }
            let prepared = manager
                .prepared
                .get(prepare_id)
                .filter(|p| p.session.id == session_id && p.created.elapsed() < PREVIEW_TTL)
                .cloned()
                .ok_or_else(|| {
                    ApiError::new(
                        "PreviewExpired",
                        "Review the Compose operation again before running it",
                    )
                })?;
            self.registered_compose_project(&prepared.project.id, prepared.project.revision)?;
            let id = uuid::Uuid::new_v4().to_string();
            let operation = ComposeOperation {
                id: id.clone(),
                session_id: session_id.into(),
                project_id: prepared.project.id.clone(),
                project_name: prepared.project.name.clone(),
                action: prepared.action,
                phase: "preparing".into(),
                outcome: None,
                cancel_requested: false,
                exit_code: None,
                started_at: chrono::Utc::now().to_rfc3339(),
                finished_at: None,
                reconciliation: "pending".into(),
                observed_containers: None,
                error: None,
            };
            let job = Arc::new(OperationRecord {
                store: Mutex::new(OperationStore {
                    operation,
                    output: VecDeque::new(),
                    bytes: 0,
                    sequence: 0,
                    lost: false,
                }),
                execution_cancel: Arc::new(AtomicBool::new(false)),
                reconciliation_cancel: Arc::new(AtomicBool::new(false)),
                worker: Mutex::new(None),
                request_id: request_id.into(),
                prepare_id: prepare_id.into(),
                launch_registered: AtomicBool::new(false),
            });
            state.compose_operation = Some(id);
            manager.prepared.remove(prepare_id);
            manager.jobs.push_back(job.clone());
            manager.prune();
            (prepared, job)
        };
        let core = self.clone();
        let worker_job = job.clone();
        // Publish the join handle before Reconnect may take it. The worker never locks this slot.
        let mut worker_slot = job.worker.lock().unwrap();
        match thread::Builder::new()
            .name("docker2u-compose".into())
            .spawn(move || {
                let snapshot = worker_job.snapshot();
                let _reservation = ComposeReservation {
                    core: core.clone(),
                    operation_id: snapshot.id,
                    session_id: snapshot.session_id,
                    job: worker_job.clone(),
                };
                core.run_compose_operation(prepared, worker_job);
            }) {
            Ok(worker) => *worker_slot = Some(worker),
            Err(_) => {
                job.fail_before_start(ApiError::new(
                    "StartFailed",
                    "The Compose worker could not start",
                ));
                let mut state = self.state.lock().unwrap();
                if state.compose_operation.as_deref() == Some(&job.snapshot().id) {
                    state.compose_operation = None;
                }
            }
        }
        drop(worker_slot);
        job.launch_registered.store(true, Ordering::Release);
        Ok(job.snapshot())
    }
    fn run_compose_operation(&self, prepared: PreparedOperation, job: Arc<OperationRecord>) {
        let start = Instant::now();
        let validation = self.validate_compose(
            &prepared.session,
            prepared.validated.input.clone(),
            prepared.validated.proofs.clone(),
            job.execution_cancel.clone(),
            start + Duration::from_secs(30),
        );
        let validated = match validation {
            Ok(validated) => validated,
            Err(error) => {
                job.fail_before_start(error);
                return;
            }
        };
        if validated.resolved_digest != prepared.validated.resolved_digest {
            job.fail_before_start(ApiError::new("ProjectFilesChanged", "The resolved Compose configuration changed after review. Review the operation again"));
            return;
        }
        if let Err(error) =
            self.registered_compose_project(&prepared.project.id, prepared.project.revision)
        {
            job.fail_before_start(error);
            return;
        }
        let timeout = match prepared.action {
            ComposeAction::Up => Duration::from_secs(30 * 60),
            ComposeAction::Stop => Duration::from_secs(2 * 60),
        };
        let options = compose_options(
            &validated.input,
            job.execution_cancel.clone(),
            Instant::now() + timeout,
        );
        let arguments = compose_arguments(
            &prepared.session.target,
            &validated.input,
            prepared.action.command(),
        );
        #[cfg(test)]
        if let Some((entered, release)) = &self.compose_pre_spawn_barriers {
            entered.wait();
            release.wait();
        }
        let process = {
            let state = self.state.lock().unwrap();
            let snapshot = job.snapshot();
            let current = state.session.as_ref().is_some_and(|session| {
                session.id == prepared.session.id && !session.needs_validation && !session.stale
            });
            if !current
                || state.closing
                || state.compose_operation.as_deref() != Some(&snapshot.id)
                || job.execution_cancel.load(Ordering::Acquire)
            {
                drop(state);
                job.fail_before_start(ApiError::new(
                    "Cancelled",
                    "Compose execution was cancelled before launch",
                ));
                return;
            }
            // Session retirement and mutation launch share this short boundary.
            let result = self.runner.start_follow_with_options(
                &prepared.session.target.docker,
                &arguments,
                &compose_environment(&prepared.session.target),
                &options,
            );
            match result {
                Ok(process) => {
                    job.store.lock().unwrap().operation.phase = "running".into();
                    process
                }
                Err(_) => {
                    drop(state);
                    job.fail_before_start(ApiError::new(
                        "StartFailed",
                        "The Compose command could not start",
                    ));
                    return;
                }
            }
        };
        let terminal = loop {
            let read = process.read();
            job.store.lock().unwrap().append(&read.text, read.truncated);
            self.compose_operations.lock().unwrap().prune();
            if read.terminal {
                break read;
            }
            thread::sleep(Duration::from_millis(50));
        };
        {
            let mut store = job.store.lock().unwrap();
            store.operation.exit_code = terminal.exit_code;
            let unknown = terminal.interrupted || terminal.exit_code.is_none();
            store.operation.outcome = Some(
                if unknown {
                    "resultUnknown"
                } else if terminal.exit_code == Some(0) {
                    "succeeded"
                } else {
                    "failed"
                }
                .into(),
            );
            if unknown {
                store.operation.error = Some(ApiError::new(
                    if terminal.timed_out {
                        "TimedOut"
                    } else {
                        "ResultUnknown"
                    },
                    "Compose stopped before its result could be confirmed. Changes already accepted by Docker may remain",
                ));
            } else if terminal.exit_code != Some(0) {
                store.operation.error = Some(ApiError::new(
                    "CommandFailed",
                    "Compose returned an error. Some project changes may already have completed",
                ));
            }
            store.operation.phase = "reconciling".into();
        }
        // User cancellation stops the CLI, then separately reads actual Engine state.
        // Reconnect/invalidation also cancels this separate, bounded read phase.
        let reconciliation = (|| {
            self.active(&prepared.session.id)?;
            let options = compose_options(
                &validated.input,
                job.reconciliation_cancel.clone(),
                Instant::now() + Duration::from_secs(45),
            );
            self.verify_compose_target(&prepared.session.target, &options)?;
            self.compose_provenance(&prepared.session.target, &validated.input, &options)
        })();
        {
            let mut store = job.store.lock().unwrap();
            match reconciliation {
                Ok(count) => {
                    store.operation.reconciliation = "succeeded".into();
                    store.operation.observed_containers = Some(count);
                }
                Err(error) => {
                    store.operation.reconciliation = if error.code == "StaleSession" {
                        "skipped"
                    } else {
                        "failed"
                    }
                    .into();
                    if store.operation.error.is_none() {
                        store.operation.error = Some(error);
                    }
                }
            }
            store.operation.phase = "finished".into();
            store.operation.finished_at = Some(chrono::Utc::now().to_rfc3339());
        }
        // Preserve terminal metadata before Drop requests process cancellation.
        drop(process);
        self.request_compose_inventory_refresh(&prepared.session.id);
    }
    fn request_compose_inventory_refresh(&self, session_id: &str) {
        // Refresh through the observer so its public generation and source reconciliation
        // stay in sync with the existing UI. No synchronous mutex waits on CLI completion.
        if let Some(service) = self
            .observation
            .lock()
            .unwrap()
            .as_ref()
            .filter(|service| service.session_id == session_id)
            .cloned()
        {
            service.request_inventory_refresh();
        }
    }
    pub fn list_compose_operations(&self, session_id: &str) -> Result<Vec<ComposeOperation>> {
        self.active(session_id)?;
        let mut manager = self.compose_operations.lock().unwrap();
        manager.prune();
        Ok(manager.jobs.iter().map(|job| job.snapshot()).collect())
    }
    pub fn read_compose_operation(
        &self,
        session_id: &str,
        operation_id: &str,
        after_sequence: u64,
    ) -> Result<ComposeOperationRead> {
        // Output belongs to the app-session archive, even after Engine reconnect.
        // Both stored identifiers must still match; this grants no mutation authority.
        let job = self.compose_job(session_id, operation_id)?;
        let store = job.store.lock().unwrap();
        if after_sequence > store.sequence {
            return Err(ApiError::new(
                "InvalidCursor",
                "This output cursor is newer than the operation output",
            ));
        }
        Ok(store.read(after_sequence))
    }
    pub fn cancel_compose_operation(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> Result<ComposeOperation> {
        self.active(session_id)?;
        let job = self.compose_job(session_id, operation_id)?;
        job.cancel(false);
        Ok(job.snapshot())
    }
    fn compose_job(&self, session_id: &str, operation_id: &str) -> Result<Arc<OperationRecord>> {
        self.compose_operations
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|job| {
                let op = job.snapshot();
                op.id == operation_id && op.session_id == session_id
            })
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "OperationUnavailable",
                    "This Compose operation is no longer retained",
                )
            })
    }
    pub(in super::super) fn cancel_compose_session(&self, session_id: &str) {
        self.compose_operations
            .lock()
            .unwrap()
            .cancel_session(session_id);
    }
    pub(in super::super) fn cancel_all_compose_and_wait(&self) {
        let (jobs, controls) = {
            let mut manager = self.compose_operations.lock().unwrap();
            manager.prepared.clear();
            let controls = manager
                .validation_tokens
                .drain()
                .map(|(_, control)| control)
                .collect::<Vec<_>>();
            (manager.jobs.iter().cloned().collect::<Vec<_>>(), controls)
        };
        for control in &controls {
            control.cancel.store(true, Ordering::Release);
        }
        for job in &jobs {
            job.cancel(true);
        }
        for job in &jobs {
            job.join();
        }
        for control in controls {
            let mut readers = control.readers.lock().unwrap();
            while *readers > 0 {
                readers = control.wake.wait(readers).unwrap();
            }
        }
    }
}
