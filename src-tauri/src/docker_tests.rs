use super::*;
use std::{
    fs,
    os::unix::{fs::PermissionsExt, net::UnixListener},
    thread,
    time::Instant,
};

#[path = "docker_bulk_tests.rs"]
mod bulk;

struct Fixture {
    dir: PathBuf,
    core: Core,
    _socket: UnixListener,
}
impl Fixture {
    fn new() -> Self {
        let dir = Path::new("/tmp")
            .canonicalize()
            .unwrap()
            .join(format!("d2u-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join("colima-home/docker2u")).unwrap();
        fs::create_dir_all(dir.join("lima")).unwrap();
        fs::create_dir_all(dir.join("docker-config")).unwrap();
        let socket = UnixListener::bind(dir.join("colima-home/docker2u/docker.sock")).unwrap();
        for name in ["docker", "colima"] {
            let path = dir.join(name);
            fs::write(&path, FAKE).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let config = RuntimeConfig {
            docker_path: Some(dir.join("docker")),
            colima_path: Some(dir.join("colima")),
            colima_home: Some(dir.join("colima-home")),
            lima_home: Some(dir.join("lima")),
            docker_config: Some(dir.join("docker-config")),
        };
        Self {
            dir,
            core: Core {
                config: Some(config),
                // Allow interpreter startup under the parallel process suite;
                // timeout fixtures then block for ten seconds deterministically.
                mutation_timeout: Some(Duration::from_secs(2)),
                host: Some(Ok(HostInfo {
                    os: "macos".into(),
                    architecture: "aarch64".into(),
                    version: Some(APPROVED_MACOS_VERSION.into()),
                })),
                ..Core::default()
            },
            _socket: socket,
        }
    }
    fn mode(&self, mode: &str) {
        fs::write(self.dir.join("mode"), mode).unwrap();
    }
    fn states(&self, states: &[&str]) {
        fs::write(self.dir.join("count"), states.len().to_string()).unwrap();
        let states: HashMap<_, _> = states
            .iter()
            .enumerate()
            .map(|(index, state)| (format!("{:064x}", index + 1), *state))
            .collect();
        fs::write(
            self.dir.join("states"),
            serde_json::to_vec(&states).unwrap(),
        )
        .unwrap();
    }
    fn behaviors(&self, modes: &[(usize, &str)]) {
        let modes: HashMap<_, _> = modes
            .iter()
            .map(|(index, mode)| (format!("{index:064x}"), *mode))
            .collect();
        fs::write(
            self.dir.join("behaviors"),
            serde_json::to_vec(&modes).unwrap(),
        )
        .unwrap();
    }
    fn connect(&self) -> String {
        let env = self.core.get_environment().unwrap();
        assert_eq!(env.status, "ready", "{env:?}");
        env.session_id.unwrap()
    }
    fn trace(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.join("trace"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn mutations(&self) -> usize {
        self.trace()
            .iter()
            .filter(|row| {
                row["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|arg| matches!(arg.as_str(), Some("start" | "stop" | "restart")))
            })
            .count()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.core.shutdown();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

const FAKE: &str = r##"#!/usr/bin/python3
import json, os, sys, time
from pathlib import Path
p=Path(__file__).parent
a=sys.argv[1:]
mode=(p/'mode').read_text() if (p/'mode').exists() else ''
endpoint='unix://'+str(p/'colima-home/docker2u/docker.sock')
with (p/'trace').open('a') as f: f.write(json.dumps({'cli':Path(__file__).name,'args':a})+'\n')
if Path(__file__).name=='colima':
    if a==['version']: print('colima version v0.10.3');sys.exit()
    print(json.dumps({'runtime':'docker','arch':'aarch64','driver':'macOS Virtualization.Framework','cpu':2,'memory':4294967296,'docker_socket':endpoint}));sys.exit()
if a==['--version']: print('Docker version 29.8.0, build fake');sys.exit()
if a==['context','inspect','colima-docker2u']:
    print(json.dumps([{'Name':'colima-docker2u','Endpoints':{'docker':{'Host':'tcp://evil.example:2375' if mode=='remote' else endpoint}}}]));sys.exit()
assert a[:2]==['--host',endpoint], repr(a)
a=a[2:]
if a[0]=='info': print(json.dumps({'ID':'changed' if mode=='engine_changed' else 'engine-A','OSType':'linux','Architecture':'aarch64','Name':'colima-docker2u'}));sys.exit()
if a[0]=='version': print(json.dumps({'Server':{'Version':'29.5.2','ApiVersion':'1.54'}}));sys.exit()
assert a[0]=='container'
if a[1]=='ls':
    count=int((p/'count').read_text()) if (p/'count').exists() else 1
    for i in range(1,count+1): print(json.dumps({'ID':format(i,'064x')}))
    if mode=='malformed': print('{')
    sys.exit()
if a[1]=='inspect':
    if mode=='reconcile_fail' and (p/'mutated').exists(): print('cannot connect',file=sys.stderr);sys.exit(1)
    if mode in ['held_inspect','held_inspect_failure']:
        (p/'inspecting').write_text('1')
        deadline=time.monotonic()+10
        while not (p/'release-inspect').exists():
            if time.monotonic()>deadline: print('fixture release timed out',file=sys.stderr);sys.exit(1)
            time.sleep(.005)
        if mode=='held_inspect_failure': print('inspect failed',file=sys.stderr);sys.exit(1)
    state=(p/'state').read_text() if (p/'state').exists() else 'exited'
    states=json.loads((p/'states').read_text()) if (p/'states').exists() else {}
    for ident in a[4:]:
        print(json.dumps({'Id':'f'*64 if mode=='wrong_id' else ident,'Name':"/test;$(touch forbidden)",'Image':'busybox:test','Created':'2026-09-05T08:00:00Z','State':states.get(ident,state),'Health':None,'Ports':None}))
    sys.exit()
if a[1]=='logs':
    sys.stdout.write('hello\x1b[31m red\x1b[0m\n');sys.stdout.flush()
    sys.stderr.write('stderr log\n');sys.exit()
if a[1] in ['start','stop','restart']:
    assert len(a)==3, repr(a)
    if (p/'behaviors').exists(): mode=json.loads((p/'behaviors').read_text()).get(a[2],mode)
    (p/'mutated').write_text('1')
    if mode!='daemon_error':
        state='exited' if a[1]=='stop' else 'running'
        if (p/'states').exists():
            states=json.loads((p/'states').read_text());states[a[2]]=state
            (p/'states').write_text(json.dumps(states))
        else: (p/'state').write_text(state)
    if mode=='held_mutation':
        deadline=time.monotonic()+10
        while not (p/'release-mutation').exists():
            if time.monotonic()>deadline: raise Exception('fixture release timed out')
            time.sleep(.005)
    if mode=='change_engine': (p/'mode').write_text('engine_changed')
    if mode=='reconcile_fail': (p/'mode').write_text('reconcile_fail')
    if mode in ['timeout','reconcile_fail','slow_mutation']: time.sleep(10)
    if mode=='daemon_error': print('Error response from daemon: rejected',file=sys.stderr);sys.exit(1)
    if mode=='transport_error': print('connection reset by peer',file=sys.stderr);sys.exit(1)
    print(a[2]);sys.exit()
raise Exception('unapproved command '+repr(a))
"##;

#[test]
fn missing_cli_is_a_diagnostic_not_a_panic() {
    let core = Core {
        config: Some(RuntimeConfig {
            docker_path: Some("/nonexistent/docker2u-docker".into()),
            ..RuntimeConfig::default()
        }),
        ..Core::default()
    };
    let env = core.get_environment().unwrap();
    assert_eq!(env.status, "unavailable");
    assert!(!env.mutation_allowed);
    assert!(env.session_id.is_none());
}

#[test]
fn remote_context_never_receives_an_engine_command() {
    let fixture = Fixture::new();
    fixture.mode("remote");
    let env = fixture.core.get_environment().unwrap();
    assert_eq!(env.status, "unsupported");
    assert!(fixture.trace().iter().all(|row| row["args"][0] != "--host"));
}

#[test]
fn atomic_list_preserves_generation_then_rejects_old_handles() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let first = fixture.core.list_containers(&id).unwrap();
    fixture.mode("malformed");
    assert_eq!(
        fixture.core.list_containers(&id).unwrap_err().code,
        "MalformedOutput"
    );
    let active = fixture.core.active(&id).unwrap();
    assert_eq!(active.generation, first.generation);
    assert!(active.stale);
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &first.containers[0].handle, Action::Start)
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    fixture.mode("");
    let second = fixture.core.list_containers(&id).unwrap();
    assert_eq!(second.generation, first.generation + 1);
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &first.containers[0].handle, Action::Start)
            .unwrap_err()
            .code,
        "StaleHandle"
    );
    let newer = fixture.connect();
    assert_ne!(id, newer);
    assert_eq!(
        fixture.core.list_containers(&id).unwrap_err().code,
        "StaleSession"
    );
    assert_eq!(fixture.mutations(), 0);
}

#[test]
fn batched_inspect_is_exact_and_failure_is_atomic() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.join("count"), "101").unwrap();
    let id = fixture.connect();
    let first = fixture.core.list_containers(&id).unwrap();
    assert_eq!(first.containers.len(), 101);
    let inspect: Vec<_> = fixture
        .trace()
        .into_iter()
        .filter(|r| r["args"][3] == "inspect")
        .collect();
    assert_eq!(inspect.len(), 2);
    assert_eq!(inspect[0]["args"].as_array().unwrap().len(), 106);
    assert_eq!(inspect[1]["args"].as_array().unwrap().len(), 7);
    fixture.mode("wrong_id");
    assert_eq!(
        fixture.core.list_containers(&id).unwrap_err().code,
        "MalformedOutput"
    );
    assert_eq!(
        fixture.core.active(&id).unwrap().generation,
        first.generation
    );
}

#[test]
fn engine_change_blocks_mutation_before_dispatch() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("engine_changed");
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &list.containers[0].handle, Action::Start)
            .unwrap_err()
            .code,
        "EnvironmentChanged"
    );
    assert_eq!(fixture.mutations(), 0);
    assert!(fixture.core.active(&id).unwrap().needs_validation);
}

