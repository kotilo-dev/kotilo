//! `assistant_chat`: one chat turn through the hub (`POST /v1/assistant/chat`). The hub
//! answers with a chunked NDJSON stream (`meta`, `text` with the full answer so far, `done`);
//! every line is forwarded as parsed JSON. Non-200 answers and a broken stream become one
//! synthetic `done` line, so the page always ends on `done` unless the chat was stopped.
//!
//! Stopping closes the socket, which is how the hub learns to cancel. One chat at a time:
//! a new chat stops the running one. Text is never logged or stored.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

use crate::hub::{PortFile, TOKEN_HEADER};

const PATH: &str = "/v1/assistant/chat";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One message of the conversation the page sends (`{role, text}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub text: String,
}

/// Where the hub listens (loopback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

impl Endpoint {
    /// From the hub's `port.json`; `None` when the hub is not running.
    pub fn from_env() -> Option<Self> {
        let dir = crate::hub::data_dir(&|k| std::env::var(k).ok())?;
        let port = PortFile::read(&dir)?;
        Some(Self { port: port.port, token: port.token })
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Managed state: the running chat's stop switch, and the connection lock a chat holds
/// until its socket is closed (the hub answers 409 busy while the previous request is open).
#[derive(Default)]
pub struct ChatSlot {
    current: Mutex<Option<(u64, oneshot::Sender<()>)>>,
    next: AtomicU64,
    connection: Arc<tokio::sync::Mutex<()>>,
}

impl ChatSlot {
    /// Waits until no earlier chat holds a connection (it was stopped by [`ChatSlot::begin`]);
    /// hold the guard until [`run`] returns.
    pub async fn connection(&self) -> tokio::sync::OwnedMutexGuard<()> {
        Arc::clone(&self.connection).lock_owned().await
    }

    /// Starts a chat (stopping the running one) and returns its id and stop signal.
    pub fn begin(&self) -> (u64, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        if let Some((_, old)) = lock(&self.current).replace((id, tx)) {
            let _ = old.send(());
        }
        (id, rx)
    }

    /// The chat `id` ended by itself.
    pub fn end(&self, id: u64) {
        let mut current = lock(&self.current);
        if current.as_ref().is_some_and(|(i, _)| *i == id) {
            *current = None;
        }
    }

    /// Stops the running chat; false when none runs.
    pub fn stop(&self) -> bool {
        match lock(&self.current).take() {
            Some((_, tx)) => {
                let _ = tx.send(());
                true
            }
            None => false,
        }
    }
}

fn done(kind: &str, error: impl Into<String>) -> Value {
    json!({ "type": "done", "errorKind": kind, "error": error.into() })
}

/// The synthetic `done` line for a non-200 answer (`409 {error:"busy"|"disabled"}`, `400`
/// with field errors, anything else).
pub fn status_done(code: u16, body: &str) -> Value {
    #[derive(Deserialize, Default)]
    struct ErrorBody {
        error: Option<String>,
        message: Option<String>,
        fields: Option<Value>,
    }
    let body: ErrorBody = serde_json::from_str(body).unwrap_or_default();
    match code {
        409 => {
            let kind = match body.error.as_deref() {
                Some("disabled") => "disabled",
                _ => "busy",
            };
            done(kind, body.message.or(body.error).unwrap_or_else(|| kind.to_string()))
        }
        400 | 422 => {
            let mut line = done("invalid", body.message.or(body.error).unwrap_or_else(|| "invalid request".into()));
            if let Some(fields) = body.fields {
                line["fields"] = fields;
            }
            line
        }
        _ => done("hubUnavailable", format!("hub returned {code}")),
    }
}

/// Splits a byte stream into lines (`\n`, optional `\r`); a line split across chunks (or
/// inside a UTF-8 sequence) is kept until its end arrives.
#[derive(Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut lines = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            push_line(&mut lines, &line[..i]);
        }
        lines
    }

    /// The last line when the stream ended without a newline.
    pub fn finish(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        let rest = std::mem::take(&mut self.buf);
        push_line(&mut lines, &rest);
        lines
    }
}

fn push_line(lines: &mut Vec<String>, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if !text.is_empty() {
        lines.push(text.to_string());
    }
}

/// Forwards complete lines; returns true once a `done` line went out.
fn forward(lines: Vec<String>, emit: &mut impl FnMut(Value)) -> bool {
    let mut saw_done = false;
    for line in lines {
        match serde_json::from_str::<Value>(&line) {
            Ok(value) => {
                saw_done |= value.get("type").and_then(Value::as_str) == Some("done");
                emit(value);
            }
            Err(e) => log::warn!("assistant: unreadable stream line ({} chars): {e}", line.len()),
        }
    }
    saw_done
}

/// How a chat ended (for the log; no text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Finished,
    Stopped,
    Failed,
}

// A minimal HTTP/1.1 client: the hub is on loopback, plain HTTP, and the answer stream must
// be droppable mid-way. (reqwest is in the tree through the updater, but built without a
// TLS crypto provider there: creating a client panics.)

type Reader = BufReader<TcpStream>;

const MAX_LINE: u64 = 16 * 1024;
const MAX_CHUNK: usize = 16 * 1024 * 1024;
const MAX_ERROR_BODY: usize = 1024 * 1024;
/// `409 busy` is retried this many times in all, this far apart (~1.5 s).
const BUSY_ATTEMPTS: u32 = 6;
const BUSY_RETRY: Duration = Duration::from_millis(300);

fn bad(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

async fn read_line(reader: &mut Reader) -> io::Result<String> {
    let mut line = Vec::new();
    let n = (&mut *reader).take(MAX_LINE).read_until(b'\n', &mut line).await?;
    if n == 0 {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    if line.last() != Some(&b'\n') {
        return Err(bad("line too long"));
    }
    Ok(String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string())
}

/// How the response body is framed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    Chunked,
    Length(usize),
    UntilClose,
    Done,
}

/// Status code and body framing from the status line and the header lines.
pub fn parse_head(status_line: &str, headers: &[String]) -> io::Result<(u16, Framing)> {
    let mut parts = status_line.split_whitespace();
    let code = match (parts.next(), parts.next()) {
        (Some(version), Some(code)) if version.starts_with("HTTP/1.") => code.parse::<u16>().map_err(|_| bad("bad status"))?,
        _ => return Err(bad("bad status line")),
    };
    let mut framing = Framing::UntilClose;
    for header in headers {
        let Some((name, value)) = header.split_once(':') else { continue };
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked") {
            framing = Framing::Chunked;
        } else if name.eq_ignore_ascii_case("content-length") && framing != Framing::Chunked {
            framing = Framing::Length(value.parse().map_err(|_| bad("bad content-length"))?);
        }
    }
    Ok((code, framing))
}

async fn read_head(reader: &mut Reader) -> io::Result<(u16, Framing)> {
    let status = read_line(reader).await?;
    let mut headers = Vec::new();
    loop {
        let line = read_line(reader).await?;
        if line.is_empty() {
            break;
        }
        headers.push(line);
    }
    parse_head(&status, &headers)
}

/// The next piece of the body; `None` at its end.
async fn next_chunk(reader: &mut Reader, framing: &mut Framing) -> io::Result<Option<Vec<u8>>> {
    match *framing {
        Framing::Done => Ok(None),
        Framing::Chunked => {
            let line = read_line(reader).await?;
            let size_text = line.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size_text, 16).map_err(|_| bad("bad chunk size"))?;
            if size == 0 {
                // Trailers until the empty line.
                while !read_line(reader).await?.is_empty() {}
                *framing = Framing::Done;
                return Ok(None);
            }
            if size > MAX_CHUNK {
                return Err(bad("chunk too large"));
            }
            let mut data = vec![0u8; size];
            reader.read_exact(&mut data).await?;
            if !read_line(reader).await?.is_empty() {
                return Err(bad("bad chunk end"));
            }
            Ok(Some(data))
        }
        Framing::Length(0) => {
            *framing = Framing::Done;
            Ok(None)
        }
        Framing::Length(left) => {
            let mut data = vec![0u8; left.min(64 * 1024)];
            let n = reader.read(&mut data).await?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            data.truncate(n);
            *framing = Framing::Length(left - n);
            Ok(Some(data))
        }
        Framing::UntilClose => {
            let mut data = vec![0u8; 64 * 1024];
            let n = reader.read(&mut data).await?;
            if n == 0 {
                *framing = Framing::Done;
                return Ok(None);
            }
            data.truncate(n);
            Ok(Some(data))
        }
    }
}

/// Connects, sends the request and reads the response head.
async fn open(endpoint: &Endpoint, body: &[u8]) -> io::Result<(Reader, u16, Framing)> {
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", endpoint.port)))
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    let mut reader = BufReader::new(stream);
    let head = format!(
        "POST {PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{TOKEN_HEADER}: {}\r\nContent-Type: application/json\r\n\
         Accept: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        endpoint.port,
        endpoint.token,
        body.len()
    );
    let stream = reader.get_mut();
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await?;
    let (code, framing) = read_head(&mut reader).await?;
    Ok((reader, code, framing))
}

/// Runs one chat turn: posts `messages`, forwards every stream line to `emit`, until the
/// stream ends or `stop` fires (then nothing more is emitted and the socket is closed).
pub async fn run(
    endpoint: Option<Endpoint>,
    messages: &[ChatMessage],
    mut stop: oneshot::Receiver<()>,
    mut emit: impl FnMut(Value),
) -> Outcome {
    let Some(endpoint) = endpoint else {
        emit(done("hubUnavailable", format!("the {} background service is not running", crate::brand::NAME)));
        return Outcome::Failed;
    };
    let body = match serde_json::to_vec(&json!({ "messages": messages })) {
        Ok(b) => b,
        Err(e) => {
            emit(done("invalid", e.to_string()));
            return Outcome::Failed;
        }
    };
    let mut attempt = 0;
    let (mut reader, mut framing) = loop {
        attempt += 1;
        let (mut reader, code, mut framing) = tokio::select! {
            _ = &mut stop => return Outcome::Stopped,
            r = open(&endpoint, &body) => match r {
                Ok(opened) => opened,
                Err(e) => {
                    log::info!("assistant: hub request failed: {e}");
                    emit(done("hubUnavailable", format!("the {} background service is not reachable", crate::brand::NAME)));
                    return Outcome::Failed;
                }
            },
        };
        if code == 200 {
            break (reader, framing);
        }
        let mut text = Vec::new();
        loop {
            let chunk = tokio::select! {
                _ = &mut stop => return Outcome::Stopped,
                c = next_chunk(&mut reader, &mut framing) => c,
            };
            match chunk {
                Ok(Some(bytes)) if text.len() < MAX_ERROR_BODY => text.extend_from_slice(&bytes),
                _ => break,
            }
        }
        drop(reader);
        let line = status_done(code, &String::from_utf8_lossy(&text));
        // Right after a stopped chat the hub may still be killing its process: retry briefly.
        if line["errorKind"] == "busy" && attempt < BUSY_ATTEMPTS {
            tokio::select! {
                _ = &mut stop => return Outcome::Stopped,
                _ = tokio::time::sleep(BUSY_RETRY) => continue,
            }
        }
        emit(line);
        return Outcome::Failed;
    };
    let mut lines = LineSplitter::default();
    let mut saw_done = false;
    loop {
        let chunk = tokio::select! {
            // Returning drops `reader`: the socket closes and the hub cancels the answer.
            _ = &mut stop => return Outcome::Stopped,
            c = next_chunk(&mut reader, &mut framing) => c,
        };
        match chunk {
            Ok(Some(bytes)) => saw_done |= forward(lines.push(&bytes), &mut emit),
            Ok(None) => {
                saw_done |= forward(lines.finish(), &mut emit);
                break;
            }
            Err(e) => {
                log::info!("assistant: answer stream broke: {e}");
                break;
            }
        }
    }
    if saw_done {
        Outcome::Finished
    } else {
        emit(done("hubUnavailable", "the answer stream ended early"));
        Outcome::Failed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    #[test]
    fn messages_wire_format() {
        let m: Vec<ChatMessage> =
            serde_json::from_str(r#"[{"role":"user","text":"hi"},{"role":"assistant","text":"hello"}]"#).unwrap();
        assert_eq!(m[1].role, Role::Assistant);
        assert_eq!(serde_json::to_value(&m[0]).unwrap(), json!({"role":"user","text":"hi"}));
        assert!(serde_json::from_str::<ChatMessage>(r#"{"role":"system","text":"x"}"#).is_err());
    }

    #[test]
    fn splitter_keeps_partial_lines_and_utf8_across_chunks() {
        let mut s = LineSplitter::default();
        let bytes = "{\"text\":\"ğü\"}\r\n\n{\"a\":1}".as_bytes();
        // Split inside the two-byte "ğ".
        let cut = bytes.iter().position(|b| *b >= 0x80).unwrap() + 1;
        assert!(s.push(&bytes[..cut]).is_empty());
        assert_eq!(s.push(&bytes[cut..]), vec!["{\"text\":\"ğü\"}".to_string()]);
        assert_eq!(s.finish(), vec!["{\"a\":1}".to_string()]);
        assert!(s.finish().is_empty());
    }

    #[test]
    fn response_head_framing() {
        let h = |lines: &[&str]| lines.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_head("HTTP/1.1 200 OK", &h(&["Content-Type: application/x-ndjson; charset=utf-8", "Transfer-Encoding: chunked"])).unwrap(),
            (200, Framing::Chunked)
        );
        assert_eq!(parse_head("HTTP/1.1 409 Conflict", &h(&["content-length: 16"])).unwrap(), (409, Framing::Length(16)));
        assert_eq!(parse_head("HTTP/1.0 500 Oops", &[]).unwrap(), (500, Framing::UntilClose));
        assert!(parse_head("garbage", &[]).is_err());
        assert!(parse_head("HTTP/1.1 200 OK", &h(&["Content-Length: x"])).is_err());
    }

    #[test]
    fn non_200_answers_become_one_done_line() {
        assert_eq!(status_done(409, r#"{"error":"busy"}"#), json!({"type":"done","errorKind":"busy","error":"busy"}));
        assert_eq!(status_done(409, r#"{"error":"disabled"}"#)["errorKind"], "disabled");
        let invalid = status_done(400, r#"{"error":"invalidRequest","message":"Bad.","fields":{"messages":["required"]}}"#);
        assert_eq!(invalid["errorKind"], "invalid");
        assert_eq!(invalid["error"], "Bad.");
        assert_eq!(invalid["fields"]["messages"][0], "required");
        assert_eq!(status_done(500, "oops"), json!({"type":"done","errorKind":"hubUnavailable","error":"hub returned 500"}));
    }

    #[test]
    fn slot_runs_one_chat_at_a_time() {
        let slot = ChatSlot::default();
        let (a, mut stop_a) = slot.begin();
        let (b, mut stop_b) = slot.begin();
        assert!(stop_a.try_recv().is_ok(), "a new chat stops the running one");
        slot.end(a); // too late: does not clear b
        assert!(slot.stop());
        assert!(stop_b.try_recv().is_ok());
        assert!(!slot.stop());
        slot.end(b);
    }

    /// Fake hub: answers one request with `head` and then the `chunks` in HTTP chunked
    /// encoding (each after `gap`), reports the request head, and whether the client
    /// closed the connection before the end.
    fn fake_stream(head: &'static str, chunks: Vec<String>, gap: Duration) -> (Endpoint, mpsc::Receiver<(String, bool)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                request.push_str(&line);
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            request.push_str(&String::from_utf8(body).unwrap());
            let mut stream = stream;
            let mut aborted = stream.write_all(head.as_bytes()).is_err();
            for chunk in chunks {
                std::thread::sleep(gap);
                let framed = format!("{:x}\r\n{chunk}\r\n", chunk.len());
                if stream.write_all(framed.as_bytes()).and_then(|_| stream.flush()).is_err() {
                    aborted = true;
                    break;
                }
            }
            if !aborted {
                aborted = stream.write_all(b"0\r\n\r\n").is_err();
            }
            if !aborted {
                // A client that hung up: the read sees EOF (or a reset) right away.
                stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
                aborted = matches!(reader.read(&mut [0u8; 1]), Ok(0) | Err(_));
            }
            let _ = tx.send((request, aborted));
        });
        (Endpoint { port, token: "secret".into() }, rx)
    }

    const STREAM_HEAD: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";

    fn user(text: &str) -> Vec<ChatMessage> {
        vec![ChatMessage { role: Role::User, text: text.into() }]
    }

    #[tokio::test]
    async fn forwards_every_line_and_sends_the_token() {
        let chunks = vec![
            "{\"type\":\"meta\",\"provider\":\"x\"}\n{\"type\":\"te".to_string(),
            "xt\",\"text\":\"Hel\"}\n".to_string(),
            "{\"type\":\"text\",\"text\":\"Hello\"}\n{\"type\":\"done\",\"errorKind\":null}\n".to_string(),
        ];
        let (endpoint, server) = fake_stream(STREAM_HEAD, chunks, Duration::from_millis(5));
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        let outcome = run(Some(endpoint), &user("hi"), stop, |v| seen.push(v)).await;
        assert_eq!(outcome, Outcome::Finished);
        let types: Vec<&str> = seen.iter().map(|v| v["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["meta", "text", "text", "done"]);
        assert_eq!(seen[2]["text"], "Hello");
        let (request, _) = server.recv().unwrap();
        assert!(request.starts_with("POST /v1/assistant/chat "));
        assert!(request.to_ascii_lowercase().contains("x-agenthub-token: secret"));
        assert!(request.ends_with(r#"{"messages":[{"role":"user","text":"hi"}]}"#));
    }

    #[tokio::test]
    async fn disabled_hub_gives_one_done_line() {
        let head = "HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"error\":\"disabled\"}";
        let (endpoint, _server) = fake_stream(head, Vec::new(), Duration::ZERO);
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(Some(endpoint), &user("hi"), stop, |v| seen.push(v)).await, Outcome::Failed);
        assert_eq!(seen, vec![json!({"type":"done","errorKind":"disabled","error":"disabled"})]);
    }

    /// Answers `busy` to the first `busy` requests, then streams one `done` line.
    fn busy_then_ok(busy: usize) -> (Endpoint, std::thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut served = 0;
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap();
                    }
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                }
                reader.read_exact(&mut vec![0u8; length]).unwrap();
                served += 1;
                if served <= busy {
                    let body = r#"{"error":"busy"}"#;
                    let head = format!("HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    stream.write_all(format!("{head}{body}").as_bytes()).unwrap();
                } else {
                    let line = "{\"type\":\"done\",\"errorKind\":null}\n";
                    stream.write_all(format!("{STREAM_HEAD}{:x}\r\n{line}\r\n0\r\n\r\n", line.len()).as_bytes()).unwrap();
                    return served;
                }
            }
            served
        });
        (Endpoint { port, token: "t".into() }, handle)
    }

    #[tokio::test]
    async fn busy_right_after_a_stop_is_retried() {
        let (endpoint, server) = busy_then_ok(2);
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(Some(endpoint), &user("hi"), stop, |v| seen.push(v)).await, Outcome::Finished);
        assert_eq!(seen, vec![json!({"type":"done","errorKind":null})]);
        assert_eq!(server.join().unwrap(), 3);
    }

    #[tokio::test]
    async fn a_hub_that_stays_busy_gives_one_done_line() {
        let (endpoint, _server) = busy_then_ok(usize::MAX);
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(Some(endpoint), &user("hi"), stop, |v| seen.push(v)).await, Outcome::Failed);
        assert_eq!(seen, vec![json!({"type":"done","errorKind":"busy","error":"busy"})]);
    }

    #[tokio::test]
    async fn a_new_chat_waits_for_the_stopped_one_to_close() {
        let slot = ChatSlot::default();
        let (_a, _stop_a) = slot.begin();
        let guard_a = slot.connection().await;
        let (_b, _stop_b) = slot.begin();
        let waiting = tokio::time::timeout(Duration::from_millis(50), slot.connection()).await;
        assert!(waiting.is_err(), "b waits while a still holds its connection");
        drop(guard_a);
        assert!(tokio::time::timeout(Duration::from_secs(1), slot.connection()).await.is_ok());
    }

    #[tokio::test]
    async fn a_stream_without_done_ends_with_a_synthetic_one() {
        let (endpoint, _server) = fake_stream(STREAM_HEAD, vec!["{\"type\":\"meta\"}\n".into()], Duration::ZERO);
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(Some(endpoint), &user("hi"), stop, |v| seen.push(v)).await, Outcome::Failed);
        assert_eq!(seen.last().unwrap()["errorKind"], "hubUnavailable");
    }

    #[tokio::test]
    async fn no_hub_is_unavailable() {
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(None, &user("hi"), stop, |v| seen.push(v)).await, Outcome::Failed);
        assert_eq!(seen[0]["errorKind"], "hubUnavailable");
        // Nothing listens on this port.
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let dead = Endpoint { port, token: "t".into() };
        let (_tx, stop) = oneshot::channel();
        let mut seen = Vec::new();
        assert_eq!(run(Some(dead), &user("hi"), stop, |v| seen.push(v)).await, Outcome::Failed);
        assert_eq!(seen[0]["errorKind"], "hubUnavailable");
    }

    #[tokio::test]
    async fn stop_closes_the_connection_and_emits_nothing_more() {
        let chunks: Vec<String> = (0..50).map(|i| format!("{{\"type\":\"text\",\"text\":\"{i}\"}}\n")).collect();
        let (endpoint, server) = fake_stream(STREAM_HEAD, chunks, Duration::from_millis(40));
        let (tx, stop) = oneshot::channel();
        let mut tx = Some(tx);
        let mut seen = Vec::new();
        let outcome = run(Some(endpoint), &user("hi"), stop, |v| {
            seen.push(v);
            if let Some(tx) = tx.take() {
                let _ = tx.send(());
            }
        })
        .await;
        assert_eq!(outcome, Outcome::Stopped);
        assert_eq!(seen.len(), 1);
        let (_, aborted) = server.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(aborted, "the hub must see the client hang up");
    }
}
