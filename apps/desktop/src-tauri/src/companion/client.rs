//! The connection to Kotilo Deck: one thread that connects to the loopback port, runs the mutual
//! handshake, sends the latest snapshots and queued events, and hands deck messages to a sink.
//! A refused connection is the normal "deck not running" case. Logs carry message types, ids
//! and close codes only.

use std::collections::VecDeque;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::Message;

use super::auth;
use super::protocol::{
    self, AgentsState, ApprovalRespond, DecodeError, Hello, HelloAuth, Incoming, OutgoingEvent, PomodoroState, UsageToday,
};
use super::token;

pub const DECK_PORT: u16 = 47831;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// How often the session loop wakes to send what the webview queued.
const POLL: Duration = Duration::from_millis(100);
const AGENTS_MIN_GAP: Duration = Duration::from_millis(250);
const USAGE_MIN_GAP: Duration = Duration::from_secs(5);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Close code for a bad token or proof (also what a pre-1.0.1 deck sends for the nonce hello).
const CLOSE_UNAUTHORIZED: u16 = 4401;

/// Reconnect delay after `attempt` failed tries in a row: 1, 2, 4, … capped at 30 s.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64 << attempt.min(5)).min(BACKOFF_MAX)
}

/// What the settings page shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    /// The setting is off.
    Off,
    /// Not connected: the deck is not running, or it dropped the connection.
    NotRunning,
    #[serde(rename_all = "camelCase")]
    Connected { server_version: String },
    /// The deck closed with 4401: older than 1.0.1, or a different token.
    Rejected,
    /// Something on the port could not prove it knows the token.
    Untrusted,
    /// The token file could not be read or created.
    TokenError,
}

/// A deck message for the webview, as `{type, payload}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "payload")]
pub enum DeckEvent {
    #[serde(rename = "approval.respond")]
    ApprovalRespond(ApprovalRespond),
    #[serde(rename = "pomodoro.state")]
    PomodoroState(PomodoroState),
}

pub enum Notice {
    Status(Status),
    Deck(DeckEvent),
}

pub struct Config {
    pub addr: SocketAddr,
    pub token_path: PathBuf,
    pub client_version: String,
}

impl Config {
    /// Always loopback: nothing is ever sent to another address.
    pub fn loopback(port: u16, token_path: PathBuf, client_version: String) -> Self {
        Self { addr: SocketAddr::from(([127, 0, 0, 1], port)), token_path, client_version }
    }
}

#[derive(Default)]
struct Outbox {
    enabled: bool,
    /// Bumped by every setting change, so a backoff wait ends early.
    generation: u64,
    agents: Option<AgentsState>,
    agents_dirty: bool,
    agents_sent: Option<Instant>,
    usage: Option<UsageToday>,
    usage_dirty: bool,
    usage_sent: Option<Instant>,
    events: VecDeque<OutgoingEvent>,
    connected: bool,
    status: Option<Status>,
}

/// State shared by the Tauri commands (writers) and the connection thread.
pub struct Shared {
    outbox: Mutex<Outbox>,
    wake: Condvar,
}

impl Shared {
    pub fn new(enabled: bool) -> Self {
        Self { outbox: Mutex::new(Outbox { enabled, ..Outbox::default() }), wake: Condvar::new() }
    }

