//! Process contract tests use only uniquely owned files and child process groups.
use crate::process::{LOG_LIMIT, Runner, STDERR_LIMIT, STDOUT_LIMIT, plain_text};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    root: PathBuf,
    executable: PathBuf,
}

impl Fixture {
    fn new(script: &str) -> Self {
        let root = std::env::temp_dir().join(format!("docker2u-process-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let executable = root.join("fake docker cli");
        fs::write(&executable, format!("#!/bin/sh\nset -eu\n{script}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root, executable }
    }

    fn args(&self) -> Vec<String> {
        vec![self.root.to_string_lossy().into_owned()]
    }

    fn pid(&self, name: &str) -> i32 {
        let path = self.root.join(name);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "child never wrote {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // A failed assertion must still clean up only this fixture's process group.
        if let Ok(text) = fs::read_to_string(self.root.join("parent.pid")) {
            if let Ok(pid) = text.trim().parse::<i32>() {
                // SAFETY: this PID was written by our unique fake executable, and
                // getpgid verifies it is still the group leader we created.
                unsafe {
                    if libc::getpgid(pid) == pid {
                        libc::kill(-pid, libc::SIGKILL);
                    }
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_gone(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        // SAFETY: signal 0 only probes a PID returned by an owned test process.
        if unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned child {pid} remains after cleanup"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn preserves_literal_arguments_without_shell_interpretation() {
    let fixture = Fixture::new("printf '%s\\0' \"$@\"");
    let marker = fixture.root.join("must not exist");
    let args = vec![
        "name with spaces".to_owned(),
        format!("$(touch '{}')", marker.display()),
        "; echo injected".to_owned(),
        "`echo injected`".to_owned(),
        "한글 * ? $HOME".to_owned(),
    ];
    let out = Runner::default()
        .run(
            &fixture.executable,
            &args,
            &[],
            Duration::from_secs(5),
            false,
        )
        .unwrap();
    let expected: Vec<u8> = args.iter().flat_map(|arg| arg.bytes().chain([0])).collect();
    assert_eq!(out.code, Some(0));
    assert_eq!(out.stdout, expected);
    assert!(!out.interrupted);
    assert!(!marker.exists(), "a literal argument was executed");
}

#[test]
fn removes_ambient_docker_target_tls_api_and_provider_overrides() {
    // A separate test process supplies ambient values, avoiding mutation of the
    // multithreaded test runner's environment (unsafe in Rust 2024).
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "process_tests::ambient_environment_probe",
            "--nocapture",
        ])
        .env("DOCKER2U_PROCESS_ENV_PROBE", "1")
        .env("DOCKER_HOST", "tcp://hostile.example:2375")
        .env("DOCKER_CONTEXT", "hostile")
        .env("DOCKER_API_VERSION", "1.01")
        .env("DOCKER_TLS", "1")
        .env("DOCKER_TLS_VERIFY", "1")
        .env("DOCKER_CERT_PATH", "/hostile/certificates")
        .env("DOCKER_CONFIG", "/hostile/config")
        .env("DOCKER_CLI_PLUGIN_EXTRA_DIRS", "/hostile/plugins")
        .env("COLIMA_HOME", "/hostile/colima")
        .env("LIMA_HOME", "/hostile/lima")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("ambient overrides stripped"));
}

#[test]
fn ambient_environment_probe() {
    if std::env::var_os("DOCKER2U_PROCESS_ENV_PROBE").is_none() {
        return;
    }
    let fixture = Fixture::new(
        "for key in DOCKER_HOST DOCKER_CONTEXT DOCKER_API_VERSION DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_CLI_PLUGIN_EXTRA_DIRS; do\n  if /usr/bin/printenv \"$key\" >/dev/null; then exit 71; fi\ndone\nprintf '%s\\n' \"$DOCKER_CONFIG\" \"$COLIMA_HOME\" \"$LIMA_HOME\"",
    );
    let env = vec![
        (
            "DOCKER_CONFIG".to_owned(),
            "/approved/private-config".to_owned(),
        ),
        ("COLIMA_HOME".to_owned(), "/approved/colima".to_owned()),
        ("LIMA_HOME".to_owned(), "/approved/lima".to_owned()),
    ];
    let out = Runner::default()
        .run(
            &fixture.executable,
            &[],
            &env,
            Duration::from_secs(5),
            false,
        )
        .unwrap();
    assert_eq!(
        out.code,
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        b"/approved/private-config\n/approved/colima\n/approved/lima\n"
    );
    println!("ambient overrides stripped");
}

#[test]
fn drains_stdout_and_stderr_concurrently_beyond_pipe_capacity() {
    let fixture = Fixture::new(
        "/bin/dd if=/dev/zero bs=65536 count=2 2>/dev/null &\n(/bin/dd if=/dev/zero bs=65536 count=2 2>/dev/null) >&2 &\nwait",
    );
    let out = Runner::default()
        .run(&fixture.executable, &[], &[], Duration::from_secs(5), false)
        .unwrap();
    assert_eq!(out.code, Some(0));
    assert!(!out.interrupted);
    assert!(!out.truncated);
    assert_eq!(out.stdout.len(), 131_072);
    assert_eq!(out.stderr.len(), 131_072);
}

#[test]
fn bounds_structured_capture_and_keeps_draining_until_exit() {
    let fixture = Fixture::new(
        "/bin/dd if=/dev/zero bs=1048576 count=9 2>/dev/null &\n(/bin/dd if=/dev/zero bs=262144 count=2 2>/dev/null) >&2 &\nwait\nexit 23",
    );
    let out = Runner::default()
        .run(&fixture.executable, &[], &[], Duration::from_secs(8), false)
        .unwrap();
    assert_eq!(out.code, Some(23));
    assert_eq!(out.stdout.len(), STDOUT_LIMIT);
    assert_eq!(out.stderr.len(), STDERR_LIMIT);
    assert!(out.truncated);
    assert!(!out.interrupted);
    assert!(out.logs.is_empty());
}

#[test]
fn logs_keep_the_last_two_mib_from_both_streams() {
    let fixture = Fixture::new(
        "printf 'old-prefix-must-disappear'\n/bin/dd if=/dev/zero bs=1048576 count=3 2>/dev/null\nprintf 'recent-stdout-tail'\nprintf 'recent-stderr-tail' >&2",
    );
    let out = Runner::default()
        .run(&fixture.executable, &[], &[], Duration::from_secs(8), true)
        .unwrap();
    assert_eq!(out.code, Some(0));
    assert_eq!(out.logs.len(), LOG_LIMIT);
    assert!(out.truncated);
    assert!(out.stdout.is_empty());
    let text = String::from_utf8_lossy(&out.logs);
    assert!(!text.contains("old-prefix-must-disappear"));
    assert!(text.contains("recent-stdout-tail"));
    assert!(text.contains("recent-stderr-tail"));
}

const RESISTS_TERM: &str = "trap '' TERM\necho $$ > \"$1/parent.pid\"\n/bin/sh -c 'trap \"\" TERM; echo $$ > \"$1/descendant.pid\"; while :; do /bin/sleep 1; done' _ \"$1\" &\nwait";

#[test]
fn timeout_kills_term_resistant_child_and_descendant_group() {
    let fixture = Fixture::new(RESISTS_TERM);
    let started = Instant::now();
    let out = Runner::default()
        .run(
            &fixture.executable,
            &fixture.args(),
            &[],
            // Allow executable initialization under the full parallel test suite
            // before exercising the timeout and two-second termination grace.
            Duration::from_secs(2),
            false,
        )
        .unwrap();
    assert!(out.interrupted);
    assert_eq!(out.code, None);
    assert!(out.duration_ms >= 2_000);
    assert!(started.elapsed() < Duration::from_secs(6));
    assert_gone(fixture.pid("parent.pid"));
    assert_gone(fixture.pid("descendant.pid"));
}

#[test]
fn parent_exit_does_not_leave_descendant_holding_pipes_open() {
    let fixture = Fixture::new(
        "echo $$ > \"$1/parent.pid\"\n/bin/sh -c 'echo $$ > \"$1/descendant.pid\"; exec /bin/sleep 30' _ \"$1\" &\nwhile [ ! -s \"$1/descendant.pid\" ]; do /bin/sleep 0.01; done\nexit 0",
    );
    let started = Instant::now();
    let out = Runner::default()
        .run(
            &fixture.executable,
            &fixture.args(),
            &[],
            Duration::from_secs(5),
            false,
        )
        .unwrap();
    assert_eq!(out.code, Some(0));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_gone(fixture.pid("descendant.pid"));
}

#[test]
fn shutdown_interrupts_owned_work_and_rejects_new_children() {
    let fixture = Fixture::new(RESISTS_TERM);
    let runner = Runner::default();
    let worker_runner = runner.clone();
    let executable = fixture.executable.clone();
    let args = fixture.args();
    let worker = thread::spawn(move || {
        worker_runner.run(&executable, &args, &[], Duration::from_secs(30), false)
    });
    let parent = fixture.pid("parent.pid");
    let descendant = fixture.pid("descendant.pid");
    let shutdown_started = Instant::now();
    runner.shutdown();
    assert!(shutdown_started.elapsed() >= Duration::from_millis(1_800));
    assert!(shutdown_started.elapsed() < Duration::from_secs(6));
    assert!(
        runner
            .run(
                Path::new("/usr/bin/true"),
                &[],
                &[],
                Duration::from_secs(1),
                false
            )
            .is_err()
    );
    assert_gone(parent);
    assert_gone(descendant);
    let out = worker.join().unwrap().unwrap();
    assert!(out.interrupted);
    assert_eq!(out.code, None);
}

#[test]
fn strips_terminal_controls_and_bounds_lossy_utf8_on_character_boundaries() {
    assert_eq!(
        plain_text(b"\x1b[31mred\x1b[0m\x1b]0;title\x07\0\x07\x7f\tline\n", 100),
        "red\tline\n"
    );
    assert_eq!(plain_text(b"a\x1b]0;title\x1b\\b", 100), "ab");
    assert_eq!(plain_text("prefix가나다".as_bytes(), 7), "나다");
    assert_eq!(plain_text(&[0xff, b'x'], 3), "x");
    assert_eq!(plain_text("가".as_bytes(), 0), "");
}