#[test]
fn uncertain_mutation_reconciles_exact_id_without_retry() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("timeout");
    let result = fixture
        .core
        .mutate_container(&id, &list.containers[0].handle, Action::Start)
        .unwrap();
    assert_eq!(result.outcome, "resultUnknown");
    assert_eq!(result.reconciliation, "succeeded");
    assert_eq!(result.observed_state.as_deref(), Some("running"));
    assert!(!result.mutation_blocked);
    assert_eq!(fixture.mutations(), 1);
    assert!(
        fixture
            .trace()
            .iter()
            .filter(|r| r["args"][3] == "start")
            .all(|r| r["args"][4] == list.containers[0].full_id)
    );
}

#[test]
fn reconciliation_failure_requires_reconnect_even_after_successful_refresh() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("reconcile_fail");
    let result = fixture
        .core
        .mutate_container(&id, &list.containers[0].handle, Action::Start)
        .unwrap();
    assert_eq!(result.outcome, "resultUnknown");
    assert!(result.mutation_blocked);
    fixture.mode("");
    let next = fixture.core.list_containers(&id).unwrap();
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &next.containers[0].handle, Action::Stop)
            .unwrap_err()
            .code,
        "NeedsValidation"
    );
    assert_eq!(fixture.mutations(), 1);
    let next_id = fixture.connect();
    let next = fixture.core.list_containers(&next_id).unwrap();
    assert_eq!(
        fixture
            .core
            .mutate_container(&next_id, &next.containers[0].handle, Action::Stop)
            .unwrap()
            .outcome,
        "succeeded"
    );
}