    fn lock(&self) -> MutexGuard<'_, Outbox> {
        self.outbox.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut o = self.lock();
        if o.enabled != enabled {
            o.enabled = enabled;
            o.generation += 1;
            self.wake.notify_all();
        }
    }

    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }

    pub fn status(&self) -> Status {
        let o = self.lock();
        if !o.enabled {
            return Status::Off;
        }
        o.status.clone().unwrap_or(Status::NotRunning)
    }

    fn set_status(&self, status: Status) -> bool {
        let mut o = self.lock();
        let changed = o.status.as_ref() != Some(&status);
        o.status = Some(status);
        changed
    }

    pub fn set_agents(&self, state: AgentsState) {
        let mut o = self.lock();
        if o.agents.as_ref() != Some(&state) {
            o.agents = Some(state);
            o.agents_dirty = true;
        }
    }

    pub fn set_usage(&self, usage: UsageToday) {
        let mut o = self.lock();
        if o.usage.as_ref() != Some(&usage) {
            o.usage = Some(usage);
            o.usage_dirty = true;
        }
    }

    /// Queues an event; dropped while not connected (the next snapshot heals the deck).
    pub fn send(&self, event: OutgoingEvent) {
        let mut o = self.lock();
        if o.connected {
            o.events.push_back(event);
        }
    }

    fn on_connected(&self) {
        let mut o = self.lock();
        o.connected = true;
        o.events.clear();
        o.agents_dirty = o.agents.is_some();
        o.usage_dirty = o.usage.is_some();
        o.agents_sent = None;
        o.usage_sent = None;
    }

    fn on_disconnected(&self) {
        let mut o = self.lock();
        o.connected = false;
        o.events.clear();
    }

    /// The frames due now, in order: events first, then the snapshots (throttled).
    fn take_due(&self, now: Instant) -> Vec<(String, Option<String>, String)> {
        let mut o = self.lock();
        let mut frames = Vec::new();
        while let Some(event) = o.events.pop_front() {
            frames.push((event.kind().to_string(), event.id().map(str::to_string), event.encode()));
        }
        let due = |sent: Option<Instant>, gap: Duration| sent.is_none_or(|t| now.duration_since(t) >= gap);
        if o.agents_dirty && due(o.agents_sent, AGENTS_MIN_GAP) {
            if let Some(state) = o.agents.clone() {
                frames.push(("agents.state".into(), None, protocol::encode("agents.state", &state.limited())));
            }
            o.agents_dirty = false;
            o.agents_sent = Some(now);
        }
        if o.usage_dirty && due(o.usage_sent, USAGE_MIN_GAP) {
            if let Some(usage) = &o.usage {
                frames.push(("usage.today".into(), None, protocol::encode("usage.today", usage)));
            }
            o.usage_dirty = false;
            o.usage_sent = Some(now);
        }
        frames
    }

    /// Waits `delay`, ending early when a setting changes; then waits while disabled.
    fn wait(&self, delay: Duration) {
        let mut o = self.lock();
        let generation = o.generation;
        let until = Instant::now() + delay;
        while o.generation == generation {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            o = self.wake.wait_timeout(o, left).unwrap_or_else(|p| p.into_inner()).0;
        }
        while !o.enabled {
            o = self.wake.wait(o).unwrap_or_else(|p| p.into_inner());
        }
    }
}

/// How one session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum End {
    /// Nothing listens on the port (the deck is not running).
    Refused,
    /// The token file could not be read or created.
    Token,
    /// The server's proof was missing or wrong; we closed without sending ours.
    BadServerProof,
    /// The deck closed the socket (`None` when it gave no code).
    Closed(Option<u16>),
    /// The connection broke (I/O error, timeout, handshake failure).
    Dropped,
    /// The setting was turned off.
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionResult {
    pub end: End,
    /// `hello.ok` arrived (the backoff starts over).
    pub authenticated: bool,
}

type Socket = tungstenite::WebSocket<TcpStream>;

fn close_code(frame: Option<CloseFrame>) -> Option<u16> {
    frame.map(|f| u16::from(f.code))
}

/// The next text frame before `deadline`; a close or error ends the session.
fn read_text(socket: &mut Socket, deadline: Instant) -> Result<String, End> {
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(End::Dropped);
        }
        let _ = socket.get_ref().set_read_timeout(Some(left));
        match socket.read() {
            Ok(Message::Text(text)) => return Ok(text.as_str().to_string()),
            Ok(Message::Close(frame)) => return Err(End::Closed(close_code(frame))),
            Ok(_) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Err(End::Closed(None)),
            Err(_) => return Err(End::Dropped),
        }
    }
}

fn send_text(socket: &mut Socket, text: String) -> Result<(), End> {
    socket.send(Message::text(text)).map_err(|_| End::Dropped)
}

fn close_normal(socket: &mut Socket) {
    let _ = socket.close(Some(CloseFrame { code: CloseCode::Normal, reason: "".into() }));
    let _ = socket.flush();
}

/// Connects, authenticates and pumps until the session ends.
pub fn run_session(shared: &Shared, config: &Config, sink: &dyn Fn(Notice)) -> SessionResult {
    let mut authenticated = false;
    let end = session(shared, config, sink, &mut authenticated);
    if authenticated {
        shared.on_disconnected();
    }
    SessionResult { end, authenticated }
}

