//! Container-owned interactive exec sessions with bounded, acknowledged output.
use super::*;
use std::collections::VecDeque;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
};

#[path = "engine_exec.rs"]
mod transport;
pub(super) use transport::ExecTarget;

const MAX_TERMINALS: usize = 8;
const CHUNK_BYTES: usize = 16 * 1024;
const WINDOW_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalShell {
    Sh,
    Bash,
}
impl TerminalShell {
    fn executable(self) -> &'static str {
        match self {
            Self::Sh => "/bin/sh",
            Self::Bash => "/bin/bash",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Connecting,
    Running,
    Exited,
    Disconnected,
    Failed,
}
impl TerminalStatus {
    fn active(self) -> bool {
        matches!(self, Self::Connecting | Self::Running)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDescriptor {
    pub session_id: String,
    pub terminal_id: String,
    pub container_id: String,
    pub container_name: String,
    pub shell: TerminalShell,
    pub status: TerminalStatus,
    pub exit_code: Option<i32>,
    pub error: Option<ApiError>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Status {
        terminal: TerminalDescriptor,
    },
    Output {
        session_id: String,
        terminal_id: String,
        sequence: u64,
        bytes: Vec<u8>,
    },
}
pub type TerminalSink = Arc<dyn Fn(TerminalEvent) -> Result<()> + Send + Sync>;

#[derive(Default)]
struct Credits {
    sent: u64,
    acknowledged: u64,
    pending: VecDeque<(u64, usize)>,
    bytes: usize,
}
impl Credits {
    fn available(&self) -> usize {
        WINDOW_BYTES - self.bytes
    }
    fn sent(&mut self, count: usize) -> u64 {
        assert!(count <= self.available());
        self.sent += 1;
        self.pending.push_back((self.sent, count));
        self.bytes += count;
        self.sent
    }
    fn acknowledge(&mut self, sequence: u64) -> Result<()> {
        if sequence > self.sent {
            return Err(ApiError::new(
                "TerminalProtocol",
                "Acknowledgment exceeds sent terminal output",
            ));
        }
        if sequence <= self.acknowledged {
            return Ok(());
        }
        while self
            .pending
            .front()
            .is_some_and(|(seq, _)| *seq <= sequence)
        {
            self.bytes -= self.pending.pop_front().unwrap().1;
        }
        self.acknowledged = sequence;
        Ok(())
    }
}
enum Input {
    Write {
        bytes: Vec<u8>,
        response: oneshot::Sender<Result<()>>,
        _permit: OwnedSemaphorePermit,
    },
}
struct Resize {
    cols: u16,
    rows: u16,
    response: oneshot::Sender<Result<()>>,
}
struct Terminal {
    descriptor: Mutex<TerminalDescriptor>,
    project: Option<String>,
    service: Option<String>,
    sink: TerminalSink,
    credits: Mutex<Credits>,
    wake: Notify,
    input: mpsc::Sender<Input>,
    resize: mpsc::Sender<Resize>,
    input_budget: Arc<Semaphore>,
    cancel: watch::Sender<bool>,
    worker: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}
impl Terminal {
    fn snapshot(&self) -> TerminalDescriptor {
        self.descriptor.lock().unwrap().clone()
    }
    fn status(&self, status: TerminalStatus, exit_code: Option<i32>, error: Option<ApiError>) {
        let terminal = {
            let mut descriptor = self.descriptor.lock().unwrap();
            // A stop request already revoked input authority. A late startup or
            // socket response must not revive it or rewrite its reason.
            if !descriptor.status.active() {
                return;
            }
            descriptor.status = status;
            descriptor.exit_code = exit_code;
            descriptor.error = error;
            descriptor.clone()
        };
        if let Err(error) = (self.sink)(TerminalEvent::Status { terminal }) {
            let mut descriptor = self.descriptor.lock().unwrap();
            if descriptor.status.active() {
                descriptor.status = TerminalStatus::Disconnected;
                descriptor.error = Some(error);
            }
            let _ = self.cancel.send(true);
        }
    }
    fn cancel(&self, error: Option<ApiError>) {
        self.status(TerminalStatus::Disconnected, None, error);
        let _ = self.cancel.send(true);
        self.wake.notify_one();
    }
    fn join(&self) {
        let mut worker = self.worker.lock().unwrap();
        if let Some(worker) = worker.take() {
            let _ = tauri::async_runtime::block_on(worker);
        }
    }
}
#[derive(Default)]
pub(super) struct TerminalManager {
    target: Option<(String, ExecTarget)>,
    terminals: Vec<Arc<Terminal>>,
}
impl TerminalManager {
    pub(super) fn bind(&mut self, session: &str, target: ExecTarget) {
        self.target = Some((session.into(), target));
    }
}
fn dimensions(cols: u16, rows: u16) -> Result<()> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        return Err(ApiError::new(
            "InvalidTerminalSize",
            "Terminal size must be 2–500 columns and 1–200 rows",
        ));
    }
    Ok(())
}

impl Core {
    pub fn start_container_terminal(
        &self,
        session_id: &str,
        generation: u64,
        handle: &str,
        shell: TerminalShell,
        cols: u16,
        rows: u16,
        sink: TerminalSink,
    ) -> Result<TerminalDescriptor> {
        dimensions(cols, rows)?;
        let terminal = {
            let state = self.state.lock().unwrap();
            if state.closing
                || state.diagnosing
                || state.mutating
                || state.compose_operation.is_some()
            {
                return Err(ApiError::new(
                    "Busy",
                    "Wait for the current environment operation",
                ));
            }
            let session = state
                .session
                .as_ref()
                .filter(|session| session.id == session_id)
                .ok_or_else(|| {
                    ApiError::new("StaleSession", "Reconnect before opening a terminal")
                })?;
            if session.stale || session.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before opening a terminal",
                ));
            }
            if session.generation != generation {
                return Err(ApiError::new(
                    "StaleHandle",
                    "Select the container from the latest list",
                ));
            }
            let container = session.handles.get(handle).ok_or_else(|| {
                ApiError::new("StaleHandle", "Select the container from the latest list")
            })?;
            if container.state != "running" {
                return Err(ApiError::new(
                    "TerminalUnavailable",
                    "Terminal requires a running container",
                ));
            }
            let mut manager = self.terminals.lock().unwrap();
            if manager
                .terminals
                .iter()
                .any(|terminal| terminal.snapshot().container_id == container.full_id)
            {
                return Err(ApiError::new(
                    "TerminalAlreadyOpen",
                    "This container already has a retained terminal; close it before opening another",
                ));
            }
            if manager.terminals.len() >= MAX_TERMINALS {
                return Err(ApiError::new(
                    "TerminalLimitReached",
                    "Eight terminals are retained; close an existing terminal before opening another",
                ));
            }
            let target = manager
                .target
                .as_ref()
                .filter(|(id, _)| id == session_id)
                .map(|(_, target)| target.clone())
                .ok_or_else(|| {
                    ApiError::new("NeedsValidation", "Reconnect before opening a terminal")
                })?;
            let (input, receiver) = mpsc::channel(64);
            let (resize, resizes) = mpsc::channel(8);
            let (cancel, cancelled) = watch::channel(false);
            let terminal = Arc::new(Terminal {
                descriptor: Mutex::new(TerminalDescriptor {
                    session_id: session_id.into(),
                    terminal_id: uuid::Uuid::new_v4().to_string(),
                    container_id: container.full_id.clone(),
                    container_name: container.name.clone(),
                    shell,
                    status: TerminalStatus::Connecting,
                    exit_code: None,
                    error: None,
                }),
                project: container.compose_project.clone(),
                service: container.compose_service.clone(),
                sink,
                credits: Mutex::new(Credits::default()),
                wake: Notify::new(),
                input,
                resize,
                input_budget: Arc::new(Semaphore::new(WINDOW_BYTES)),
                cancel,
                worker: Mutex::new(None),
            });
            // Publish the worker while Core authority is locked. Reconnect and
            // recovery can then cancel/join even a not-yet-started exec task.
            let worker_terminal = terminal.clone();
            let worker_target = target.clone();
            let core = self.clone();
            let mut worker = terminal.worker.lock().unwrap();
            *worker = Some(tauri::async_runtime::spawn(async move {
                run(
                    core,
                    worker_terminal,
                    worker_target,
                    receiver,
                    resizes,
                    cancelled,
                    cols,
                    rows,
                )
                .await;
            }));
            drop(worker);
            manager.terminals.push(terminal.clone());
            terminal
        };
        Ok(terminal.snapshot())
    }
    fn terminal(
        &self,
        session_id: &str,
        terminal_id: &str,
        writable: bool,
    ) -> Result<Arc<Terminal>> {
        let state = self.state.lock().unwrap();
        let session = state
            .session
            .as_ref()
            .filter(|session| session.id == session_id)
            .ok_or_else(|| {
                ApiError::new("StaleSession", "Terminal belongs to an older connection")
            })?;
        if writable && (state.closing || session.needs_validation) {
            return Err(ApiError::new(
                "NeedsValidation",
                "Reconnect before using the terminal",
            ));
        }
        let manager = self.terminals.lock().unwrap();
        let terminal = manager
            .terminals
            .iter()
            .find(|terminal| terminal.snapshot().terminal_id == terminal_id)
            .cloned()
            .ok_or_else(|| ApiError::new("TerminalClosed", "This terminal is closed"))?;
        if terminal.snapshot().session_id != session_id {
            return Err(ApiError::new(
                "StaleSession",
                "Terminal belongs to an older connection",
            ));
        }
        if writable && terminal.snapshot().status != TerminalStatus::Running {
            return Err(ApiError::new(
                "TerminalClosed",
                "This terminal is not connected",
            ));
        }
        Ok(terminal)
    }
    pub async fn write_container_terminal(
        &self,
        session_id: &str,
        terminal_id: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err(ApiError::new(
                "InvalidTerminalInput",
                "Terminal input must contain 1–16384 bytes",
            ));
        }
        let terminal = self.terminal(session_id, terminal_id, true)?;
        let permit = terminal
            .input_budget
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
            .map_err(|_| {
                ApiError::new(
                    "TerminalBackpressure",
                    "Terminal input is busy; pending input was not retried",
                )
            })?;
        let (response, result) = oneshot::channel();
        terminal
            .input
            .try_send(Input::Write {
                bytes,
                response,
                _permit: permit,
            })
            .map_err(|_| ApiError::new("TerminalBackpressure", "Terminal input queue is busy"))?;
        result.await.map_err(|_| {
            ApiError::new(
                "TerminalClosed",
                "Terminal disconnected before input was confirmed; it was not retried",
            )
        })?
    }
    pub async fn resize_container_terminal(
        &self,
        session_id: &str,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        dimensions(cols, rows)?;
        let terminal = self.terminal(session_id, terminal_id, true)?;
        let (response, result) = oneshot::channel();
        terminal
            .resize
            .try_send(Resize {
                cols,
                rows,
                response,
            })
            .map_err(|_| ApiError::new("TerminalBackpressure", "Terminal resize queue is busy"))?;
        result.await.map_err(|_| {
            ApiError::new(
                "TerminalClosed",
                "Terminal disconnected before resize completed",
            )
        })?
    }
    pub fn ack_container_terminal(
        &self,
        session_id: &str,
        terminal_id: &str,
        through_sequence: u64,
    ) -> Result<()> {
        let terminal = self.terminal(session_id, terminal_id, false)?;
        terminal
            .credits
            .lock()
            .unwrap()
            .acknowledge(through_sequence)?;
        terminal.wake.notify_one();
        Ok(())
    }
    pub fn disconnect_container_terminal(&self, session_id: &str, terminal_id: &str) -> Result<()> {
        let terminal = self.terminal(session_id, terminal_id, false)?;
        terminal.cancel(None);
        terminal.join();
        Ok(())
    }
    pub fn close_container_terminal(&self, session_id: &str, terminal_id: &str) -> Result<()> {
        let terminal = self.terminal(session_id, terminal_id, false)?;
        terminal.cancel(None);
        terminal.join();
        self.terminals
            .lock()
            .unwrap()
            .terminals
            .retain(|entry| !Arc::ptr_eq(entry, &terminal));
        Ok(())
    }
    pub(super) fn cancel_all_terminals(&self) {
        let terminals = {
            let mut manager = self.terminals.lock().unwrap();
            manager.target = None;
            std::mem::take(&mut manager.terminals)
        };
        for terminal in &terminals {
            terminal.cancel(Some(ApiError::new(
                "StaleSession",
                "The Engine connection was closed",
            )));
        }
        for terminal in terminals {
            terminal.join();
        }
    }
    pub(super) fn invalidate_terminals(&self, session_id: &str, error: &ApiError) {
        let terminals = self.terminals.lock().unwrap().terminals.clone();
        // Invalidation can originate inside a terminal task. Signal all peers,
        // but never synchronously join the caller from its own async worker.
        for terminal in terminals {
            if terminal.snapshot().session_id == session_id {
                terminal.cancel(Some(error.clone()));
            }
        }
    }
    pub(super) fn reconcile_terminals(&self, snapshot: &ContainerList) {
        let terminals = self.terminals.lock().unwrap().terminals.clone();
        for terminal in terminals {
            let current = terminal.snapshot();
            if current.session_id == snapshot.session_id
                && current.status.active()
                && !snapshot.containers.iter().any(|container| {
                    container.full_id == current.container_id && container.state == "running"
                })
            {
                terminal.cancel(Some(ApiError::new(
                    "TerminalUnavailable",
                    "The original container stopped, paused, or was removed",
                )));
            }
        }
    }
    pub(super) fn disconnect_terminal_targets(&self, session_id: &str, ids: &[String]) {
        let terminals: Vec<_> = self
            .terminals
            .lock()
            .unwrap()
            .terminals
            .iter()
            .filter(|terminal| {
                let current = terminal.snapshot();
                current.session_id == session_id && ids.contains(&current.container_id)
            })
            .cloned()
            .collect();
        for terminal in &terminals {
            terminal.cancel(Some(ApiError::new(
                "TerminalContainerChanged",
                "A container operation disconnected this terminal",
            )));
        }
        for terminal in terminals {
            terminal.join();
        }
    }
    pub(super) fn disconnect_compose_terminals(
        &self,
        session_id: &str,
        project: &str,
        services: Option<&[String]>,
    ) {
        let ids: Vec<_> = self
            .terminals
            .lock()
            .unwrap()
            .terminals
            .iter()
            .filter(|terminal| {
                terminal.project.as_deref() == Some(project)
                    && services.is_none_or(|services| {
                        terminal
                            .service
                            .as_ref()
                            .is_some_and(|service| services.contains(service))
                    })
            })
            .map(|terminal| terminal.snapshot().container_id)
            .collect();
        self.disconnect_terminal_targets(session_id, &ids);
    }
}

