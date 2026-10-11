//! Faz 5 §1.3: the hook endpoint — a tokio named pipe server on
//! `\\.\pipe\agenthub-<app pid>`, handed to every PTY pane via `AGENTHUB_ENDPOINT` and
//! written to by `agenthub-hook` (`agenthub-hook`).
//!
//! Each connection carries exactly one message: a [`agenthub_proto::HookMessage`],
//! JSON-encoded, optionally followed by a trailing newline — read up to a 1 MiB cap and
//! decoded. A successfully decoded message is funneled onto a single `mpsc` channel
//! that one dedicated task drains, in receive order, into
//! [`crate::agents::AgentTracker::on_hook`] (spec §4 item 5: this — rather than letting
//! every connection's own task call `on_hook` directly — is what keeps ordering
//! predictable when several hooks fire in quick succession, each its own pipe
//! connection). Anything that *doesn't* decode as a `HookMessage` is, in debug builds
//! only, tried as the dev-only input control channel (see `try_dev_control` below); in a
//! release build that code path doesn't exist at all.
//!
//! Optional diagnostics: with `AGENTHUB_DEBUG=1`, one metadata line per decoded hook
//! message is appended to `%APPDATA%\kotilo\hooks.log` (agent, event, session id, pane
//! id, payload byte length; never payload content, AGENTS.md rule 5). There is no
//! `hook:message` Tauri event any more — the frontend's signal is `agents:changed`.

use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use tauri::{AppHandle, Manager};

use crate::agents::AgentTracker;
use crate::pty::PtyRegistry;

/// Spec §1.3: a connection is read up to this many bytes; anything past it is never
/// consumed (mirrors `agenthub-hook`'s own cap on the write side).
const MAX_MESSAGE_BYTES: u64 = 1024 * 1024;

/// `\\.\pipe\agenthub-<pid>` (D1) — `pid` is the Kotilo app's own process id, shared
/// by every pane spawned this run (passed to each as `AGENTHUB_ENDPOINT`).
/// The pane whose shell is the nearest ancestor in `chain` (hook pid's ancestors, nearest first).
pub fn pane_for_chain<'a>(panes: &'a [crate::pty::PaneSummary], chain: &[u32]) -> Option<&'a crate::pty::PaneSummary> {
    chain
        .iter()
        .find_map(|pid| panes.iter().find(|p| p.shell_pid == *pid))
}

pub fn pipe_name(pid: u32) -> String {
    format!(r"\\.\pipe\{}-{pid}", crate::brand::EXE_PREFIX)
}

fn debug_enabled() -> bool {
    std::env::var(agenthub_proto::ENV_DEBUG).ok().as_deref() == Some("1")
}

/// One `hooks.log` line: metadata only (agent, event, session id, pane id, payload byte
/// length). The payload itself is never written (AGENTS.md rule 5).
pub fn hook_log_line(msg: &agenthub_proto::HookMessage) -> String {
    let session = ["session_id", "sessionId", "conversation_id"]
        .iter()
        .find_map(|key| msg.payload.get(key).and_then(|v| v.as_str()))
        .unwrap_or_default();
    let payload_bytes = serde_json::to_vec(&msg.payload).map(|b| b.len()).unwrap_or(0);
    serde_json::json!({
        "tsMs": msg.ts_ms,
        "agent": msg.agent,
        "event": msg.event,
        "sessionId": session,
        "paneId": msg.pane_id,
        "payloadBytes": payload_bytes,
    })
    .to_string()
}

/// Optional dev/diagnostics log (spec §1.3) — never on by default.
fn debug_log_hook(msg: &agenthub_proto::HookMessage) {
    use std::io::Write;

    if !debug_enabled() {
        return;
    }
    let dir = crate::persistence::state_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hooks.log"))
    {
        let _ = writeln!(file, "{}", hook_log_line(msg));
    }
}

/// Spec §4 finding 8: initial/max backoff for retrying a failed connect (or a failed
/// attempt to stand up the next listening pipe instance) — doubles each consecutive
/// failure, reset to the initial value after a successful connect.
const CONNECT_RETRY_INITIAL_BACKOFF_MS: u64 = 100;
const CONNECT_RETRY_MAX_BACKOFF_MS: u64 = 2000;

