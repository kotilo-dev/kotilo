//! The client against a fake deck on a random loopback port.

use std::net::TcpListener;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::Message;

use super::auth;
use super::client::{self, Config, DeckEvent, End, Notice, Shared, Status};
use super::protocol::{self, AgentsState, ApprovalResolved, Decision, OutgoingEvent, ResolvedBy, UsageToday};

const TOKEN: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SERVER_NONCE: &str = "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";

type ServerSocket = tungstenite::WebSocket<std::net::TcpStream>;

fn write_token(dir: &Path) -> std::path::PathBuf {
    let path = super::token::token_path(dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, TOKEN).unwrap();
    path
}

fn read_json(ws: &mut ServerSocket) -> Value {
    loop {
        match ws.read().expect("server read") {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Close(_) => panic!("client closed"),
            _ => {}
        }
    }
}

fn send_json(ws: &mut ServerSocket, value: Value) {
    ws.send(Message::text(value.to_string())).unwrap();
}

/// Runs the deck's side of the mutual handshake and returns the client's hello.
fn accept_and_auth(listener: &TcpListener) -> (ServerSocket, Value) {
    let (tcp, _) = listener.accept().unwrap();
    tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut ws = tungstenite::accept(tcp).unwrap();
    let hello = read_json(&mut ws);
    let nc = hello["payload"]["nonce"].as_str().unwrap().to_string();
    let ps = auth::server_proof(TOKEN, &nc, SERVER_NONCE);
    send_json(&mut ws, json!({"v":1,"type":"hello.challenge","payload":{"nonce":SERVER_NONCE,"proof":ps}}));
    let auth_frame = read_json(&mut ws);
    assert_eq!(auth_frame["type"], "hello.auth");
    assert_eq!(auth_frame["payload"]["proof"], auth::client_proof(TOKEN, &nc, SERVER_NONCE));
    send_json(&mut ws, json!({"v":1,"type":"hello.ok","payload":{"server":"kotilo-deck","serverVersion":"1.0.1","protocol":1,"auth":"mutual"}}));
    (ws, hello)
}

fn sink(tx: mpsc::Sender<String>) -> impl Fn(Notice) {
    move |notice| {
        let text = match notice {
            Notice::Status(s) => serde_json::to_string(&s).unwrap(),
            Notice::Deck(e) => serde_json::to_string(&e).unwrap(),
        };
        let _ = tx.send(text);
    }
}