async fn run(
    core: Core,
    terminal: Arc<Terminal>,
    target: ExecTarget,
    receiver: mpsc::Receiver<Input>,
    resizes: mpsc::Receiver<Resize>,
    mut cancelled: watch::Receiver<bool>,
    cols: u16,
    rows: u16,
) {
    let result = tokio::select! {
        biased;
        _ = cancelled.wait_for(|cancel| *cancel) => return,
        result = run_connected(&terminal, &target, receiver, resizes, cols, rows) => result,
    };
    if let Err(error) = result {
        let status = if terminal.snapshot().status == TerminalStatus::Connecting {
            TerminalStatus::Failed
        } else {
            TerminalStatus::Disconnected
        };
        terminal.status(status, None, Some(error.clone()));
        if error.code == "EnvironmentChanged" {
            let id = terminal.snapshot().session_id;
            core.invalidate_observation(&id, &error);
        }
    }
}
async fn run_connected(
    terminal: &Arc<Terminal>,
    target: &ExecTarget,
    mut input: mpsc::Receiver<Input>,
    mut resizes: mpsc::Receiver<Resize>,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let descriptor = terminal.snapshot();
    let (exec_id, io) = target
        .start(&descriptor.container_id, descriptor.shell.executable())
        .await?;
    target.resize(&exec_id, rows, cols).await?;
    terminal.status(TerminalStatus::Running, None, None);
    let (mut reader, mut writer) = tokio::io::split(io);
    // Keep all three futures independently polled. In particular, a blocked
    // stdin write or slow resize must not prevent stdout from being drained.
    let read_output = async {
        let mut bytes = [0u8; CHUNK_BYTES];
        loop {
            let available = terminal
                .credits
                .lock()
                .unwrap()
                .available()
                .min(CHUNK_BYTES);
            if available == 0 {
                terminal.wake.notified().await;
                continue;
            }
            let count = reader.read(&mut bytes[..available]).await.map_err(|_| {
                ApiError::new(
                    "TerminalTransport",
                    "Terminal output was interrupted; it was not restarted",
                )
            })?;
            if count == 0 {
                match target.inspect(&exec_id, &descriptor.container_id).await? {
                    Some(code) => terminal.status(TerminalStatus::Exited, Some(code), None),
                    None => terminal.status(
                        TerminalStatus::Disconnected,
                        None,
                        Some(ApiError::new(
                            "TerminalTransport",
                            "The connection ended while the command may still be running",
                        )),
                    ),
                }
                return Ok(());
            }
            let sequence = terminal.credits.lock().unwrap().sent(count);
            (terminal.sink)(TerminalEvent::Output {
                session_id: descriptor.session_id.clone(),
                terminal_id: descriptor.terminal_id.clone(),
                sequence,
                bytes: bytes[..count].to_vec(),
            })?;
        }
    };
    let write_input = async {
        while let Some(Input::Write {
            bytes,
            response,
            _permit,
        }) = input.recv().await
        {
            let result = tokio::time::timeout(Duration::from_secs(5), writer.write_all(&bytes))
                .await
                .map_err(|_| {
                    ApiError::new(
                        "TerminalInputUnknown",
                        "Terminal input timed out; it was not retried",
                    )
                })
                .and_then(|result| {
                    result.map_err(|_| {
                        ApiError::new(
                            "TerminalInputUnknown",
                            "Terminal input was interrupted; it was not retried",
                        )
                    })
                });
            let error = result.as_ref().err().cloned();
            let _ = response.send(result);
            if let Some(error) = error {
                return Err(error);
            }
        }
        Ok(())
    };
    let control = async {
        let mut monitor = tokio::time::interval(Duration::from_secs(5));
        monitor.tick().await;
        loop {
            tokio::select! {
                resize = resizes.recv() => match resize {
                    Some(Resize { cols, rows, response }) => {
                        let result = target.resize(&exec_id, rows, cols).await;
                        let error = result.as_ref().err().cloned();
                        let _ = response.send(result);
                        if let Some(error) = error { return Err(error); }
                    }
                    None => return Ok(()),
                },
                _ = monitor.tick() => target.validate().await?,
            }
        }
    };
    tokio::select! {
        result = read_output => result,
        result = write_input => result,
        result = control => result,
    }
}

#[cfg(test)]
#[path = "docker_terminal_tests.rs"]
mod tests;