fn session(shared: &Shared, config: &Config, sink: &dyn Fn(Notice), authenticated: &mut bool) -> End {
    if !config.addr.ip().is_loopback() {
        return End::Refused;
    }
    let token = match token::read_or_create(&config.token_path) {
        Ok(token) => token,
        Err(e) => {
            log::warn!("deck: {e}");
            return End::Token;
        }
    };
    let tcp = match TcpStream::connect_timeout(&config.addr, CONNECT_TIMEOUT) {
        Ok(tcp) => tcp,
        Err(e) => {
            log::debug!("deck: not reachable ({:?})", e.kind());
            return End::Refused;
        }
    };
    let _ = tcp.set_nodelay(true);
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    let _ = tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = tcp.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let mut socket = match tungstenite::client::client(format!("ws://{}/", config.addr), tcp) {
        Ok((socket, _)) => socket,
        Err(_) => {
            log::debug!("deck: websocket handshake failed");
            return End::Dropped;
        }
    };

    // §2.1 mutual handshake: the token itself never crosses the socket.
    let Ok(client_nonce) = auth::random_hex32() else {
        return End::Token;
    };
    let hello = Hello { nonce: client_nonce.clone(), client: protocol::CLIENT_NAME.into(), client_version: config.client_version.clone() };
    if let Err(end) = send_text(&mut socket, protocol::encode("hello", &hello)) {
        return end;
    }
    let challenge = match read_text(&mut socket, deadline) {
        Ok(text) => protocol::decode(&text),
        Err(end) => return end,
    };
    let Ok(Incoming::HelloChallenge(challenge)) = challenge else {
        log::info!("deck: no valid challenge, closing");
        close_normal(&mut socket);
        return End::BadServerProof;
    };
    if !auth::is_hex64(&challenge.nonce) || !auth::verify_server_proof(&token, &client_nonce, &challenge.nonce, &challenge.proof) {
        log::warn!("deck: the server on the deck port did not prove the token, closing");
        close_normal(&mut socket);
        return End::BadServerProof;
    }
    let proof = auth::client_proof(&token, &client_nonce, &challenge.nonce);
    if let Err(end) = send_text(&mut socket, protocol::encode("hello.auth", &HelloAuth { proof })) {
        return end;
    }
    let ok = match read_text(&mut socket, deadline) {
        Ok(text) => protocol::decode(&text),
        Err(end) => return end,
    };
    let Ok(Incoming::HelloOk(ok)) = ok else {
        log::info!("deck: expected hello.ok, closing");
        close_normal(&mut socket);
        return End::Dropped;
    };

    *authenticated = true;
    log::info!("deck: connected (deck {}, auth {})", ok.server_version, ok.auth.as_deref().unwrap_or("-"));
    shared.on_connected();
    let connected = Status::Connected { server_version: ok.server_version };
    shared.set_status(connected.clone());
    sink(Notice::Status(connected));
    let _ = socket.get_ref().set_read_timeout(Some(POLL));

    loop {
        if !shared.enabled() {
            close_normal(&mut socket);
            return End::Disabled;
        }
        for (kind, id, frame) in shared.take_due(Instant::now()) {
            log::debug!("deck: send {kind} {}", id.unwrap_or_default());
            if let Err(end) = send_text(&mut socket, frame) {
                return end;
            }
        }
        match socket.read() {
            Ok(Message::Text(text)) => match protocol::decode(text.as_str()) {
                Ok(Incoming::ApprovalRespond(respond)) => {
                    log::info!("deck: approval.respond {}", respond.id);
                    sink(Notice::Deck(DeckEvent::ApprovalRespond(respond)));
                }
                Ok(Incoming::PomodoroState(state)) => {
                    log::debug!("deck: pomodoro.state");
                    sink(Notice::Deck(DeckEvent::PomodoroState(state)));
                }
                Ok(Incoming::TodoAdded(_)) => log::debug!("deck: todo.added (ignored)"),
                Ok(Incoming::HelloChallenge(_) | Incoming::HelloOk(_)) => log::debug!("deck: late handshake frame (ignored)"),
                Err(DecodeError::UnknownType(kind)) => log::debug!("deck: unknown type {kind} (ignored)"),
                Err(DecodeError::Invalid(kind)) => log::debug!("deck: invalid {kind} (ignored)"),
                Err(e) => log::debug!("deck: bad frame {e:?} (ignored)"),
            },
            Ok(Message::Close(frame)) => {
                let code = close_code(frame);
                log::info!("deck: closed ({})", code.map(|c| c.to_string()).unwrap_or_else(|| "-".into()));
                return End::Closed(code);
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return End::Closed(None),
            Err(_) => {
                log::info!("deck: connection lost");
                return End::Dropped;
            }
        }
    }
}

fn status_after(result: &SessionResult) -> Status {
    match result.end {
        End::Disabled => Status::Off,
        End::Token => Status::TokenError,
        End::BadServerProof => Status::Untrusted,
        End::Closed(Some(CLOSE_UNAUTHORIZED)) => Status::Rejected,
        _ => Status::NotRunning,
    }
}

/// Runs forever: connect, pump, back off, reconnect. Waits without CPU while disabled.
pub fn run(shared: &Shared, config: &Config, sink: &dyn Fn(Notice)) -> ! {
    let mut attempt = 0u32;
    loop {
        shared.wait(Duration::ZERO);
        let result = run_session(shared, config, sink);
        let status = status_after(&result);
        if shared.set_status(status.clone()) {
            sink(Notice::Status(status));
        }
        if result.authenticated {
            attempt = 0;
        }
        let delay = if result.end == End::Disabled { Duration::ZERO } else { backoff(attempt) };
        attempt = attempt.saturating_add(1);
        shared.wait(delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_at_30_seconds() {
        let secs: Vec<u64> = (0..8).map(|a| backoff(a).as_secs()).collect();
        assert_eq!(secs, vec![1, 2, 4, 8, 16, 30, 30, 30]);
        assert_eq!(backoff(u32::MAX), BACKOFF_MAX);
    }

    #[test]
    fn status_follows_how_the_session_ended() {
        let r = |end| SessionResult { end, authenticated: false };
        assert_eq!(status_after(&r(End::Refused)), Status::NotRunning);
        assert_eq!(status_after(&r(End::Closed(Some(4401)))), Status::Rejected);
        assert_eq!(status_after(&r(End::Closed(Some(4409)))), Status::NotRunning);
        assert_eq!(status_after(&r(End::BadServerProof)), Status::Untrusted);
        assert_eq!(status_after(&r(End::Disabled)), Status::Off);
    }

    #[test]
    fn outbox_sends_events_then_throttled_snapshots_and_drops_events_offline() {
        let shared = Shared::new(true);
        shared.send(OutgoingEvent::WorkspaceSwitch(protocol::WorkspaceSwitch { slug: "agents".into() }));
        shared.set_agents(AgentsState::default());
        shared.set_usage(UsageToday { tokens: 1, cost_usd: 0.1, budget_usd: None });
        shared.on_connected();
        let t0 = Instant::now();
        let kinds = |frames: Vec<(String, Option<String>, String)>| frames.into_iter().map(|f| f.0).collect::<Vec<_>>();
        // The offline event is gone; the snapshots go at once after connecting.
        assert_eq!(kinds(shared.take_due(t0)), vec!["agents.state", "usage.today"]);
        shared.set_agents(AgentsState { agents: vec![], approvals: vec![protocol::Approval { id: "x".into(), agent_id: "a".into(), summary: "s".into(), detail: None, requested_at: 1 }] });
        shared.set_usage(UsageToday { tokens: 2, cost_usd: 0.2, budget_usd: None });
        shared.send(OutgoingEvent::WorkspaceSwitch(protocol::WorkspaceSwitch { slug: "agents".into() }));
        assert_eq!(kinds(shared.take_due(t0 + Duration::from_millis(100))), vec!["workspace.switch"]);
        assert_eq!(kinds(shared.take_due(t0 + Duration::from_millis(300))), vec!["agents.state"]);
        assert_eq!(kinds(shared.take_due(t0 + Duration::from_secs(5))), vec!["usage.today"]);
        // An unchanged snapshot is not sent again.
        shared.set_usage(UsageToday { tokens: 2, cost_usd: 0.2, budget_usd: None });
        assert!(shared.take_due(t0 + Duration::from_secs(20)).is_empty());
    }

    #[test]
    fn status_is_off_while_disabled() {
        let shared = Shared::new(false);
        assert_eq!(shared.status(), Status::Off);
        shared.set_enabled(true);
        assert_eq!(shared.status(), Status::NotRunning);
    }
}
