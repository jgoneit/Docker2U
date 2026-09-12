//! Shell-free, bounded processes. Every child owns its process group.
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub const STDOUT_LIMIT: usize = 8 * 1024 * 1024;
pub const STDERR_LIMIT: usize = 256 * 1024;
pub const LOG_LIMIT: usize = 2 * 1024 * 1024;

/// Opt-in process policy for Compose; legacy follows have no deadline.
#[derive(Clone, Default)]
pub struct ProcessOptions {
    pub cwd: Option<PathBuf>,
    pub deadline: Option<Instant>,
    pub cancel: Arc<AtomicBool>,
    pub isolate_compose_env: bool,
}

impl ProcessOptions {
    fn check_launch(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err("Process cancelled before launch".into());
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("Process deadline elapsed before launch".into());
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct Runner {
    children: Arc<Mutex<HashMap<u32, ()>>>,
    closing: Arc<AtomicBool>,
    /// Let timeout contract tests install child signal handlers before starting
    /// their clock. Production always measures the timeout from process launch.
    #[cfg(test)]
    pub(crate) timeout_gate: Option<Arc<AtomicBool>>,
}

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub logs: Vec<u8>,
    pub truncated: bool,
    pub interrupted: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// A drain of pending follow output; terminal metadata survives subsequent reads.
#[derive(Debug)]
pub struct FollowRead {
    pub text: String,
    pub truncated: bool,
    pub terminal: bool,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub interrupted: bool,
    pub timed_out: bool,
}

#[derive(Default)]
struct FollowCapture {
    pending: VecDeque<u8>,
    truncated: bool,
    terminal: bool,
    exit_code: Option<i32>,
    stderr: String,
    interrupted: bool,
    timed_out: bool,
}

impl FollowCapture {
    fn append(&mut self, text: &str, stderr: bool) {
        self.pending.extend(text.as_bytes());
        let excess = self.pending.len().saturating_sub(LOG_LIMIT);
        if excess > 0 {
            self.truncated = true;
            self.pending.drain(..excess);
            // The retained tail must start at a UTF-8 character boundary.
            while self.pending.front().is_some_and(|byte| byte & 0xc0 == 0x80) {
                self.pending.pop_front();
            }
        }
        if stderr {
            let mut end = text
                .len()
                .min(STDERR_LIMIT.saturating_sub(self.stderr.len()));
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            self.stderr.push_str(&text[..end]);
        }
    }
}

struct FollowHandle {
    capture: Arc<Mutex<FollowCapture>>,
    cancel: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl FollowHandle {
    fn stop(&self) {
        // A completed follow may share its token with later preparation steps.
        // Releasing that handle must not turn a successful operation into cancel.
        if !self.capture.lock().unwrap().terminal {
            self.cancel.store(true, Ordering::Release);
        }
        // Holding this lock through join makes concurrent stop calls wait for
        // the same completed cleanup. The worker never acquires this lock.
        let mut worker = self.worker.lock().unwrap();
        if let Some(worker) = worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for FollowHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Clones share a drain cursor and cancellation. Drop of the last owner stops it.
#[derive(Clone)]
pub struct FollowProcess(Arc<FollowHandle>);

impl FollowProcess {
    pub fn read(&self) -> FollowRead {
        let mut capture = self.0.capture.lock().unwrap();
        FollowRead {
            text: String::from_utf8(capture.pending.drain(..).collect())
                .expect("follow buffer contains sanitized UTF-8"),
            truncated: std::mem::take(&mut capture.truncated),
            terminal: capture.terminal,
            exit_code: capture.exit_code,
            stderr: capture.stderr.clone(),
            interrupted: capture.interrupted,
            timed_out: capture.timed_out,
        }
    }

    /// Call outside Core locks: termination includes process and reader joins.
    pub fn stop(&self) {
        self.0.stop();
    }
}

#[derive(Default)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

/// At most three incomplete UTF-8 bytes and one escape state per pipe. Escape
/// payloads are discarded as they arrive. A newline always resumes visible text.
#[derive(Default)]
struct StreamSanitizer {
    pending: Vec<u8>,
    escape: EscapeState,
}

impl StreamSanitizer {
    fn text(&mut self, text: &str, output: &mut String) {
        for ch in text.chars() {
            if ch == '\n' {
                self.escape = EscapeState::Text;
                output.push(ch);
                continue;
            }
            match self.escape {
                EscapeState::Text if ch == '\u{1b}' => self.escape = EscapeState::Escape,
                EscapeState::Text => {
                    if ch == '\n' || ch == '\t' || (!ch.is_control() && ch != '\u{7f}') {
                        output.push(ch);
                    }
                }
                EscapeState::Escape => {
                    self.escape = match ch {
                        '[' => EscapeState::Csi,
                        ']' => EscapeState::Osc,
                        '\u{1b}' => EscapeState::Escape,
                        _ => EscapeState::Text,
                    };
                }
                EscapeState::Csi => {
                    if ('@'..='~').contains(&ch) {
                        self.escape = EscapeState::Text;
                    } else if ch == '\u{1b}' {
                        self.escape = EscapeState::Escape;
                    }
                }
                EscapeState::Osc => {
                    if ch == '\u{7}' {
                        self.escape = EscapeState::Text;
                    } else if ch == '\u{1b}' {
                        self.escape = EscapeState::OscEscape;
                    }
                }
                EscapeState::OscEscape => {
                    self.escape = match ch {
                        '\\' | '\u{7}' => EscapeState::Text,
                        '\u{1b}' => EscapeState::OscEscape,
                        _ => EscapeState::Osc,
                    };
                }
            }
        }
    }

    fn push(&mut self, chunk: &[u8], eof: bool) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut remaining = bytes.as_slice();
        let mut output = String::new();
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(text) => {
                    self.text(text, &mut output);
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    self.text(
                        std::str::from_utf8(&remaining[..valid]).unwrap(),
                        &mut output,
                    );
                    remaining = &remaining[valid..];
                    if let Some(length) = error.error_len() {
                        self.text("\u{fffd}", &mut output);
                        remaining = &remaining[length..];
                    } else {
                        if eof {
                            self.text("\u{fffd}", &mut output);
                        } else {
                            self.pending.extend_from_slice(remaining);
                        }
                        break;
                    }
                }
            }
        }
        output
    }
}

struct OwnedFollowChild {
    child: Child,
    registry: Arc<Mutex<HashMap<u32, ()>>>,
}

impl Drop for OwnedFollowChild {
    fn drop(&mut self) {
        let id = self.child.id();
        signal_group(id, libc::SIGKILL);
        let _ = self.child.wait();
        self.registry.lock().unwrap().remove(&id);
    }
}

#[derive(Default)]
struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    logs: VecDeque<u8>,
    truncated: bool,
}

impl Capture {
    fn append(&mut self, bytes: &[u8], stderr: bool, logs: bool) {
        if logs {
            let excess = (self.logs.len() + bytes.len()).saturating_sub(LOG_LIMIT);
            if excess > 0 {
                self.truncated = true;
            }
            let remove = excess.min(self.logs.len());
            self.logs.drain(..remove);
            self.logs.extend(&bytes[excess.saturating_sub(remove)..]);
            // On failure stderr is a bounded CLI diagnostic, not log content.
            if stderr {
                let available = STDERR_LIMIT.saturating_sub(self.stderr.len());
                self.stderr
                    .extend_from_slice(&bytes[..available.min(bytes.len())]);
            }
        } else {
            let (buffer, limit) = if stderr {
                (&mut self.stderr, STDERR_LIMIT)
            } else {
                (&mut self.stdout, STDOUT_LIMIT)
            };
            let available = limit.saturating_sub(buffer.len());
            buffer.extend_from_slice(&bytes[..available.min(bytes.len())]);
            self.truncated |= bytes.len() > available;
        }
    }
}

fn signal_group(id: u32, signal: i32) {
    #[cfg(unix)]
    // SAFETY: negative pid addresses only the group created for our child.
    unsafe {
        libc::kill(-(id as i32), signal);
    }
}

fn isolated_command(
    executable: &Path,
    args: &[String],
    env: &[(String, String)],
    options: &ProcessOptions,
) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Core supplies a discovery allowlist or the pinned Engine config. Neither
    // one-shot nor follow work may inherit ambient Docker/provider overrides.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("DOCKER_")
            || key == "COLIMA_HOME"
            || key == "LIMA_HOME"
            || (options.isolate_compose_env
                && (name.starts_with("COMPOSE_")
                    || name.starts_with("BUILDX_")
                    || name.starts_with("BUILDKIT_")))
        {
            command.env_remove(key);
        }
    }
    command.envs(env.iter().map(|(key, value)| (key, value)));
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
}

