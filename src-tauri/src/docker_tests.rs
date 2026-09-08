use super::*;
use std::{
    fs,
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    },
    thread,
    time::Instant,
};

#[path = "docker_bulk_tests.rs"]
mod bulk;
#[path = "docker_insights_tests.rs"]
mod insights;

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
        fs::create_dir_all(dir.join("docker-config")).unwrap();
        let socket = UnixListener::bind(dir.join("engine-A.sock")).unwrap();
        let path = dir.join("docker");
        fs::write(&path, FAKE).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            dir.join("docker-config/config.json"),
            r#"{"currentContext":"context-A"}"#,
        )
        .unwrap();
        let config = RuntimeConfig {
            docker_path: Some(dir.join("docker")),
            ..RuntimeConfig::default()
        };
        let launch_env = HashMap::from([
            ("HOME".into(), dir.to_string_lossy().into_owned()),
            (
                "DOCKER_CONFIG".into(),
                dir.join("docker-config").to_string_lossy().into_owned(),
            ),
        ]);
        Self {
            dir,
            core: Core {
                config: Some(config),
                launch_env: Some(launch_env),
                // Allow interpreter startup under the parallel process suite;
                // timeout fixtures then block for ten seconds deterministically.
                mutation_timeout: Some(Duration::from_secs(2)),
                host: Some(Ok(HostInfo {
                    os: "macos".into(),
                    architecture: "aarch64".into(),
                    version: Some("26.6.2".into()),
                })),
                ..Core::default()
            },
            _socket: socket,
        }
    }
    fn mode(&self, mode: &str) {
        fs::write(self.dir.join("mode"), mode).unwrap();
    }
    fn endpoint(&self, engine: &str) -> String {
        format!(
            "unix://{}",
            self.dir.join(format!("engine-{engine}.sock")).display()
        )
    }
    fn choose(&self, context: &str) {
        fs::write(
            self.dir.join("docker-config/config.json"),
            serde_json::to_vec(&serde_json::json!({"currentContext": context})).unwrap(),
        )
        .unwrap();
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
with (p/'trace').open('a') as f: f.write(json.dumps({'cli':Path(__file__).name,'args':a,'env':{k:v for k,v in os.environ.items() if k.startswith('DOCKER_') or k in ['COLIMA_HOME','LIMA_HOME']}})+'\n')
if a==['--version']:
    print('Docker version '+('30.0.0' if mode=='client_changed' else '29.8.0')+', build fake');sys.exit()
if a==['context','inspect']:
    if mode=='context_fail': print('selected context unavailable',file=sys.stderr);sys.exit(1)
    if mode=='context_warning': print('WARNING: invalid config; using defaults',file=sys.stderr)
    if mode=='context_malformed': print('{');sys.exit()
    config=Path(os.environ['DOCKER_CONFIG'])/'config.json'
    stored=json.loads(config.read_text()).get('currentContext','context-A') if config.exists() else 'context-A'
    context=os.environ.get('DOCKER_CONTEXT',stored)
    endpoint='unix://'+str(p/('engine-B.sock' if context=='context-B' else 'engine-A.sock'))
    if os.environ.get('DOCKER_HOST'): context='default';endpoint=os.environ['DOCKER_HOST']
    if (p/'endpoint').exists(): endpoint=(p/'endpoint').read_text()
    if mode=='remote': endpoint='tcp://evil.example:2375'
    result=[{'Name':context,'Endpoints':{'docker':{'Host':endpoint}}}]
    if mode=='context_multiple': result*=2
    if mode=='context_no_name': del result[0]['Name']
    print(json.dumps(result));sys.exit()
assert a[0]=='--host', repr(a)
endpoint=a[1]
assert endpoint in ['unix://'+str(p/'engine-A.sock'),'unix://'+str(p/'engine-B.sock')], repr(a)
a=a[2:]
if a[0]=='info':
    if mode=='held_info':
        (p/'verifying').write_text('1')
        deadline=time.monotonic()+10
        while not (p/'release-info').exists():
            if time.monotonic()>deadline: sys.exit(1)
            time.sleep(.005)
    if mode=='connection_fail': print('connection reset by peer',file=sys.stderr);sys.exit(1)
    if mode=='permission_denied': print('permission denied while connecting to Docker socket',file=sys.stderr);sys.exit(1)
    print(json.dumps({'ID':'' if mode=='empty_engine_id' else ('changed' if mode=='engine_changed' else ('engine-B' if endpoint.endswith('engine-B.sock') else 'engine-A')),'OSType':'windows' if mode=='windows_engine' else 'linux','Architecture':'amd64','Name':'arbitrary-compatible-engine'}));sys.exit()
if a[0]=='version':
    print(json.dumps({'Client':{'Version':'29.8.0','ApiVersion':'1.54'},'Server':{'Version':'30.0.0' if mode=='server_changed' else '29.5.2','ApiVersion':'bad' if mode=='bad_api' else '1.54'}}));sys.exit()
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
        print(json.dumps({'Id':'f'*64 if mode=='wrong_id' else ident,'Name':"/test;$(touch forbidden)",'Image':'busybox:test','Created':'2026-09-05T08:00:00Z','State':states.get(ident,state),'Health':None,'Ports':None,'ComposeProject':'team-dev' if mode=='compose' else None,'ComposeService':'api' if mode=='compose' else None}))
    sys.exit()
if a[1]=='logs':
    sys.stdout.write('hello\x1b[31m red\x1b[0m\n');sys.stdout.flush()
    sys.stderr.write('stderr log\n');sys.stderr.flush()
    if '--follow' in a:
        (p/'following').write_text(str(os.getpid()))
        while True: time.sleep(.05)
    sys.exit()
if a[1]=='stats':
    assert a[2:6]==['--no-stream','--no-trunc','--format','{{json .}}'], repr(a)
    assert len(a)>6
    if mode=='held_stats':
        (p/'sampling').write_text('1')
        deadline=time.monotonic()+10
        while not (p/'release-stats').exists():
            if time.monotonic()>deadline: sys.exit(1)
            time.sleep(.005)
    if mode=='stats_fail': print('container disappeared',file=sys.stderr);sys.exit(1)
    if mode=='stats_missing': sys.exit()
    for ident in a[6:]:
        row=json.dumps({'ID':'f'*64 if mode=='wrong_stats_id' else ident,'CPUPerc':'250.25%','MemUsage':'12.5MiB / 2GiB','MemPerc':'0.61%'})
        print(row)
        if mode=='duplicate_stats_id': print(row)
    sys.exit()
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
    let mut fixture = Fixture::new();
    fixture.core.config.as_mut().unwrap().docker_path = Some("/nonexistent/docker2u-docker".into());
    let env = fixture.core.get_environment().unwrap();
    assert_eq!(env.status, "unavailable");
    assert!(!env.mutation_allowed);
    assert!(env.session_id.is_none());
    assert_eq!(env.error.unwrap().code, "CliNotFound");
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
fn discovery_preserves_cli_inputs_but_engine_calls_strip_target_tls_and_api_overrides() {
    let mut fixture = Fixture::new();
    let endpoint = fixture.endpoint("A");
    let config_path = fixture
        .dir
        .join("docker-config")
        .to_string_lossy()
        .into_owned();
    let inputs = [
        ("DOCKER_HOST", endpoint.as_str()),
        ("DOCKER_CONTEXT", "context-B"),
        ("DOCKER_TLS", "1"),
        ("DOCKER_TLS_VERIFY", "1"),
        ("DOCKER_CERT_PATH", "/not-used-for-local-engine"),
        ("DOCKER_API_VERSION", "1.01"),
        ("DOCKER_CLI_PLUGIN_EXTRA_DIRS", "/not-used-plugins"),
        ("COLIMA_HOME", "/not-used-colima"),
        ("LIMA_HOME", "/not-used-lima"),
    ];
    for (key, value) in inputs {
        fixture
            .core
            .launch_env
            .as_mut()
            .unwrap()
            .insert(key.into(), value.into());
    }
    let env = fixture.core.get_environment().unwrap();
    assert_eq!(env.status, "ready", "{env:?}");
    assert_eq!(env.context_name.as_deref(), Some("default"));
    assert_eq!(env.endpoint.as_deref(), Some(endpoint.as_str()));
    let id = env.session_id.unwrap();
    let list = fixture.core.list_containers(&id).unwrap();
    fixture
        .core
        .get_recent_logs(&id, &list.containers[0].handle)
        .unwrap();
    fixture
        .core
        .mutate_container(&id, &list.containers[0].handle, Action::Start)
        .unwrap();
    let trace = fixture.trace();
    let discovery: Vec<_> = trace
        .iter()
        .filter(|r| r["args"] == serde_json::json!(["context", "inspect"]))
        .collect();
    assert_eq!(discovery.len(), 1);
    for (key, value) in &inputs[..5] {
        assert_eq!(discovery[0]["env"][key], *value);
    }
    for row in trace.iter().filter(|r| r["args"][0] == "--host") {
        assert_eq!(row["args"][1], endpoint);
        assert_eq!(row["env"]["DOCKER_CONFIG"], config_path);
        for (key, _) in inputs {
            assert!(row["env"].get(key).is_none(), "{key} leaked into {row}");
        }
    }
}

#[test]
fn stored_context_and_each_launch_override_are_left_to_cli_selection() {
    for (context, use_host, expected_context, engine) in [
        (None, false, "context-A", "A"),
        (Some("context-B"), false, "context-B", "B"),
        (None, true, "default", "B"),
        (Some("context-A"), true, "default", "B"),
        (Some("default"), false, "default", "A"),
    ] {
        let mut fixture = Fixture::new();
        let _second_socket = UnixListener::bind(fixture.dir.join("engine-B.sock")).unwrap();
        if let Some(context) = context {
            fixture
                .core
                .launch_env
                .as_mut()
                .unwrap()
                .insert("DOCKER_CONTEXT".into(), context.into());
        }
        if use_host {
            let endpoint = fixture.endpoint("B");
            fixture
                .core
                .launch_env
                .as_mut()
                .unwrap()
                .insert("DOCKER_HOST".into(), endpoint);
        }
        let env = fixture.core.get_environment().unwrap();
        assert_eq!(env.status, "ready", "{env:?}");
        assert_eq!(env.context_name.as_deref(), Some(expected_context));
        assert_eq!(env.endpoint, Some(fixture.endpoint(engine)));
        let contexts: Vec<_> = fixture
            .trace()
            .into_iter()
            .filter(|r| r["args"][0] == "context")
            .collect();
        assert_eq!(contexts.len(), 1);
        assert_eq!(
            contexts[0]["args"],
            serde_json::json!(["context", "inspect"])
        );
    }
}

#[test]
fn absent_user_config_is_allowed_without_creating_a_directory() {
    let mut fixture = Fixture::new();
    fixture
        .core
        .launch_env
        .as_mut()
        .unwrap()
        .remove("DOCKER_CONFIG");
    let expected = fixture.dir.join(".docker");
    let environment = fixture.core.get_environment().unwrap();
    assert_eq!(environment.status, "ready", "{environment:?}");
    assert_eq!(environment.docker_config_path.as_deref(), expected.to_str());
    assert!(!expected.exists());
}

#[test]
fn selected_context_and_config_are_resolved_once_until_reconnect() {
    let fixture = Fixture::new();
    let _second_socket = UnixListener::bind(fixture.dir.join("engine-B.sock")).unwrap();
    let id = fixture.connect();
    let first = fixture.core.list_containers(&id).unwrap();
    fixture.choose("context-B");
    let refreshed = fixture.core.list_containers(&id).unwrap();
    fixture
        .core
        .get_recent_logs(&id, &refreshed.containers[0].handle)
        .unwrap();
    let single = fixture
        .core
        .mutate_container(&id, &refreshed.containers[0].handle, Action::Start)
        .unwrap();
    assert_eq!(single.outcome, "succeeded");
    assert_eq!(
        fixture.core.active(&id).unwrap().target.fingerprint.id,
        "engine-A"
    );
    let next = fixture.core.list_containers(&id).unwrap();
    let batch = fixture
        .core
        .mutate_containers(
            &id,
            next.generation,
            &[next.containers[0].handle.clone()],
            Action::Stop,
        )
        .unwrap();
    assert_eq!(batch.items[0].outcome, "succeeded");
    let trace = fixture.trace();
    assert_eq!(
        trace
            .iter()
            .filter(|r| r["args"] == serde_json::json!(["context", "inspect"]))
            .count(),
        1
    );
    assert!(
        trace
            .iter()
            .filter(|r| r["args"][0] == "--host")
            .all(|r| r["args"][1] == fixture.endpoint("A"))
    );
    let boundary = trace.len();
    let environment = fixture.core.get_environment().unwrap();
    assert_eq!(environment.context_name.as_deref(), Some("context-B"));
    assert_eq!(environment.engine_id.as_deref(), Some("engine-B"));
    let new_id = environment.session_id.unwrap();
    let replacement = fixture.core.list_containers(&new_id).unwrap();
    assert_eq!(
        replacement.containers[0].full_id,
        first.containers[0].full_id
    );
    assert_ne!(replacement.containers[0].handle, first.containers[0].handle);
    assert_eq!(
        fixture.core.list_containers(&id).unwrap_err().code,
        "StaleSession"
    );
    assert_eq!(
        fixture
            .core
            .mutate_container(&new_id, &first.containers[0].handle, Action::Start)
            .unwrap_err()
            .code,
        "StaleHandle"
    );
    assert!(
        fixture.trace()[boundary..]
            .iter()
            .filter(|r| r["args"][0] == "--host")
            .all(|r| r["args"][1] == fixture.endpoint("B"))
    );
}

#[test]
fn deleted_context_settings_do_not_reselect_an_active_engine() {
    let fixture = Fixture::new();
    let id = fixture.connect();
    fs::remove_file(fixture.dir.join("docker-config/config.json")).unwrap();
    fixture.mode("context_fail");
    let list = fixture.core.list_containers(&id).unwrap();
    fixture
        .core
        .get_recent_logs(&id, &list.containers[0].handle)
        .unwrap();
    assert_eq!(
        fixture
            .core
            .mutate_container(&id, &list.containers[0].handle, Action::Start)
            .unwrap()
            .outcome,
        "succeeded"
    );
    let env = fixture.core.get_environment().unwrap();
    assert!(env.session_id.is_none());
    assert_eq!(env.error.unwrap().code, "ContextSelection");
    assert_eq!(
        fixture.core.list_containers(&id).unwrap_err().code,
        "StaleSession"
    );
}

#[test]
fn obsolete_runtime_paths_are_ignored_without_rewriting_any_config() {
    let mut fixture = Fixture::new();
    let missing = fixture.dir.join("never-created");
    let legacy = serde_json::json!({"dockerPath": fixture.dir.join("docker"), "dockerConfig":missing, "colimaPath":missing, "colimaHome":missing, "limaHome":missing});
    fixture.core.config = Some(serde_json::from_value(legacy.clone()).unwrap());
    let runtime_path = fixture.dir.join("runtime.json");
    let runtime_bytes = serde_json::to_vec(&legacy).unwrap();
    fs::write(&runtime_path, &runtime_bytes).unwrap();
    let config_path = fixture.dir.join("docker-config/config.json");
    let config_bytes = fs::read(&config_path).unwrap();
    let env = fixture.core.get_environment().unwrap();
    assert_eq!(env.status, "ready", "{env:?}");
    assert_eq!(
        env.docker_config_path.as_deref(),
        fixture.dir.join("docker-config").to_str()
    );
    for key in ["dockerConfig", "colimaPath", "colimaHome", "limaHome"] {
        assert!(
            env.diagnostics.iter().any(|message| message.contains(key)),
            "{env:?}"
        );
    }
    assert_eq!(fs::read(runtime_path).unwrap(), runtime_bytes);
    assert_eq!(fs::read(config_path).unwrap(), config_bytes);
    assert!(!missing.exists());
}

#[test]
fn malformed_docker_config_and_context_responses_never_reach_the_engine() {
    for bytes in [b"{".as_slice(), b"[]", b"null"] {
        let fixture = Fixture::new();
        let path = fixture.dir.join("docker-config/config.json");
        fs::write(&path, bytes).unwrap();
        let env = fixture.core.get_environment().unwrap();
        assert!(env.session_id.is_none(), "{env:?}");
        assert!(env.error.is_some());
        assert!(fixture.trace().iter().all(|r| r["args"][0] != "--host"));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    for mode in [
        "context_fail",
        "context_warning",
        "context_malformed",
        "context_multiple",
        "context_no_name",
    ] {
        let fixture = Fixture::new();
        fixture.mode(mode);
        let env = fixture.core.get_environment().unwrap();
        assert!(env.session_id.is_none(), "{mode}: {env:?}");
        assert!(env.error.is_some());
        assert!(fixture.trace().iter().all(|r| r["args"][0] != "--host"));
        assert_eq!(
            fixture
                .trace()
                .iter()
                .filter(|r| r["args"] == serde_json::json!(["context", "inspect"]))
                .count(),
            1
        );
    }
}

#[test]
fn broken_symlinks_and_non_regular_config_files_fail_before_any_cli_call() {
    for kind in ["directory_symlink", "file_symlink", "fifo", "directory"] {
        let mut fixture = Fixture::new();
        let config = fixture.dir.join("docker-config/config.json");
        match kind {
            "directory_symlink" => {
                let alias = fixture.dir.join("missing-config-directory");
                symlink(fixture.dir.join("nonexistent"), &alias).unwrap();
                fixture
                    .core
                    .launch_env
                    .as_mut()
                    .unwrap()
                    .insert("DOCKER_CONFIG".into(), alias.to_string_lossy().into_owned());
            }
            "file_symlink" => {
                fs::remove_file(&config).unwrap();
                symlink(fixture.dir.join("nonexistent.json"), &config).unwrap();
            }
            "fifo" => {
                fs::remove_file(&config).unwrap();
                let path = std::ffi::CString::new(config.to_str().unwrap()).unwrap();
                // SAFETY: path is an owned, NUL-terminated fixture path and the
                // permissions apply only to this newly created named pipe.
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            }
            "directory" => {
                fs::remove_file(&config).unwrap();
                fs::create_dir(&config).unwrap();
            }
            _ => unreachable!(),
        }
        let started = Instant::now();
        let environment = fixture.core.get_environment().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2), "{kind} blocked");
        assert!(environment.session_id.is_none(), "{kind}: {environment:?}");
        assert!(!environment.mutation_allowed);
        assert_eq!(environment.error.unwrap().code, "Configuration", "{kind}");
        assert!(fixture.trace().is_empty(), "{kind} reached the Docker CLI");
    }
    // Filesystem permission failures must keep their actionable classification,
    // independently of the process error/stderr classification covered above.
    assert_eq!(
        filesystem_error(
            "Configuration",
            "Docker config.json",
            std::io::Error::from_raw_os_error(libc::EACCES),
        )
        .code,
        "PermissionDenied"
    );
}