fn next_backoff_ms(current_ms: u64) -> u64 {
    (current_ms * 2).min(CONNECT_RETRY_MAX_BACKOFF_MS)
}

/// Creates one listening instance of the hook pipe, logging (and returning `None`,
/// never panicking) on failure. `first` must be `true` only for the very first instance
/// of the pipe's whole lifetime (`ServerOptions::first_pipe_instance`) — passing it for
/// a later instance would fail spuriously, since an instance already exists by then.
fn create_pipe_instance(name: &str, first: bool) -> Option<NamedPipeServer> {
    let mut opts = ServerOptions::new();
    if first {
        opts.first_pipe_instance(true);
    }
    match opts.create(name) {
        Ok(server) => Some(server),
        Err(err) => {
            log::warn!("failed to create hook pipe {name}: {err}");
            None
        }
    }
}

/// Starts the named pipe server in the background (call from `setup` via
/// `tauri::async_runtime::spawn`). Runs until the process exits — spec §4 finding 8: a
/// `connect()` error (or a failure to stand up the next listening instance) is logged
/// and retried, with a bounded exponential backoff, rather than ever breaking the loop
/// for good.
pub async fn run(app: AppHandle) {
    let pid = std::process::id();
    let name = pipe_name(pid);

    let (tx, mut rx) = mpsc::channel::<agenthub_proto::HookMessage>(256);

    // The single tracker-consumer task (spec §4 item 5): every decoded HookMessage,
    // regardless of which connection it arrived on, is applied here in receive order.
    {
        let app_for_tracker = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(mut msg) = rx.recv().await {
                let Some(pty) = app_for_tracker.try_state::<PtyRegistry>() else {
                    continue;
                };
                // M1: agents that drop our pane environment (Codex) send the hook's
                // ancestor pids instead; the nearest one that is a pane shell names the pane.
                if msg.pane_id.is_empty() {
                    if let Some(pane) = pane_for_chain(&pty.pane_summaries(), &msg.chain) {
                        msg.pane_id = pane.pane_id.clone();
                        msg.workspace_id = pane.workspace_id.clone();
                    }
                }
                // Spec §4 finding 2: a hook message for a pane the `PtyRegistry`
                // doesn't (any more) know about — queued right before `pane_died`, or
                // an escaped/never-tracked process — must never reach `on_hook` at all,
                // or it would create a ghost record that then lives forever.
                let known_pane = pty.shell_pid(&msg.pane_id).is_some();
                if let Some(tracker) = app_for_tracker.try_state::<AgentTracker>() {
                    tracker.on_hook(&msg, known_pane);
                }
            }
        });
    }

    let mut pending = create_pipe_instance(&name, true);
    let mut backoff_ms = CONNECT_RETRY_INITIAL_BACKOFF_MS;

    loop {
        let Some(server) = pending.take() else {
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = next_backoff_ms(backoff_ms);
            pending = create_pipe_instance(&name, false);
            continue;
        };

        if let Err(err) = server.connect().await {
            log::warn!("hook pipe connect error: {err}");
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = next_backoff_ms(backoff_ms);
            pending = create_pipe_instance(&name, false);
            continue;
        }
        backoff_ms = CONNECT_RETRY_INITIAL_BACKOFF_MS;

        // Stand up the next listening instance before handing this connection off, so
        // a second client is never left waiting on a pipe with no free instance.
        pending = create_pipe_instance(&name, false);

        let app = app.clone();
        let tx = tx.clone();
        tauri::async_runtime::spawn(handle_connection(server, app, tx));
    }
}

