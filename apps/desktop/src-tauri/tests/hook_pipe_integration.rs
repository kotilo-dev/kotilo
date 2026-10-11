//! Faz 5 §1.9: real named-pipe integration test — a real OS named pipe, the real
//! `agenthub-hook` `run()` (its actual `real_connect`, not an injected fake) writing a hook
//! to it, and a real `AgentTracker::on_hook` applying the decoded message. This
//! exercises the exact byte-for-byte path a live Claude Code hook takes: sidecar ->
//! named pipe -> `agenthub_proto::decode` -> tracker.
//!
//! The server side here is deliberately the same read-up-to-1MiB-then-decode logic as
//! `ipc_server::handle_connection`, without the surrounding Tauri `App`/`AppHandle` —
//! standing up a full mock Tauri runtime just to reach a private `handle_connection`
//! would test Tauri's own plumbing, not this feature's. `ipc_server`'s own unit tests
//! already cover the dev-control fallback and pipe naming; `agents::AgentTracker`'s unit
//! tests already cover every state transition. What only an end-to-end test like this
//! one can prove is that the real bytes that `agenthub-hook` puts on a real named
//! pipe are exactly what `agenthub_proto::decode` expects.

use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::windows::named_pipe::ServerOptions;

use agenthub_lib::agents::{AgentState, AgentTracker};

#[test]
fn real_pipe_delivers_a_hook_from_agenthub_hook_to_the_tracker() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let pipe_name = format!(r"\\.\pipe\agenthub-hook-integration-test-{unique}");

    let tracker = Arc::new(AgentTracker::new());
    let tracker_for_server = tracker.clone();
    let pipe_name_for_server = pipe_name.clone();

    // Server side: exactly what `ipc_server::handle_connection` does with a decoded
    // message, minus the Tauri emit (that part is unit-tested separately).
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .expect("build a tokio runtime for the pipe server");
        rt.block_on(async move {
            let mut server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name_for_server)
                .expect("create the test named pipe");
            server.connect().await.expect("accept one connection");

            let mut buf = Vec::new();
            {
                let mut limited = (&mut server).take(1024 * 1024);
                limited
                    .read_to_end(&mut buf)
                    .await
                    .expect("read the hook message");
            }

            let msg = agenthub_proto::decode(&buf).expect("decode a real HookMessage");
            // `known_pane: true` — this end-to-end test isn't exercising the finding-2
            // unknown-pane drop (covered by `agents::AgentTracker`'s own unit tests); 
            tracker_for_server.on_hook(&msg, true);
        });
    });

    // Give the server a moment to start listening before the client tries to connect.
    std::thread::sleep(Duration::from_millis(100));

    // Client side: the *real* `agenthub-hook` `run()` + its real Windows named-pipe
    // connect/write, exactly as `agenthub-hook.exe` runs it from a Claude Code hook.
    let args = vec![
        "agenthub-hook".to_string(),
        "--event".to_string(),
        "Stop".to_string(),
    ];
    let env = move |key: &str| match key {
        "AGENTHUB_ENDPOINT" => Some(pipe_name.clone()),
        "AGENTHUB_PANE_ID" => Some("pane-integration-1".to_string()),
        "AGENTHUB_WORKSPACE_ID" => Some("ws-integration-1".to_string()),
        _ => None,
    };
    let mut stdin = Cursor::new(br#"{"session_id":"s-integration"}"#.to_vec());
    agenthub_hook::run(&args, &env, &mut stdin, &agenthub_hook::real_connect);

    server_thread.join().expect("server thread must not panic");

    let snapshot = tracker.snapshot();
    assert_eq!(snapshot.len(), 1, "the hook must have created exactly one agent record");
    let agent = &snapshot[0];
    assert_eq!(agent.pane_id, "pane-integration-1");
    assert_eq!(agent.workspace_id, "ws-integration-1");
    // `Stop` with no visible/focused pane reported (the tracker's default) -> `done`,
    // proving the *whole* pipeline reached `apply_hook`, not just "some bytes arrived".
    assert_eq!(agent.state, AgentState::Done);
}