#[test]
fn duplicate_mutation_and_reconnect_are_busy() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture.mode("slow_mutation");
    let core = fixture.core.clone();
    let task_id = id.clone();
    let handle = list.containers[0].handle.clone();
    let child = thread::spawn(move || core.mutate_container(&task_id, &handle, Action::Start));
    let started = Instant::now();
    while !fixture.dir.join("mutated").exists() {
        assert!(started.elapsed() < Duration::from_secs(10));
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &list.containers[0].handle, Action::Start)
            .unwrap_err()
            .code,
        "Busy"
    );
    assert_eq!(fixture.core.get_environment().unwrap_err().code, "Busy");
    assert_eq!(fixture.core.list_containers(&id).unwrap_err().code, "Busy");
    assert_eq!(child.join().unwrap().unwrap().outcome, "resultUnknown");
    assert_eq!(fixture.mutations(), 1);
}

#[test]
fn reconnect_preserves_active_refresh_until_success_or_failure() {
    for mode in ["held_inspect", "held_inspect_failure"] {
        let fixture = Fixture::new();
        let id = fixture.connect();
        let first = fixture.core.list_containers(&id).unwrap();
        let epoch = fixture.core.state.lock().unwrap().epoch;
        fixture.mode(mode);
        let core = fixture.core.clone();
        let old = id.clone();
        let child = thread::spawn(move || core.list_containers(&old));
        let started = Instant::now();
        while !fixture.dir.join("inspecting").exists() {
            assert!(started.elapsed() < Duration::from_secs(10));
            thread::sleep(Duration::from_millis(5));
        }
        let trace = fixture.trace();
        assert_eq!(fixture.core.get_environment().unwrap_err().code, "Busy");
        assert_eq!(fixture.core.list_containers(&id).unwrap_err().code, "Busy");
        {
            let state = fixture.core.state.lock().unwrap();
            let session = state.session.as_ref().unwrap();
            assert_eq!(state.epoch, epoch);
            assert!(state.refreshing);
            assert!(!state.diagnosing);
            assert_eq!(session.id, id);
            assert_eq!(session.generation, first.generation);
            assert!(session.handles.contains_key(&first.containers[0].handle));
            assert!(!session.stale);
        }
        assert_eq!(fixture.trace(), trace);
        fs::write(fixture.dir.join("release-inspect"), "1").unwrap();
        let refreshed = child.join().unwrap();
        if mode == "held_inspect" {
            let refreshed = refreshed.unwrap();
            assert_eq!(refreshed.session_id, id);
            assert_eq!(refreshed.generation, first.generation + 1);
        } else {
            assert_eq!(refreshed.unwrap_err().code, "CommandFailed");
            let active = fixture.core.active(&id).unwrap();
            assert_eq!(active.generation, first.generation);
            assert!(active.stale);
        }
        assert!(!fixture.core.state.lock().unwrap().refreshing);
        fixture.mode("");
        let new_id = fixture.connect();
        assert_ne!(new_id, id);
        assert_eq!(fixture.core.active(&new_id).unwrap().generation, 0);
        assert_eq!(fixture.core.list_containers(&new_id).unwrap().generation, 1);
        assert_eq!(fixture.mutations(), 0);
    }
}