impl Runner {
    pub fn start_follow(
        &self,
        executable: &Path,
        args: &[String],
        env: &[(String, String)],
    ) -> Result<FollowProcess, String> {
        self.start_follow_with_options(executable, args, env, &ProcessOptions::default())
    }

    pub fn start_follow_with_options(
        &self,
        executable: &Path,
        args: &[String],
        env: &[(String, String)],
        options: &ProcessOptions,
    ) -> Result<FollowProcess, String> {
        let mut command = isolated_command(executable, args, env, options);
        let mut registry = self
            .children
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        if self.closing.load(Ordering::Acquire) || registry.len() >= 8 {
            return Err("Process capacity unavailable".into());
        }
        // The check, spawn and registration share the shutdown registry lock.
        // Cancellation after this check is observed by the same token in worker.
        options.check_launch()?;
        let child = command
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", executable.display()))?;
        let id = child.id();
        registry.insert(id, ());
        drop(registry);
        let mut owned = OwnedFollowChild {
            child,
            registry: self.children.clone(),
        };
        let capture = Arc::new(Mutex::new(FollowCapture::default()));
        let cancel = options.cancel.clone();
        let deadline = options.deadline;
        let shared = capture.clone();
        let cancelled = cancel.clone();
        let closing = self.closing.clone();
        let worker = thread::Builder::new()
            .name("docker2u-follow".into())
            .spawn(move || {
                let failed = Arc::new(AtomicBool::new(false));
                let mut readers = Vec::new();
                for (pipe, is_stderr) in [
                    (
                        Box::new(owned.child.stdout.take().unwrap()) as Box<dyn Read + Send>,
                        false,
                    ),
                    (
                        Box::new(owned.child.stderr.take().unwrap()) as Box<dyn Read + Send>,
                        true,
                    ),
                ] {
                    let capture = shared.clone();
                    let read_failed = failed.clone();
                    match thread::Builder::new()
                        .name("docker2u-follow-pipe".into())
                        .spawn(move || {
                            let mut pipe = pipe;
                            let mut sanitizer = StreamSanitizer::default();
                            let mut buffer = [0u8; 16 * 1024];
                            loop {
                                match pipe.read(&mut buffer) {
                                    Ok(size) => {
                                        let text = sanitizer.push(&buffer[..size], size == 0);
                                        if !text.is_empty() {
                                            capture.lock().unwrap().append(&text, is_stderr);
                                        }
                                        if size == 0 {
                                            break;
                                        }
                                    }
                                    Err(error)
                                        if error.kind() == std::io::ErrorKind::Interrupted =>
                                    {
                                        continue;
                                    }
                                    Err(_) => {
                                        read_failed.store(true, Ordering::Release);
                                        break;
                                    }
                                }
                            }
                        }) {
                        Ok(reader) => readers.push(reader),
                        Err(_) => {
                            failed.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
                let mut interrupted = false;
                let mut timed_out = false;
                let status = loop {
                    match owned.child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Err(_) => {
                            interrupted = true;
                            break None;
                        }
                        Ok(None) => {}
                    }
                    timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
                    if timed_out
                        || cancelled.load(Ordering::Acquire)
                        || closing.load(Ordering::Acquire)
                        || failed.load(Ordering::Acquire)
                    {
                        interrupted = true;
                        signal_group(id, libc::SIGTERM);
                        let grace = Instant::now();
                        while grace.elapsed() < Duration::from_secs(2) {
                            if matches!(owned.child.try_wait(), Ok(Some(_))) {
                                break;
                            }
                            thread::sleep(Duration::from_millis(10));
                        }
                        break None;
                    }
                    thread::sleep(Duration::from_millis(10));
                };
                // Kill descendants even when the parent exited normally: otherwise
                // inherited pipes can keep readers and app shutdown alive forever.
                signal_group(id, libc::SIGKILL);
                let _ = owned.child.wait();
                for reader in readers {
                    interrupted |= reader.join().is_err();
                }
                drop(owned);
                let mut capture = shared.lock().unwrap();
                capture.terminal = true;
                capture.exit_code = status.and_then(|status| status.code());
                capture.interrupted = interrupted || failed.load(Ordering::Acquire);
                capture.timed_out = timed_out;
            })
            .map_err(|error| format!("Cannot start follow worker: {error}"))?;
        Ok(FollowProcess(Arc::new(FollowHandle {
            capture,
            cancel,
            worker: Mutex::new(Some(worker)),
        })))
    }

    pub fn run(
        &self,
        executable: &Path,
        args: &[String],
        env: &[(String, String)],
        timeout: Duration,
        logs: bool,
    ) -> Result<Output, String> {
        let options = ProcessOptions {
            deadline: Some(Instant::now() + timeout),
            ..ProcessOptions::default()
        };
        self.run_with_options(executable, args, env, &options, logs)
    }

    pub fn run_with_options(
        &self,
        executable: &Path,
        args: &[String],
        env: &[(String, String)],
        options: &ProcessOptions,
        logs: bool,
    ) -> Result<Output, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Application is closing".into());
        }
        let mut command = isolated_command(executable, args, env, options);
        let started = Instant::now();
        #[cfg(test)]
        let gated_timeout = options
            .deadline
            .map(|deadline| deadline.saturating_duration_since(started));
        #[cfg(test)]
        let mut deadline = self
            .timeout_gate
            .is_none()
            .then_some(options.deadline)
            .flatten();
        #[cfg(not(test))]
        let deadline = options.deadline;
        let mut registry = self
            .children
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        if self.closing.load(Ordering::Acquire) || registry.len() >= 8 {
            return Err("Process capacity unavailable".into());
        }
        options.check_launch()?;
        let child = command
            .spawn()
            .map_err(|e| format!("Cannot start {}: {e}", executable.display()))?;
        let id = child.id();
        registry.insert(id, ());
        drop(registry);
        let mut owned = OwnedFollowChild {
            child,
            registry: self.children.clone(),
        };
        let capture = Arc::new(Mutex::new(Capture::default()));
        let read_failed = Arc::new(AtomicBool::new(false));
        let mut readers = Vec::new();
        for (pipe, is_stderr) in [
            (
                Box::new(owned.child.stdout.take().unwrap()) as Box<dyn Read + Send>,
                false,
            ),
            (
                Box::new(owned.child.stderr.take().unwrap()) as Box<dyn Read + Send>,
                true,
            ),
        ] {
            let shared = capture.clone();
            let failed = read_failed.clone();
            match thread::Builder::new()
                .name("docker2u-process-pipe".into())
                .spawn(move || {
                    let mut pipe = pipe;
                    let mut buffer = [0u8; 16 * 1024];
                    loop {
                        match pipe.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(size) => {
                                shared
                                    .lock()
                                    .unwrap()
                                    .append(&buffer[..size], is_stderr, logs)
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => {
                                failed.store(true, Ordering::Release);
                                break;
                            }
                        }
                    }
                }) {
                Ok(reader) => readers.push(reader),
                Err(_) => {
                    read_failed.store(true, Ordering::Release);
                    break;
                }
            }
        }
        let mut interrupted = false;
        let mut timed_out = false;
        let status = loop {
            match owned.child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Err(_) => {
                    interrupted = true;
                    break None;
                }
                Ok(None) => {}
            }
            #[cfg(test)]
            if deadline.is_none()
                && self
                    .timeout_gate
                    .as_ref()
                    .is_some_and(|gate| gate.load(Ordering::Acquire))
            {
                deadline = gated_timeout.map(|timeout| Instant::now() + timeout);
            }
            timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if timed_out
                || options.cancel.load(Ordering::Acquire)
                || self.closing.load(Ordering::Acquire)
                || read_failed.load(Ordering::Acquire)
            {
                interrupted = true;
                signal_group(id, libc::SIGTERM);
                let grace = Instant::now();
                while grace.elapsed() < Duration::from_secs(2) {
                    if matches!(owned.child.try_wait(), Ok(Some(_))) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        // A descendant may keep pipes open even after its parent exits.
        signal_group(id, libc::SIGKILL);
        let _ = owned.child.wait();
        for reader in readers {
            if reader.join().is_err() {
                interrupted = true;
            }
        }
        drop(owned);
        let mut capture = capture.lock().unwrap();
        Ok(Output {
            code: status.and_then(|s| s.code()),
            stdout: std::mem::take(&mut capture.stdout),
            stderr: std::mem::take(&mut capture.stderr),
            logs: capture.logs.drain(..).collect(),
            truncated: capture.truncated,
            interrupted: interrupted || read_failed.load(Ordering::Acquire),
            timed_out,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        let ids: Vec<_> = self.children.lock().unwrap().keys().copied().collect();
        for id in &ids {
            signal_group(*id, libc::SIGTERM);
        }
        if !ids.is_empty() {
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2)
                && !self.children.lock().unwrap().is_empty()
            {
                thread::sleep(Duration::from_millis(10));
            }
            for id in ids {
                if self.children.lock().unwrap().contains_key(&id) {
                    signal_group(id, libc::SIGKILL);
                }
            }
            // Exit is blocked until termination has been delivered to every owned group.
        }
    }
}

/// Strip terminal escapes/control bytes and bound UTF-8 expansion after decoding.
pub fn plain_text(bytes: &[u8], limit: usize) -> String {
    let mut clean = StreamSanitizer::default().push(bytes, true);
    if clean.len() > limit {
        let mut start = clean.len() - limit;
        while !clean.is_char_boundary(start) {
            start += 1;
        }
        clean.drain(..start);
    }
    clean
}

#[cfg(test)]
mod stream_text_tests {
    use super::{FollowCapture, LOG_LIMIT, ProcessOptions, Runner, StreamSanitizer, plain_text};
    use std::{path::Path, sync::atomic::Ordering, thread, time::Duration};

    #[test]
    fn preserves_utf8_and_discards_controls_across_every_byte_boundary() {
        let bytes =
            "한글\u{1b}[31mred\u{1b}[0m\u{1b}]0;비밀\u{7}끝\u{1b}]title\u{1b}\\\n\t\0".as_bytes();
        for split in 0..=bytes.len() {
            let mut sanitizer = StreamSanitizer::default();
            let mut result = sanitizer.push(&bytes[..split], false);
            result.push_str(&sanitizer.push(&bytes[split..], true));
            assert_eq!(result, "한글red끝\n\t", "split at {split}");
        }
        let mut sanitizer = StreamSanitizer::default();
        let mut result = String::new();
        for byte in bytes {
            result.push_str(&sanitizer.push(&[*byte], false));
        }
        result.push_str(&sanitizer.push(&[], true));
        assert_eq!(result, "한글red끝\n\t");
    }

    #[test]
    fn invalid_and_incomplete_utf8_are_lossy_without_retaining_escape_payloads() {
        let mut sanitizer = StreamSanitizer::default();
        assert_eq!(sanitizer.push(&[0xff, 0xed, 0x95], false), "�");
        assert_eq!(sanitizer.pending.len(), 2);
        assert_eq!(sanitizer.push(&[], true), "�");
        assert!(sanitizer.push(b"\x1b]", false).is_empty());
        for _ in 0..512 {
            assert!(sanitizer.push(&[b'a'; 16_384], false).is_empty());
            assert!(sanitizer.pending.is_empty());
        }
        assert_eq!(sanitizer.push(b"\x1b\\visible", true), "visible");
    }

    #[test]
    fn ring_eviction_keeps_valid_utf8_with_a_byte_limit() {
        let mut capture = FollowCapture::default();
        capture.append(&"가".repeat(LOG_LIMIT / 3 + 2), false);
        assert!(capture.truncated);
        assert!(capture.pending.len() <= LOG_LIMIT);
        assert!(String::from_utf8(capture.pending.into()).is_ok());
    }

    #[test]
    fn incomplete_escape_states_resume_at_newline_across_every_split() {
        for escape in [
            "\u{1b}",
            "\u{1b}[123;",
            "\u{1b}]title",
            "\u{1b}]title\u{1b}",
        ] {
            let bytes = format!("이전{escape}\n다음 서비스 준비\n").into_bytes();
            for split in 0..=bytes.len() {
                let mut sanitizer = StreamSanitizer::default();
                let mut text = sanitizer.push(&bytes[..split], false);
                text.push_str(&sanitizer.push(&bytes[split..], true));
                assert_eq!(text, "이전\n다음 서비스 준비\n", "split {split}");
            }
            assert_eq!(plain_text(&bytes, 1024), "이전\n다음 서비스 준비\n");
        }
    }

    #[test]
    fn cancellation_is_rechecked_after_waiting_for_launch_registry() {
        for follow in [false, true] {
            let runner = Runner::default();
            let registry = runner.children.lock().unwrap();
            let options = ProcessOptions::default();
            let cancel = options.cancel.clone();
            let worker_runner = runner.clone();
            let (ready, waiting) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                ready.send(()).unwrap();
                if follow {
                    worker_runner
                        .start_follow_with_options(Path::new("/usr/bin/true"), &[], &[], &options)
                        .is_err()
                } else {
                    worker_runner
                        .run_with_options(Path::new("/usr/bin/true"), &[], &[], &options, false)
                        .is_err()
                }
            });
            waiting.recv().unwrap();
            // Keep launch blocked independently of subprocess scheduling.
            thread::sleep(Duration::from_millis(20));
            cancel.store(true, Ordering::Release);
            drop(registry);
            assert!(worker.join().unwrap());
            assert!(runner.children.lock().unwrap().is_empty());
        }
    }
}
