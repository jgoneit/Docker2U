//! Incremental Docker framing; HTTP chunks, Docker frames, and log lines differ.
use super::{EngineEventRecord, LogRecord, LogStreamKind, ReaderError, valid_id};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use std::collections::BTreeMap;

const LINE_LIMIT: usize = 64 * 1024;
// A protocol frame can contain many lines. Never allocate its advertised length.
const FRAME_LIMIT: u32 = 16 * 1024 * 1024;

#[derive(Default)]
enum Escape {
    #[default]
    Text,
    Start,
    Csi,
    Osc,
    OscEnd,
}
#[derive(Default)]
struct LineDecoder {
    bytes: Vec<u8>,
    truncated: bool,
    escape: Escape,
}
impl LineDecoder {
    fn push(&mut self, bytes: &[u8], stream: LogStreamKind, emit: &mut impl FnMut(LogRecord)) {
        for &byte in bytes {
            match self.escape {
                Escape::Text if byte == 0x1b => self.escape = Escape::Start,
                Escape::Text if byte == b'\n' => self.emit(stream, emit),
                Escape::Text if byte == b'\t' || (byte >= 0x20 && byte != 0x7f) => {
                    if self.bytes.len() < LINE_LIMIT {
                        self.bytes.push(byte);
                    } else {
                        self.truncated = true;
                    }
                }
                Escape::Text => {}
                Escape::Start => {
                    self.escape = match byte {
                        b'[' => Escape::Csi,
                        b']' => Escape::Osc,
                        0x1b => Escape::Start,
                        _ => Escape::Text,
                    }
                }
                Escape::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.escape = Escape::Text;
                    } else if byte == 0x1b {
                        self.escape = Escape::Start;
                    }
                }
                Escape::Osc => {
                    if byte == 7 {
                        self.escape = Escape::Text;
                    } else if byte == 0x1b {
                        self.escape = Escape::OscEnd;
                    }
                }
                Escape::OscEnd => {
                    self.escape = match byte {
                        b'\\' | 7 => Escape::Text,
                        0x1b => Escape::OscEnd,
                        _ => Escape::Osc,
                    }
                }
            }
        }
    }
    fn emit(&mut self, stream: LogStreamKind, emit: &mut impl FnMut(LogRecord)) {
        if self.truncated {
            if let Err(error) = std::str::from_utf8(&self.bytes) {
                if error.error_len().is_none() {
                    self.bytes.truncate(error.valid_up_to());
                }
            }
        }
        let raw = String::from_utf8_lossy(&self.bytes);
        let (timestamp, text) = raw
            .split_once(' ')
            .and_then(|(prefix, text)| {
                // Only the Docker prefix is interpreted; never application timestamps.
                if prefix.len() > 40 {
                    return None;
                }
                DateTime::parse_from_rfc3339(prefix).ok().map(|stamp| {
                    (
                        stamp
                            .with_timezone(&Utc)
                            .to_rfc3339_opts(SecondsFormat::Nanos, true),
                        text.to_owned(),
                    )
                })
            })
            .map_or_else(
                || (None, raw.into_owned()),
                |(stamp, text)| (Some(stamp), text),
            );
        emit(LogRecord {
            timestamp,
            received_at: Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
            stream,
            text,
            truncated: self.truncated,
        });
        self.bytes.clear();
        self.truncated = false;
    }
    fn finish(&mut self, stream: LogStreamKind, emit: &mut impl FnMut(LogRecord)) {
        if !self.bytes.is_empty() || self.truncated {
            self.emit(stream, emit);
        }
    }
}