#[test]
fn macos_version_parser_requires_one_numeric_version() {
    for (output, expected) in [
        (b"26.5.2\n".as_slice(), "26.5.2"),
        (b" 26.5.2\r\n".as_slice(), "26.5.2"),
        (b"14.0\n".as_slice(), "14.0"),
        (b"26.5.3".as_slice(), "26.5.3"),
    ] {
        assert_eq!(parse_macos_version(output).unwrap(), expected);
    }
    for output in [
        b"".as_slice(),
        b" \n",
        b"26.5.2\n26.5.2",
        b"macOS 26.5.2",
        b"26.5.2beta",
        b"26..2",
        b"26.5.2.1",
        b"26",
        b"\xff",
    ] {
        assert_eq!(
            parse_macos_version(output).unwrap_err().code,
            "MalformedOutput"
        );
    }
}

#[test]
fn approved_host_receives_a_session_and_mutation_permission() {
    let fixture = Fixture::new();
    let env = fixture.core.get_environment().unwrap();
    assert_eq!(env.status, "ready");
    assert!(env.mutation_allowed);
    assert!(env.session_id.is_some());
    assert_eq!(fixture.mutations(), 0);
}

#[test]
fn unapproved_hosts_cannot_replace_an_active_session() {
    for (os, architecture, version) in [
        ("macos", "aarch64", Some("14.0")),
        ("macos", "aarch64", Some("15.0")),
        ("macos", "aarch64", Some("26.5.1")),
        ("macos", "aarch64", Some("26.5.3")),
        ("macos", "aarch64", Some("27.0")),
        ("macos", "x86_64", Some("26.5.2")),
        ("linux", "aarch64", None),
    ] {
        let mut fixture = Fixture::new();
        let old_id = fixture.connect();
        let list = fixture.core.list_containers(&old_id).unwrap();
        fixture.core.host = Some(Ok(HostInfo {
            os: os.into(),
            architecture: architecture.into(),
            version: version.map(str::to_owned),
        }));
        let env = fixture.core.get_environment().unwrap();
        assert_eq!(env.status, "unsupported", "{env:?}");
        assert!(!env.mutation_allowed);
        assert!(env.session_id.is_none());
        assert!(env.diagnostics[0].contains(APPROVED_MACOS_VERSION));
        assert!(env.diagnostics[0].contains(architecture));
        assert_eq!(
            fixture
                .core
                .mutate_container(&old_id, &list.containers[0].handle, Action::Start)
                .unwrap_err()
                .code,
            "StaleSession"
        );
        assert_eq!(fixture.mutations(), 0);
    }
}

