use super::*;
use std::{io::Write, os::unix::fs::symlink, sync::Barrier};

struct Fixture {
    root: PathBuf,
    core: Core,
    prepared: PreparedExport,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("docker2u-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("config")).unwrap();
        let session = Session {
            id: "export-session".into(),
            generation: 1,
            handles: HashMap::new(),
            stale: false,
            needs_validation: false,
            inventory: None,
            target: Target {
                docker: "/usr/bin/false".into(),
                client_version: "1".into(),
                endpoint: format!("unix://{}", root.join("absent.sock").display()),
                env: vec![],
                docker_config: root.join("config"),
                fingerprint: Fingerprint {
                    id: "engine".into(),
                    name: "Engine".into(),
                    server: "1".into(),
                    api: "1.45".into(),
                    os: "linux".into(),
                    arch: "arm64".into(),
                },
            },
        };
        let prepared = PreparedExport {
            preview: ImageExportPreview {
                prepare_id: "prepare".into(),
                session_id: session.id.clone(),
                container_id: "a".repeat(64),
                container_name: "container".into(),
                image_id: format!("sha256:{}", "b".repeat(64)),
                image_reference: "image:tag".into(),
                engine_id: "engine".into(),
                engine_name: "Engine".into(),
                engine_endpoint: session.target.endpoint.clone(),
                expires_at: chrono::Utc::now().to_rfc3339(),
            },
            session: session.clone(),
            expires: Instant::now() + PREPARE_TTL,
        };
        let core = Core::default();
        core.state.lock().unwrap().session = Some(session);
        core.image_exports
            .lock()
            .unwrap()
            .prepared
            .insert("prepare".into(), prepared.clone());
        Self {
            root,
            core,
            prepared,
        }
    }
    fn destination(&self) -> Destination {
        Destination::open("export-session", "prepare", self.root.join("result.tar")).unwrap()
    }
    fn job(&self, request: &str) -> Arc<ImageExportJob> {
        let preview = &self.prepared.preview;
        Arc::new(ImageExportJob {
            operation: Mutex::new(ImageExportOperation {
                id: request.into(),
                request_id: request.into(),
                session_id: preview.session_id.clone(),
                container_id: preview.container_id.clone(),
                container_name: preview.container_name.clone(),
                image_id: preview.image_id.clone(),
                image_reference: preview.image_reference.clone(),
                engine_id: preview.engine_id.clone(),
                engine_name: preview.engine_name.clone(),
                engine_endpoint: preview.engine_endpoint.clone(),
                path: self.root.join("result.tar").display().to_string(),
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
            }),
            prepare_id: "prepare".into(),
            destination_token: "destination".into(),
            cancel: Arc::new(AtomicBool::new(false)),
            committed: AtomicBool::new(false),
            started: Instant::now(),
            worker: Mutex::new(None),
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.core.cancel_all_image_exports_and_wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn actual_image_parser_rejects_name_reference_wrong_container_and_extra_output() {
    let container = "a".repeat(64);
    let image = format!("sha256:{}", "b".repeat(64));
    let bytes =
        serde_json::to_vec(&serde_json::json!({"Id": container, "ImageId": image})).unwrap();
    assert_eq!(parse_image_id(&bytes, &container).unwrap(), image);
    for value in [
        serde_json::json!({"Id": container, "ImageId":"example:latest"}),
        serde_json::json!({"Id": "c".repeat(64), "ImageId": image}),
        serde_json::json!({"Id": container, "ImageId": null}),
        serde_json::json!({"Id": container, "ImageId": image, "Config": {"Env":["SECRET"]}}),
    ] {
        assert!(parse_image_id(&serde_json::to_vec(&value).unwrap(), &container).is_err());
    }
    assert!(parse_image_id(&[bytes.clone(), bytes].concat(), &container).is_err());
}

#[test]
fn destination_never_overwrites_existing_file_or_dangling_symlink() {
    let fixture = Fixture::new();
    let target = fixture.root.join("result.tar");
    fs::write(&target, b"existing").unwrap();
    assert_eq!(
        Destination::open("s", "p", target.clone())
            .err()
            .unwrap()
            .code,
        "ImageExportDestinationExists"
    );
    fs::remove_file(&target).unwrap();
    symlink(fixture.root.join("missing"), &target).unwrap();
    assert_eq!(
        Destination::open("s", "p", target).err().unwrap().code,
        "ImageExportDestinationExists"
    );
    assert!(Destination::open("s", "p", "relative.tar".into()).is_err());
    assert!(Destination::open("s", "p", fixture.root.join("result.tar.gz")).is_err());
}

#[test]
fn temporary_archive_publishes_complete_file_without_replacing_late_collision() {
    let fixture = Fixture::new();
    let mut archive = TemporaryArchive::create(fixture.destination(), None).unwrap();
    archive.file.write_all(b"complete archive").unwrap();
    archive.file.sync_all().unwrap();
    assert!(!fixture.root.join("result.tar").exists());
    archive.publish().unwrap();
    drop(archive);
    assert_eq!(
        fs::read(fixture.root.join("result.tar")).unwrap(),
        b"complete archive"
    );
    fs::remove_file(fixture.root.join("result.tar")).unwrap();
    let mut archive = TemporaryArchive::create(fixture.destination(), None).unwrap();
    archive.file.write_all(b"new archive").unwrap();
    fs::write(fixture.root.join("result.tar"), b"another writer").unwrap();
    assert_eq!(
        archive.publish().unwrap_err().code,
        "ImageExportDestinationExists"
    );
    drop(archive);
    assert_eq!(
        fs::read(fixture.root.join("result.tar")).unwrap(),
        b"another writer"
    );
    assert!(!fs::read_dir(&fixture.root).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")
    }));
}

#[test]
fn changed_directory_and_changed_temporary_entry_fail_closed() {
    let fixture = Fixture::new();
    let folder = fixture.root.join("chosen");
    fs::create_dir(&folder).unwrap();
    let destination = Destination::open("s", "p", folder.join("result.tar")).unwrap();
    fs::rename(&folder, fixture.root.join("moved")).unwrap();
    fs::create_dir(&folder).unwrap();
    assert_eq!(
        destination.verify().unwrap_err().code,
        "ImageExportDestinationChanged"
    );

    let job = fixture.job("request");
    let mut archive = TemporaryArchive::create(fixture.destination(), Some(job.clone())).unwrap();
    let path = fixture.root.join(archive.name.to_string_lossy().as_ref());
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"not our file").unwrap();
    assert!(
        fixture
            .core
            .publish_image_export(&job, &ProcessOptions::default(), &mut archive)
            .is_err()
    );
    drop(archive);
    assert_eq!(fs::read(path).unwrap(), b"not our file");
    assert!(job.snapshot().cleanup_warning.is_some());
}

#[test]
fn tokens_are_bound_to_source_session_and_survive_normal_generation_changes() {
    let fixture = Fixture::new();
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .generation += 1;
    assert!(
        fixture
            .core
            .image_export_picker_preview("export-session", "prepare")
            .is_ok()
    );
    assert!(
        fixture
            .core
            .image_export_picker_preview("other-session", "prepare")
            .is_err()
    );
    let destination = fixture
        .core
        .set_image_export_destination("export-session", "prepare", fixture.root.join("result.tar"))
        .unwrap();
    assert_eq!(
        fixture
            .core
            .start_image_export("export-session", "prepare", "different", "request")
            .unwrap_err()
            .code,
        "ImageExportDestinationUnavailable"
    );
    fixture
        .core
        .image_exports
        .lock()
        .unwrap()
        .prepared
        .get_mut("prepare")
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        fixture
            .core
            .start_image_export(
                "export-session",
                "prepare",
                &destination.destination_token,
                "request"
            )
            .unwrap_err()
            .code,
        "ImageExportPreparationExpired"
    );
    assert!(
        fixture
            .core
            .image_exports
            .lock()
            .unwrap()
            .destinations
            .is_empty()
    );
}

