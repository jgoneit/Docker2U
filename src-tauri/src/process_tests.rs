//! Process contract tests use only uniquely owned files and child process groups.
use crate::process::{
    FollowProcess, FollowRead, LOG_LIMIT, Output, ProcessOptions, Runner, STDERR_LIMIT,
    STDOUT_LIMIT, plain_text,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
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
fn structured_capture_budget_is_shared_across_stdout_and_stderr() {
    let fixture = Fixture::new(
        "/bin/dd if=/dev/zero bs=65536 count=2 2>/dev/null &\n(/bin/dd if=/dev/zero bs=65536 count=2 2>/dev/null) >&2 &\nwait\nexit 23",
    );
    for limit in [0, 17, 100_000] {
        let options = ProcessOptions {
            capture_limit: Some(limit),
            deadline: Some(Instant::now() + Duration::from_secs(5)),
            ..ProcessOptions::default()
        };
        let output = Runner::default()
            .run_with_options(&fixture.executable, &[], &[], &options, false)
            .unwrap();
        assert_eq!(
            output.code,
            Some(23),
            "capture must keep draining after the budget is exhausted"
        );
        assert_eq!(output.stdout.len() + output.stderr.len(), limit);
        assert!(output.truncated && !output.interrupted);
        assert!(output.logs.is_empty());
    }
}

#[test]
fn structured_capture_budget_carries_only_remaining_bytes_to_the_next_call() {
    let first = Fixture::new("printf '123'\nprintf '45' >&2");
    let second = Fixture::new("printf 'abcdef'\nprintf 'ghijkl' >&2");
    let mut remaining = 8;
    let mut retained = 0;
    let runner = Runner::default();
    for (index, fixture) in [first, second].iter().enumerate() {
        let options = ProcessOptions {
            capture_limit: Some(remaining),
            deadline: Some(Instant::now() + Duration::from_secs(5)),
            ..ProcessOptions::default()
        };
        let output = runner
            .run_with_options(&fixture.executable, &[], &[], &options, false)
            .unwrap();
        let bytes = output.stdout.len() + output.stderr.len();
        assert!(bytes <= remaining);
        remaining -= bytes;
        retained += bytes;
        assert_eq!(output.code, Some(0));
        assert_eq!(output.truncated, index == 1);
        assert!(!output.interrupted);
    }
    assert_eq!(retained, 8);
    assert_eq!(remaining, 0);
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
    let gate = Arc::new(AtomicBool::new(false));
    let mut runner = Runner::default();
    runner.timeout_gate = Some(gate.clone());
    struct ShutdownOnDrop {
        runner: Runner,
        worker: Option<thread::JoinHandle<Result<Output, String>>>,
    }
    impl Drop for ShutdownOnDrop {
        fn drop(&mut self) {
            self.runner.shutdown();
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    // Even a failed readiness assertion stops the registered group when there is
    // no PID file yet. Fixture cleanup alone cannot identify that earlier child.
    let owned_runner = runner.clone();
    let executable = fixture.executable.clone();
    let arguments = fixture.args();
    let worker = thread::spawn(move || {
        runner.run(&executable, &arguments, &[], Duration::from_secs(2), false)
    });
    let mut owned = ShutdownOnDrop {
        runner: owned_runner,
        worker: Some(worker),
    };
    // RESISTS_TERM installs each TERM handler before publishing its PID.
    let parent = fixture.pid("parent.pid");
    let descendant = fixture.pid("descendant.pid");
    assert!(
        !owned.worker.as_ref().unwrap().is_finished(),
        "fixture ended before the timeout was armed"
    );
    let started = Instant::now();
    gate.store(true, Ordering::Release);
    let out = owned.worker.take().unwrap().join().unwrap().unwrap();
    assert!(out.interrupted);
    assert!(out.timed_out);
    assert_eq!(out.code, None);
    assert!(out.duration_ms >= 2_000);
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert!(started.elapsed() < Duration::from_secs(6));
    assert_gone(parent);
    assert_gone(descendant);
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

fn follow_until(
    follow: &FollowProcess,
    done: impl Fn(&FollowRead, &str) -> bool,
) -> (FollowRead, String) {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut text = String::new();
    loop {
        let output = follow.read();
        text.push_str(&output.text);
        if done(&output, &text) {
            return (output, text);
        }
        assert!(
            Instant::now() < deadline,
            "follow did not reach expected state"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn follow_delivers_both_pipes_before_exit_and_retains_terminal_metadata() {
    let fixture = Fixture::new(
        "printf 'first-out\\n'\nprintf 'first-err\\n' >&2\nwhile [ ! -f \"$1/continue\" ]; do /bin/sleep 0.01; done\nprintf 'second-out\\n'\nprintf 'second-err\\n' >&2\nexit 17",
    );
    let follow = Runner::default()
        .start_follow(&fixture.executable, &fixture.args(), &[])
        .unwrap();
    let (output, first) = follow_until(&follow, |_, text| {
        text.contains("first-out") && text.contains("first-err")
    });
    assert!(!output.terminal);
    assert!(
        follow.read().text.is_empty(),
        "reads drain rather than repeat old text"
    );
    fs::write(fixture.root.join("continue"), "").unwrap();
    let (output, second) = follow_until(&follow, |output, _| output.terminal);
    assert!(first.contains("first-out") && first.contains("first-err"));
    assert!(second.contains("second-out") && second.contains("second-err"));
    assert_eq!(output.exit_code, Some(17));
    assert!(!output.interrupted);
    assert_eq!(output.stderr, "first-err\nsecond-err\n");
    assert!(follow.read().text.is_empty());
    assert!(follow.read().terminal);
    follow.stop();
    follow.stop();
}

#[test]
fn follow_bounds_pending_tail_and_stderr_while_continuing_to_drain_pipes() {
    let fixture = Fixture::new(
        "printf 'discarded-prefix'\n(/bin/dd if=/dev/zero bs=1048576 count=3 2>/dev/null | /usr/bin/tr '\\000' x)\nprintf 'newest-stdout'\n(/bin/dd if=/dev/zero bs=262144 count=2 2>/dev/null | /usr/bin/tr '\\000' y) >&2\nprintf 'newest-stderr' >&2\necho $$ > \"$1/output-done.pid\"\nexec /bin/sleep 30",
    );
    let follow = Runner::default()
        .start_follow(&fixture.executable, &fixture.args(), &[])
        .unwrap();
    fixture.pid("output-done.pid");
    follow.stop();
    let output = follow.read();
    assert!(output.terminal && output.interrupted);
    assert!(output.truncated);
    assert_eq!(output.text.len(), LOG_LIMIT);
    assert!(!output.text.contains("discarded-prefix"));
    assert!(output.text.contains("newest-stdout"));
    assert!(output.text.contains("newest-stderr"));
    assert_eq!(output.stderr.len(), STDERR_LIMIT);
    assert!(
        !follow.read().truncated,
        "overflow flag is since the previous drain"
    );
}

#[test]
fn follow_stop_waits_for_owned_group_without_interrupting_another_follow() {
    let fixture = Fixture::new(RESISTS_TERM);
    let other = Fixture::new("printf 'still-running'\nexec /bin/sleep 30");
    let runner = Runner::default();
    let follow = runner
        .start_follow(&fixture.executable, &fixture.args(), &[])
        .unwrap();
    let unaffected = runner.start_follow(&other.executable, &[], &[]).unwrap();
    let parent = fixture.pid("parent.pid");
    let descendant = fixture.pid("descendant.pid");
    let cloned = follow.clone();
    let stop = thread::spawn(move || cloned.stop());
    follow.stop();
    stop.join().unwrap();
    assert_gone(parent);
    assert_gone(descendant);
    let output = follow.read();
    assert!(output.terminal && output.interrupted);
    assert!(!unaffected.read().terminal);
    unaffected.stop();
    assert!(
        runner
            .run(
                Path::new("/usr/bin/true"),
                &[],
                &[],
                Duration::from_secs(1),
                false
            )
            .is_ok()
    );
}

#[test]
fn follow_parent_exit_cleans_descendants_and_last_handle_drop_stops_running_work() {
    let fixture = Fixture::new(
        "echo $$ > \"$1/parent.pid\"\n/bin/sh -c 'echo $$ > \"$1/descendant.pid\"; exec /bin/sleep 30' _ \"$1\" &\nwhile [ ! -s \"$1/descendant.pid\" ]; do /bin/sleep 0.01; done\nexit 0",
    );
    let runner = Runner::default();
    let follow = runner
        .start_follow(&fixture.executable, &fixture.args(), &[])
        .unwrap();
    let (output, _) = follow_until(&follow, |output, _| output.terminal);
    assert_eq!(output.exit_code, Some(0));
    assert_gone(fixture.pid("descendant.pid"));
    let live = Fixture::new("echo $$ > \"$1/parent.pid\"\nexec /bin/sleep 30");
    let follow = runner
        .start_follow(&live.executable, &live.args(), &[])
        .unwrap();
    let parent = live.pid("parent.pid");
    drop(follow);
    assert_gone(parent);
}

#[test]
fn follow_and_one_shot_share_capacity_and_shutdown_closes_follow_work() {
    let runner = Runner::default();
    let fixture = Fixture::new("exec /bin/sleep 30");
    let follows: Vec<_> = (0..8)
        .map(|_| runner.start_follow(&fixture.executable, &[], &[]).unwrap())
        .collect();
    assert!(runner.start_follow(&fixture.executable, &[], &[]).is_err());
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
    runner.shutdown();
    for follow in follows {
        follow.stop();
        assert!(follow.read().terminal);
    }
    assert!(runner.start_follow(&fixture.executable, &[], &[]).is_err());
}

#[test]
fn compose_options_use_explicit_unicode_working_directory_and_literal_arguments() {
    let fixture = Fixture::new("pwd -P\nprintf '%s\\0' \"$@\"");
    let cwd = fixture.root.join("한글 프로젝트 폴더");
    fs::create_dir(&cwd).unwrap();
    let cwd = fs::canonicalize(cwd).unwrap();
    let args = vec!["$HOME $(touch must-not-exist) ; `pwd`".into()];
    let options = ProcessOptions {
        cwd: Some(cwd.clone()),
        deadline: Some(Instant::now() + Duration::from_secs(5)),
        isolate_compose_env: true,
        ..ProcessOptions::default()
    };
    let output = Runner::default()
        .run_with_options(&fixture.executable, &args, &[], &options, false)
        .unwrap();
    assert_eq!(output.code, Some(0));
    assert!(!output.interrupted && !output.timed_out);
    assert_eq!(
        output.stdout,
        format!("{}\n{}\0", cwd.display(), args[0]).as_bytes()
    );
    assert!(!cwd.join("must-not-exist").exists());
    let follow = Runner::default()
        .start_follow_with_options(&fixture.executable, &args, &[], &options)
        .unwrap();
    let (output, text) = follow_until(&follow, |output, _| output.terminal);
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(text, format!("{}\n{}", cwd.display(), args[0]));
    assert!(!cwd.join("must-not-exist").exists());
}

#[test]
fn compose_options_strip_ambient_compose_and_builder_values_then_apply_pins() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "process_tests::compose_environment_probe",
            "--nocapture",
        ])
        .env("DOCKER2U_COMPOSE_ENV_PROBE", "1")
        .env("DOCKER_HOST", "tcp://hostile.example:2375")
        .env("COMPOSE_FILE", "/hostile/compose.yml")
        .env("COMPOSE_PROJECT_NAME", "hostile")
        .env("COMPOSE_PROFILES", "danger")
        .env("COMPOSE_ENV_FILES", "/hostile/env")
        .env("COMPOSE_REMOVE_ORPHANS", "true")
        .env("COMPOSE_NEW_UNKNOWN_OVERRIDE", "hostile")
        .env("BUILDX_BUILDER", "remote")
        .env("BUILDX_CONFIG", "/hostile/buildx")
        .env("BUILDKIT_HOST", "tcp://hostile.example:1234")
        .env("BUILDKIT_PROGRESS", "tty")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("compose environment pinned"));
}

#[test]
fn compose_environment_probe() {
    if std::env::var_os("DOCKER2U_COMPOSE_ENV_PROBE").is_none() {
        return;
    }
    let fixture = Fixture::new(
        "for key in COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES COMPOSE_NEW_UNKNOWN_OVERRIDE BUILDX_BUILDER BUILDX_CONFIG BUILDKIT_HOST BUILDKIT_PROGRESS; do\n if /usr/bin/printenv \"$key\" >/dev/null; then exit 71; fi\ndone\nprintf '%s\\n' \"$DOCKER_HOST\" \"$COMPOSE_REMOVE_ORPHANS\" \"$COMPOSE_PROFILES\"",
    );
    let env = vec![
        ("DOCKER_HOST".into(), "unix:///pinned.sock".into()),
        ("COMPOSE_REMOVE_ORPHANS".into(), "false".into()),
        ("COMPOSE_PROFILES".into(), "".into()),
    ];
    let options = ProcessOptions {
        isolate_compose_env: true,
        deadline: Some(Instant::now() + Duration::from_secs(5)),
        ..ProcessOptions::default()
    };
    let runner = Runner::default();
    let output = runner
        .run_with_options(&fixture.executable, &[], &env, &options, false)
        .unwrap();
    assert_eq!(output.code, Some(0));
    assert_eq!(output.stdout, b"unix:///pinned.sock\nfalse\n\n");
    let follow = runner
        .start_follow_with_options(&fixture.executable, &[], &env, &options)
        .unwrap();
    let (output, text) = follow_until(&follow, |output, _| output.terminal);
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(text, "unix:///pinned.sock\nfalse\n\n");
    println!("compose environment pinned");
}

#[test]
fn cancelled_or_expired_options_never_launch_and_do_not_consume_capacity() {
    let fixture = Fixture::new("echo $$ > \"$1/must-not-launch\"");
    let runner = Runner::default();
    let cancelled = ProcessOptions {
        cancel: Arc::new(AtomicBool::new(true)),
        ..ProcessOptions::default()
    };
    let expired = ProcessOptions {
        deadline: Some(Instant::now() - Duration::from_secs(1)),
        ..ProcessOptions::default()
    };
    for options in [cancelled, expired] {
        for _ in 0..9 {
            assert!(
                runner
                    .run_with_options(&fixture.executable, &fixture.args(), &[], &options, false)
                    .is_err()
            );
            assert!(
                runner
                    .start_follow_with_options(&fixture.executable, &fixture.args(), &[], &options)
                    .is_err()
            );
        }
    }
    assert!(!fixture.root.join("must-not-launch").exists());
    let result = runner
        .run(
            Path::new("/usr/bin/true"),
            &[],
            &[],
            Duration::from_secs(5),
            false,
        )
        .unwrap();
    assert_eq!(result.code, Some(0));
}

#[test]
fn shared_cancel_interrupts_quiet_preparation_and_cleans_resistant_descendants() {
    let fixture = Fixture::new(RESISTS_TERM);
    let runner = Runner::default();
    let options = ProcessOptions::default();
    let cancelled = options.cancel.clone();
    let worker_runner = runner.clone();
    let executable = fixture.executable.clone();
    let args = fixture.args();
    let worker = thread::spawn(move || {
        worker_runner.run_with_options(&executable, &args, &[], &options, false)
    });
    let parent = fixture.pid("parent.pid");
    let descendant = fixture.pid("descendant.pid");
    cancelled.store(true, Ordering::Release);
    let output = worker.join().unwrap().unwrap();
    assert!(output.interrupted && !output.timed_out);
    assert_eq!(output.code, None);
    assert_gone(parent);
    assert_gone(descendant);
}

#[test]
fn shared_cancel_interrupts_quiet_follow_and_prevents_later_launch() {
    let fixture = Fixture::new(RESISTS_TERM);
    let runner = Runner::default();
    let options = ProcessOptions::default();
    let follow = runner
        .start_follow_with_options(&fixture.executable, &fixture.args(), &[], &options)
        .unwrap();
    let parent = fixture.pid("parent.pid");
    let descendant = fixture.pid("descendant.pid");
    assert!(!follow.read().terminal);
    options.cancel.store(true, Ordering::Release);
    let (output, _) = follow_until(&follow, |output, _| output.terminal);
    assert!(output.interrupted && !output.timed_out);
    assert_gone(parent);
    assert_gone(descendant);
    assert!(
        runner
            .start_follow_with_options(&fixture.executable, &fixture.args(), &[], &options)
            .is_err()
    );
}

#[test]
fn follow_deadline_interrupts_quiet_process_and_records_timeout() {
    let fixture = Fixture::new("exec /bin/sleep 30");
    let options = ProcessOptions {
        deadline: Some(Instant::now() + Duration::from_millis(400)),
        ..ProcessOptions::default()
    };
    let follow = Runner::default()
        .start_follow_with_options(&fixture.executable, &[], &[], &options)
        .unwrap();
    let (output, text) = follow_until(&follow, |output, _| output.terminal);
    assert!(output.interrupted && output.timed_out);
    assert_eq!(output.exit_code, None);
    assert!(text.is_empty());
    assert!(
        follow.read().timed_out,
        "terminal classification survives reads"
    );
}

#[test]
fn completed_follow_stays_successful_when_read_after_deadline() {
    let fixture = Fixture::new("printf done");
    let deadline = Instant::now() + Duration::from_secs(5);
    let options = ProcessOptions {
        deadline: Some(deadline),
        ..ProcessOptions::default()
    };
    let follow = Runner::default()
        .start_follow_with_options(&fixture.executable, &[], &[], &options)
        .unwrap();
    let (output, text) = follow_until(&follow, |output, _| output.terminal);
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(text, "done");
    thread::sleep(deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(20));
    let late = follow.read();
    assert_eq!(late.exit_code, Some(0));
    assert!(!late.interrupted && !late.timed_out);
    follow.stop();
    assert!(
        !options.cancel.load(Ordering::Acquire),
        "joining successful follow must preserve shared token"
    );
}
