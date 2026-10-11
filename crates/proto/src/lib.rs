//! Faz 5 §1.1: wire types shared between the Kotilo app (`ipc_server`) and the
//! `agenthub-hook` sidecar (desktop named-pipe message). Deliberately tiny — `serde`/
//! `serde_json` only — since it is linked into a cold-start-sensitive CLI.

use serde::{Deserialize, Serialize};

/// Product identity generated from the repo's `brand.json` (`build.rs`): display name, folder
/// slug, exe prefix, hook marker and the legacy values a renamed build migrates from.
pub mod brand {
    include!(concat!(env!("OUT_DIR"), "/brand.rs"));
}

/// Env vars stay `AGENTHUB_*` under any brand: user wrapper scripts and agent configs read
/// them, so they are protocol constants, not identity (DECISIONS "Brand switch").
///
/// Env vars `pty::pane_env_overrides` injects into every spawned pane and that
/// `agenthub-hook` reads to find its way back to the app (spec §1.1/§1.2).
pub const ENV_PANE_ID: &str = "AGENTHUB_PANE_ID";
pub const ENV_WORKSPACE_ID: &str = "AGENTHUB_WORKSPACE_ID";
pub const ENV_ENDPOINT: &str = "AGENTHUB_ENDPOINT";
/// Not injected by `pty` — set by a developer in their own shell to get
/// `agenthub-hook` stderr diagnostics (spec §1.2 item 4) and the app's optional
/// `hooks.log` (spec §1.3).
pub const ENV_DEBUG: &str = "AGENTHUB_DEBUG";
/// Set to `1` by the hub on its own headless AI runs (`cli:<agent>` providers). Agent hooks
/// fired by those runs are dropped by `agenthub-hook` (no send, no spool). The name avoids
/// the substrings Gemini CLI redacts from hook environments (`KEY`, `TOKEN`, `AUTH`, ...).
pub const ENV_INTERNAL: &str = "AGENTHUB_INTERNAL";

/// Agent Integration Protocol v1 event names (`docs/agent-protocol.md`). Sent as
/// `--event <name>`; the sidecar forwards them unchanged.
pub const PROTOCOL_EVENTS: [&str; 8] = [
    "session-start",
    "working",
    "waiting-permission",
    "waiting-input",
    "done",
    "error",
    "session-end",
    "usage",
];

/// `HookMessage::v` — bumped if the wire shape ever changes incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;

/// Adapter id assumed when a message carries no `agent` (every sender before M1 was a
/// Claude Code hook).
pub const DEFAULT_AGENT: &str = "claude-code";

fn default_agent() -> String {
    DEFAULT_AGENT.to_string()
}

/// One agent hook invocation, forwarded by `agenthub-hook` over the app's
/// named pipe (spec §1.1). `ts_ms` (Revizyon item 5) is stamped by the sidecar at
/// process start (wall clock, epoch ms) so the app can order messages that arrive out
/// of sequence relative to when their hooks actually fired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookMessage {
    pub v: u32,
    /// Adapter id of the agent whose hook fired (`claude-code`, `codex`, ...).
    #[serde(default = "default_agent")]
    pub agent: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub event: String,
    pub ts_ms: u64,
    #[serde(default)]
    pub payload: serde_json::Value,
    /// Ancestor pids of the hook, nearest first. Set when `pane_id` is empty because the
    /// agent dropped our pane environment (Codex): the app maps one of them to a pane's shell.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chain: Vec<u32>,
}

impl HookMessage {
    pub fn new(
        pane_id: impl Into<String>,
        workspace_id: impl Into<String>,
        event: impl Into<String>,
        ts_ms: u64,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            agent: default_agent(),
            pane_id: pane_id.into(),
            workspace_id: workspace_id.into(),
            event: event.into(),
            ts_ms,
            payload,
            chain: Vec::new(),
        }
    }

    /// Sets the adapter id (default [`DEFAULT_AGENT`]).
    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agent = agent.into();
        self
    }

    /// Sets the ancestor pid chain (see [`HookMessage::chain`]).
    pub fn with_chain(mut self, chain: Vec<u32>) -> Self {
        self.chain = chain;
        self
    }
}