#[test]
fn request_id_recovers_registered_source_failure_without_second_launch() {
    let fixture = Fixture::new();
    let destination = fixture
        .core
        .set_image_export_destination("export-session", "prepare", fixture.root.join("result.tar"))
        .unwrap();
    let first = fixture
        .core
        .start_image_export(
            "export-session",
            "prepare",
            &destination.destination_token,
            "request",
        )
        .unwrap();
    fixture
        .core
        .image_export_job("export-session", "request")
        .unwrap()
        .join();
    let second = fixture
        .core
        .start_image_export(
            "export-session",
            "prepare",
            &destination.destination_token,
            "request",
        )
        .unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.outcome, Some(ImageExportOutcome::Failed));
    assert!(second.error.is_some());
    assert_eq!(
        fixture
            .core
            .list_image_exports("export-session")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        fixture
            .core
            .start_image_export(
                "export-session",
                "another",
                &destination.destination_token,
                "request"
            )
            .unwrap_err()
            .code,
        "RequestConflict"
    );
    assert_eq!(
        fixture
            .core
            .read_image_export("export-session", "other")
            .unwrap_err()
            .code,
        "ImageExportUnavailable"
    );
    assert!(!fixture.root.join("result.tar").exists());
}

#[test]
fn export_reservation_is_independent_of_observation_and_released_on_worker_failure() {
    let fixture = Fixture::new();
    let job = fixture.job("request");
    fixture.core.image_exports.lock().unwrap().active = Some("request".into());
    let destination = fixture
        .core
        .set_image_export_destination("export-session", "prepare", fixture.root.join("result.tar"))
        .unwrap();
    assert_eq!(
        fixture
            .core
            .start_image_export(
                "export-session",
                "prepare",
                &destination.destination_token,
                "other"
            )
            .unwrap_err()
            .code,
        "ImageExportBusy"
    );
    assert!(!fixture.core.state.lock().unwrap().mutating);
    drop(ExportReservation {
        manager: fixture.core.image_exports.clone(),
        job: job.clone(),
    });
    assert!(fixture.core.image_exports.lock().unwrap().active.is_none());
    assert_eq!(job.snapshot().outcome, Some(ImageExportOutcome::Failed));
    assert!(
        !fixture
            .core
            .state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .stale
    );
}