async fn handle_connection(
    mut pipe: NamedPipeServer,
    app: AppHandle,
    tx: mpsc::Sender<agenthub_proto::HookMessage>,
) {
    let mut buf = Vec::new();
    {
        let mut limited = (&mut pipe).take(MAX_MESSAGE_BYTES);
        if let Err(err) = limited.read_to_end(&mut buf).await {
            log::debug!("hook pipe read error: {err}");
            return;
        }
    }
    if buf.is_empty() {
        return;
    }

    match agenthub_proto::decode(&buf) {
        Ok(msg) => {
            debug_log_hook(&msg);
            let _ = tx.send(msg).await;
        }
        Err(err) => {
            // Faz 7 spec §9.2: bytes that parse as JSON in a debug build are the
            // dev-only input-control channel's normal shape (`{"type":"input",...}`),
            // not a real hook message at all — checked *before* warning so that
            // expected, harmless traffic never logs a warning. (`try_dev_control` always
            // returns `false` in a release build, so this never suppresses a real one
            // there.)
            if try_dev_control(&app, &buf) {
                return;
            }
            // An unresolvable hook message is logged at `warn` — its byte size and a
            // structural classification of the parse failure only, never the
            // `serde_json::Error`'s `Display`, which can quote fragments of the payload
            // back verbatim (e.g. `invalid type: string "secret", expected ...`).
            log::warn!(
                "hook pipe: unresolved message len={} category={:?} line={} column={}",
                buf.len(),
                err.classify(),
                err.line(),
                err.column()
            );
        }
    }
}

// ---------------------------------------------------------------------------------
// Dev-only input control (spec §1.3 Revizyon: exists *only* in a debug build — no code
// path at all in release). `"type":"input"` with a `pane_id` (or `"pane":"first"`,
// meaning the first pane spawned this run) and `data` writes straight into that pane's
// PTY, so the orchestrator can drive a terminal without focusing the window (see
// `spikes/send-input.ps1`).
// ---------------------------------------------------------------------------------

/// Returns `true` when `buf` parsed as JSON at all (and was handed to
/// `handle_dev_control`) — the caller uses this to skip logging a "failed to decode a
/// hook message" warning for bytes that were never meant to be one.
#[cfg(debug_assertions)]
fn try_dev_control(app: &AppHandle, buf: &[u8]) -> bool {
    match parse_message(buf) {
        Ok(value) => {
            handle_dev_control(app, &value);
            true
        }
        Err(_) => false,
    }
}

#[cfg(not(debug_assertions))]
fn try_dev_control(_app: &AppHandle, _buf: &[u8]) -> bool {
    false
}

/// Parses one connection's raw bytes (a JSON object, possibly with a trailing newline)
/// into a [`serde_json::Value`] — only ever reached in a debug build, for the dev input
/// control channel (real hook messages go through `agenthub_proto::decode`).
#[cfg(debug_assertions)]
pub fn parse_message(bytes: &[u8]) -> serde_json::Result<serde_json::Value> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.trim())
}

