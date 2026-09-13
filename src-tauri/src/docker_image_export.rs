//! Session-bound image exports. Rust owns both image identity and destination.
use super::*;
use crate::process::ProcessOptions;
use std::{
    collections::VecDeque,
    ffi::CString,
    fs::{self, File, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt, fs::OpenOptionsExt},
    },
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Instant,
};

const IMAGE_ID_FORMAT: &str = r#"{"Id":{{json .Id}},"ImageId":{{json .Image}}}"#;
const PREPARE_TTL: Duration = Duration::from_secs(300);
const EXPORT_DEADLINE: Duration = Duration::from_secs(30 * 60);
const RETENTION: usize = 10;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportPreview {
    pub prepare_id: String,
    pub session_id: String,
    pub container_id: String,
    pub container_name: String,
    pub image_id: String,
    pub image_reference: String,
    pub engine_id: String,
    pub engine_name: String,
    pub engine_endpoint: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportDestination {
    pub destination_token: String,
    pub path: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageExportPhase {
    Queued,
    Exporting,
    Publishing,
    Finished,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageExportOutcome {
    Succeeded,
    Failed,
    CancelledBeforeStart,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportOperation {
    pub id: String,
    pub request_id: String,
    pub session_id: String,
    pub container_id: String,
    pub container_name: String,
    pub image_id: String,
    pub image_reference: String,
    pub engine_id: String,
    pub engine_name: String,
    pub engine_endpoint: String,
    pub path: String,
    pub phase: ImageExportPhase,
    pub outcome: Option<ImageExportOutcome>,
    pub bytes_written: u64,
    pub elapsed_ms: u64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub stderr_truncated: bool,
    pub error: Option<ApiError>,
    pub cleanup_warning: Option<String>,
}

#[derive(Clone)]
struct PreparedExport {
    preview: ImageExportPreview,
    session: Session,
    expires: Instant,
}

#[derive(Clone)]
struct Destination {
    response: ImageExportDestination,
    prepare_id: String,
    session_id: String,
    directory: Arc<File>,
    directory_path: PathBuf,
    name: CString,
}

struct ImageExportJob {
    operation: Mutex<ImageExportOperation>,
    prepare_id: String,
    destination_token: String,
    cancel: Arc<AtomicBool>,
    committed: AtomicBool,
    started: Instant,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl ImageExportJob {
    fn snapshot(&self) -> ImageExportOperation {
        let mut operation = self.operation.lock().unwrap();
        if operation.outcome.is_none() {
            operation.elapsed_ms = self.started.elapsed().as_millis() as u64;
        }
        operation.clone()
    }

    fn finish(&self, outcome: ImageExportOutcome, error: Option<ApiError>) {
        let mut operation = self.operation.lock().unwrap();
        if operation.outcome.is_some() {
            return;
        }
        let (outcome, error) = if self.committed.load(Ordering::Acquire) {
            if let Some(error) = error {
                operation.cleanup_warning = Some(format!(
                    "Archive saved, but post-publication work could not finish: {}",
                    error.message
                ));
            }
            (ImageExportOutcome::Succeeded, None)
        } else {
            (outcome, error)
        };
        finish_operation(&mut operation, outcome, error, self.started);
    }

    fn join(&self) {
        // Start holds this lock until the new worker is registered.
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

fn finish_operation(
    operation: &mut ImageExportOperation,
    outcome: ImageExportOutcome,
    error: Option<ApiError>,
    started: Instant,
) {
    if operation.outcome.is_none() {
        operation.phase = ImageExportPhase::Finished;
        operation.outcome = Some(outcome);
        operation.error = error;
        operation.elapsed_ms = started.elapsed().as_millis() as u64;
        operation.finished_at = Some(chrono::Utc::now().to_rfc3339());
    }
}

#[derive(Default)]
pub(super) struct ImageExportManager {
    prepared: HashMap<String, PreparedExport>,
    destinations: HashMap<String, Destination>,
    jobs: VecDeque<Arc<ImageExportJob>>,
    active: Option<String>,
    picker_active: bool,
}

impl ImageExportManager {
    fn prune(&mut self) {
        self.prepared
            .retain(|_, value| value.expires > Instant::now());
        self.destinations
            .retain(|_, value| self.prepared.contains_key(&value.prepare_id));
        while self.jobs.len() > RETENTION {
            if let Some(index) = self
                .jobs
                .iter()
                .position(|job| job.snapshot().outcome.is_some())
            {
                self.jobs.remove(index);
            } else {
                break;
            }
        }
    }
}

pub(crate) struct ImageExportPickerGuard(Arc<Mutex<ImageExportManager>>);
impl Drop for ImageExportPickerGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap().picker_active = false;
    }
}

struct ExportReservation {
    manager: Arc<Mutex<ImageExportManager>>,
    job: Arc<ImageExportJob>,
}
impl Drop for ExportReservation {
    fn drop(&mut self) {
        self.job.finish(
            ImageExportOutcome::Failed,
            Some(ApiError::new(
                "WorkerFailed",
                "Image export worker interrupted",
            )),
        );
        let mut manager = self.manager.lock().unwrap();
        if manager.active.as_deref() == Some(&self.job.snapshot().id) {
            manager.active = None;
        }
        manager.prune();
    }
}

fn file_error(action: &str, error: std::io::Error) -> ApiError {
    ApiError::new(
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "ImageExportDestinationExists"
        } else {
            "ImageExportIo"
        },
        format!("{action}: {error}"),
    )
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn entry_metadata(directory: &File, name: &CString) -> std::io::Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: directory is live, name is NUL-terminated, stat is initialized on success.
    let result = unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        Ok(unsafe { stat.assume_init() })
    } else {
        Err(std::io::Error::last_os_error())
    }
}

impl Destination {
    fn open(session_id: &str, prepare_id: &str, path: PathBuf) -> Result<Self> {
        if !path.is_absolute()
            || path
                .extension()
                .and_then(|v| v.to_str())
                .map(str::to_ascii_lowercase)
                != Some("tar".into())
        {
            return Err(ApiError::new(
                "InvalidImageExportDestination",
                "Choose an absolute local path with a .tar extension",
            ));
        }
        let name = path
            .file_name()
            .ok_or_else(|| ApiError::new("InvalidImageExportDestination", "Choose a file name"))?;
        let name = CString::new(name.as_bytes())
            .map_err(|_| ApiError::new("InvalidImageExportDestination", "Invalid file name"))?;
        let directory_path = fs::canonicalize(path.parent().unwrap())
            .map_err(|error| file_error("Cannot resolve destination folder", error))?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&directory_path)
            .map_err(|error| file_error("Cannot open destination folder", error))?;
        let display_path = directory_path.join(path.file_name().unwrap());
        let value = Self {
            response: ImageExportDestination {
                destination_token: uuid::Uuid::new_v4().to_string(),
                path: display_path.to_string_lossy().into_owned(),
            },
            prepare_id: prepare_id.into(),
            session_id: session_id.into(),
            directory: Arc::new(directory),
            directory_path,
            name,
        };
        value.verify()?;
        Ok(value)
    }

    fn verify(&self) -> Result<()> {
        let opened = self
            .directory
            .metadata()
            .map_err(|error| file_error("Cannot inspect destination folder", error))?;
        let current = fs::symlink_metadata(&self.directory_path)
            .map_err(|error| file_error("Destination folder is unavailable", error))?;
        if !current.is_dir() || !same_file(&opened, &current) {
            return Err(ApiError::new(
                "ImageExportDestinationChanged",
                "The selected destination folder changed",
            ));
        }
        match entry_metadata(&self.directory, &self.name) {
            Ok(_) => Err(ApiError::new(
                "ImageExportDestinationExists",
                "A file already exists at the selected path; choose a new file name",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(file_error("Cannot inspect destination path", error)),
        }
    }
}

struct TemporaryArchive {
    destination: Destination,
    name: CString,
    file: File,
    removed: bool,
    job: Option<Arc<ImageExportJob>>,
}

impl TemporaryArchive {
    fn create(destination: Destination, job: Option<Arc<ImageExportJob>>) -> Result<Self> {
        destination.verify()?;
        let name =
            CString::new(format!(".docker2u-export-{}.partial", uuid::Uuid::new_v4())).unwrap();
        // SAFETY: both descriptor and C string remain live. O_EXCL never follows
        // or replaces an existing entry, and the descriptor owns the new file.
        let fd = unsafe {
            libc::openat(
                destination.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(file_error(
                "Cannot create temporary archive",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(Self {
            destination,
            name,
            file: unsafe { File::from_raw_fd(fd) },
            removed: false,
            job,
        })
    }

    fn verify_owned_entry(&self) -> std::io::Result<()> {
        let stat = entry_metadata(&self.destination.directory, &self.name)?;
        let file = self.file.metadata()?;
        if stat.st_dev as u64 != file.dev() || stat.st_ino as u64 != file.ino() {
            return Err(std::io::Error::other("Temporary archive entry changed"));
        }
        Ok(())
    }

    fn cleanup(&mut self) -> std::io::Result<()> {
        if self.removed {
            return Ok(());
        }
        self.verify_owned_entry()?;
        // SAFETY: the entry was checked against the owned descriptor. No glob
        // cleanup or unrelated path is used.
        if unsafe {
            libc::unlinkat(
                self.destination.directory.as_raw_fd(),
                self.name.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error());
        }
        self.removed = true;
        Ok(())
    }

    fn validate_publication(&self) -> Result<()> {
        self.destination.verify()?;
        self.verify_owned_entry()
            .map_err(|error| file_error("Temporary archive changed", error))
    }

    fn publish(&mut self) -> Result<()> {
        let directory = self.destination.directory.as_raw_fd();
        #[cfg(target_os = "macos")]
        // SAFETY: both names are relative to the same live, pinned directory.
        // RENAME_EXCL is the atomic no-clobber check, including existing symlinks.
        let result = unsafe {
            libc::renameatx_np(
                directory,
                self.name.as_ptr(),
                directory,
                self.destination.name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(not(target_os = "macos"))]
        // A hard link publishes the complete inode without replacing any entry.
        // Unsupported filesystems fail closed rather than copying into the target.
        let result = unsafe {
            libc::linkat(
                directory,
                self.name.as_ptr(),
                directory,
                self.destination.name.as_ptr(),
                0,
            )
        };
        if result != 0 {
            return Err(file_error(
                "Cannot publish archive",
                std::io::Error::last_os_error(),
            ));
        }
        #[cfg(target_os = "macos")]
        {
            self.removed = true;
        }
        Ok(())
    }

    fn cleanup_after_publish(&mut self) {
        #[cfg(not(target_os = "macos"))]
        if let Err(error) = self.cleanup() {
            self.record_cleanup_warning(&error);
        }
    }

    fn record_directory_sync(&self, result: std::io::Result<()>) {
        if let Err(error) = result {
            if let Some(job) = &self.job {
                let mut operation = job.operation.lock().unwrap();
                let message = format!(
                    "Archive saved, but destination folder metadata could not be synchronized: {error}"
                );
                if let Some(warning) = &mut operation.cleanup_warning {
                    warning.push_str("; ");
                    warning.push_str(&message);
                } else {
                    operation.cleanup_warning = Some(message);
                }
            }
        }
    }

    fn record_cleanup_warning(&self, error: &std::io::Error) {
        if let Some(job) = &self.job {
            job.operation.lock().unwrap().cleanup_warning = Some(format!(
                "Temporary archive cleanup could not finish: {error}; owned temporary path: {}",
                self.destination
                    .directory_path
                    .join(self.name.to_string_lossy().as_ref())
                    .display(),
            ));
        }
    }
}

impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup() {
            self.record_cleanup_warning(&error);
        }
    }
}

fn parse_image_id(bytes: &[u8], expected_container_id: &str) -> Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase", deny_unknown_fields)]
    struct Identity {
        id: String,
        image_id: String,
    }
    let identity: Identity = serde_json::from_slice(bytes)
        .map_err(|_| malformed("Docker returned an invalid image identity"))?;
    if identity.id != expected_container_id
        || !identity
            .image_id
            .strip_prefix("sha256:")
            .is_some_and(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
    {
        return Err(malformed(
            "Docker returned a different container or invalid image ID",
        ));
    }
    Ok(identity.image_id)
}

impl Core {
    fn image_export_capture(
        &self,
        target: &Target,
        arguments: &[String],
        options: &ProcessOptions,
    ) -> Result<Vec<u8>> {
        let mut options = options.clone();
        options.deadline = Some(
            options
                .deadline
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(15))
                .min(Instant::now() + Duration::from_secs(15)),
        );
        options.capture_limit = Some(64 * 1024);
        let output = self
            .runner
            .run_with_options(&target.docker, arguments, &target.env, &options, false)
            .map_err(|error| ApiError::new("StartFailed", error))?;
        if output.interrupted || output.timed_out || output.truncated || output.code != Some(0) {
            return Err(ApiError {
                code: if output.timed_out {
                    "TimedOut"
                } else if output.truncated {
                    "OutputLimitExceeded"
                } else {
                    "CommandFailed"
                }
                .into(),
                message: "Could not verify the image export source".into(),
                command: Some(command_label(&target.docker, arguments)),
                stderr: Some(process::plain_text(&output.stderr, process::STDERR_LIMIT)),
            });
        }
        Ok(output.stdout)
    }

    fn verify_image_export_target(&self, target: &Target, options: &ProcessOptions) -> Result<()> {
        validate_docker_config(&target.docker_config)?;
        if local_endpoint(&target.endpoint)? != target.endpoint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "The Docker endpoint changed",
            ));
        }
        let client = self.image_export_capture(target, &args(&["--version"]), options)?;
        let client = std::str::from_utf8(&client)
            .ok()
            .and_then(|value| value.trim().strip_prefix("Docker version "))
            .and_then(|value| value.split(',').next());
        let info: Value = serde_json::from_slice(&self.image_export_capture(
            target,
            &target.engine_args(&["info", "--format", "{{json .}}"]),
            options,
        )?)
        .map_err(|_| malformed("Invalid Engine information"))?;
        let version: Value = serde_json::from_slice(&self.image_export_capture(
            target,
            &target.engine_args(&["version", "--format", "{{json .}}"]),
            options,
        )?)
        .map_err(|_| malformed("Invalid Engine version"))?;
        let server = version
            .get("Server")
            .ok_or_else(|| malformed("Missing Engine version"))?;
        let fingerprint = Fingerprint {
            id: required(&info, "ID")?.into(),
            name: required(&info, "Name")?.into(),
            os: required(&info, "OSType")?.into(),
            arch: required(&info, "Architecture")?.into(),
            server: required(server, "Version")?.into(),
            api: required(server, "ApiVersion")?.into(),
        };
        if client != Some(&target.client_version) || fingerprint != target.fingerprint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "CLI or Engine identity changed",
            ));
        }
        Ok(())
    }

    pub fn prepare_image_export(
        &self,
        session_id: &str,
        generation: u64,
        handle: &str,
    ) -> Result<ImageExportPreview> {
        let (session, container) = {
            let state = self.state.lock().unwrap();
            let session = state
                .session
                .as_ref()
                .filter(|session| session.id == session_id)
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before exporting"))?;
            if state.closing
                || state.diagnosing
                || state.mutating
                || session.stale
                || session.needs_validation
            {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh before exporting this image",
                ));
            }
            if session.generation != generation {
                return Err(ApiError::new(
                    "StaleHandle",
                    "Select from the latest container list",
                ));
            }
            let container = session.handles.get(handle).ok_or_else(|| {
                ApiError::new("StaleHandle", "Select from the latest container list")
            })?;
            (session.clone(), container.clone())
        };
        let options = ProcessOptions {
            deadline: Some(Instant::now() + Duration::from_secs(30)),
            ..ProcessOptions::default()
        };
        self.verify_image_export_target(&session.target, &options)?;
        let image_id = parse_image_id(
            &self.image_export_capture(
                &session.target,
                &session.target.engine_args(&[
                    "container",
                    "inspect",
                    "--format",
                    IMAGE_ID_FORMAT,
                    &container.full_id,
                ]),
                &options,
            )?,
            &container.full_id,
        )?;
        let preview = ImageExportPreview {
            prepare_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            container_id: container.full_id,
            container_name: container.name,
            image_id,
            image_reference: container.image,
            engine_id: session.target.fingerprint.id.clone(),
            engine_name: session.target.fingerprint.name.clone(),
            engine_endpoint: session.target.endpoint.clone(),
            expires_at: (chrono::Utc::now()
                + chrono::Duration::seconds(PREPARE_TTL.as_secs() as i64))
            .to_rfc3339(),
        };
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, session_id)?;
        let mut manager = self.image_exports.lock().unwrap();
        manager.prune();
        if manager.prepared.len() >= RETENTION {
            return Err(ApiError::new(
                "ImageExportBusy",
                "Too many image export previews are open",
            ));
        }
        manager.prepared.insert(
            preview.prepare_id.clone(),
            PreparedExport {
                preview: preview.clone(),
                session,
                expires: Instant::now() + PREPARE_TTL,
            },
        );
        Ok(preview)
    }

    pub(crate) fn reserve_image_export_picker(&self) -> Result<ImageExportPickerGuard> {
        let mut manager = self.image_exports.lock().unwrap();
        if manager.picker_active {
            return Err(ApiError::new(
                "ImageExportBusy",
                "An image export save dialog is already open",
            ));
        }
        manager.picker_active = true;
        Ok(ImageExportPickerGuard(self.image_exports.clone()))
    }

    pub fn image_export_picker_preview(
        &self,
        session_id: &str,
        prepare_id: &str,
    ) -> Result<ImageExportPreview> {
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, session_id)?;
        let mut manager = self.image_exports.lock().unwrap();
        manager.prune();
        Ok(prepared_export(&manager, session_id, prepare_id)?
            .preview
            .clone())
    }

    // Deliberately Rust-only: the path must come from the native save picker.
    pub fn set_image_export_destination(
        &self,
        session_id: &str,
        prepare_id: &str,
        path: PathBuf,
    ) -> Result<ImageExportDestination> {
        self.image_export_picker_preview(session_id, prepare_id)?;
        let destination = Destination::open(session_id, prepare_id, path)?;
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, session_id)?;
        let mut manager = self.image_exports.lock().unwrap();
        manager.prune();
        prepared_export(&manager, session_id, prepare_id)?;
        manager
            .destinations
            .retain(|_, value| value.prepare_id != prepare_id);
        let response = destination.response.clone();
        manager
            .destinations
            .insert(response.destination_token.clone(), destination);
        Ok(response)
    }

    pub fn start_image_export(
        &self,
        session_id: &str,
        prepare_id: &str,
        destination_token: &str,
        request_id: &str,
    ) -> Result<ImageExportOperation> {
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(ApiError::new(
                "InvalidRequestId",
                "Use a unique request ID of at most 128 ASCII characters",
            ));
        }
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, session_id)?;
        let mut manager = self.image_exports.lock().unwrap();
        manager.prune();
        if let Some(job) = manager.jobs.iter().find(|job| {
            let operation = job.snapshot();
            operation.session_id == session_id && operation.request_id == request_id
        }) {
            if job.prepare_id != prepare_id || job.destination_token != destination_token {
                return Err(ApiError::new(
                    "RequestConflict",
                    "This request ID belongs to another export",
                ));
            }
            return Ok(job.snapshot());
        }
        if manager.active.is_some() {
            return Err(ApiError::new(
                "ImageExportBusy",
                "An image export is already running",
            ));
        }
        let prepared = prepared_export(&manager, session_id, prepare_id)?.clone();
        let destination = manager
            .destinations
            .get(destination_token)
            .filter(|value| value.prepare_id == prepare_id && value.session_id == session_id)
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "ImageExportDestinationUnavailable",
                    "Choose the save location again",
                )
            })?;
        let preview = &prepared.preview;
        let operation = ImageExportOperation {
            id: uuid::Uuid::new_v4().to_string(),
            request_id: request_id.into(),
            session_id: session_id.into(),
            container_id: preview.container_id.clone(),
            container_name: preview.container_name.clone(),
            image_id: preview.image_id.clone(),
            image_reference: preview.image_reference.clone(),
            engine_id: preview.engine_id.clone(),
            engine_name: preview.engine_name.clone(),
            engine_endpoint: preview.engine_endpoint.clone(),
            path: destination.response.path.clone(),
            phase: ImageExportPhase::Queued,
            outcome: None,
            bytes_written: 0,
            elapsed_ms: 0,
            started_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
            exit_code: None,
            stderr: String::new(),
            stderr_truncated: false,
            error: None,
            cleanup_warning: None,
        };
        let job = Arc::new(ImageExportJob {
            operation: Mutex::new(operation.clone()),
            prepare_id: prepare_id.into(),
            destination_token: destination_token.into(),
            cancel: Arc::new(AtomicBool::new(false)),
            committed: AtomicBool::new(false),
            started: Instant::now(),
            worker: Mutex::new(None),
        });
        let mut registration = job.worker.lock().unwrap();
        manager.active = Some(operation.id.clone());
        manager.prepared.remove(prepare_id);
        manager.destinations.remove(destination_token);
        manager.jobs.push_back(job.clone());
        manager.prune();
        drop(manager);
        drop(state);
        let core = self.clone();
        let worker_job = job.clone();
        match thread::Builder::new()
            .name("docker2u-image-export".into())
            .spawn(move || {
                let _reservation = ExportReservation {
                    manager: core.image_exports.clone(),
                    job: worker_job.clone(),
                };
                core.run_image_export(prepared, destination, &worker_job);
            }) {
            Ok(worker) => *registration = Some(worker),
            Err(error) => {
                job.finish(
                    ImageExportOutcome::Failed,
                    Some(ApiError::new("WorkerFailed", error.to_string())),
                );
                self.image_exports.lock().unwrap().active = None;
            }
        }
        drop(registration);
        Ok(job.snapshot())
    }

    fn run_image_export(
        &self,
        prepared: PreparedExport,
        destination: Destination,
        job: &Arc<ImageExportJob>,
    ) {
        #[cfg(test)]
        let timeout = self.image_export_timeout.unwrap_or(EXPORT_DEADLINE);
        #[cfg(not(test))]
        let timeout = EXPORT_DEADLINE;
        let options = ProcessOptions {
            deadline: Some(job.started + timeout),
            cancel: job.cancel.clone(),
            ..ProcessOptions::default()
        };
        let mut command_started = false;
        let result = (|| -> Result<()> {
            self.check_image_export_job(job, &options)?;
            self.verify_image_export_target(&prepared.session.target, &options)?;
            let actual = parse_image_id(
                &self.image_export_capture(
                    &prepared.session.target,
                    &prepared.session.target.engine_args(&[
                        "container",
                        "inspect",
                        "--format",
                        IMAGE_ID_FORMAT,
                        &prepared.preview.container_id,
                    ]),
                    &options,
                )?,
                &prepared.preview.container_id,
            )?;
            if actual != prepared.preview.image_id {
                return Err(ApiError::new(
                    "ImageExportSourceChanged",
                    "The selected container image changed",
                ));
            }
            self.check_image_export_job(job, &options)?;
            let mut archive = TemporaryArchive::create(destination, Some(job.clone()))?;
            let output = archive
                .file
                .try_clone()
                .map_err(|error| file_error("Cannot open export output", error))?;
            let arguments = prepared.session.target.engine_args(&[
                "image",
                "save",
                "--",
                &prepared.preview.image_id,
            ]);
            let child = self
                .runner
                .start_file_with_options(
                    &prepared.session.target.docker,
                    &arguments,
                    &prepared.session.target.env,
                    &options,
                    output,
                )
                .map_err(|error| ApiError::new("StartFailed", error))?;
            command_started = true;
            job.operation.lock().unwrap().phase = ImageExportPhase::Exporting;
            loop {
                let update = child.read();
                {
                    let mut operation = job.operation.lock().unwrap();
                    operation.bytes_written = archive
                        .file
                        .metadata()
                        .map_err(|error| file_error("Cannot measure archive", error))?
                        .len();
                    operation.stderr = update.stderr;
                    operation.stderr_truncated |= update.truncated;
                    operation.exit_code = update.exit_code;
                }
                if update.terminal {
                    child.stop();
                    self.check_image_export_job(job, &options)?;
                    if update.timed_out {
                        return Err(ApiError::new(
                            "TimedOut",
                            "Image export exceeded its deadline",
                        ));
                    }
                    if update.interrupted || update.exit_code != Some(0) {
                        return Err(ApiError::new(
                            "ImageExportCommandFailed",
                            "Docker could not save the selected image",
                        ));
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            job.operation.lock().unwrap().phase = ImageExportPhase::Publishing;
            archive
                .file
                .sync_all()
                .map_err(|error| file_error("Cannot synchronize archive data", error))?;
            self.verify_image_export_target(&prepared.session.target, &options)?;
            // State is the commit gate shared with cancellation and retirement.
            // Reconnection either retires first, or observes a finished file.
            self.publish_image_export(job, &options, &mut archive)?;
            Ok(())
        })();
        if let Err(error) = result {
            let outcome = if options
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                ImageExportOutcome::TimedOut
            } else if job.cancel.load(Ordering::Acquire) || error.code == "StaleSession" {
                if command_started {
                    ImageExportOutcome::Cancelled
                } else {
                    ImageExportOutcome::CancelledBeforeStart
                }
            } else {
                ImageExportOutcome::Failed
            };
            job.finish(outcome, Some(error));
        }
    }

    fn publish_image_export(
        &self,
        job: &ImageExportJob,
        options: &ProcessOptions,
        archive: &mut TemporaryArchive,
    ) -> Result<()> {
        archive.validate_publication()?;
        {
            let state = self.state.lock().unwrap();
            ensure_export_session(&state, &job.snapshot().session_id)?;
            check_export_cancel(job, options)?;
            archive.publish()?;
            // Success is irreversible after the atomic no-clobber publication.
            // Keep polling in Publishing until the final warnings are available.
            job.committed.store(true, Ordering::Release);
            job.operation.lock().unwrap().phase = ImageExportPhase::Publishing;
        }
        // Slow destination metadata I/O must never retain the global state gate.
        archive.cleanup_after_publish();
        #[cfg(test)]
        let sync = match &self.image_export_directory_sync {
            Some(sync) => sync(),
            None => archive.destination.directory.sync_all(),
        };
        #[cfg(not(test))]
        let sync = archive.destination.directory.sync_all();
        archive.record_directory_sync(sync);
        job.finish(ImageExportOutcome::Succeeded, None);
        Ok(())
    }

    fn check_image_export_job(&self, job: &ImageExportJob, options: &ProcessOptions) -> Result<()> {
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, &job.snapshot().session_id)?;
        check_export_cancel(job, options)
    }

    fn image_export_job(&self, session_id: &str, request_id: &str) -> Result<Arc<ImageExportJob>> {
        self.image_exports
            .lock()
            .unwrap()
            .jobs
            .iter()
            .find(|job| {
                let operation = job.snapshot();
                operation.session_id == session_id && operation.request_id == request_id
            })
            .cloned()
            .ok_or_else(|| {
                ApiError::new(
                    "ImageExportUnavailable",
                    "This image export is not retained",
                )
            })
    }

    pub fn read_image_export(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<ImageExportOperation> {
        Ok(self.image_export_job(session_id, request_id)?.snapshot())
    }

    pub fn list_image_exports(&self, session_id: &str) -> Result<Vec<ImageExportOperation>> {
        self.active(session_id)?;
        let mut manager = self.image_exports.lock().unwrap();
        manager.prune();
        Ok(manager
            .jobs
            .iter()
            .rev()
            .map(|job| job.snapshot())
            .collect())
    }

    pub fn cancel_image_export(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<ImageExportOperation> {
        let job = self.image_export_job(session_id, request_id)?;
        let state = self.state.lock().unwrap();
        ensure_export_session(&state, session_id)?;
        if job.snapshot().outcome.is_none() && !job.committed.load(Ordering::Acquire) {
            job.cancel.store(true, Ordering::Release);
        }
        Ok(job.snapshot())
    }

    pub(super) fn cancel_all_image_exports_and_wait(&self) {
        let jobs = {
            let mut manager = self.image_exports.lock().unwrap();
            manager.prepared.clear();
            manager.destinations.clear();
            manager.jobs.iter().cloned().collect::<Vec<_>>()
        };
        for job in &jobs {
            if job.snapshot().outcome.is_none() && !job.committed.load(Ordering::Acquire) {
                job.cancel.store(true, Ordering::Release);
            }
        }
        for job in jobs {
            job.join();
        }
    }
}

fn ensure_export_session(state: &State, session_id: &str) -> Result<()> {
    if state.closing
        || state
            .session
            .as_ref()
            .is_none_or(|session| session.id != session_id)
    {
        Err(ApiError::new(
            "StaleSession",
            "This image export belongs to an older connection",
        ))
    } else {
        Ok(())
    }
}

fn prepared_export<'a>(
    manager: &'a ImageExportManager,
    session_id: &str,
    prepare_id: &str,
) -> Result<&'a PreparedExport> {
    manager
        .prepared
        .get(prepare_id)
        .filter(|value| value.preview.session_id == session_id && value.expires > Instant::now())
        .ok_or_else(|| {
            ApiError::new(
                "ImageExportPreparationExpired",
                "Prepare the image export again",
            )
        })
}

fn check_export_cancel(job: &ImageExportJob, options: &ProcessOptions) -> Result<()> {
    if options
        .deadline
        .is_some_and(|deadline| Instant::now() >= deadline)
    {
        Err(ApiError::new(
            "TimedOut",
            "Image export exceeded its 30 minute deadline",
        ))
    } else if job.cancel.load(Ordering::Acquire) {
        Err(ApiError::new("Cancelled", "Image export was cancelled"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "docker_image_export_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "docker_image_export_pipeline_tests.rs"]
mod pipeline_tests;