#[test]
fn cancellation_deadline_and_reconnection_prevent_publication() {
    for reason in ["cancel", "deadline", "reconnect"] {
        let fixture = Fixture::new();
        let job = fixture.job("request");
        fixture
            .core
            .image_exports
            .lock()
            .unwrap()
            .jobs
            .push_back(job.clone());
        let mut archive =
            TemporaryArchive::create(fixture.destination(), Some(job.clone())).unwrap();
        archive.file.write_all(b"archive").unwrap();
        let mut options = ProcessOptions::default();
        match reason {
            "cancel" => {
                fixture
                    .core
                    .cancel_image_export("export-session", "request")
                    .unwrap();
            }
            "deadline" => options.deadline = Some(Instant::now() - Duration::from_secs(1)),
            _ => {
                fixture.core.state.lock().unwrap().session = None;
                fixture.core.cancel_all_image_exports_and_wait();
            }
        }
        assert!(
            fixture
                .core
                .publish_image_export(&job, &options, &mut archive)
                .is_err()
        );
        drop(archive);
        assert!(!fixture.root.join("result.tar").exists());
    }
}

#[test]
fn publication_and_cancel_share_one_commit_decision() {
    let fixture = Fixture::new();
    let job = fixture.job("request");
    fixture
        .core
        .image_exports
        .lock()
        .unwrap()
        .jobs
        .push_back(job.clone());
    let mut archive = TemporaryArchive::create(fixture.destination(), Some(job.clone())).unwrap();
    archive.file.write_all(b"archive").unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let worker = {
        let core = fixture.core.clone();
        let job = job.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            core.publish_image_export(&job, &ProcessOptions::default(), &mut archive)
        })
    };
    let cancel = {
        let core = fixture.core.clone();
        let barrier = barrier.clone();
        thread::spawn(move || {
            barrier.wait();
            core.cancel_image_export("export-session", "request")
                .unwrap()
        })
    };
    barrier.wait();
    let result = worker.join().unwrap();
    cancel.join().unwrap();
    if result.is_ok() {
        assert_eq!(job.snapshot().outcome, Some(ImageExportOutcome::Succeeded));
        assert_eq!(
            fs::read(fixture.root.join("result.tar")).unwrap(),
            b"archive"
        );
        assert!(!job.cancel.load(Ordering::Acquire));
    } else {
        assert!(!fixture.root.join("result.tar").exists());
        assert!(job.cancel.load(Ordering::Acquire));
    }
}

