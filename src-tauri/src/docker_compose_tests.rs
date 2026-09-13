use super::*;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

struct Fixture {
    root: PathBuf,
    core: Core,
    _socket: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        let root = Path::new("/tmp").join(format!("d2uc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(
            root.join("compose.yaml"),
            "services:\n  api:\n    image: fixture\n",
        )
        .unwrap();
        fs::create_dir(root.join("docker-config")).unwrap();
        let script = root.join("docker");
        let source = r#"#!/usr/bin/env python3
import json, os, pathlib, sys, time
root=pathlib.Path(__ROOT__)
args=sys.argv[1:]
if args[:1]==['--host']: args=args[2:]
mode=(root/'mode').read_text() if (root/'mode').exists() else ''
if args==['--version']: print('Docker version 26.1.4, build fixture')
elif args[:1]==['info']: print(json.dumps(dict(ID='fixture-engine',OSType='linux',Architecture='aarch64',Name='fixture')))
elif args[:1]==['version']: print(json.dumps(dict(Server=dict(Version='26.1.4',ApiVersion='1.45'))))
elif args[:2]==['compose','version']: print('2.38.0' if mode=='old-version' else '2.39.4')
elif args[:1]==['compose'] and '--help' in args: print('--project-directory --project-name --env-file --progress --ansi --format --detach --timeout' if mode!='missing-option' else '--format')
elif args[:1]==['compose']:
    name=args[args.index('--project-name')+1] if '--project-name' in args else 'derived-name'
    if 'config' in args:
        if mode=='waiting-config':
            (root/'config-entered').write_text('yes')
            while not (root/'release-config').exists(): time.sleep(.01)
        if mode=='bad-config':
            print('SECRET_ENV_VALUE',file=sys.stderr); sys.exit(1)
        secret=(root/'resolved-value').read_text() if (root/'resolved-value').exists() else 'SECRET_ENV_VALUE'
        print(json.dumps(dict(name=name,services=dict(api=dict(image='fixture',environment=dict(TOKEN=secret),build=dict(context='.'),profiles=[])))))
    elif 'up' in args or 'stop' in args:
        action='up' if 'up' in args else 'stop'
        with (root/'mutations').open('a') as out: out.write(action+'\n')
        (root/'engine-container').write_text(name)
        print('Compose '+action+' progress',flush=True)
        if mode=='waiting-up':
            while True: time.sleep(.01)
        if mode=='failed-up': sys.exit(9)
    else: sys.exit(3)
elif args[:2]==['container','ls']:
    if (root/'engine-container').exists(): print('a'*64)
elif args[:2]==['container','inspect']:
    name=(root/'engine-container').read_text()
    print(json.dumps(dict(Id='a'*64,Project=name,WorkingDirectory=str(root) if mode!='wrong-source' else '/other/source',ConfigFiles=str(root/'compose.yaml'))))
else: sys.exit(4)
"#.replace("__ROOT__", &serde_json::to_string(&root.to_string_lossy()).unwrap());
        fs::write(&script, source).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = UnixListener::bind(root.join("engine.sock")).unwrap();
        let target = Target {
            docker: script,
            client_version: "26.1.4".into(),
            endpoint: format!("unix://{}", root.join("engine.sock").display()),
            env: vec![(
                "DOCKER_CONFIG".into(),
                root.join("docker-config").to_string_lossy().into_owned(),
            )],
            docker_config: root.join("docker-config"),
            fingerprint: Fingerprint {
                id: "fixture-engine".into(),
                server: "26.1.4".into(),
                api: "1.45".into(),
                os: "linux".into(),
                arch: "aarch64".into(),
                name: "fixture".into(),
            },
        };
        let core = Core::default();
        core.set_compose_storage_path(root.join("registry.json"))
            .unwrap();
        core.state.lock().unwrap().session = Some(Session {
            id: "session".into(),
            target,
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
        });
        Self {
            root,
            core,
            _socket: socket,
        }
    }
    fn input(&self) -> ComposeProjectInput {
        ComposeProjectInput {
            id: None,
            expected_revision: None,
            name: "demo".into(),
            compose_file: self
                .root
                .join("compose.yaml")
                .to_string_lossy()
                .into_owned(),
            working_directory: self.root.to_string_lossy().into_owned(),
            env_file: None,
        }
    }
    fn save(&self) -> ComposeProject {
        let preview = self
            .core
            .preview_compose_project("session", self.input())
            .unwrap();
        self.core.save_compose_project(&preview.preview_id).unwrap()
    }
    fn prepare(&self, project: &ComposeProject, action: ComposeAction) -> ComposeOperationPreview {
        self.core
            .prepare_compose_operation("session", &project.id, project.revision, action)
            .unwrap()
    }
    fn mode(&self, mode: &str) {
        fs::write(self.root.join("mode"), mode).unwrap();
    }
    fn wait_file(&self, name: &str) {
        let started = Instant::now();
        while !self.root.join(name).exists() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "fixture did not reach {name}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn wait_terminal(&self, id: &str) -> ComposeOperation {
        self.wait_terminal_for("session", id)
    }
    fn wait_terminal_for(&self, session_id: &str, id: &str) -> ComposeOperation {
        let started = Instant::now();
        loop {
            let op = self
                .core
                .read_compose_operation(session_id, id, 0)
                .unwrap()
                .operation;
            if op.phase == "finished" {
                return op;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "operation did not finish: {}",
                op.phase
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.core.shutdown();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn compose_preview_uses_minimal_fields_and_suggests_name_and_env() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join(".env"), "TOKEN=private\n").unwrap();
    let mut input = fixture.input();
    input.name.clear();
    let preview = fixture
        .core
        .preview_compose_project("session", input)
        .unwrap();
    assert_eq!(preview.project.name, "derived-name");
    assert!(
        preview
            .project
            .env_file
            .as_ref()
            .unwrap()
            .ends_with("/.env")
    );
    let encoded = serde_json::to_string(&preview).unwrap();
    assert!(!encoded.contains("SECRET_ENV_VALUE"));
    assert!(!encoded.contains("environment"));
    assert_eq!(preview.services[0].name, "api");
}
#[test]
fn compose_validation_failures_do_not_expose_resolved_secrets() {
    let fixture = Fixture::new();
    fixture.mode("bad-config");
    let error = fixture
        .core
        .preview_compose_project("session", fixture.input())
        .unwrap_err();
    assert_eq!(error.code, "ComposeValidationFailed");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("SECRET_ENV_VALUE")
    );
}
#[test]
fn compose_requires_supported_version_and_options() {
    assert!(version_supported("v2.39.4"));
    assert!(version_supported("v2.40.3-desktop.1"));
    assert!(!version_supported("v2.39.3-desktop.1"));
    assert!(version_supported("5.0.0"));
    assert!(!version_supported("2.39.3"));
    assert!(!version_supported("2.40.0-rc.1"));
    let fixture = Fixture::new();
    for mode in ["old-version", "missing-option"] {
        fixture.mode(mode);
        assert_eq!(
            fixture
                .core
                .preview_compose_project("session", fixture.input())
                .unwrap_err()
                .code,
            "ComposeUnavailable"
        );
    }
}
#[test]
fn compose_registry_save_reload_revision_remove_are_metadata_only() {
    let fixture = Fixture::new();
    let mut project = fixture.save();
    let restored = Core::default();
    restored
        .set_compose_storage_path(fixture.root.join("registry.json"))
        .unwrap();
    assert_eq!(restored.list_compose_projects().unwrap()[0].id, project.id);
    let mut input = project.input();
    input.name = "renamed".into();
    let preview = fixture
        .core
        .preview_compose_project("session", input)
        .unwrap();
    project = fixture
        .core
        .save_compose_project(&preview.preview_id)
        .unwrap();
    assert_eq!(project.revision, 2);
    assert_eq!(
        fixture
            .core
            .remove_compose_project(&project.id, 1)
            .unwrap_err()
            .code,
        "RegistrationChanged"
    );
    fixture.core.remove_compose_project(&project.id, 2).unwrap();
    assert!(fixture.core.list_compose_projects().unwrap().is_empty());
    assert!(fixture.root.join("compose.yaml").exists());
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_corrupt_registry_is_preserved_and_does_not_remove_session() {
    let fixture = Fixture::new();
    let path = fixture.root.join("registry.json");
    fs::write(&path, b"{broken private data").unwrap();
    fixture.core.set_compose_storage_path(path.clone()).unwrap();
    assert_eq!(
        fixture.core.list_compose_projects().unwrap_err().code,
        "RegistryCorrupt"
    );
    assert_eq!(
        fixture
            .core
            .save_compose_project("unknown")
            .unwrap_err()
            .code,
        "RegistryCorrupt"
    );
    assert_eq!(fs::read(&path).unwrap(), b"{broken private data");
    assert!(fixture.core.active("session").is_ok());
}
#[test]
fn compose_same_file_can_have_distinct_names_but_names_are_unique() {
    let fixture = Fixture::new();
    fixture.save();
    let alias = fixture.root.join("alias.yaml");
    std::os::unix::fs::symlink(fixture.root.join("compose.yaml"), &alias).unwrap();
    let mut input = fixture.input();
    input.name = "other".into();
    input.compose_file = alias.to_string_lossy().into_owned();
    let preview = fixture
        .core
        .preview_compose_project("session", input)
        .unwrap();
    fixture
        .core
        .save_compose_project(&preview.preview_id)
        .unwrap();
    assert_eq!(fixture.core.list_compose_projects().unwrap().len(), 2);
    fs::write(fixture.root.join("second.yaml"), "services: {}\n").unwrap();
    let mut input = fixture.input();
    input.compose_file = fixture
        .root
        .join("second.yaml")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        fixture
            .core
            .preview_compose_project("session", input)
            .unwrap_err()
            .code,
        "DuplicateRegistration"
    );
}
#[test]
fn compose_preview_rejects_changed_selected_files() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join(".env"), "OLD=1").unwrap();
    let preview = fixture
        .core
        .preview_compose_project("session", fixture.input())
        .unwrap();
    fs::write(fixture.root.join(".env"), "NEW=1").unwrap();
    assert_eq!(
        fixture
            .core
            .save_compose_project(&preview.preview_id)
            .unwrap_err()
            .code,
        "ProjectFilesChanged"
    );
    let preview = fixture
        .core
        .preview_compose_project("session", fixture.input())
        .unwrap();
    fs::write(fixture.root.join("compose.yaml"), "services: changed").unwrap();
    assert_eq!(
        fixture
            .core
            .save_compose_project(&preview.preview_id)
            .unwrap_err()
            .code,
        "ProjectFilesChanged"
    );
}
#[test]
fn compose_deselected_env_stays_deselected_after_save_and_reentry() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join(".env"), "TOKEN=private").unwrap();
    let mut input = fixture.input();
    input.env_file = Some(String::new());
    let preview = fixture
        .core
        .preview_compose_project("session", input)
        .unwrap();
    assert!(preview.project.env_file.is_none());
    let project = fixture
        .core
        .save_compose_project(&preview.preview_id)
        .unwrap();
    let (normalized, proofs) = normalize_input(project.input()).unwrap();
    assert!(normalized.env_file.is_none());
    assert_eq!(proofs.len(), 1);
    let target = fixture.core.active("session").unwrap().target;
    let args = compose_arguments(&target, &normalized, &["up", "--detach"]);
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--env-file", "/dev/null"])
    );
}
#[test]
fn compose_registry_external_corruption_is_not_overwritten() {
    let fixture = Fixture::new();
    let project = fixture.save();
    fs::write(
        fixture.root.join("registry.json"),
        "corrupt-external-change",
    )
    .unwrap();
    assert_eq!(
        fixture
            .core
            .remove_compose_project(&project.id, project.revision)
            .unwrap_err()
            .code,
        "RegistryChanged"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("registry.json")).unwrap(),
        "corrupt-external-change"
    );
}
#[test]
fn compose_provenance_requires_matching_file_and_directory_on_current_engine() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("engine-container"), "demo").unwrap();
    assert_eq!(
        fixture
            .core
            .preview_compose_project("session", fixture.input())
            .unwrap()
            .provenance,
        "matched"
    );
    fixture.mode("wrong-source");
    assert_eq!(
        fixture
            .core
            .preview_compose_project("session", fixture.input())
            .unwrap_err()
            .code,
        "ProjectProvenanceConflict"
    );
}
#[test]
fn compose_start_rechecks_resolved_config_before_mutation() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fs::write(
        fixture.root.join("resolved-value"),
        "changed-service-env-file",
    )
    .unwrap();
    let started = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    let terminal = fixture.wait_terminal(&started.id);
    assert_eq!(terminal.outcome.as_deref(), Some("failed"));
    assert_eq!(terminal.error.unwrap().code, "ProjectFilesChanged");
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_prepared_operation_requires_the_session_to_remain_valid() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .stale = true;
    assert_eq!(
        fixture
            .core
            .start_compose_operation("session", &prepared.prepare_id, "request")
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_preparing_cancel_deduplicates_request_and_never_launches_mutation() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture.mode("waiting-config");
    let started = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    fixture.wait_file("config-entered");
    assert_eq!(
        fixture
            .core
            .start_compose_operation("session", &prepared.prepare_id, "request")
            .unwrap()
            .id,
        started.id
    );
    assert_eq!(
        fixture
            .core
            .mutate_container("session", "irrelevant", Action::Start)
            .unwrap_err()
            .code,
        "Busy"
    );
    assert!(!fixture.core.state.lock().unwrap().mutating);
    assert_eq!(
        fixture
            .core
            .remove_compose_project(&project.id, project.revision)
            .unwrap_err()
            .code,
        "Busy"
    );
    fixture
        .core
        .cancel_compose_operation("session", &started.id)
        .unwrap();
    let terminal = fixture.wait_terminal(&started.id);
    assert_eq!(terminal.outcome.as_deref(), Some("cancelledBeforeStart"));
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_success_output_replays_without_consuming_and_stop_preserves_registration() {
    let fixture = Fixture::new();
    let project = fixture.save();
    for action in [ComposeAction::Up, ComposeAction::Stop] {
        let prepared = fixture.prepare(&project, action);
        let op = fixture
            .core
            .start_compose_operation(
                "session",
                &prepared.prepare_id,
                &uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
        let terminal = fixture.wait_terminal(&op.id);
        assert_eq!(terminal.outcome.as_deref(), Some("succeeded"));
        assert_eq!(terminal.reconciliation, "succeeded");
        assert_eq!(terminal.observed_containers, Some(1));
        let first = fixture
            .core
            .read_compose_operation("session", &op.id, 0)
            .unwrap();
        let second = fixture
            .core
            .read_compose_operation("session", &op.id, 0)
            .unwrap();
        assert_eq!(first.text, second.text);
        assert!(first.text.contains("progress"));
        assert!(
            fixture
                .core
                .read_compose_operation("session", &op.id, first.next_sequence)
                .unwrap()
                .text
                .is_empty()
        );
    }
    assert_eq!(fixture.core.list_compose_projects().unwrap().len(), 1);
    assert_eq!(
        fs::read_to_string(fixture.root.join("mutations")).unwrap(),
        "up\nstop\n"
    );
}
#[test]
fn compose_running_cancel_preserves_partial_state_and_reconciles() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture.mode("waiting-up");
    let op = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    fixture.wait_file("mutations");
    fixture
        .core
        .cancel_compose_operation("session", &op.id)
        .unwrap();
    let terminal = fixture.wait_terminal(&op.id);
    assert!(terminal.cancel_requested);
    assert_eq!(terminal.outcome.as_deref(), Some("resultUnknown"));
    assert_eq!(terminal.reconciliation, "succeeded");
    assert_eq!(terminal.observed_containers, Some(1));
}
#[test]
fn compose_nonzero_exit_keeps_failure_separate_from_reconciled_state() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture.mode("failed-up");
    let op = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    let terminal = fixture.wait_terminal(&op.id);
    assert_eq!(terminal.outcome.as_deref(), Some("failed"));
    assert_eq!(terminal.exit_code, Some(9));
    assert_eq!(terminal.reconciliation, "succeeded");
}
#[test]
fn compose_session_retirement_cancels_preparing_work_before_new_session() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture.mode("waiting-config");
    let op = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    fixture.wait_file("config-entered");
    let old = {
        let mut state = fixture.core.state.lock().unwrap();
        state.epoch += 1;
        state.session.take().unwrap()
    };
    fixture.core.cancel_all_compose_and_wait();
    let mut next = old;
    next.id = "new-session".into();
    fixture.core.state.lock().unwrap().session = Some(next);
    let retained = fixture.core.list_compose_operations("new-session").unwrap();
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].session_id, "session");
    assert_eq!(
        fixture
            .core
            .read_compose_operation("session", &op.id, 0)
            .unwrap()
            .operation
            .outcome
            .as_deref(),
        Some("cancelledBeforeStart")
    );
    assert!(!fixture.root.join("mutations").exists());
    assert!(
        fixture
            .core
            .state
            .lock()
            .unwrap()
            .compose_operation
            .is_none()
    );
}
#[test]
fn compose_completed_output_survives_reconnect_and_a_new_operation_without_old_authority() {
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    let old = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request-a")
        .unwrap();
    fixture.wait_terminal(&old.id);
    let original = fixture
        .core
        .read_compose_operation("session", &old.id, 0)
        .unwrap()
        .text;
    assert!(!original.is_empty());
    let mut next = {
        let mut state = fixture.core.state.lock().unwrap();
        state.epoch += 1;
        state.session.take().unwrap()
    };
    fixture.core.cancel_all_compose_and_wait();
    next.id = "new-session".into();
    fixture.core.state.lock().unwrap().session = Some(next);
    let prepared = fixture
        .core
        .prepare_compose_operation(
            "new-session",
            &project.id,
            project.revision,
            ComposeAction::Stop,
        )
        .unwrap();
    let new = fixture
        .core
        .start_compose_operation("new-session", &prepared.prepare_id, "request-b")
        .unwrap();
    fixture.wait_terminal_for("new-session", &new.id);
    let retained = fixture.core.list_compose_operations("new-session").unwrap();
    assert_eq!(retained.len(), 2);
    assert_eq!(retained[0].session_id, "session");
    assert_eq!(retained[1].session_id, "new-session");
    assert_eq!(
        fixture
            .core
            .read_compose_operation("session", &old.id, 0)
            .unwrap()
            .text,
        original
    );
    assert_eq!(
        fixture
            .core
            .read_compose_operation("new-session", &old.id, 0)
            .unwrap_err()
            .code,
        "OperationUnavailable"
    );
    assert_eq!(
        fixture
            .core
            .cancel_compose_operation("session", &old.id)
            .unwrap_err()
            .code,
        "StaleSession"
    );
    assert_eq!(
        fixture
            .core
            .cancel_compose_operation("new-session", &old.id)
            .unwrap_err()
            .code,
        "OperationUnavailable"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("mutations")).unwrap(),
        "up\nstop\n"
    );
}
#[test]
fn compose_session_invalidation_cancels_standalone_preview_validation() {
    let fixture = Fixture::new();
    fixture.mode("waiting-config");
    let core = fixture.core.clone();
    let input = fixture.input();
    let thread = thread::spawn(move || core.preview_compose_project("session", input));
    fixture.wait_file("config-entered");
    fixture.core.cancel_compose_session("session");
    assert!(thread.join().unwrap().is_err());
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_retired_start_token_cannot_spawn_after_validation_finished() {
    let mut fixture = Fixture::new();
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    fixture.core.compose_pre_spawn_barriers = Some((entered.clone(), release.clone()));
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    entered.wait();
    fixture.core.state.lock().unwrap().session = None;
    fixture.core.cancel_compose_session("session");
    release.wait();
    fixture.core.cancel_all_compose_and_wait();
    assert!(!fixture.root.join("mutations").exists());
    assert!(
        fixture
            .core
            .state
            .lock()
            .unwrap()
            .compose_operation
            .is_none()
    );
}
#[test]
fn compose_reconnect_waits_for_standalone_validation_children() {
    let fixture = Fixture::new();
    fixture.mode("waiting-config");
    let core = fixture.core.clone();
    let input = fixture.input();
    let thread = thread::spawn(move || core.preview_compose_project("session", input));
    fixture.wait_file("config-entered");
    fixture.core.state.lock().unwrap().session = None;
    fixture.core.cancel_all_compose_and_wait();
    assert!(thread.join().unwrap().is_err());
    assert!(!fixture.root.join("mutations").exists());
}
#[test]
fn compose_project_log_identity_failure_cancels_a_quiet_running_operation() {
    use std::io::{BufRead, BufReader};
    let fixture = Fixture::new();
    let project = fixture.save();
    let prepared = fixture.prepare(&project, ComposeAction::Up);
    fixture.mode("waiting-up");
    let operation = fixture
        .core
        .start_compose_operation("session", &prepared.prepare_id, "request")
        .unwrap();
    fixture.wait_file("mutations");
    let container = Container {
        handle: "container-handle".into(),
        full_id: "a".repeat(64),
        short_id: "a".repeat(12),
        name: "api".into(),
        image: "fixture".into(),
        state: "running".into(),
        health: None,
        health_configured: None,
        ports: vec![],
        created_at: "2026-09-13T00:00:00Z".into(),
        started_at: None,
        tty: false,
        compose_project: Some("demo".into()),
        compose_service: Some("api".into()),
    };
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .handles
        .insert(container.handle.clone(), container);
    let listener = fixture._socket.try_clone().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            while line != "\r\n" {
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
            }
            let body = r#"{"Version":"99.0.0","ApiVersion":"1.45","MinAPIVersion":"1.24","Os":"linux","Arch":"aarch64"}"#;
            if write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .is_err()
            {
                break;
            }
        }
    });
    fixture
        .core
        .configure_project_logs("session", "demo", None)
        .unwrap();
    let terminal = fixture.wait_terminal(&operation.id);
    assert!(fixture.core.active("session").unwrap().needs_validation);
    assert!(terminal.cancel_requested);
    assert_eq!(terminal.outcome.as_deref(), Some("resultUnknown"));
    fixture.core.stop_project_logs("session").unwrap();
    server.join().unwrap();
}