#[test]
fn host_detection_failures_never_grant_a_session() {
    let malformed = parse_macos_version(b"invalid host version").unwrap_err();
    for error in [
        ApiError::new(
            "StartFailed",
            "Cannot determine host macOS version: cannot start sw_vers",
        ),
        ApiError::new(
            "TimedOut",
            "Cannot determine host macOS version: command timed out",
        ),
        ApiError::new(
            "CommandFailed",
            "Cannot determine host macOS version: nonzero exit",
        ),
        malformed,
    ] {
        let mut fixture = Fixture::new();
        let reason = error.message.clone();
        fixture.core.host = Some(Err(error));
        let env = fixture.core.get_environment().unwrap();
        assert_eq!(env.status, "unavailable");
        assert!(!env.mutation_allowed);
        assert!(env.session_id.is_none());
        assert_eq!(env.diagnostics, vec![reason]);
        assert_eq!(fixture.mutations(), 0);
    }
    assert_eq!(
        validate_host(&HostInfo {
            os: "macos".into(),
            architecture: "aarch64".into(),
            version: None,
        })
        .unwrap_err()
        .code,
        "HostDetection"
    );
}

#[test]
fn default_core_detects_the_native_host() {
    let core = Core::default();
    assert!(core.host.is_none());
    let host = core.detect_host().unwrap();
    assert_eq!(host.os, std::env::consts::OS);
    assert_eq!(host.architecture, std::env::consts::ARCH);
    if host.os == "macos" && host.architecture == "aarch64" {
        let version = host.version.unwrap();
        assert_eq!(parse_macos_version(version.as_bytes()).unwrap(), version);
    }
}

#[test]
fn logs_are_plain_text_and_do_not_expose_stderr_as_error_on_success() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    let logs = fixture
        .core
        .get_recent_logs(&id, &list.containers[0].handle)
        .unwrap();
    assert!(logs.text.contains("hello red"));
    assert!(logs.text.contains("stderr log"));
    assert!(!logs.text.contains('\u{1b}'));
    assert!(logs.stderr.is_empty());
    assert_eq!(logs.generation, list.generation);
}

#[test]
fn complete_daemon_error_is_failed_but_transport_error_is_unknown() {
    for (mode, outcome) in [
        ("daemon_error", "failed"),
        ("transport_error", "resultUnknown"),
    ] {
        let fixture = Fixture::new();
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        fixture.mode(mode);
        let result = fixture
            .core
            .mutate_container(&id, &list.containers[0].handle, Action::Start)
            .unwrap();
        assert_eq!(result.outcome, outcome);
        assert_eq!(result.exit_code, Some(1));
        assert_eq!(result.reconciliation, "succeeded");
    }
}

/// Opt-in only. Creates one test-labeled container, then removes only its verified full ID.
#[test]
#[ignore = "Read-only live Colima probe; requires DOCKER2U_REAL_PROBE=1"]
fn real_environment_probe() {
    assert_eq!(std::env::var("DOCKER2U_REAL_PROBE").as_deref(), Ok("1"));
    let core = Core::default();
    let env = core.get_environment().unwrap();
    eprintln!("environment: {}", serde_json::to_string(&env).unwrap());
    assert_eq!(env.status, "ready", "{env:?}");
    assert!(env.mutation_allowed);
    let list = core
        .list_containers(env.session_id.as_deref().unwrap())
        .unwrap();
    eprintln!(
        "read-only list: {} containers, generation {}",
        list.containers.len(),
        list.generation
    );
}