#[test]
fn terminal_results_survive_late_cancel_and_archive_retention_is_ten() {
    let fixture = Fixture::new();
    for index in 0..12 {
        let job = fixture.job(&format!("request-{index}"));
        job.finish(ImageExportOutcome::Succeeded, None);
        fixture
            .core
            .image_exports
            .lock()
            .unwrap()
            .jobs
            .push_back(job);
    }
    let jobs = fixture.core.list_image_exports("export-session").unwrap();
    assert_eq!(jobs.len(), RETENTION);
    let cancelled = fixture
        .core
        .cancel_image_export("export-session", "request-11")
        .unwrap();
    assert_eq!(cancelled.outcome, Some(ImageExportOutcome::Succeeded));
    fixture
        .core
        .state
        .lock()
        .unwrap()
        .session
        .as_mut()
        .unwrap()
        .id = "reconnected".into();
    assert_eq!(
        fixture
            .core
            .read_image_export("export-session", "request-11")
            .unwrap()
            .outcome,
        Some(ImageExportOutcome::Succeeded)
    );
    assert_eq!(
        fixture
            .core
            .list_image_exports("reconnected")
            .unwrap()
            .len(),
        RETENTION
    );
    assert!(
        fixture
            .core
            .start_image_export("export-session", "prepare", "destination", "old-request")
            .is_err()
    );
}

#[test]
fn slow_directory_sync_releases_state_gate_and_preserves_committed_success_with_warning() {
    let mut fixture = Fixture::new();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    fixture.core.image_export_directory_sync = Some({
        let entered = entered.clone();
        let release = release.clone();
        Arc::new(move || {
            entered.wait();
            release.wait();
            Err(std::io::Error::other("simulated directory sync failure"))
        })
    });
    let job = fixture.job("request");
    fixture
        .core
        .image_exports
        .lock()
        .unwrap()
        .jobs
        .push_back(job.clone());
    let mut archive = TemporaryArchive::create(fixture.destination(), Some(job.clone())).unwrap();
    archive.file.write_all(b"complete archive").unwrap();
    archive.file.sync_all().unwrap();
    let publisher = {
        let core = fixture.core.clone();
        let job = job.clone();
        thread::spawn(move || {
            core.publish_image_export(&job, &ProcessOptions::default(), &mut archive)
        })
    };
    entered.wait();
    let state_available = fixture.core.state.try_lock().is_ok();
    let progress = if state_available {
        // This is the same state gate required by inventory/log observation.
        let generation = fixture
            .core
            .active("export-session")
            .map(|session| session.generation);
        let progress = fixture
            .core
            .cancel_image_export("export-session", "request");
        let cancelled = job.cancel.load(Ordering::Acquire);
        fixture.core.state.lock().unwrap().session = None;
        fixture.core.cancel_all_image_exports_and_wait();
        Some((
            generation,
            progress,
            cancelled,
            job.cancel.load(Ordering::Acquire),
        ))
    } else {
        None
    };
    // Always release before asserting so a lock regression cannot strand a worker.
    release.wait();
    publisher.join().unwrap().unwrap();
    assert!(
        state_available,
        "directory sync held the global observation state gate"
    );
    let (generation, progress, cancelled, retired) = progress.unwrap();
    assert_eq!(generation.unwrap(), 1);
    let progress = progress.unwrap();
    assert_eq!(progress.phase, ImageExportPhase::Publishing);
    assert_eq!(
        progress.outcome, None,
        "publish warnings must accompany the first terminal snapshot"
    );
    assert!(!cancelled, "cancel is too late once the archive exists");
    assert!(!retired, "retirement must preserve committed success");
    let finished = fixture
        .core
        .read_image_export("export-session", "request")
        .unwrap();
    assert_eq!(finished.outcome, Some(ImageExportOutcome::Succeeded));
    assert!(finished.error.is_none());
    assert!(
        finished
            .cleanup_warning
            .unwrap()
            .contains("simulated directory sync failure")
    );
    assert_eq!(
        fs::read(fixture.root.join("result.tar")).unwrap(),
        b"complete archive"
    );
    job.finish(ImageExportOutcome::Cancelled, None);
    assert_eq!(job.snapshot().outcome, Some(ImageExportOutcome::Succeeded));
}
