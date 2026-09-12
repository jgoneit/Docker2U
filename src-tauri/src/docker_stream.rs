//! One bounded follow process, bound to a session and exact full container ID.
use super::*;
use crate::process::FollowProcess;
use std::{thread, time::Instant};

pub(super) struct ActiveLogStream {
    session_id: String,
    stream_id: String,
    full_id: String,
    process: FollowProcess,
    sequence: u64,
    terminal_error: Option<ApiError>,
    terminal_seen: bool,
    verified_at: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamStarted {
    pub session_id: String,
    pub stream_id: String,
    pub full_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStreamChunk {
    pub session_id: String,
    pub stream_id: String,
    pub sequence: u64,
    pub text: String,
    pub truncated: bool,
    pub terminal: bool,
    pub error: Option<ApiError>,
}

struct StartGuard(Arc<Mutex<State>>);
impl Drop for StartGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap().stream_starting = false;
    }
}

fn readable(state: &str) -> bool {
    matches!(
        state,
        "created" | "running" | "paused" | "restarting" | "exited" | "dead"
    )
}

impl Core {
    pub(super) fn cancel_log_stream(&self) {
        let stream = self.state.lock().unwrap().log_stream.take();
        if let Some(stream) = stream {
            stream.process.stop();
        }
    }

    /// Connection failures affect all readers of this session, not mutation authority
    /// from a resource-only timeout or malformed sample.
    pub(super) fn invalidate_observation(&self, id: &str, error: &ApiError) {
        if !connection_invalidated(error) {
            return;
        }
        let process = {
            let mut state = self.state.lock().unwrap();
            if let Some(session) = state.session.as_mut().filter(|session| session.id == id) {
                session.stale = true;
                session.needs_validation = true;
            }
            state
                .log_stream
                .as_mut()
                .filter(|stream| stream.session_id == id)
                .map(|stream| {
                    stream.terminal_error = Some(error.clone());
                    stream.process.clone()
                })
        };
        if let Some(process) = process {
            process.stop();
        }
        self.invalidate_session_observations(id, error);
    }

    /// Refresh regenerates handles. A still-readable full ID keeps the same stream.
    pub(super) fn reconcile_log_stream(&self) {
        let process = {
            let mut state = self.state.lock().unwrap();
            let issue = state.log_stream.as_ref().and_then(|stream| {
                let session = state
                    .session
                    .as_ref()
                    .filter(|session| session.id == stream.session_id);
                match session {
                    None => Some(ApiError::new(
                        "StaleSession",
                        "Log stream belongs to an older session",
                    )),
                    Some(session) if session.needs_validation => Some(ApiError::new(
                        "NeedsValidation",
                        "Reconnect before following logs",
                    )),
                    Some(session)
                        if !session.handles.values().any(|container| {
                            container.full_id == stream.full_id && readable(&container.state)
                        }) =>
                    {
                        Some(ApiError::new(
                            "ActionUnavailable",
                            "The log target is no longer readable in the current list",
                        ))
                    }
                    _ => None,
                }
            });
            issue.and_then(|error| {
                state.log_stream.as_mut().map(|stream| {
                    stream.terminal_error.get_or_insert(error);
                    stream.process.clone()
                })
            })
        };
        if let Some(process) = process {
            process.stop();
        }
    }

    pub fn start_log_stream(
        &self,
        id: &str,
        generation: u64,
        handle: &str,
    ) -> Result<LogStreamStarted> {
        let (session, container, previous, _reservation) = {
            let mut state = self.state.lock().unwrap();
            if state.stream_starting || state.refreshing || state.diagnosing || state.mutating {
                return Err(ApiError::new("Busy", "An operation is still in progress"));
            }
            let session = state
                .session
                .as_ref()
                .filter(|session| session.id == id)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleSession", "Reconnect before following logs"))?;
            if session.stale || session.needs_validation {
                return Err(ApiError::new(
                    "NeedsValidation",
                    "Refresh or reconnect before following logs",
                ));
            }
            if session.generation != generation {
                return Err(ApiError::new("StaleHandle", "Select from the latest list"));
            }
            let container = session
                .handles
                .get(handle)
                .cloned()
                .ok_or_else(|| ApiError::new("StaleHandle", "Select from the latest list"))?;
            if !readable(&container.state) {
                return Err(ApiError::new(
                    "ActionUnavailable",
                    "Logs are unavailable for this state",
                ));
            }
            state.stream_starting = true;
            let previous = state.log_stream.take();
            (session, container, previous, StartGuard(self.state.clone()))
        };
        if let Some(previous) = previous {
            previous.process.stop();
        }
        if let Err(error) = self.verify(&session.target) {
            self.invalidate_observation(id, &error);
            return Err(error);
        }
        {
            let state = self.state.lock().unwrap();
            let current = state.session.as_ref().is_some_and(|active| {
                active.id == id
                    && active.generation == generation
                    && !active.stale
                    && !active.needs_validation
            });
            if !current || state.refreshing || state.diagnosing || state.mutating {
                return Err(ApiError::new(
                    "StaleHandle",
                    "Log subscription was superseded during validation",
                ));
            }
        }
        let arguments = session.target.engine_args(&[
            "container",
            "logs",
            "--follow",
            "--tail",
            "300",
            "--timestamps",
            &container.full_id,
        ]);
        let process = self
            .runner
            .start_follow(&session.target.docker, &arguments, &session.target.env)
            .map_err(|error| ApiError::new("StartFailed", error))?;
        let stream_id = uuid::Uuid::new_v4().to_string();
        {
            let mut state = self.state.lock().unwrap();
            let current = state.session.as_ref().is_some_and(|active| {
                active.id == id
                    && active.generation == generation
                    && !active.stale
                    && !active.needs_validation
            });
            if !current || state.refreshing || state.diagnosing || state.mutating {
                drop(state);
                process.stop();
                return Err(ApiError::new(
                    "StaleHandle",
                    "Log subscription was superseded by another operation",
                ));
            }
            state.log_stream = Some(ActiveLogStream {
                session_id: id.into(),
                stream_id: stream_id.clone(),
                full_id: container.full_id.clone(),
                process,
                sequence: 0,
                terminal_error: None,
                terminal_seen: false,
                verified_at: Instant::now(),
            });
        }
        self.monitor_log_stream(id.to_owned(), stream_id.clone(), session.target);
        Ok(LogStreamStarted {
            session_id: id.into(),
            stream_id,
            full_id: container.full_id,
        })
    }