#[test]
fn handshake_snapshot_respond_resolve_and_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config::loopback(port, write_token(dir.path()), "9.9.9".into());
    let shared = Arc::new(Shared::new(true));
    shared.set_agents(AgentsState {
        agents: vec![protocol::Agent { id: "a1".into(), repo: "kotilo".into(), name: "Claude Code".into(), status: protocol::AgentStatus::Waiting, task: Some("cargo build".into()), since: Some(1) }],
        approvals: vec![protocol::Approval { id: "claude-code:s1:1".into(), agent_id: "a1".into(), summary: "Bash".into(), detail: Some("cargo build".into()), requested_at: 1 }],
    });
    shared.set_usage(UsageToday { tokens: 10, cost_usd: 0.5, budget_usd: None });

    let (tx, rx) = mpsc::channel();
    let thread_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        let sink = sink(tx);
        client::run(&thread_shared, &config, &sink);
    });

    // 1) Handshake: the hello carries a nonce, never the token.
    let (mut ws, hello) = accept_and_auth(&listener);
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["payload"]["client"], "kotilo-desktop");
    assert_eq!(hello["payload"]["clientVersion"], "9.9.9");
    assert!(hello["payload"].get("token").is_none());
    assert!(!hello.to_string().contains(TOKEN));
    let status: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
    assert_eq!(status, json!({"state":"connected","serverVersion":"1.0.1"}));

    // 2) Snapshots right after hello.ok.
    let agents = read_json(&mut ws);
    assert_eq!(agents["type"], "agents.state");
    assert_eq!(agents["payload"]["approvals"][0]["id"], "claude-code:s1:1");
    let usage = read_json(&mut ws);
    assert_eq!(usage, json!({"v":1,"type":"usage.today","payload":{"tokens":10,"costUsd":0.5}}));

    // 3) approval.respond reaches the sink; the webview's resolve goes back. Junk is ignored.
    send_json(&mut ws, json!({"v":1,"type":"deck.future","payload":{}}));
    ws.send(Message::text("not json")).unwrap();
    send_json(&mut ws, json!({"v":1,"type":"approval.respond","payload":{"id":"claude-code:s1:1","decision":"approve","extra":true}}));
    let respond = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&respond).unwrap(), json!({"type":"approval.respond","payload":{"id":"claude-code:s1:1","decision":"approve"}}));
    shared.send(OutgoingEvent::ApprovalResolved(ApprovalResolved { id: "claude-code:s1:1".into(), decision: Decision::Approve, by: ResolvedBy::Deck }));
    shared.set_agents(AgentsState::default());
    let resolved = read_json(&mut ws);
    assert_eq!(resolved["type"], "agent.approval.resolved");
    assert_eq!(resolved["payload"]["by"], "deck");
    let after = read_json(&mut ws);
    assert_eq!(after["type"], "agents.state");
    assert_eq!(after["payload"]["approvals"], json!([]));

    // 4) The deck goes away; the client comes back after the 1 s backoff and resends snapshots.
    ws.close(Some(CloseFrame { code: CloseCode::Away, reason: "".into() })).unwrap();
    let _ = ws.flush();
    drop(ws);
    let (mut ws2, _) = accept_and_auth(&listener);
    assert_eq!(read_json(&mut ws2)["type"], "agents.state");
    assert_eq!(read_json(&mut ws2)["type"], "usage.today");

    // 5) Turning the setting off closes the socket.
    shared.set_enabled(false);
    loop {
        match ws2.read() {
            Ok(Message::Close(frame)) => {
                assert_eq!(frame.map(|f| f.code), Some(CloseCode::Normal));
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    assert_eq!(shared.status(), Status::Off);
}

#[test]
fn a_server_without_a_valid_proof_never_gets_a_client_proof() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config::loopback(port, write_token(dir.path()), "1".into());
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut ws = tungstenite::accept(tcp).unwrap();
        let _hello = read_json(&mut ws);
        // A squatter that does not know the token.
        send_json(&mut ws, json!({"v":1,"type":"hello.challenge","payload":{"nonce":SERVER_NONCE,"proof":"00".repeat(32)}}));
        let mut frames = Vec::new();
        loop {
            match ws.read() {
                Ok(Message::Text(t)) => frames.push(t.as_str().to_string()),
                Ok(Message::Close(frame)) => return (frames, frame.map(|f| f.code)),
                Ok(_) => {}
                Err(_) => return (frames, None),
            }
        }
    });
    let shared = Shared::new(true);
    let result = client::run_session(&shared, &config, &|_| {});
    assert_eq!(result.end, End::BadServerProof);
    assert!(!result.authenticated);
    let (frames, code) = server.join().unwrap();
    assert!(frames.is_empty(), "client sent {frames:?}");
    assert_eq!(code, Some(CloseCode::Normal));
}

#[test]
fn an_old_deck_closing_with_4401_is_rejected_and_refused_port_is_not_running() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config::loopback(port, write_token(dir.path()), "1".into());
    let server = std::thread::spawn(move || {
        let (tcp, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(tcp).unwrap();
        let _ = read_json(&mut ws);
        ws.close(Some(CloseFrame { code: CloseCode::from(4401), reason: "".into() })).unwrap();
        let _ = ws.flush();
        let _ = ws.read();
    });
    let shared = Shared::new(true);
    let result = client::run_session(&shared, &config, &|_| {});
    assert_eq!(result.end, End::Closed(Some(4401)));
    server.join().unwrap();

    // Nothing listens any more.
    let result = client::run_session(&shared, &config, &|_| {});
    assert_eq!(result.end, End::Refused);
}

#[test]
fn pomodoro_state_reaches_the_sink() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = Config::loopback(port, write_token(dir.path()), "1".into());
    let server = std::thread::spawn(move || {
        let (mut ws, _) = accept_and_auth(&listener);
        send_json(&mut ws, json!({"v":1,"type":"pomodoro.state","payload":{"phase":"focus","running":true,"endsAt":5,"remaining":1500,"duration":1500,"session":2,"sessionsPerCycle":4}}));
        ws.close(None).unwrap();
        let _ = ws.flush();
        let _ = ws.read();
    });
    let (tx, rx) = mpsc::channel::<DeckEvent>();
    let shared = Shared::new(true);
    let result = client::run_session(&shared, &config, &move |n| {
        if let Notice::Deck(e) = n {
            let _ = tx.send(e);
        }
    });
    assert!(result.authenticated);
    server.join().unwrap();
    assert!(matches!(rx.try_recv(), Ok(DeckEvent::PomodoroState(p)) if p.phase == "focus" && p.ends_at == Some(5)));
}