/// Resolves the dev-input control's target pane: an explicit `pane_id`, an explicit
/// `pane` (taken as a literal pane id unless it's the literal string `"first"`, which
/// resolves against `first_pane_id`), or `None` if the message names no pane.
#[cfg(debug_assertions)]
pub fn resolve_target_pane(msg: &serde_json::Value, first_pane_id: Option<&str>) -> Option<String> {
    if let Some(pane_id) = msg.get("pane_id").and_then(serde_json::Value::as_str) {
        return Some(pane_id.to_string());
    }
    match msg.get("pane").and_then(serde_json::Value::as_str) {
        Some("first") => first_pane_id.map(str::to_string),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

#[cfg(debug_assertions)]
fn handle_dev_control(app: &AppHandle, msg: &serde_json::Value) {
    use tauri::Manager;

    let Some(msg_type) = msg.get("type").and_then(serde_json::Value::as_str) else {
        return;
    };
    match msg_type {
        "input" => {
            let Some(data) = msg.get("data").and_then(serde_json::Value::as_str) else {
                return;
            };
            let Some(registry) = app.try_state::<crate::pty::PtyRegistry>() else {
                return;
            };
            let first_pane_id = registry.first_pane_id();
            let Some(pane_id) = resolve_target_pane(msg, first_pane_id.as_deref()) else {
                return;
            };
            if let Err(err) = registry.write_to_pane(&pane_id, data) {
                log::debug!("dev input control: {err}");
            }
        }
        "screen" => {
            // Reserved (spike leftover); not used.
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(debug_assertions)]
    use serde_json::json;

    #[test]
    fn pane_for_chain_picks_the_nearest_pane_shell() {
        let pane = |id: &str, pid: u32| crate::pty::PaneSummary {
            pane_id: id.to_string(),
            workspace_id: "w".to_string(),
            shell_pid: pid,
        };
        let panes = vec![pane("outer", 100), pane("inner", 300)];
        // hook <- pwsh(400) <- codex(350) <- pane shell(300) <- ... <- outer shell(100)
        assert_eq!(pane_for_chain(&panes, &[400, 350, 300, 200, 100]).unwrap().pane_id, "inner");
        assert!(pane_for_chain(&panes, &[1, 2, 3]).is_none());
        assert!(pane_for_chain(&panes, &[]).is_none());
    }

    #[test]
    fn hook_log_line_has_metadata_only() {
        let payload = serde_json::json!({
            "session_id": "s-1",
            "tool_input": {"command": "SECRET", "content": "SECRET"},
            "tool_response": "SECRET",
        });
        let bytes = serde_json::to_vec(&payload).unwrap().len();
        let msg = agenthub_proto::HookMessage::new("pane-1", "ws", "PostToolUse", 7, payload).with_agent("codex");
        let line = hook_log_line(&msg);
        assert!(!line.contains("SECRET"), "{line}");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["agent"], "codex");
        assert_eq!(v["event"], "PostToolUse");
        assert_eq!(v["sessionId"], "s-1");
        assert_eq!(v["paneId"], "pane-1");
        assert_eq!(v["payloadBytes"], bytes);
    }

    #[test]
    fn pipe_name_matches_expected_format() {
        assert_eq!(pipe_name(1234), format!(r"\\.\pipe\{}-1234", crate::brand::EXE_PREFIX));
    }

    // -- Spec §4 finding 8: bounded exponential backoff on a connect error ----------

    #[test]
    fn next_backoff_ms_doubles_and_caps() {
        let mut backoff = CONNECT_RETRY_INITIAL_BACKOFF_MS;
        assert_eq!(backoff, 100);
        backoff = next_backoff_ms(backoff);
        assert_eq!(backoff, 200);
        backoff = next_backoff_ms(backoff);
        assert_eq!(backoff, 400);
        for _ in 0..20 {
            backoff = next_backoff_ms(backoff);
        }
        assert_eq!(backoff, CONNECT_RETRY_MAX_BACKOFF_MS);
    }

    #[tokio::test]
    async fn create_pipe_instance_returns_none_on_failure_without_panicking() {
        let name = r"\\.\pipe\agenthub-test-create-pipe-instance-dup";
        let _first = create_pipe_instance(name, true).expect("first instance should succeed");
        // Asking for ANOTHER "first" instance on the same name fails (one already
        // exists) — must report `None`, never panic.
        let second = create_pipe_instance(name, true);
        assert!(second.is_none());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parse_message_accepts_trailing_newline() {
        let msg = parse_message(b"{\"a\":1}\n").unwrap();
        assert_eq!(msg, json!({"a": 1}));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parse_message_accepts_bare_object() {
        let msg = parse_message(b"{\"hello\":\"world\"}").unwrap();
        assert_eq!(msg, json!({"hello": "world"}));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parse_message_rejects_invalid_json() {
        assert!(parse_message(b"not json").is_err());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_target_pane_prefers_explicit_pane_id() {
        let msg = json!({"pane_id": "abc-123", "pane": "first"});
        assert_eq!(
            resolve_target_pane(&msg, Some("first-pane")),
            Some("abc-123".to_string())
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_target_pane_resolves_first() {
        let msg = json!({"pane": "first"});
        assert_eq!(
            resolve_target_pane(&msg, Some("first-pane")),
            Some("first-pane".to_string())
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_target_pane_first_with_no_pane_spawned_yet() {
        let msg = json!({"pane": "first"});
        assert_eq!(resolve_target_pane(&msg, None), None);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_target_pane_literal_pane_name() {
        let msg = json!({"pane": "some-other-pane-id"});
        assert_eq!(
            resolve_target_pane(&msg, Some("first-pane")),
            Some("some-other-pane-id".to_string())
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn resolve_target_pane_none_when_unaddressed() {
        let msg = json!({"type": "input", "data": "x"});
        assert_eq!(resolve_target_pane(&msg, Some("first-pane")), None);
    }
}