#[test]
fn endpoint_must_be_an_absolute_existing_unix_socket() {
    for endpoint in [
        "unix://relative.sock",
        "ssh://some-host",
        "tcp://localhost:2375",
        "unix:///nonexistent/docker2u.sock",
    ] {
        let fixture = Fixture::new();
        fs::write(fixture.dir.join("endpoint"), endpoint).unwrap();
        let env = fixture.core.get_environment().unwrap();
        assert!(env.session_id.is_none(), "{env:?}");
        assert!(!env.mutation_allowed);
        assert!(fixture.trace().iter().all(|r| r["args"][0] != "--host"));
    }
    let fixture = Fixture::new();
    let regular = fixture.dir.join("regular-file");
    fs::write(&regular, "not a socket").unwrap();
    fs::write(
        fixture.dir.join("endpoint"),
        format!("unix://{}", regular.display()),
    )
    .unwrap();
    let env = fixture.core.get_environment().unwrap();
    assert!(env.session_id.is_none());
    assert!(fixture.trace().iter().all(|r| r["args"][0] != "--host"));
}

#[test]
fn socket_symlink_reselection_cannot_move_the_pinned_session() {
    let fixture = Fixture::new();
    let _second_socket = UnixListener::bind(fixture.dir.join("engine-B.sock")).unwrap();
    let alias = fixture.dir.join("selected.sock");
    symlink(fixture.dir.join("engine-A.sock"), &alias).unwrap();
    fs::write(
        fixture.dir.join("endpoint"),
        format!("unix://{}", alias.display()),
    )
    .unwrap();
    let id = fixture.connect();
    fs::remove_file(&alias).unwrap();
    symlink(fixture.dir.join("engine-B.sock"), &alias).unwrap();
    fixture.core.list_containers(&id).unwrap();
    assert_eq!(
        fixture.core.active(&id).unwrap().target.endpoint,
        fixture.endpoint("A")
    );
    let new_id = fixture.connect();
    assert_eq!(
        fixture.core.active(&new_id).unwrap().target.endpoint,
        fixture.endpoint("B")
    );
}

