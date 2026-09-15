//! Production Core exports against an isolated, strict binary-output CLI.
use super::*;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};

const SESSION: &str = "pipeline-session";
const HANDLE: &str = "pipeline-container";

struct Pipeline {
    root: PathBuf,
    core: Core,
    _socket: UnixListener,
}

impl Pipeline {
    fn new(state: &str) -> Self {
        // Keep the socket path below the Unix-domain address length limit.
        let root = Path::new("/tmp")
            .canonicalize()
            .unwrap()
            .join(format!("d2u-ep-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&root).unwrap();
        let socket = UnixListener::bind(root.join("engine.sock")).unwrap_or_else(|error| {
            let _ = fs::remove_dir_all(&root);
            panic!("image export pipeline requires a local fixture socket: {error}")
        });
        fs::create_dir(root.join("config")).unwrap();
        fs::create_dir(root.join("exports")).unwrap();
        fs::write(root.join("docker"), CLI).unwrap();
        fs::set_permissions(root.join("docker"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("archive.bin"), archive_bytes()).unwrap();
        fs::write(root.join("inventory-format"), INSPECT_FORMAT).unwrap();
        fs::write(root.join("tag"), "fixture.invalid/example:old").unwrap();
        fs::write(root.join("container-state"), state).unwrap();
        let container = Container {
            handle: HANDLE.into(),
            full_id: "a".repeat(64),
            short_id: "a".repeat(12),
            name: "pipeline-컨테이너".into(),
            image: "fixture.invalid/example:old".into(),
            state: state.into(),
            health: Some("none".into()),
            health_configured: Some(false),
            ports: vec![],
            created_at: "2026-09-13T00:00:00Z".into(),
            started_at: None,
            tty: false,
            compose_project: None,
            compose_service: None,
        };
        let core = Core::default();
        core.state.lock().unwrap().session = Some(Session {
            id: SESSION.into(),
            generation: 1,
            handles: HashMap::from([(HANDLE.into(), container)]),
            stale: false,
            needs_validation: false,
            inventory: None,
            target: Target {
                docker: root.join("docker"),
                client_version: "28.0.0".into(),
                endpoint: format!("unix://{}", root.join("engine.sock").display()),
                env: vec![],
                docker_config: root.join("config"),
                fingerprint: Fingerprint {
                    id: "fixture-engine".into(),
                    name: "Fixture Engine".into(),
                    server: "28.0.0".into(),
                    api: "1.48".into(),
                    os: "linux".into(),
                    arch: "arm64".into(),
                },
            },
        });
        Self {
            root,
            core,
            _socket: socket,
        }
    }

    fn mode(&self, mode: &str) {
        fs::write(self.root.join("mode"), mode).unwrap();
    }

    fn prepare(&self) -> ImageExportPreview {
        let session = self.core.active(SESSION).unwrap();
        let handle = session.handles.keys().next().unwrap();
        self.core
            .prepare_image_export(SESSION, session.generation, handle)
            .unwrap()
    }

    fn start(&self, preview: &ImageExportPreview, request: &str) -> ImageExportOperation {
        let destination = self
            .core
            .set_image_export_destination(
                SESSION,
                &preview.prepare_id,
                self.root.join("exports").join(format!("{request}.tar")),
            )
            .unwrap();
        let operation = self
            .core
            .start_image_export(
                SESSION,
                &preview.prepare_id,
                &destination.destination_token,
                request,
            )
            .unwrap();
        assert_eq!(operation.request_id, request);
        assert_eq!(operation.image_id, image_id());
        operation
    }

    fn wait(&self, request: &str, finished: bool) -> ImageExportOperation {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let operation = self.core.read_image_export(SESSION, request).unwrap();
            if (finished && operation.phase == ImageExportPhase::Finished)
                || (!finished && operation.bytes_written > 0)
            {
                if finished {
                    self.core.image_export_job(SESSION, request).unwrap().join();
                    assert!(self.core.image_exports.lock().unwrap().active.is_none());
                }
                return operation;
            }
            assert!(
                Instant::now() < deadline && (finished || operation.outcome.is_none()),
                "pipeline did not reach expected state: {operation:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn trace(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.root.join("trace"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn saves(&self) -> Vec<Vec<String>> {
        self.trace()
            .into_iter()
            .filter(|args| args.get(2).is_some_and(|value| value == "image"))
            .collect()
    }

    fn assert_no_output(&self) {
        assert_eq!(fs::read_dir(self.root.join("exports")).unwrap().count(), 0);
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.core.cancel_all_image_exports_and_wait();
        self.core.runner.shutdown();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn image_id() -> String {
    format!("sha256:{}", "b".repeat(64))
}

fn archive_bytes() -> Vec<u8> {
    // A deterministic USTAR member containing non-UTF-8 bytes, not CLI text.
    let payload: Vec<u8> = (0..65_536).map(|index| (index % 256) as u8).collect();
    let mut header = [0_u8; 512];
    header[..11].copy_from_slice(b"payload.bin");
    header[100..108].copy_from_slice(b"0000644\0");
    header[108..116].copy_from_slice(b"0000000\0");
    header[116..124].copy_from_slice(b"0000000\0");
    header[124..136].copy_from_slice(format!("{:011o}\0", payload.len()).as_bytes());
    header[136..148].copy_from_slice(b"00000000000\0");
    header[148..156].fill(b' ');
    header[156] = b'0';
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    let checksum: u32 = header.iter().map(|byte| *byte as u32).sum();
    header[148..156].copy_from_slice(format!("{checksum:06o}\0 ").as_bytes());
    [header.to_vec(), payload, vec![0; 1024]].concat()
}

#[test]
fn pipeline_exports_running_and_stopped_images_by_id_despite_reference_change() {
    for state in ["running", "exited"] {
        let fixture = Pipeline::new(state);
        let preview = fixture.prepare();
        assert_eq!(preview.image_reference, "fixture.invalid/example:old");
        assert_eq!(preview.image_id, image_id());
        // Refresh the display reference after preparation without changing .Image.
        fs::write(fixture.root.join("tag"), "fixture.invalid/example:retagged").unwrap();
        let list = fixture.core.list_containers(SESSION).unwrap();
        assert_eq!(list.containers[0].image, "fixture.invalid/example:retagged");
        assert_eq!(list.containers[0].state, state);
        fixture.start(&preview, "success");
        let result = fixture.wait("success", true);
        assert_eq!(result.outcome, Some(ImageExportOutcome::Succeeded));
        assert_eq!(result.container_id, preview.container_id);
        assert_eq!(result.image_reference, preview.image_reference);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.finished_at.is_some());
        assert!(result.error.is_none());
        assert!(result.cleanup_warning.is_none());
        assert_eq!(result.bytes_written, archive_bytes().len() as u64);
        assert_eq!(fs::read(&result.path).unwrap(), archive_bytes());
        assert_eq!(
            fixture.saves(),
            vec![args(&[
                "--host",
                &preview.engine_endpoint,
                "image",
                "save",
                "--",
                &image_id(),
            ])]
        );
        assert!(fixture.trace().iter().flatten().all(|argument| {
            !matches!(
                argument.as_str(),
                "pull" | "tag" | "start" | "stop" | "restart"
            ) && !argument.starts_with("fixture.invalid/")
        }));
        assert_eq!(
            fixture
                .core
                .active(SESSION)
                .unwrap()
                .handles
                .values()
                .next()
                .unwrap()
                .state,
            state
        );
        assert_eq!(
            fs::read_dir(fixture.root.join("exports")).unwrap().count(),
            1
        );
        assert_eq!(
            fixture.core.list_image_exports(SESSION).unwrap()[0].request_id,
            "success"
        );
    }
}

#[test]
fn pipeline_rejects_unavailable_or_changed_source_before_launching_save() {
    for (mode, code) in [
        ("source-changed", "ImageExportSourceChanged"),
        ("missing-container", "CommandFailed"),
        ("missing-image", "MalformedOutput"),
    ] {
        let fixture = Pipeline::new("running");
        let preview = fixture.prepare();
        fixture.mode(mode);
        if mode != "source-changed" {
            assert_eq!(
                fixture
                    .core
                    .prepare_image_export(SESSION, 1, HANDLE)
                    .unwrap_err()
                    .code,
                code
            );
        }
        fixture.start(&preview, "rejected");
        let result = fixture.wait("rejected", true);
        assert_eq!(result.outcome, Some(ImageExportOutcome::Failed));
        assert_eq!(result.error.unwrap().code, code);
        assert_eq!(result.bytes_written, 0);
        assert!(fixture.saves().is_empty());
        fixture.assert_no_output();
    }
}

#[test]
fn pipeline_partial_command_failure_cleans_temporary_archive_without_publishing() {
    let fixture = Pipeline::new("running");
    fixture.mode("failed");
    let preview = fixture.prepare();
    fixture.start(&preview, "failed");
    let result = fixture.wait("failed", true);
    assert_eq!(result.outcome, Some(ImageExportOutcome::Failed));
    assert_eq!(result.exit_code, Some(23));
    assert_eq!(result.bytes_written, 4096);
    assert_eq!(result.error.unwrap().code, "ImageExportCommandFailed");
    assert!(result.stderr.contains("synthetic save failure"));
    assert!(result.cleanup_warning.is_none());
    assert_eq!(fixture.saves().len(), 1);
    fixture.assert_no_output();
}

#[test]
fn pipeline_quiet_export_allows_logs_and_inventory_reads_then_cancels_without_publishing() {
    let fixture = Pipeline::new("running");
    fixture.mode("quiet");
    let preview = fixture.prepare();
    fixture.start(&preview, "quiet");
    let running = fixture.wait("quiet", false);
    assert_eq!(running.phase, ImageExportPhase::Exporting);
    assert!(running.outcome.is_none());
    assert!(!fixture.core.state.lock().unwrap().mutating);
    let logs = fixture.core.get_recent_logs(SESSION, HANDLE).unwrap();
    assert!(logs.text.contains("parallel logs remain available"));
    let list = fixture.core.list_containers(SESSION).unwrap();
    assert_eq!(list.containers[0].state, "running");
    assert_eq!(
        fixture
            .core
            .read_image_export(SESSION, "quiet")
            .unwrap()
            .outcome,
        None
    );
    let second = fixture.prepare();
    let destination = fixture
        .core
        .set_image_export_destination(
            SESSION,
            &second.prepare_id,
            fixture.root.join("exports/second.tar"),
        )
        .unwrap();
    assert_eq!(
        fixture
            .core
            .start_image_export(
                SESSION,
                &second.prepare_id,
                &destination.destination_token,
                "second"
            )
            .unwrap_err()
            .code,
        "ImageExportBusy"
    );
    fixture.core.cancel_image_export(SESSION, "quiet").unwrap();
    let result = fixture.wait("quiet", true);
    assert_eq!(result.outcome, Some(ImageExportOutcome::Cancelled));
    assert_eq!(result.bytes_written, 4096);
    assert!(result.cleanup_warning.is_none());
    assert_eq!(fixture.saves().len(), 1);
    fixture.assert_no_output();
}

#[test]
fn pipeline_quiet_child_deadline_is_terminal_and_cleans_temporary_archive() {
    let mut fixture = Pipeline::new("exited");
    fixture.core.image_export_timeout = Some(Duration::from_secs(5));
    fixture.mode("quiet");
    let preview = fixture.prepare();
    fixture.start(&preview, "timeout");
    let result = fixture.wait("timeout", true);
    assert_eq!(result.outcome, Some(ImageExportOutcome::TimedOut));
    assert_eq!(result.error.unwrap().code, "TimedOut");
    assert_eq!(result.bytes_written, 4096);
    assert!(result.elapsed_ms >= 5_000);
    assert!(result.cleanup_warning.is_none());
    assert_eq!(fixture.saves().len(), 1);
    fixture.assert_no_output();
}

const CLI: &str = r##"#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path(__file__).resolve().parent
argv = sys.argv[1:]
fd = os.open(root / 'trace', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(argv) + '\n').encode())
os.close(fd)
if argv == ['--version']:
    print('Docker version 28.0.0, build fixture')
    sys.exit(0)
endpoint = 'unix://' + str(root / 'engine.sock')
if argv[:2] != ['--host', endpoint]:
    sys.exit('unexpected unpinned Engine')
args = argv[2:]
mode = (root / 'mode').read_text() if (root / 'mode').exists() else 'success'
container = 'a' * 64
image = 'sha256:' + 'b' * 64
if args == ['info', '--format', '{{json .}}']:
    print(json.dumps({'ID':'fixture-engine','Name':'Fixture Engine','OSType':'linux','Architecture':'arm64'}))
elif args == ['version', '--format', '{{json .}}']:
    print(json.dumps({'Server':{'Version':'28.0.0','ApiVersion':'1.48'}}))
elif args == ['container', 'inspect', '--format', '{"Id":{{json .Id}},"ImageId":{{json .Image}}}', container]:
    if mode == 'missing-container':
        sys.exit('No such container')
    if mode == 'missing-image':
        image = None
    elif mode == 'source-changed':
        image = 'sha256:' + 'c' * 64
    print(json.dumps({'Id':container,'ImageId':image}))
elif args == ['container', 'ls', '--all', '--no-trunc', '--format', '{{json .}}']:
    print(json.dumps({'ID':container}))
elif args == ['container', 'inspect', '--format', (root / 'inventory-format').read_text(), container]:
    print(json.dumps({'Id':container,'Name':'/pipeline-컨테이너','Image':(root/'tag').read_text(),'Created':'2026-09-13T00:00:00Z','StartedAt':None,'Tty':False,'State':(root/'container-state').read_text(),'Health':None,'HealthConfigured':False,'Ports':{},'ComposeProject':None,'ComposeService':None}))
elif args == ['container', 'logs', '--tail', '300', '--timestamps', container]:
    print('2026-09-13T00:00:01Z parallel logs remain available')
elif args == ['image', 'save', '--', image]:
    payload = (root / 'archive.bin').read_bytes()
    sys.stdout.buffer.write(payload[:4096])
    sys.stdout.buffer.flush()
    if mode == 'failed':
        print('synthetic save failure', file=sys.stderr)
        sys.exit(23)
    if mode == 'quiet':
        while True:
            time.sleep(0.1)
    sys.stdout.buffer.write(payload[4096:])
    sys.stdout.buffer.flush()
else:
    sys.exit('unexpected Docker arguments: ' + repr(args))
"##;