/// Opt-in only. Creates one test-labeled container, then removes only its verified full ID.
#[test]
#[ignore = "Requires the prepared local Colima profile and DOCKER2U_REAL_SMOKE=1"]
fn real_runtime_smoke() {
    assert_eq!(std::env::var("DOCKER2U_REAL_SMOKE").as_deref(), Ok("1"));
    let core = Core::default();
    let env = core.get_environment().unwrap();
    eprintln!("environment: {}", serde_json::to_string(&env).unwrap());
    assert_eq!(env.status, "ready", "{env:?}");
    assert!(env.mutation_allowed);
    let session = core.active(env.session_id.as_deref().unwrap()).unwrap();
    let id = session.id.clone();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let label = format!("io.github.jgoneit.docker2u.smoke={nonce}");
    let name = format!("docker2u-smoke-{}", &nonce[..12]);
    core.docker(&session.target, &["image", "pull", "busybox:1.37.0"], 120)
        .unwrap();
    let created=core.docker(&session.target,&["container","create","--name",&name,"--label",&label,"--health-cmd","test -f /tmp/ready","--health-interval","1s","--health-timeout","1s","--health-retries","5","--stop-timeout","1","busybox:1.37.0","sh","-c","touch /tmp/ready; i=0; while [ $i -lt 400 ]; do echo Docker2U-smoke-$i; i=$((i+1)); done; echo stderr-smoke >&2; while :; do sleep 1; done"],30).unwrap();
    let full_id = String::from_utf8(created).unwrap().trim().to_owned();
    assert!(valid_id(&full_id));
    struct Cleanup {
        core: Core,
        target: Target,
        id: String,
        nonce: String,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let check = self.core.docker(
                &self.target,
                &[
                    "container",
                    "inspect",
                    "--format",
                    r#"{{index .Config.Labels "io.github.jgoneit.docker2u.smoke"}}"#,
                    &self.id,
                ],
                15,
            );
            if check
                .as_ref()
                .is_ok_and(|s| String::from_utf8_lossy(s).trim() == self.nonce)
            {
                let result =
                    self.core
                        .docker(&self.target, &["container", "rm", "--force", &self.id], 30);
                eprintln!(
                    "exact owned cleanup {}: {}",
                    self.id,
                    if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    }
                );
            }
        }
    }
    let cleanup = Cleanup {
        core: core.clone(),
        target: session.target.clone(),
        id: full_id.clone(),
        nonce,
    };
    let select = |list: ContainerList| {
        list.containers
            .into_iter()
            .find(|c| c.full_id == full_id)
            .expect("Owned smoke container missing")
    };
    let created = select(core.list_containers(&id).unwrap());
    assert_eq!(created.state, "created");
    assert_eq!(
        core.mutate_container(&id, &created.handle, Action::Start)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let mut running = select(core.list_containers(&id).unwrap());
    let wait = Instant::now();
    while running.health.as_deref() != Some("healthy") && wait.elapsed() < Duration::from_secs(15) {
        thread::sleep(Duration::from_millis(500));
        running = select(core.list_containers(&id).unwrap());
    }
    assert_eq!(running.health.as_deref(), Some("healthy"));
    let logs = core.get_recent_logs(&id, &running.handle).unwrap();
    assert!(logs.text.contains("Docker2U-smoke-399"));
    assert!(logs.text.contains("stderr-smoke"));
    assert!(!logs.text.contains("Docker2U-smoke-0\n"));
    assert_eq!(
        core.mutate_container(&id, &running.handle, Action::Stop)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let stopped = select(core.list_containers(&id).unwrap());
    assert_eq!(stopped.state, "exited");
    assert_eq!(
        core.mutate_container(&id, &stopped.handle, Action::Start)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let running = select(core.list_containers(&id).unwrap());
    assert_eq!(
        core.mutate_container(&id, &running.handle, Action::Restart)
            .unwrap()
            .outcome,
        "succeeded"
    );
    assert_eq!(select(core.list_containers(&id).unwrap()).state, "running");
    eprintln!(
        "real runtime: list, health, recent logs/tail 300, start, stop, restart passed for {full_id}"
    );
    drop(cleanup);
    assert!(
        core.docker(&session.target, &["container", "inspect", &full_id], 15)
            .is_err(),
        "Owned test container remains after cleanup"
    );
}