#[test]
fn missing_pinned_socket_and_upgraded_cli_or_engine_require_reconnect() {
    for mode in ["client_changed", "server_changed"] {
        let fixture = Fixture::new();
        let id = fixture.connect();
        let list = fixture.core.list_containers(&id).unwrap();
        fixture.mode(mode);
        assert_eq!(
            fixture
                .core
                .mutate_container(&id, &list.containers[0].handle, Action::Start)
                .unwrap_err()
                .code,
            "EnvironmentChanged"
        );
        assert_eq!(fixture.mutations(), 0);
        let new_id = fixture.connect();
        assert_ne!(new_id, id);
        assert!(!fixture.core.active(&new_id).unwrap().needs_validation);
    }
    let fixture = Fixture::new();
    let id = fixture.connect();
    let list = fixture.core.list_containers(&id).unwrap();
    fs::remove_file(fixture.dir.join("engine-A.sock")).unwrap();
    assert!(
        fixture
            .core
            .mutate_container(&id, &list.containers[0].handle, Action::Start)
            .is_err()
    );
    assert_eq!(fixture.mutations(), 0);
    assert!(fixture.core.active(&id).unwrap().needs_validation);
}

#[test]
fn incompatible_engine_responses_never_grant_a_mutation_session() {
    for mode in [
        "windows_engine",
        "empty_engine_id",
        "bad_api",
        "connection_fail",
        "permission_denied",
    ] {
        let fixture = Fixture::new();
        fixture.mode(mode);
        let env = fixture.core.get_environment().unwrap();
        assert!(env.session_id.is_none(), "{mode}: {env:?}");
        assert!(!env.mutation_allowed);
        let error = env.error.unwrap();
        if mode == "permission_denied" {
            assert_eq!(error.code, "PermissionDenied");
        }
        if mode == "connection_fail" {
            assert_eq!(error.stderr.as_deref(), Some("connection reset by peer\n"));
            assert!(error.command.unwrap().contains("info"));
        }
        assert_eq!(fixture.mutations(), 0);
    }
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
    for version in ["14.0", "15.0", "26.5.1", "26.5.3", "26.6.2", "27.0"] {
        let mut fixture = Fixture::new();
        fixture
            .core
            .host
            .as_mut()
            .unwrap()
            .as_mut()
            .unwrap()
            .version = Some(version.into());
        let env = fixture.core.get_environment().unwrap();
        assert_eq!(env.status, "ready", "{version}: {env:?}");
        assert!(env.mutation_allowed);
        assert!(env.session_id.is_some());
        assert_eq!(fixture.mutations(), 0);
    }
}

