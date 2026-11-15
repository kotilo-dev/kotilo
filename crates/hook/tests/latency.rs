//! End-to-end hook latency: the real `agenthub-hook` binary per event (process start,
//! process-chain snapshot, loopback POST to a fake hub). This is the time an agent waits on
//! every hook firing, so it must stay well inside the watchdog budget.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const RUNS: usize = 20;
/// The binary's watchdog force-exits after HUB_BUDGET_MS + CONNECT_TIMEOUT_MS + 250 ms; a
/// p95 near that means delivery is timing out, not just slow.
const P95_LIMIT: Duration = Duration::from_millis(
    agenthub_hook::HUB_BUDGET_MS as u64 + agenthub_hook::CONNECT_TIMEOUT_MS as u64,
);

/// Answers every request with 200 and reports each request body.
fn fake_hub() -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read the head, then Content-Length bytes of body.
            let body = loop {
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break None,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
                let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let len: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                if buf.len() >= end + 4 + len {
                    break Some(String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).into_owned());
                }
            };
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            if let Some(b) = body {
                let _ = tx.send(b);
            }
        }
    });
    (port, rx)
}

#[test]
fn hook_delivers_each_event_within_budget() {
    let (port, rx) = fake_hub();
    let data = tempfile::tempdir().unwrap();
    std::fs::write(
        data.path().join(agenthub_hook::PORT_FILE_NAME),
        format!(r#"{{"port":{port},"token":"latency-test"}}"#),
    )
    .unwrap();

    let mut times = Vec::with_capacity(RUNS);
    for i in 0..RUNS {
        let start = Instant::now();
        let mut child = Command::new(env!("CARGO_BIN_EXE_agenthub-hook"))
            .args(["--agent", "claude-code", "--event", "Notification"])
            .env(agenthub_hook::ENV_DATA_DIR, data.path())
            .env_remove("AGENTHUB_ENDPOINT")
            .env_remove("AGENTHUB_PANE_ID")
            .env_remove("CURSOR_TRACE_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let payload = format!(r#"{{"session_id":"s-{i}","hook_event_name":"Notification","cwd":"."}}"#);
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let status = child.wait().unwrap();
        times.push(start.elapsed());
        assert!(status.success(), "run {i}: {status}");
        let body = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_else(|_| panic!("run {i}: no event reached the hub"));
        assert!(body.contains(&format!("s-{i}")), "run {i}: {body}");
    }

    // Spooling would mean a POST failed although the hub answered.
    assert!(!data.path().join(agenthub_hook::SPOOL_DIR_NAME).exists(), "events were spooled");

    times.sort();
    let p50 = times[RUNS / 2];
    let p95 = times[RUNS * 95 / 100 - 1];
    let max = times[RUNS - 1];
    println!("hook latency over {RUNS} runs: p50 {p50:?}, p95 {p95:?}, max {max:?}");
    assert!(p95 < P95_LIMIT, "p95 {p95:?} ≥ {P95_LIMIT:?} (all: {times:?})");
}