/// `serde_json::to_vec` never fails for a plain-data struct like [`HookMessage`]
/// (no maps with non-string keys, no floats that could be NaN); falling back to an
/// empty buffer keeps this infallible for callers that must never panic (the sidecar).
pub fn encode(msg: &HookMessage) -> Vec<u8> {
    serde_json::to_vec(msg).unwrap_or_default()
}

/// Decodes one connection's raw bytes into a [`HookMessage`]. Tolerates a trailing
/// newline/whitespace (the spike's probe always appended one) and ignores unknown
/// fields (`serde`'s default for structs).
pub fn decode(bytes: &[u8]) -> serde_json::Result<HookMessage> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(text.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encode_decode_roundtrip() {
        let msg = HookMessage::new("pane-1", "ws-1", "Stop", 123, json!({"a": 1}));
        let bytes = encode(&msg);
        assert_eq!(decode(&bytes).unwrap(), msg);
    }

    #[test]
    fn encode_uses_camel_case_field_names() {
        let msg = HookMessage::new("p", "w", "Stop", 42, json!(null));
        let bytes = encode(&msg);
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"paneId\""));
        assert!(text.contains("\"workspaceId\""));
        assert!(text.contains("\"tsMs\""));
        assert!(!text.contains("pane_id"));
    }

    #[test]
    fn decode_tolerates_trailing_newline_and_whitespace() {
        let mut bytes = encode(&HookMessage::new("p", "w", "Stop", 1, json!(null)));
        bytes.extend_from_slice(b"\n  ");
        assert!(decode(&bytes).is_ok());
    }

    #[test]
    fn decode_ignores_unknown_fields() {
        let text = r#"{"v":1,"paneId":"p","workspaceId":"w","event":"Stop","tsMs":1,"payload":null,"extra":"ignored"}"#;
        let msg = decode(text.as_bytes()).unwrap();
        assert_eq!(msg.event, "Stop");
    }

    #[test]
    fn decode_rejects_invalid_json() {
        assert!(decode(b"not json").is_err());
    }

    #[test]
    fn decode_rejects_empty_input() {
        assert!(decode(b"").is_err());
    }

    #[test]
    fn decode_defaults_missing_agent_to_claude_code() {
        let text = r#"{"v":1,"paneId":"p","workspaceId":"w","event":"Stop","tsMs":1}"#;
        assert_eq!(decode(text.as_bytes()).unwrap().agent, DEFAULT_AGENT);
    }

    #[test]
    fn chain_roundtrips_and_is_omitted_when_empty() {
        let msg = HookMessage::new("", "", "Stop", 1, json!(null)).with_chain(vec![10, 20]);
        assert_eq!(decode(&encode(&msg)).unwrap().chain, vec![10, 20]);
        let plain = String::from_utf8(encode(&HookMessage::new("p", "w", "Stop", 1, json!(null)))).unwrap();
        assert!(!plain.contains("chain"));
    }

    #[test]
    fn with_agent_roundtrips() {
        let msg = HookMessage::new("p", "w", "Stop", 1, json!(null)).with_agent("codex");
        assert_eq!(decode(&encode(&msg)).unwrap().agent, "codex");
    }

    #[test]
    fn protocol_event_names_are_kebab_case_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for e in PROTOCOL_EVENTS {
            assert!(e.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'), "{e}");
            assert!(seen.insert(e), "duplicate {e}");
        }
    }

    #[test]
    fn decode_defaults_missing_payload_field_to_null() {
        let text = r#"{"v":1,"paneId":"p","workspaceId":"w","event":"Stop","tsMs":1}"#;
        let msg = decode(text.as_bytes()).unwrap();
        assert_eq!(msg.payload, serde_json::Value::Null);
    }
}
