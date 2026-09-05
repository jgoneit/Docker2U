//! Shell-free, bounded one-shot processes. Every child owns its process group.
use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    path::Path,
    process::{Command, Stdio},
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

#[derive(Clone, Default)]
pub struct Runner {
    children: Arc<Mutex<HashMap<u32, ()>>>,
    closing: Arc<AtomicBool>,
}

#[derive(Debug)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub logs: Vec<u8>,
    pub truncated: bool,
    pub interrupted: bool,
    pub duration_ms: u64,
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

impl Runner {
    pub fn run(
        &self,
        executable: &Path,
        args: &[String],
        env: &[(String, String)],
        timeout: Duration,
        logs: bool,
    ) -> Result<Output, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("Application is closing".into());
        }
        let mut command = Command::new(executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Ambient Docker target, TLS, API, config and plugin overrides never select an Engine.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("DOCKER_")
                || key == "COLIMA_HOME"
                || key == "LIMA_HOME"
            {
                command.env_remove(key);
            }
        }
        command.envs(env.iter().map(|(k, v)| (k, v)));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let started = Instant::now();
        let mut registry = self
            .children
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        if self.closing.load(Ordering::Acquire) || registry.len() >= 8 {
            return Err("Process capacity unavailable".into());
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start {}: {e}", executable.display()))?;
        let id = child.id();
        registry.insert(id, ());
        drop(registry);
        let capture = Arc::new(Mutex::new(Capture::default()));
        let read_failed = Arc::new(AtomicBool::new(false));
        let mut readers = Vec::new();
        for (pipe, is_stderr) in [
            (
                Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
                false,
            ),
            (
                Box::new(child.stderr.take().unwrap()) as Box<dyn Read + Send>,
                true,
            ),
        ] {
            let shared = capture.clone();
            let failed = read_failed.clone();
            readers.push(thread::spawn(move || {
                let mut pipe = pipe;
                let mut buffer = [0u8; 16 * 1024];
                loop {
                    match pipe.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(size) => shared
                            .lock()
                            .unwrap()
                            .append(&buffer[..size], is_stderr, logs),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            failed.store(true, Ordering::Release);
                            break;
                        }
                    }
                }
            }));
        }
        let mut interrupted = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Err(_) => {
                    interrupted = true;
                    break None;
                }
                Ok(None) => {}
            }
            if started.elapsed() >= timeout || self.closing.load(Ordering::Acquire) {
                interrupted = true;
                signal_group(id, libc::SIGTERM);
                let grace = Instant::now();
                while grace.elapsed() < Duration::from_secs(2) {
                    if matches!(child.try_wait(), Ok(Some(_))) {
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
        let _ = child.wait();
        for reader in readers {
            if reader.join().is_err() {
                interrupted = true;
            }
        }
        self.children.lock().unwrap().remove(&id);
        let mut capture = capture.lock().unwrap();
        Ok(Output {
            code: status.and_then(|s| s.code()),
            stdout: std::mem::take(&mut capture.stdout),
            stderr: std::mem::take(&mut capture.stderr),
            logs: capture.logs.drain(..).collect(),
            truncated: capture.truncated,
            interrupted: interrupted || read_failed.load(Ordering::Acquire),
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
    let text = String::from_utf8_lossy(bytes);
    let mut clean = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.next() == Some('\\')) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if ch == '\n' || ch == '\t' || (!ch.is_control() && ch != '\u{7f}') {
            clean.push(ch);
        }
    }
    if clean.len() > limit {
        let mut start = clean.len() - limit;
        while !clean.is_char_boundary(start) {
            start += 1;
        }
        clean.drain(..start);
    }
    clean
}