#[test]
fn unapproved_hosts_cannot_replace_an_active_session() {
    for (os, architecture, version) in [
        ("macos", "aarch64", Some("13.6.9")),
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
        assert!(env.error.as_ref().unwrap().message.contains("14"));
        assert!(env.error.as_ref().unwrap().message.contains(architecture));
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
        assert_eq!(env.error.as_ref().unwrap().message, reason);
        assert!(env.diagnostics.is_empty());
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
fn log_identity_or_socket_failure_requires_reconnect_after_successful_refresh() {
    for expected_code in ["EnvironmentChanged", "SocketMissing"] {
        let fixture = Fixture::new();
        let id = fixture.connect();
        let first = fixture.core.list_containers(&id).unwrap();
        let socket_path = fixture.dir.join("engine-A.sock");
        if expected_code == "EnvironmentChanged" {
            fixture.mode("engine_changed");
        } else {
            fs::remove_file(&socket_path).unwrap();
        }
        assert_eq!(
            fixture
                .core
                .get_recent_logs(&id, &first.containers[0].handle)
                .unwrap_err()
                .code,
            expected_code
        );
        let failed = fixture.core.active(&id).unwrap();
        assert!(failed.stale);
        assert!(failed.needs_validation);
        fixture.mode("");
        // Keep the replacement socket alive through the refresh/reconnect checks.
        let _replacement_socket =
            (expected_code == "SocketMissing").then(|| UnixListener::bind(&socket_path).unwrap());
        let refreshed = fixture.core.list_containers(&id).unwrap();
        assert_eq!(
            fixture
                .core
                .mutate_container(&id, &refreshed.containers[0].handle, Action::Start)
                .unwrap_err()
                .code,
            "NeedsValidation"
        );
        assert_eq!(fixture.mutations(), 0);
        let new_id = fixture.connect();
        let reconnected = fixture.core.list_containers(&new_id).unwrap();
        assert_eq!(
            fixture
                .core
                .mutate_container(&new_id, &reconnected.containers[0].handle, Action::Start)
                .unwrap()
                .outcome,
            "succeeded"
        );
        assert_eq!(fixture.mutations(), 1);
    }
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

/// Opt-in read-only comparison against CLI IDs on the selected, pinned Engine.
#[test]
#[ignore = "Read-only live Docker probe; requires DOCKER2U_REAL_PROBE=1"]
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
    let session = core.active(env.session_id.as_deref().unwrap()).unwrap();
    let cli = core
        .docker(
            &session.target,
            &["container", "ls", "--all", "--quiet", "--no-trunc"],
            15,
        )
        .unwrap();
    let cli_ids: HashSet<_> = String::from_utf8(cli)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert!(cli_ids.iter().all(|id| valid_id(id)));
    let app_ids: HashSet<_> = list
        .containers
        .iter()
        .map(|container| container.full_id.clone())
        .collect();
    assert_eq!(app_ids, cli_ids, "App and pinned CLI full ID sets differ");
    eprintln!(
        "read-only list: {} containers, generation {}",
        list.containers.len(),
        list.generation
    );
}

/// Opt-in only. Creates one test-labeled container, then removes only its verified full ID.
#[test]
#[ignore = "Requires a running local Docker Engine and DOCKER2U_REAL_SMOKE=1"]
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
    let remaining = core.list_containers(&id).unwrap();
    assert!(
        remaining
            .containers
            .iter()
            .all(|container| container.full_id != full_id),
        "Owned test container remains after cleanup"
    );
}