    fn monitor_log_stream(&self, id: String, stream_id: String, target: Target) {
        let core = self.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(100));
                let verify =
                    {
                        let state = core.state.lock().unwrap();
                        let Some(stream) = state.log_stream.as_ref().filter(|stream| {
                            stream.session_id == id && stream.stream_id == stream_id
                        }) else {
                            return;
                        };
                        if stream.terminal_error.is_some() || stream.terminal_seen {
                            return;
                        }
                        // Mutation/refresh own their existing validation and can briefly stale
                        // the list. Avoid overlapping their identity checks or killing their logs.
                        !state.mutating
                            && !state.refreshing
                            && !state.diagnosing
                            && stream.verified_at.elapsed() >= Duration::from_secs(5)
                    };
                if !verify {
                    continue;
                }
                let verified = core.verify(&target);
                let invalidated = verified.as_ref().is_err_and(connection_invalidated);
                let process = {
                    let mut state = core.state.lock().unwrap();
                    if !state.log_stream.as_ref().is_some_and(|stream| {
                        stream.session_id == id && stream.stream_id == stream_id
                    }) {
                        return;
                    }
                    if let Err(error) = &verified {
                        if connection_invalidated(error) {
                            if let Some(session) =
                                state.session.as_mut().filter(|session| session.id == id)
                            {
                                session.stale = true;
                                session.needs_validation = true;
                            }
                        }
                    }
                    let stream = state.log_stream.as_mut().unwrap();
                    stream.verified_at = Instant::now();
                    verified.err().map(|error| {
                        stream.terminal_error = Some(error);
                        stream.process.clone()
                    })
                };
                if let Some(process) = process {
                    if invalidated {
                        core.cancel_compose_session(&id);
                    }
                    process.stop();
                    return;
                }
            }
        });
    }

    pub fn read_log_stream(&self, id: &str, stream_id: &str) -> Result<LogStreamChunk> {
        let mut state = self.state.lock().unwrap();
        if !state
            .session
            .as_ref()
            .is_some_and(|session| session.id == id)
        {
            return Err(ApiError::new(
                "StaleSession",
                "Log stream belongs to an older session",
            ));
        }
        let stream = state
            .log_stream
            .as_mut()
            .filter(|stream| stream.session_id == id && stream.stream_id == stream_id)
            .ok_or_else(|| ApiError::new("StaleHandle", "Log subscription is no longer active"))?;
        let read = stream.process.read();
        // Stop joins the readers outside the Core lock. Publish terminal only once
        // their final bytes have reached the drain buffer, not when cancellation starts.
        let terminal = read.terminal;
        stream.terminal_seen |= terminal;
        let error = if terminal {
            stream.terminal_error.clone().or_else(|| {
                if read.terminal && (read.interrupted || read.exit_code != Some(0)) {
                    Some(ApiError {
                        code: "CommandFailed".into(),
                        message: "Live log stream ended unexpectedly".into(),
                        command: None,
                        stderr: Some(read.stderr),
                    })
                } else {
                    None
                }
            })
        } else {
            None
        };
        stream.sequence += 1;
        Ok(LogStreamChunk {
            session_id: id.into(),
            stream_id: stream_id.into(),
            sequence: stream.sequence,
            text: read.text,
            truncated: read.truncated,
            terminal,
            error,
        })
    }

    pub fn stop_log_stream(&self, id: &str, stream_id: &str) -> Result<()> {
        let stream = {
            let mut state = self.state.lock().unwrap();
            if state
                .log_stream
                .as_ref()
                .is_some_and(|stream| stream.session_id == id && stream.stream_id == stream_id)
            {
                state.log_stream.take()
            } else {
                None
            }
        };
        if let Some(stream) = stream {
            stream.process.stop();
        }
        Ok(())
    }
}
