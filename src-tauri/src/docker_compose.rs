//! Registered local Compose files and session-owned, replayable operations.
use super::*;
use crate::process::ProcessOptions;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Instant,
};

#[path = "docker_compose_apply.rs"]
mod apply;
#[cfg(test)]
use apply::ComposePreparationMode;
use apply::{
    ComposeApplyMetadata, apply_help_supports_flags, parse_apply_metadata, plan_compose_apply,
};
pub use apply::{ComposeApplyPreview, ComposeApplyWarning, ComposeServiceSelection};

#[path = "docker_compose_operations.rs"]
mod operations;
pub(super) use operations::ComposeOperationManager;
pub use operations::{
    ComposeAction, ComposeOperation, ComposeOperationPreview, ComposeOperationRead,
};

const FILE_LIMIT: u64 = 4 * 1024 * 1024;
const PREVIEW_TTL: Duration = Duration::from_secs(300);
const PREVIEW_LIMIT: usize = 16;
const PROVENANCE_FORMAT: &str = r#"{"Id":{{json .Id}},"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"WorkingDirectory":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"ConfigFiles":{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeProjectInput {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub name: String,
    pub compose_file: String,
    pub working_directory: String,
    pub env_file: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComposeProject {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub compose_file: String,
    pub working_directory: String,
    pub env_file: Option<String>,
}
impl ComposeProject {
    fn input(&self) -> ComposeProjectInput {
        ComposeProjectInput {
            id: Some(self.id.clone()),
            expected_revision: Some(self.revision),
            name: self.name.clone(),
            compose_file: self.compose_file.clone(),
            working_directory: self.working_directory.clone(),
            env_file: self.env_file.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeServicePreview {
    pub name: String,
    pub image: Option<String>,
    pub build: bool,
    pub profiles: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProjectPreview {
    pub preview_id: String,
    pub project: ComposeProjectInput,
    pub compose_version: String,
    pub services: Vec<ComposeServicePreview>,
    pub existing_containers: usize,
    pub provenance: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct FileProof {
    path: PathBuf,
    digest: Vec<u8>,
}
#[derive(Clone)]
struct ValidatedProject {
    input: ComposeProjectInput,
    proofs: Vec<FileProof>,
    compose_version: String,
    services: Vec<ComposeServicePreview>,
    existing_containers: usize,
    resolved_digest: Vec<u8>,
    apply_metadata: Option<ComposeApplyMetadata>,
}
struct RegistrationPreview {
    project: ValidatedProject,
    created: Instant,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RegistryFile {
    version: u32,
    projects: Vec<ComposeProject>,
}
#[derive(Default)]
pub(super) struct ComposeRegistry {
    path: Option<PathBuf>,
    projects: Vec<ComposeProject>,
    error: Option<ApiError>,
    previews: HashMap<String, RegistrationPreview>,
    disk_digest: Option<Vec<u8>>,
}
impl ComposeRegistry {
    fn ready(&self) -> Result<()> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        if self.path.is_none() {
            return Err(ApiError::new(
                "RegistryUnavailable",
                "Compose registration storage is not configured",
            ));
        }
        Ok(())
    }
    fn check_input(&self, input: &ComposeProjectInput) -> Result<()> {
        self.ready()?;
        match (&input.id, input.expected_revision) {
            (Some(id), Some(revision)) => {
                if !self
                    .projects
                    .iter()
                    .any(|p| p.id == *id && p.revision == revision)
                {
                    return Err(ApiError::new(
                        "RegistrationChanged",
                        "Reload the registered project before editing it",
                    ));
                }
            }
            (None, None) => {}
            _ => {
                return Err(ApiError::new(
                    "InvalidRegistration",
                    "An existing registration requires its revision",
                ));
            }
        }
        if self
            .projects
            .iter()
            .any(|p| Some(&p.id) != input.id.as_ref() && p.name == input.name)
        {
            return Err(ApiError::new(
                "DuplicateRegistration",
                "This project name is already registered",
            ));
        }
        Ok(())
    }
    fn write(&mut self, projects: &[ComposeProject]) -> Result<()> {
        self.ready()?;
        let path = self.path.as_ref().unwrap();
        let current_digest = if path.exists() {
            Some(
                Sha256::digest(bounded_file(path).map_err(|_| {
                    ApiError::new(
                        "RegistryChanged",
                        "Compose registration storage changed externally and was preserved",
                    )
                })?)
                .to_vec(),
            )
        } else {
            None
        };
        if current_digest != self.disk_digest {
            return Err(ApiError::new(
                "RegistryChanged",
                "Compose registration storage changed externally and was preserved. Reload the app before editing registrations",
            ));
        }
        let parent = path.parent().ok_or_else(|| {
            ApiError::new(
                "RegistryUnavailable",
                "Compose storage needs a parent directory",
            )
        })?;
        fs::create_dir_all(parent).map_err(|_| {
            ApiError::new(
                "RegistryWriteFailed",
                "Cannot create Compose registration storage",
            )
        })?;
        let temporary = parent.join(format!(".compose-projects-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(&RegistryFile {
            version: 1,
            projects: projects.to_vec(),
        })
        .map_err(|_| {
            ApiError::new(
                "RegistryWriteFailed",
                "Compose registrations could not be encoded",
            )
        })?;
        let result = (|| -> std::io::Result<()> {
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, path)?;
            // Rename commits the new registry. A directory durability hint failing
            // afterward must not leave memory describing the previous file.
            let _ = fs::File::open(parent).and_then(|directory| directory.sync_all());
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        if result.is_ok() {
            self.disk_digest = Some(Sha256::digest(&bytes).to_vec());
        }
        result.map_err(|_| {
            ApiError::new(
                "RegistryWriteFailed",
                "Cannot save Compose registrations; the previous file was preserved",
            )
        })
    }
    fn prune_previews(&mut self) {
        self.previews
            .retain(|_, p| p.created.elapsed() < PREVIEW_TTL);
        while self.previews.len() >= PREVIEW_LIMIT {
            if let Some(key) = self
                .previews
                .iter()
                .min_by_key(|(key, p)| (p.created, *key))
                .map(|(key, _)| key.clone())
            {
                self.previews.remove(&key);
            }
        }
    }
}

fn bounded_file(path: &Path) -> Result<Vec<u8>> {
    let mut file = fs::File::open(path).map_err(|_| {
        ApiError::new(
            "ProjectFileUnavailable",
            "A selected Compose or environment file cannot be read",
        )
    })?;
    if !file
        .metadata()
        .map(|m| m.is_file() && m.len() <= FILE_LIMIT)
        .unwrap_or(false)
    {
        return Err(ApiError::new(
            "ProjectFileUnavailable",
            "Selected files must be regular files smaller than 4 MiB",
        ));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            ApiError::new(
                "ProjectFileUnavailable",
                "A selected project file cannot be read",
            )
        })?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(ApiError::new(
            "ProjectFileUnavailable",
            "A selected project file exceeds 4 MiB",
        ));
    }
    Ok(bytes)
}
fn file_proof(path: PathBuf) -> Result<FileProof> {
    Ok(FileProof {
        digest: Sha256::digest(bounded_file(&path)?).to_vec(),
        path,
    })
}
fn canonical_path(value: &str, directory: bool) -> Result<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(ApiError::new(
            "InvalidRegistration",
            "Select absolute local project paths",
        ));
    }
    let path = fs::canonicalize(path).map_err(|_| {
        ApiError::new(
            "ProjectFileUnavailable",
            "A selected local project path no longer exists",
        )
    })?;
    if if directory {
        !path.is_dir()
    } else {
        !path.is_file()
    } {
        return Err(ApiError::new(
            "InvalidRegistration",
            "The selected project path has the wrong file type",
        ));
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| ApiError::new("InvalidRegistration", "Project paths must be valid UTF-8"))
}
fn normalize_input(
    mut input: ComposeProjectInput,
) -> Result<(ComposeProjectInput, Vec<FileProof>)> {
    input.name = input.name.trim().to_owned();
    if !input.name.is_empty() && !valid_project_name(&input.name) {
        return Err(ApiError::new(
            "InvalidProjectName",
            "Use a lowercase project name containing letters, digits, hyphens or underscores",
        ));
    }
    input.compose_file = canonical_path(&input.compose_file, false)?;
    input.working_directory = canonical_path(&input.working_directory, true)?;
    let suggest_env = input.id.is_none() && input.env_file.is_none();
    input.env_file = input
        .env_file
        .filter(|s| !s.is_empty())
        .map(|p| canonical_path(&p, false))
        .transpose()?;
    if suggest_env {
        let implicit = Path::new(&input.working_directory).join(".env");
        if implicit.is_file() {
            input.env_file = Some(canonical_path(&implicit.to_string_lossy(), false)?);
        }
    }
    let mut proofs = vec![file_proof(PathBuf::from(&input.compose_file))?];
    if let Some(env) = &input.env_file {
        proofs.push(file_proof(PathBuf::from(env))?);
    }
    Ok((input, proofs))
}
fn verify_proofs(proofs: &[FileProof]) -> Result<()> {
    for proof in proofs {
        let matches = if proof.digest.is_empty() {
            !proof.path.exists()
        } else {
            file_proof(proof.path.clone())
                .map(|new| new == *proof)
                .unwrap_or(false)
        };
        if !matches {
            return Err(ApiError::new(
                "ProjectFilesChanged",
                "Project files changed after preview. Review them again before continuing",
            ));
        }
    }
    Ok(())
}
fn compose_environment(target: &Target) -> Vec<(String, String)> {
    let mut env = target.env.clone();
    env.extend([
        ("COMPOSE_REMOVE_ORPHANS".into(), "false".into()),
        ("COMPOSE_PROFILES".into(), "".into()),
        ("COMPOSE_MENU".into(), "false".into()),
        ("DOCKER_HOST".into(), target.endpoint.clone()),
        ("BUILDX_BUILDER".into(), "default".into()),
    ]);
    env
}
fn compose_arguments(
    target: &Target,
    input: &ComposeProjectInput,
    command: &[&str],
) -> Vec<String> {
    let mut args = target.engine_args(&[
        "compose",
        "--ansi",
        "never",
        "--progress",
        "plain",
        "--project-directory",
        &input.working_directory,
        "--file",
        &input.compose_file,
    ]);
    if !input.name.is_empty() {
        args.extend(["--project-name".into(), input.name.clone()]);
    }
    // An explicit empty file prevents ambient COMPOSE_ENV_FILES and cwd discovery.
    args.extend([
        "--env-file".into(),
        input.env_file.clone().unwrap_or_else(|| "/dev/null".into()),
    ]);
    args.extend(command.iter().map(|s| (*s).to_owned()));
    args
}
fn compose_options(
    input: &ComposeProjectInput,
    cancel: Arc<AtomicBool>,
    deadline: Instant,
) -> ProcessOptions {
    ProcessOptions {
        cwd: Some(PathBuf::from(&input.working_directory)),
        deadline: Some(deadline),
        cancel,
        isolate_compose_env: true,
        capture_limit: None,
    }
}
fn version_supported(version: &str) -> bool {
    let version = version.trim().trim_start_matches('v');
    let version = match version.split_once('-') {
        Some((release, vendor))
            if vendor.strip_prefix("desktop.").is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            }) =>
        {
            release
        }
        Some(_) => return false,
        None => version,
    };
    let parts: Vec<_> = version.split('.').map(str::parse::<u64>).collect();
    parts.len() == 3
        && parts.iter().all(|part| part.is_ok())
        && (
            parts[0].as_ref().unwrap(),
            parts[1].as_ref().unwrap(),
            parts[2].as_ref().unwrap(),
        ) >= (&2, &39, &4)
}
impl Core {
    /// Corrupt registry data is retained for the Compose UI; other app features can start.
    pub fn set_compose_storage_path(&self, path: PathBuf) -> Result<()> {
        let mut registry = self.compose_registry.lock().unwrap();
        registry.path = Some(path.clone());
        registry.projects.clear();
        registry.previews.clear();
        registry.error = None;
        registry.disk_digest = None;
        if path.exists() {
            let bytes = bounded_file(&path).ok();
            registry.disk_digest = bytes.as_ref().map(|bytes| Sha256::digest(bytes).to_vec());
            let loaded = bytes
                .and_then(|bytes| serde_json::from_slice::<RegistryFile>(&bytes).ok())
                .filter(|data| data.version == 1);
            match loaded {
                Some(data) if registry_valid(&data.projects) => registry.projects = data.projects,
                _ => {
                    registry.error = Some(ApiError::new(
                        "RegistryCorrupt",
                        "Compose registrations could not be read. The existing file has been preserved",
                    ))
                }
            }
        }
        Ok(())
    }
    pub fn list_compose_projects(&self) -> Result<Vec<ComposeProject>> {
        let registry = self.compose_registry.lock().unwrap();
        registry.ready()?;
        Ok(registry.projects.clone())
    }
    pub fn preview_compose_project(
        &self,
        session_id: &str,
        input: ComposeProjectInput,
    ) -> Result<ComposeProjectPreview> {
        let (input, proofs) = normalize_input(input)?;
        self.compose_registry.lock().unwrap().check_input(&input)?;
        let session = self.active(session_id)?;
        let validation = self.compose_validation_guard(session_id)?;
        let validated = self.validate_compose(
            &session,
            input,
            proofs,
            validation.token(),
            Instant::now() + Duration::from_secs(30),
        )?;
        self.active(session_id)?;
        let result = ComposeProjectPreview {
            preview_id: uuid::Uuid::new_v4().to_string(),
            project: validated.input.clone(),
            compose_version: validated.compose_version.clone(),
            services: validated.services.clone(),
            existing_containers: validated.existing_containers,
            provenance: if validated.existing_containers == 0 {
                "new"
            } else {
                "matched"
            }
            .into(),
        };
        let mut registry = self.compose_registry.lock().unwrap();
        registry.check_input(&validated.input)?;
        registry.prune_previews();
        registry.previews.insert(
            result.preview_id.clone(),
            RegistrationPreview {
                project: validated,
                created: Instant::now(),
            },
        );
        Ok(result)
    }
    pub fn save_compose_project(&self, preview_id: &str) -> Result<ComposeProject> {
        let manager = self.compose_operations.lock().unwrap();
        let mut registry = self.compose_registry.lock().unwrap();
        registry.ready()?;
        let preview = registry
            .previews
            .get(preview_id)
            .filter(|p| p.created.elapsed() < PREVIEW_TTL)
            .ok_or_else(|| {
                ApiError::new("PreviewExpired", "Preview the project again before saving")
            })?;
        verify_proofs(&preview.project.proofs)?;
        let input = preview.project.input.clone();
        registry.check_input(&input)?;
        if input
            .id
            .as_ref()
            .is_some_and(|id| manager.has_active_project(id))
        {
            return Err(ApiError::new(
                "Busy",
                "Wait for the project operation before editing its registration",
            ));
        }
        if input.id.is_none() && registry.projects.len() >= 256 {
            return Err(ApiError::new(
                "RegistrationLimit",
                "At most 256 Compose projects can be registered",
            ));
        }
        let project = ComposeProject {
            id: input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision: input
                .expected_revision
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| {
                    ApiError::new("RegistrationChanged", "Registration revision limit reached")
                })?,
            name: input.name,
            compose_file: input.compose_file,
            working_directory: input.working_directory,
            env_file: input.env_file,
        };
        let mut projects = registry.projects.clone();
        projects.retain(|p| p.id != project.id);
        projects.push(project.clone());
        projects.sort_by(|a, b| a.name.cmp(&b.name));
        registry.write(&projects)?;
        registry.projects = projects;
        registry.previews.remove(preview_id);
        Ok(project)
    }
    pub fn remove_compose_project(&self, project_id: &str, expected_revision: u64) -> Result<()> {
        let manager = self.compose_operations.lock().unwrap();
        if manager.has_active_project(project_id) {
            return Err(ApiError::new(
                "Busy",
                "Wait for the project operation before removing its registration",
            ));
        }
        let mut registry = self.compose_registry.lock().unwrap();
        registry.ready()?;
        if !registry
            .projects
            .iter()
            .any(|p| p.id == project_id && p.revision == expected_revision)
        {
            return Err(ApiError::new(
                "RegistrationChanged",
                "Reload the project before removing its registration",
            ));
        }
        let projects: Vec<_> = registry
            .projects
            .iter()
            .filter(|p| p.id != project_id)
            .cloned()
            .collect();
        registry.write(&projects)?;
        registry.projects = projects;
        Ok(())
    }
    fn compose_capture(
        &self,
        target: &Target,
        arguments: &[String],
        options: &ProcessOptions,
    ) -> Result<Vec<u8>> {
        let output = self
            .runner
            .run_with_options(
                &target.docker,
                arguments,
                &compose_environment(target),
                options,
                false,
            )
            .map_err(|_| ApiError::new("StartFailed", "The Compose CLI could not be started"))?;
        // config can contain resolved secrets. Never place raw stdout/stderr into IPC errors.
        if output.interrupted || output.code.is_none() {
            return Err(ApiError::new(
                if output.timed_out {
                    "TimedOut"
                } else {
                    "Cancelled"
                },
                "Compose validation was interrupted",
            ));
        }
        if output.truncated {
            return Err(ApiError::new(
                "OutputLimitExceeded",
                "Compose validation output exceeded its limit",
            ));
        }
        if output.code != Some(0) {
            return Err(ApiError::new(
                "ComposeValidationFailed",
                "Compose validation failed. Check the selected files, required variables and CLI installation",
            ));
        }
        Ok(output.stdout)
    }
    fn validate_compose(
        &self,
        session: &Session,
        input: ComposeProjectInput,
        proofs: Vec<FileProof>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<ValidatedProject> {
        self.validate_compose_mode(session, input, proofs, cancel, deadline, false)
    }
    fn validate_compose_apply(
        &self,
        session: &Session,
        input: ComposeProjectInput,
        proofs: Vec<FileProof>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> Result<ValidatedProject> {
        self.validate_compose_mode(session, input, proofs, cancel, deadline, true)
    }
    fn validate_compose_mode(
        &self,
        session: &Session,
        mut input: ComposeProjectInput,
        proofs: Vec<FileProof>,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
        apply: bool,
    ) -> Result<ValidatedProject> {
        if session.needs_validation || session.stale {
            return Err(ApiError::new(
                "NeedsValidation",
                "Refresh or reconnect before using Compose",
            ));
        }
        let options = compose_options(&input, cancel, deadline);
        verify_proofs(&proofs)?;
        self.active(&session.id)?;
        self.verify_compose_target(&session.target, &options)?;
        let version = self.compose_capture(
            &session.target,
            &session
                .target
                .engine_args(&["compose", "version", "--short"]),
            &options,
        )?;
        let version = std::str::from_utf8(&version)
            .map_err(|_| {
                ApiError::new("ComposeUnavailable", "Compose returned an invalid version")
            })?
            .trim()
            .to_owned();
        if !version_supported(&version) {
            return Err(ApiError::new(
                "ComposeUnavailable",
                "Docker Compose 2.39.4 or later is required",
            ));
        }
        for (command, required) in [
            (
                vec!["compose", "--help"],
                vec![
                    "--project-directory",
                    "--project-name",
                    "--env-file",
                    "--progress",
                    "--ansi",
                ],
            ),
            (vec!["compose", "config", "--help"], vec!["--format"]),
            (vec!["compose", "up", "--help"], vec!["--detach"]),
            (vec!["compose", "stop", "--help"], vec!["--timeout"]),
        ] {
            let help = self.compose_capture(
                &session.target,
                &session.target.engine_args(&command),
                &options,
            )?;
            let text = String::from_utf8_lossy(&help);
            if required.iter().any(|flag| !text.contains(flag)) {
                return Err(ApiError::new(
                    "ComposeUnavailable",
                    "The installed Compose CLI lacks required options",
                ));
            }
        }
        if apply {
            for (command, required) in [
                (vec!["compose", "--help"], vec!["--profile"]),
                (vec!["compose", "pull", "--help"], vec!["--policy"]),
                (vec!["compose", "build", "--help"], vec![]),
                (
                    vec!["compose", "up", "--help"],
                    vec!["--no-deps", "--no-build", "--pull", "--force-recreate"],
                ),
            ] {
                let help = self.compose_capture(
                    &session.target,
                    &session.target.engine_args(&command),
                    &options,
                )?;
                let text = String::from_utf8_lossy(&help);
                if !apply_help_supports_flags(&text, &required) {
                    return Err(ApiError::new(
                        "ComposeUnavailable",
                        "The installed Compose CLI lacks required apply options",
                    ));
                }
            }
        }
        // Profiles expand only the read-only catalog. Mutations name selected services.
        let config_command: &[&str] = if apply {
            &["--profile", "*", "config", "--format", "json"]
        } else {
            &["config", "--format", "json"]
        };
        let data = self.compose_capture(
            &session.target,
            &compose_arguments(&session.target, &input, config_command),
            &options,
        )?;
        let config: Value = serde_json::from_slice(&data).map_err(|_| {
            ApiError::new(
                "MalformedOutput",
                "Compose returned an invalid configuration",
            )
        })?;
        if input.name.is_empty() {
            input.name = config
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| valid_project_name(name))
                .ok_or_else(|| malformed("Compose could not resolve a valid project name"))?
                .to_owned();
        }
        let services = preview_services(&config, &input.name)?;
        let apply_metadata = if apply {
            Some(parse_apply_metadata(&config, &input.name)?)
        } else {
            None
        };
        let existing_containers = self.compose_provenance(&session.target, &input, &options)?;
        verify_proofs(&proofs)?;
        let active = self.active(&session.id)?;
        if active.needs_validation || active.stale {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before using Compose",
            ));
        }
        let resolved_digest = Sha256::digest(
            serde_json::to_vec(&config)
                .map_err(|_| malformed("Compose configuration could not be fingerprinted"))?,
        )
        .to_vec();
        Ok(ValidatedProject {
            input,
            proofs,
            compose_version: version,
            services,
            existing_containers,
            resolved_digest,
            apply_metadata,
        })
    }
    fn verify_compose_target(&self, target: &Target, options: &ProcessOptions) -> Result<()> {
        validate_docker_config(&target.docker_config)?;
        if local_endpoint(&target.endpoint)? != target.endpoint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "The Docker endpoint changed. Reconnect before using Compose",
            ));
        }
        let client = self.compose_capture(target, &args(&["--version"]), options)?;
        let client = std::str::from_utf8(&client)
            .ok()
            .and_then(|s| s.trim().strip_prefix("Docker version "))
            .and_then(|s| s.split(',').next());
        let info: Value = serde_json::from_slice(&self.compose_capture(
            target,
            &target.engine_args(&["info", "--format", "{{json .}}"]),
            options,
        )?)
        .map_err(|_| malformed("Docker returned invalid Engine information"))?;
        let version: Value = serde_json::from_slice(&self.compose_capture(
            target,
            &target.engine_args(&["version", "--format", "{{json .}}"]),
            options,
        )?)
        .map_err(|_| malformed("Docker returned invalid Engine version"))?;
        let server = version
            .get("Server")
            .ok_or_else(|| malformed("Missing Docker Server version"))?;
        let fingerprint = Fingerprint {
            id: required(&info, "ID")?.into(),
            server: required(server, "Version")?.into(),
            api: required(server, "ApiVersion")?.into(),
            os: required(&info, "OSType")?.into(),
            arch: required(&info, "Architecture")?.into(),
            name: required(&info, "Name")?.into(),
        };
        if client != Some(&target.client_version) || fingerprint != target.fingerprint {
            return Err(ApiError::new(
                "EnvironmentChanged",
                "CLI or Engine identity changed. Reconnect before using Compose",
            ));
        }
        Ok(())
    }
    fn compose_provenance(
        &self,
        target: &Target,
        input: &ComposeProjectInput,
        options: &ProcessOptions,
    ) -> Result<usize> {
        let filter = format!("label=com.docker.compose.project={}", input.name);
        let output = self.compose_capture(
            target,
            &target.engine_args(&[
                "container",
                "ls",
                "--all",
                "--no-trunc",
                "--filter",
                &filter,
                "--format",
                "{{.ID}}",
            ]),
            options,
        )?;
        let text = std::str::from_utf8(&output)
            .map_err(|_| malformed("Compose inventory is not UTF-8"))?;
        let ids: Vec<_> = text
            .lines()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if ids.iter().any(|id| !valid_id(id))
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(malformed(
                "Compose inventory contains invalid container IDs",
            ));
        }
        for chunk in ids.chunks(100) {
            let mut arguments =
                target.engine_args(&["container", "inspect", "--format", PROVENANCE_FORMAT]);
            arguments.extend_from_slice(chunk);
            let rows = json_lines(&self.compose_capture(target, &arguments, options)?)?;
            if rows.len() != chunk.len() {
                return Err(malformed("Compose provenance inspection is incomplete"));
            }
            let mut seen = HashSet::new();
            for row in rows {
                let id = required(&row, "Id")?;
                if !chunk.iter().any(|candidate| candidate == id) || !seen.insert(id.to_owned()) {
                    return Err(malformed(
                        "Compose provenance returned an unexpected container",
                    ));
                }
                let same = row.get("Project").and_then(Value::as_str) == Some(&input.name)
                    && row
                        .get("WorkingDirectory")
                        .and_then(Value::as_str)
                        .and_then(|p| canonical_path(p, true).ok())
                        .as_deref()
                        == Some(&input.working_directory)
                    && row
                        .get("ConfigFiles")
                        .and_then(Value::as_str)
                        .filter(|p| !p.contains(','))
                        .and_then(|p| canonical_path(p, false).ok())
                        .as_deref()
                        == Some(&input.compose_file);
                if !same {
                    return Err(ApiError::new(
                        "ProjectProvenanceConflict",
                        "Containers with this project name belong to a different or unverifiable Compose source",
                    ));
                }
            }
        }
        Ok(ids.len())
    }
}
fn registry_valid(projects: &[ComposeProject]) -> bool {
    projects.len() <= 256
        && projects.iter().all(|p| {
            !p.id.is_empty()
                && p.revision > 0
                && valid_project_name(&p.name)
                && Path::new(&p.compose_file).is_absolute()
                && Path::new(&p.working_directory).is_absolute()
                && p.env_file
                    .as_ref()
                    .is_none_or(|path| Path::new(path).is_absolute())
        })
        && projects.iter().map(|p| &p.id).collect::<HashSet<_>>().len() == projects.len()
        && projects
            .iter()
            .map(|p| &p.name)
            .collect::<HashSet<_>>()
            .len()
            == projects.len()
}
fn valid_project_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && (b == b'-' || b == b'_'))
        })
}
fn preview_services(config: &Value, expected_name: &str) -> Result<Vec<ComposeServicePreview>> {
    if config.get("name").and_then(Value::as_str) != Some(expected_name) {
        return Err(malformed("Compose resolved an unexpected project name"));
    }
    let services = config
        .get("services")
        .and_then(Value::as_object)
        .filter(|services| !services.is_empty() && services.len() <= 512)
        .ok_or_else(|| {
            malformed("Compose configuration must contain between 1 and 512 services")
        })?;
    let mut rows = Vec::new();
    for (name, service) in services {
        if name.len() > 256 {
            return Err(malformed("Compose service name exceeds its limit"));
        }
        let image = service
            .get("image")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if image.as_ref().is_some_and(|image| image.len() > 2048) {
            return Err(malformed("Compose image name exceeds its limit"));
        }
        let profiles = match service.get("profiles") {
            None => vec![],
            Some(value) => {
                let profiles = value
                    .as_array()
                    .filter(|profiles| profiles.len() <= 64)
                    .ok_or_else(|| malformed("Compose service profiles exceed their limit"))?;
                profiles
                    .iter()
                    .map(|profile| {
                        profile
                            .as_str()
                            .filter(|profile| profile.len() <= 256)
                            .map(str::to_owned)
                            .ok_or_else(|| malformed("Compose service profile is invalid"))
                    })
                    .collect::<Result<Vec<_>>>()?
            }
        };
        rows.push(ComposeServicePreview {
            name: name.clone(),
            image,
            build: service.get("build").is_some_and(|v| !v.is_null()),
            profiles,
        });
    }
    Ok(rows)
}

#[cfg(all(test, unix))]
#[path = "docker_compose_tests.rs"]
mod tests;