pub(super) struct LogDecoder {
    tty: bool,
    header: [u8; 8],
    header_len: usize,
    remaining: u32,
    stream: LogStreamKind,
    stdout: LineDecoder,
    stderr: LineDecoder,
}
impl LogDecoder {
    pub fn new(tty: bool) -> Self {
        Self {
            tty,
            header: [0; 8],
            header_len: 0,
            remaining: 0,
            stream: LogStreamKind::Stdout,
            stdout: LineDecoder::default(),
            stderr: LineDecoder::default(),
        }
    }
    pub fn push(
        &mut self,
        mut bytes: &[u8],
        eof: bool,
        emit: &mut impl FnMut(LogRecord),
    ) -> Result<(), ReaderError> {
        if self.tty {
            self.stdout.push(bytes, LogStreamKind::Tty, emit);
        } else {
            while !bytes.is_empty() {
                if self.remaining == 0 {
                    let length = (8 - self.header_len).min(bytes.len());
                    self.header[self.header_len..self.header_len + length]
                        .copy_from_slice(&bytes[..length]);
                    self.header_len += length;
                    bytes = &bytes[length..];
                    if self.header_len < 8 {
                        break;
                    }
                    if self.header[1..4] != [0, 0, 0] {
                        return Err(ReaderError::protocol(
                            "The Docker log frame header is malformed",
                        ));
                    }
                    self.stream = match self.header[0] {
                        0 | 1 => LogStreamKind::Stdout,
                        2 => LogStreamKind::Stderr,
                        _ => {
                            return Err(ReaderError::protocol(
                                "The Docker log stream returned an unsupported frame type",
                            ));
                        }
                    };
                    self.remaining = u32::from_be_bytes(self.header[4..8].try_into().unwrap());
                    self.header_len = 0;
                    if self.remaining > FRAME_LIMIT {
                        return Err(ReaderError::protocol(
                            "The Docker log frame exceeded its size limit",
                        ));
                    }
                    if self.remaining == 0 {
                        continue;
                    }
                }
                let length = (self.remaining as usize).min(bytes.len());
                match self.stream {
                    LogStreamKind::Stderr => self.stderr.push(&bytes[..length], self.stream, emit),
                    _ => self.stdout.push(&bytes[..length], self.stream, emit),
                }
                self.remaining -= length as u32;
                bytes = &bytes[length..];
            }
        }
        if eof {
            if !self.tty && (self.header_len != 0 || self.remaining != 0) {
                return Err(ReaderError::transport());
            }
            self.stdout.finish(
                if self.tty {
                    LogStreamKind::Tty
                } else {
                    LogStreamKind::Stdout
                },
                emit,
            );
            self.stderr.finish(LogStreamKind::Stderr, emit);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct EventWire {
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "Action")]
    action: String,
    #[serde(rename = "Actor")]
    actor: Actor,
    #[serde(rename = "timeNano")]
    time_nano: i64,
}
#[derive(Deserialize)]
struct Actor {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Attributes", default)]
    attributes: BTreeMap<String, serde_json::Value>,
}
#[derive(Default)]
pub(super) struct EventDecoder {
    bytes: Vec<u8>,
}
impl EventDecoder {
    pub fn push(
        &mut self,
        bytes: &[u8],
        eof: bool,
        emit: &mut impl FnMut(EngineEventRecord),
    ) -> Result<(), ReaderError> {
        for &byte in bytes {
            if byte == b'\n' {
                self.emit(emit)?;
            } else {
                if self.bytes.len() >= LINE_LIMIT {
                    return Err(ReaderError::protocol(
                        "The Engine event exceeded its size limit",
                    ));
                }
                self.bytes.push(byte);
            }
        }
        if eof && !self.bytes.is_empty() {
            self.emit(emit)?;
        }
        Ok(())
    }
    fn emit(&mut self, emit: &mut impl FnMut(EngineEventRecord)) -> Result<(), ReaderError> {
        if self.bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
            self.bytes.clear();
            return Ok(());
        }
        let event: EventWire = serde_json::from_slice(&self.bytes)
            .map_err(|_| ReaderError::protocol("The Engine event is malformed"))?;
        self.bytes.clear();
        if event.kind != "container" {
            return Ok(());
        }
        let allowed = matches!(
            event.action.as_str(),
            "create"
                | "start"
                | "stop"
                | "die"
                | "restart"
                | "kill"
                | "oom"
                | "pause"
                | "unpause"
                | "destroy"
                | "rename"
                | "health_status: starting"
                | "health_status: healthy"
                | "health_status: unhealthy"
        );
        if !allowed {
            return Ok(());
        }
        if !valid_id(&event.actor.id) || event.time_nano <= 0 {
            return Err(ReaderError::protocol(
                "The Engine event identity or timestamp is invalid",
            ));
        }
        let mut attributes = BTreeMap::new();
        // Arbitrary labels, exec commands, and environment values never leave this decoder.
        for key in [
            "name",
            "oldName",
            "exitCode",
            "signal",
            "com.docker.compose.project",
            "com.docker.compose.service",
        ] {
            if let Some(value) = event
                .actor
                .attributes
                .get(key)
                .and_then(|value| value.as_str())
            {
                let bounded: String = value
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(512)
                    .collect();
                attributes.insert(key.to_owned(), bounded);
            }
        }
        emit(EngineEventRecord {
            time_nano: event.time_nano,
            action: event.action,
            full_id: event.actor.id,
            attributes,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(stream: u8, body: &[u8]) -> Vec<u8> {
        let mut value = vec![stream, 0, 0, 0];
        value.extend_from_slice(&(body.len() as u32).to_be_bytes());
        value.extend_from_slice(body);
        value
    }
    #[test]
    fn split_headers_utf8_and_pipes_preserve_distinct_lines_and_nanoseconds() {
        let mut bytes = frame(1, b"2026-09-11T10:00:00.123456789Z fir");
        bytes.extend(frame(2, "2026-09-11T10:00:00.123456788Z 오류\n".as_bytes()));
        bytes.extend(frame(1, "st 한글\n".as_bytes()));
        let mut decoder = LogDecoder::new(false);
        let mut rows = Vec::new();
        for byte in bytes {
            decoder
                .push(&[byte], false, &mut |row| rows.push(row))
                .unwrap();
        }
        decoder.push(&[], true, &mut |row| rows.push(row)).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "오류");
        assert_eq!(rows[1].text, "first 한글");
        assert_eq!(rows[0].stream, LogStreamKind::Stderr);
        assert_eq!(
            rows[1].timestamp.as_deref(),
            Some("2026-09-11T10:00:00.123456789Z")
        );
    }
    #[test]
    fn tty_ansi_long_lines_and_final_partial_are_bounded() {
        let mut decoder = LogDecoder::new(true);
        let mut rows = Vec::new();
        decoder
            .push(b"\x1b]secret", false, &mut |row| rows.push(row))
            .unwrap();
        decoder
            .push(b"\x07\x1b[31mred\x1b[0m\n", false, &mut |row| {
                rows.push(row)
            })
            .unwrap();
        decoder
            .push(&vec![b'x'; LINE_LIMIT + 100], false, &mut |row| {
                rows.push(row)
            })
            .unwrap();
        decoder
            .push(b"\nlast", true, &mut |row| rows.push(row))
            .unwrap();
        assert_eq!(rows[0].text, "red");
        assert_eq!(rows[0].stream, LogStreamKind::Tty);
        assert_eq!(rows[1].text.len(), LINE_LIMIT);
        assert!(rows[1].truncated);
        assert_eq!(rows[2].text, "last");
    }
    #[test]
    fn rejects_invalid_or_incomplete_mux_without_large_allocation() {
        let mut decoder = LogDecoder::new(false);
        assert!(
            decoder
                .push(&[1, 0, 0, 0, 255, 255, 255, 255], false, &mut |_| {})
                .is_err()
        );
        let mut decoder = LogDecoder::new(false);
        assert!(
            decoder
                .push(&[1, 0], true, &mut |_| {})
                .unwrap_err()
                .transient
        );
    }
    #[test]
    fn events_keep_nanos_and_only_named_safe_attributes() {
        let input = format!(
            r#"{{"Type":"container","Action":"die","Actor":{{"ID":"{}","Attributes":{{"name":"api","exitCode":"1","secret":"token","execCommand":"hidden"}}}},"timeNano":1789120800123456789}}"#,
            "a".repeat(64)
        );
        let mut decoder = EventDecoder::default();
        let mut events = Vec::new();
        for bytes in input.as_bytes().chunks(3) {
            decoder
                .push(bytes, false, &mut |event| events.push(event))
                .unwrap();
        }
        decoder
            .push(&[], true, &mut |event| events.push(event))
            .unwrap();
        assert_eq!(events[0].time_nano, 1789120800123456789);
        assert_eq!(events[0].attributes.len(), 2);
        assert!(!events[0].attributes.contains_key("secret"));
    }
}
