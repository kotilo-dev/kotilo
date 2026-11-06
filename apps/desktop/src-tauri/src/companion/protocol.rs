//! Kotilo Deck companion protocol v1 (`docs/companion-protocol.md`, the source of truth).
//! Every frame is `{ "v": 1, "type": "<dotted.name>", "payload": { … } }`. Outgoing payloads are
//! typed so only fields the protocol defines leave the app; incoming frames decode into
//! [`Incoming`], and anything unknown or invalid becomes `None` (logged by the caller, never fatal).

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const CLIENT_NAME: &str = "kotilo-desktop";
/// Approval summary/detail and agent task text are cut to this many characters.
pub const MAX_TEXT_CHARS: usize = 500;
/// Ids are opaque strings of up to 256 characters (protocol §5).
pub const MAX_ID_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Envelope<T> {
    v: u32,
    #[serde(rename = "type")]
    kind: String,
    payload: T,
}

/// One frame as JSON text.
pub fn encode<T: Serialize>(kind: &str, payload: &T) -> String {
    let envelope = Envelope { v: PROTOCOL_VERSION, kind: kind.to_string(), payload };
    // Serializing these plain structs cannot fail.
    serde_json::to_string(&envelope).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------
// Handshake (§2.1)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub nonce: String,
    pub client: String,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloChallenge {
    #[serde(default)]
    pub nonce: String,
    #[serde(default)]
    pub proof: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloAuth {
    pub proof: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub server_version: String,
    #[serde(default = "default_protocol")]
    pub protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
}

fn default_protocol() -> u32 {
    PROTOCOL_VERSION
}

// ---------------------------------------------------------------------------------------
// Desktop → Deck (§5)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Working,
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub repo: String,
    pub name: String,
    pub status: AgentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub agent_id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub requested_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct AgentsState {
    pub agents: Vec<Agent>,
    pub approvals: Vec<Approval>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approve,
    Deny,
    Expired,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedBy {
    Deck,
    Desktop,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalResolved {
    pub id: String,
    pub decision: Decision,
    pub by: ResolvedBy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageToday {
    pub tokens: u64,
    pub cost_usd: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PomodoroSuggest {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceSwitch {
    pub slug: String,
}

/// A desktop → deck event other than the snapshots, as the webview hands it over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum OutgoingEvent {
    #[serde(rename = "agent.approval.requested")]
    ApprovalRequested(Approval),
    #[serde(rename = "agent.approval.resolved")]
    ApprovalResolved(ApprovalResolved),
    #[serde(rename = "pomodoro.suggest")]
    PomodoroSuggest(PomodoroSuggest),
    #[serde(rename = "workspace.switch")]
    WorkspaceSwitch(WorkspaceSwitch),
}

impl OutgoingEvent {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ApprovalRequested(_) => "agent.approval.requested",
            Self::ApprovalResolved(_) => "agent.approval.resolved",
            Self::PomodoroSuggest(_) => "pomodoro.suggest",
            Self::WorkspaceSwitch(_) => "workspace.switch",
        }
    }

    /// The approval id it concerns, for logs.
    pub fn id(&self) -> Option<&str> {
        match self {
            Self::ApprovalRequested(a) => Some(&a.id),
            Self::ApprovalResolved(r) => Some(&r.id),
            _ => None,
        }
    }

    pub fn encode(&self) -> String {
        match self {
            Self::ApprovalRequested(p) => encode(self.kind(), &p.clone().limited()),
            Self::ApprovalResolved(p) => encode(self.kind(), p),
            Self::PomodoroSuggest(p) => encode(self.kind(), p),
            Self::WorkspaceSwitch(p) => encode(self.kind(), p),
        }
    }
}

/// `text` cut to `max` characters (not bytes), with an ellipsis when cut.
pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn limit_id(id: String) -> String {
    if id.chars().count() <= MAX_ID_CHARS {
        id
    } else {
        id.chars().take(MAX_ID_CHARS).collect()
    }
}

impl Approval {
    /// Ids and texts within the protocol's limits.
    pub fn limited(self) -> Self {
        Self {
            id: limit_id(self.id),
            agent_id: limit_id(self.agent_id),
            summary: truncate(&self.summary, MAX_TEXT_CHARS),
            detail: self.detail.map(|d| truncate(&d, MAX_TEXT_CHARS)),
            requested_at: self.requested_at,
        }
    }
}

impl AgentsState {
    /// Ids and texts within the protocol's limits.
    pub fn limited(self) -> Self {
        Self {
            agents: self
                .agents
                .into_iter()
                .map(|a| Agent {
                    id: limit_id(a.id),
                    repo: truncate(&a.repo, MAX_TEXT_CHARS),
                    name: truncate(&a.name, MAX_TEXT_CHARS),
                    status: a.status,
                    task: a.task.map(|t| truncate(&t, MAX_TEXT_CHARS)),
                    since: a.since,
                })
                .collect(),
            approvals: self.approvals.into_iter().map(Approval::limited).collect(),
        }
    }
}

// ---------------------------------------------------------------------------------------
// Deck → Desktop (§6)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RespondDecision {
    Approve,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalRespond {
    pub id: String,
    pub decision: RespondDecision,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PomodoroState {
    pub phase: String,
    pub running: bool,
    #[serde(default)]
    pub ends_at: Option<i64>,
    #[serde(default)]
    pub remaining: u64,
    #[serde(default)]
    pub duration: u64,
    #[serde(default = "one")]
    pub session: u32,
    #[serde(default = "four")]
    pub sessions_per_cycle: u32,
}

fn one() -> u32 {
    1
}
fn four() -> u32 {
    4
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoAdded {
    pub id: serde_json::Value,
    pub text: String,
    #[serde(default)]
    pub due: Option<i64>,
}

/// A decoded deck → desktop frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    HelloChallenge(HelloChallenge),
    HelloOk(HelloOk),
    ApprovalRespond(ApprovalRespond),
    PomodoroState(PomodoroState),
    TodoAdded(TodoAdded),
}

/// Why a frame was not decoded; only the type goes to the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Not a `{v, type, payload}` object.
    Malformed,
    /// A protocol version other than 1.
    Version(u32),
    /// A type this client does not handle (ignored per §3).
    UnknownType(String),
    /// A known type whose payload failed validation.
    Invalid(String),
}

#[derive(Deserialize)]
struct RawEnvelope {
    v: u32,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

pub fn decode(text: &str) -> Result<Incoming, DecodeError> {
    let raw: RawEnvelope = serde_json::from_str(text).map_err(|_| DecodeError::Malformed)?;
    if raw.v != PROTOCOL_VERSION {
        return Err(DecodeError::Version(raw.v));
    }
    fn payload<T: for<'de> Deserialize<'de>>(raw: RawEnvelope) -> Result<T, DecodeError> {
        let kind = raw.kind;
        serde_json::from_value(raw.payload).map_err(|_| DecodeError::Invalid(kind))
    }
    match raw.kind.as_str() {
        "hello.challenge" => payload(raw).map(Incoming::HelloChallenge),
        "hello.ok" => payload(raw).map(Incoming::HelloOk),
        "approval.respond" => payload(raw).map(Incoming::ApprovalRespond),
        "pomodoro.state" => payload(raw).map(Incoming::PomodoroState),
        "todo.added" => payload(raw).map(Incoming::TodoAdded),
        _ => Err(DecodeError::UnknownType(raw.kind)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Decodes `example` (a frame from the protocol doc) into `T`, re-encodes it and checks the
    /// JSON is unchanged.
    fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(example: &str) -> T {
        let raw: RawEnvelope = serde_json::from_str(example).expect("example parses");
        let kind = raw.kind.clone();
        let original: Value = serde_json::from_str(example).expect("json");
        let typed: T = serde_json::from_value(raw.payload).expect("payload decodes");
        let again: Value = serde_json::from_str(&encode(&kind, &typed)).expect("json");
        assert_eq!(numbers_as_f64(again), numbers_as_f64(original), "round trip of {kind}");
        typed
    }

    /// `10` and `10.0` are the same JSON number for the deck.
    fn numbers_as_f64(value: Value) -> Value {
        match value {
            Value::Number(n) => json!(n.as_f64()),
            Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_f64).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, numbers_as_f64(v))).collect()),
            other => other,
        }
    }

    #[test]
    fn handshake_examples_round_trip() {
        let hello: Hello = round_trip(r#"{ "v": 1, "type": "hello", "payload": { "nonce": "<Nc>", "client": "kotilo-desktop", "clientVersion": "1.4.0" } }"#);
        assert_eq!(hello.client, CLIENT_NAME);
        let ch: HelloChallenge = round_trip(r#"{ "v": 1, "type": "hello.challenge", "payload": { "nonce": "<Ns>", "proof": "<Ps>" } }"#);
        assert_eq!(ch.proof, "<Ps>");
        let _: HelloAuth = round_trip(r#"{ "v": 1, "type": "hello.auth", "payload": { "proof": "<Pc>" } }"#);
        let ok: HelloOk = round_trip(r#"{ "v": 1, "type": "hello.ok", "payload": { "server": "kotilo-deck", "serverVersion": "1.0.1", "protocol": 1, "auth": "mutual" } }"#);
        assert_eq!(ok.auth.as_deref(), Some("mutual"));
    }

    #[test]
    fn desktop_to_deck_examples_round_trip() {
        let state: AgentsState = round_trip(
            r#"{ "v": 1, "type": "agents.state", "payload": {
              "agents": [
                { "id": "a1", "repo": "kotilo-deck", "name": "claude", "status": "working", "task": "Phase 3 widgets", "since": 1793733000000 },
                { "id": "a2", "repo": "shell", "name": "claude", "status": "waiting", "task": "Run cargo build?", "since": 1793733100000 }
              ],
              "approvals": [
                { "id": "ap-17", "agentId": "a2", "summary": "Run cargo build", "detail": "cargo build --release", "requestedAt": 1793733100000 }
              ]
            } }"#,
        );
        assert_eq!(state.agents[1].status, AgentStatus::Waiting);
        let resolved: ApprovalResolved = round_trip(r#"{ "v": 1, "type": "agent.approval.resolved", "payload": { "id": "ap-17", "decision": "approve", "by": "deck" } }"#);
        assert_eq!(resolved.by, ResolvedBy::Deck);
        let usage: UsageToday = round_trip(r#"{ "v": 1, "type": "usage.today", "payload": { "tokens": 1840000, "costUsd": 4.12, "budgetUsd": 10 } }"#);
        assert_eq!(usage.tokens, 1_840_000);
        let _: PomodoroSuggest = round_trip(r#"{ "v": 1, "type": "pomodoro.suggest", "payload": { "reason": "Agent started a long task", "minutes": 25 } }"#);
        let _: WorkspaceSwitch = round_trip(r#"{ "v": 1, "type": "workspace.switch", "payload": { "slug": "agents" } }"#);
    }

    #[test]
    fn deck_to_desktop_examples_round_trip_and_decode() {
        let respond = r#"{ "v": 1, "type": "approval.respond", "payload": { "id": "ap-17", "decision": "approve" } }"#;
        let _: ApprovalRespond = round_trip(respond);
        assert_eq!(
            decode(respond),
            Ok(Incoming::ApprovalRespond(ApprovalRespond { id: "ap-17".into(), decision: RespondDecision::Approve }))
        );
        let pomodoro = r#"{ "v": 1, "type": "pomodoro.state", "payload": {
          "phase": "focus", "running": true, "endsAt": 1793734500000, "remaining": 1500,
          "duration": 1500, "session": 2, "sessionsPerCycle": 4
        } }"#;
        let p: PomodoroState = round_trip(pomodoro);
        assert_eq!(p.ends_at, Some(1_793_734_500_000));
        assert!(matches!(decode(pomodoro), Ok(Incoming::PomodoroState(_))));
        let todo = r#"{ "v": 1, "type": "todo.added", "payload": { "id": 42, "text": "deploy", "due": 1793770000000 } }"#;
        let _: TodoAdded = round_trip(todo);
        assert!(matches!(decode(todo), Ok(Incoming::TodoAdded(_))));
    }

    #[test]
    fn decode_ignores_unknown_and_bad_input() {
        assert_eq!(decode("not json"), Err(DecodeError::Malformed));
        assert_eq!(decode(r#"{"type":"x"}"#), Err(DecodeError::Malformed));
        assert_eq!(decode(r#"{"v":2,"type":"hello.ok","payload":{}}"#), Err(DecodeError::Version(2)));
        assert_eq!(decode(r#"{"v":1,"type":"deck.new","payload":{}}"#), Err(DecodeError::UnknownType("deck.new".into())));
        assert_eq!(
            decode(r#"{"v":1,"type":"approval.respond","payload":{"id":"x","decision":"maybe"}}"#),
            Err(DecodeError::Invalid("approval.respond".into()))
        );
        // Unknown fields and a missing optional field are fine.
        let p = decode(r#"{"v":1,"type":"pomodoro.state","payload":{"phase":"idle","running":false,"extra":1}}"#);
        assert!(matches!(p, Ok(Incoming::PomodoroState(PomodoroState { ends_at: None, .. }))));
    }

    #[test]
    fn decision_unknown_and_events_encode_with_their_type() {
        let event = OutgoingEvent::ApprovalResolved(ApprovalResolved { id: "x".into(), decision: Decision::Unknown, by: ResolvedBy::Agent });
        let v: Value = serde_json::from_str(&event.encode()).unwrap();
        assert_eq!(v, json!({"v":1,"type":"agent.approval.resolved","payload":{"id":"x","decision":"unknown","by":"agent"}}));
        // The webview's shape is the same tagged object.
        let from_webview: OutgoingEvent =
            serde_json::from_value(json!({"type":"workspace.switch","payload":{"slug":"agents"}})).unwrap();
        assert_eq!(from_webview.kind(), "workspace.switch");
    }

    #[test]
    fn texts_and_ids_are_limited() {
        let long = "é".repeat(600);
        let state = AgentsState {
            agents: vec![Agent { id: "i".repeat(300), repo: "r".into(), name: "n".into(), status: AgentStatus::Idle, task: Some(long.clone()), since: None }],
            approvals: vec![Approval { id: "a".into(), agent_id: "i".into(), summary: long.clone(), detail: Some(long), requested_at: 1 }],
        }
        .limited();
        assert_eq!(state.agents[0].id.chars().count(), MAX_ID_CHARS);
        assert_eq!(state.agents[0].task.as_ref().unwrap().chars().count(), MAX_TEXT_CHARS);
        assert!(state.approvals[0].detail.as_ref().unwrap().ends_with('…'));
        assert_eq!(truncate("short", 500), "short");
        // Without a budget the field is left out.
        let usage = encode("usage.today", &UsageToday { tokens: 1, cost_usd: 0.5, budget_usd: None });
        assert!(!usage.contains("budgetUsd"));
    }
}
