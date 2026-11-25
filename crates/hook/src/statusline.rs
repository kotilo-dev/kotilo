//! The `agenthub-statusline` helper (shipped as `kotilo-statusline`): Claude Code runs it as its
//! `statusLine` command on every render and feeds it a JSON object on stdin (spec §9, D-078).
//!
//! 1. The JSON is forwarded, byte for byte, to the hub (`POST /v1/statusline`) within a hard budget
//!    ([`HUB_BUDGET_MS`]); a missing port file or a hub that is down is silent. Nothing is written
//!    to disk (no transcript content at rest, AGENTS.md rule 5).
//! 2. The line shown below the prompt is, in this order: the output of the user's own previous
//!    statusLine command (stored by the hub in `statusline.json`, run concurrently with the hub
//!    post so a down hub never delays it) with the plan limits and prompt cache appended
//!    (`<your line> · 5h 42% (2h10m) · wk 18% · cache 91% (4m)`), else a short language-neutral
//!    summary (`5h 42% (2h10m) · wk 18% · cache 91% (4m) · ctx 37%`), else nothing.
//!
//! Claude blanks the line on a non-zero exit, so the binary always exits 0 (`main` does).
//! Everything here is generic over its inputs so it is testable without a real Claude.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::{data_dir, platform, post_json, read_port_file, strip_bom, MAX_STDIN_BYTES};

/// Hard total budget for delivering the JSON to the hub (connect + write + status line).
pub const HUB_BUDGET_MS: u64 = 150;
/// The user's own command is killed after this long; Claude cancels slow status lines itself.
pub const WRAPPED_TIMEOUT_MS: u64 = 5_000;
/// File in the hub data folder holding `{"wrappedCommand": "<the user's command>"}`.
pub const CONFIG_FILE_NAME: &str = "statusline.json";
/// Route on the hub.
pub const HUB_PATH: &str = "/v1/statusline";

/// The user's original statusLine command from `<data>/statusline.json`, if configured.
pub fn wrapped_command(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join(CONFIG_FILE_NAME)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(strip_bom(&bytes)).ok()?;
    let command = value.get("wrappedCommand")?.as_str()?.trim();
    (!command.is_empty()).then(|| command.to_string())
}

/// `5h 42% (2h10m) · wk 18% · cache 91% (4m) · ctx 37%`; parts without data (and windows that
/// already reset) are left out. Empty when nothing is known.
pub fn summary(payload: &serde_json::Value, now_unix: u64) -> String {
    let mut parts = extras(payload, now_unix);
    if let Some(percent) = percent(payload.get("context_window").and_then(|c| c.get("used_percentage"))) {
        parts.push(format!("ctx {percent}%"));
    }
    parts.join(SEPARATOR)
}

const SEPARATOR: &str = " \u{b7} ";

/// What Kotilo adds to a line: the plan limit windows and the prompt cache. Context is left to the
/// user's own line, which nearly always shows it already.
fn extras(payload: &serde_json::Value, now_unix: u64) -> Vec<String> {
    let mut parts = Vec::new();
    for (key, label, with_remaining) in [("five_hour", "5h", true), ("seven_day", "wk", false)] {
        let Some(window) = payload.get("rate_limits").and_then(|r| r.get(key)) else {
            continue;
        };
        let Some(percent) = percent(window.get("used_percentage")) else {
            continue;
        };
        let resets_at = window.get("resets_at").and_then(serde_json::Value::as_f64);
        if resets_at.is_some_and(|t| t <= now_unix as f64) {
            continue;
        }
        let mut part = format!("{label} {percent}%");
        if let (true, Some(t)) = (with_remaining, resets_at) {
            part.push_str(&format!(" ({})", remaining((t as u64).saturating_sub(now_unix))));
        }
        parts.push(part);
    }
    if let Some(part) = cache_part(payload.get("prompt_cache"), now_unix) {
        parts.push(part);
    }
    parts
}

/// `cache 91% (4m)` while the cached prefix is warm (time until it goes cold), `cache 91% cold`
/// after. From Claude Code's `prompt_cache` object (v2.1.251+: `hit_ratio` 0..1 or null, `warm`,
/// `expires_at` epoch seconds or null); absent before the first API response.
fn cache_part(cache: Option<&serde_json::Value>, now_unix: u64) -> Option<String> {
    let cache = cache?;
    let ratio = cache.get("hit_ratio")?.as_f64().filter(|r| r.is_finite())?;
    let mut part = format!("cache {}%", (ratio * 100.0).round().clamp(0.0, 100.0) as u32);
    let warm = cache.get("warm").and_then(serde_json::Value::as_bool).unwrap_or(false);
    match cache.get("expires_at").and_then(serde_json::Value::as_f64) {
        Some(t) if warm && t > now_unix as f64 => {
            part.push_str(&format!(" ({})", remaining((t as u64).saturating_sub(now_unix))));
        }
        _ => part.push_str(" cold"),
    }
    Some(part)
}

/// The user's own output with the extras appended to its last line (trailing blank lines dropped).
fn append_extras(output: Vec<u8>, extras: &[String]) -> Vec<u8> {
    if extras.is_empty() {
        return output;
    }
    let mut text = String::from_utf8_lossy(&output).trim_end().to_string();
    text.push_str(SEPARATOR);
    text.push_str(&extras.join(SEPARATOR));
    text.into_bytes()
}

fn percent(value: Option<&serde_json::Value>) -> Option<u32> {
    let p = value?.as_f64()?;
    p.is_finite().then(|| p.round().clamp(0.0, 999.0) as u32)
}

/// `2h10m`, or `35m` below an hour (at least `1m`).
fn remaining(seconds: u64) -> String {
    let minutes = seconds.div_ceil(60).max(1);
    if minutes >= 60 {
        format!("{}h{:02}m", minutes / 60, minutes % 60)
    } else {
        format!("{minutes}m")
    }
}

/// Delivers `body` to the hub; every failure is swallowed (the status line must never wait for it).
fn post_to_hub(dir: Option<PathBuf>, body: Vec<u8>, budget: Duration) {
    if body.is_empty() {
        return;
    }
    let Some((port, token)) = dir.as_deref().and_then(read_port_file) else {
        return;
    };
    let _ = post_json(HUB_PATH, port, &token, &body, budget);
}

/// Runs the user's command through the platform shell with `input` on stdin; its stdout, or
/// `None` when it could not be started. Killed after `timeout` (partial output is kept).
fn run_wrapped(command: &str, input: &[u8], timeout: Duration) -> Option<Vec<u8>> {
    let mut child = platform::shell_command(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_vec();
        // A thread: a command that never reads stdin must not block us on a large write.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = tx.send(out);
        });
    }

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
    // The pipe closes with the process; a grandchild that keeps it open must not hold us.
    Some(rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default())
}

/// The whole helper: reads Claude's JSON from `stdin`, forwards it to the hub and returns the bytes
/// to print. `now_unix` is injected for tests.
pub fn run<R: Read>(
    env: &dyn Fn(&str) -> Option<String>,
    stdin: &mut R,
    now_unix: u64,
    hub_budget: Duration,
    wrapped_timeout: Duration,
) -> Vec<u8> {
    let mut raw = Vec::new();
    let _ = stdin.take(MAX_STDIN_BYTES).read_to_end(&mut raw);
    let body = strip_bom(&raw).to_vec();
    let dir = data_dir(env);

    let hub = {
        let (dir, body) = (dir.clone(), body.clone());
        std::thread::spawn(move || post_to_hub(dir, body, hub_budget))
    };

    // A user command that printed nothing (it failed, or the shell could not run it) shows the
    // summary instead of a blank line.
    let wrapped = dir
        .as_deref()
        .and_then(wrapped_command)
        .and_then(|c| run_wrapped(&c, &body, wrapped_timeout))
        .filter(|out| !out.iter().all(u8::is_ascii_whitespace));
    let payload = serde_json::from_slice::<serde_json::Value>(&body).ok();
    let output = match (wrapped, payload) {
        (Some(out), Some(payload)) => append_extras(out, &extras(&payload, now_unix)),
        (Some(out), None) => out,
        (None, Some(payload)) => summary(&payload, now_unix).into_bytes(),
        (None, None) => Vec::new(),
    };
    let _ = hub.join();
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::net::TcpListener;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn summary_with_everything() {
        let payload = json!({
            "rate_limits": {
                "five_hour": {"used_percentage": 41.6, "resets_at": NOW + 2 * 3600 + 10 * 60},
                "seven_day": {"used_percentage": 18, "resets_at": NOW + 86_400}
            },
            "context_window": {"used_percentage": 37}
        });
        assert_eq!(summary(&payload, NOW), "5h 42% (2h10m) \u{b7} wk 18% \u{b7} ctx 37%");
    }

    #[test]
    fn summary_under_an_hour_and_without_reset_time() {
        let payload = json!({"rate_limits": {"five_hour": {"used_percentage": 5, "resets_at": NOW + 35 * 60}, "seven_day": {"used_percentage": 9}}});
        assert_eq!(summary(&payload, NOW), "5h 5% (35m) \u{b7} wk 9%");
    }

    #[test]
    fn summary_partial_and_empty() {
        assert_eq!(summary(&json!({"context_window": {"used_percentage": 12.2}}), NOW), "ctx 12%");
        assert_eq!(summary(&json!({}), NOW), "");
        assert_eq!(summary(&json!({"rate_limits": {"five_hour": {"resets_at": NOW + 60}}}), NOW), "");
        assert_eq!(summary(&json!([1, 2]), NOW), "");
    }

    #[test]
    fn cache_part_warm_cold_and_absent() {
        let warm = json!({"prompt_cache": {"warm": true, "hit_ratio": 0.914, "expires_at": NOW + 4 * 60}});
        assert_eq!(summary(&warm, NOW), "cache 91% (4m)");
        let cold = json!({"prompt_cache": {"warm": false, "hit_ratio": 0.5, "expires_at": null}});
        assert_eq!(summary(&cold, NOW), "cache 50% cold");
        let expired = json!({"prompt_cache": {"warm": true, "hit_ratio": 0.5, "expires_at": NOW - 1}});
        assert_eq!(summary(&expired, NOW), "cache 50% cold");
        assert_eq!(summary(&json!({"prompt_cache": {"warm": true, "hit_ratio": null}}), NOW), "");
        let all = json!({
            "rate_limits": {"seven_day": {"used_percentage": 47}},
            "prompt_cache": {"warm": true, "hit_ratio": 1.0, "expires_at": NOW + 3600},
            "context_window": {"used_percentage": 6}
        });
        assert_eq!(summary(&all, NOW), "wk 47% \u{b7} cache 100% (1h00m) \u{b7} ctx 6%");
    }

    #[test]
    fn summary_skips_a_window_that_already_reset() {
        let payload = json!({"rate_limits": {
            "five_hour": {"used_percentage": 99, "resets_at": NOW - 1},
            "seven_day": {"used_percentage": 20, "resets_at": NOW + 100}}});
        assert_eq!(summary(&payload, NOW), "wk 20%");
    }

    fn env_for(dir: &Path) -> impl Fn(&str) -> Option<String> + '_ {
        move |k| (k == crate::ENV_DATA_DIR).then(|| dir.to_string_lossy().into_owned())
    }

    fn run_with(dir: &Path, stdin: &[u8]) -> Vec<u8> {
        run(&env_for(dir), &mut &stdin[..], NOW, Duration::from_millis(HUB_BUDGET_MS), Duration::from_secs(10))
    }

    /// Accepts one connection and reports the raw request.
    fn fake_hub() -> (u16, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = s.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let _ = s.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
        });
        (port, rx)
    }

    #[test]
    fn forwards_stdin_to_the_hub_and_prints_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        let (port, rx) = fake_hub();
        std::fs::write(dir.path().join("port.json"), format!(r#"{{"port":{port},"token":"tok123"}}"#)).unwrap();
        let json = br#"{"session_id":"s1","context_window":{"used_percentage":37}}"#;
        let out = run_with(dir.path(), json);
        assert_eq!(String::from_utf8(out).unwrap(), "ctx 37%");
        let request = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(request.starts_with("POST /v1/statusline HTTP/1.1\r\n"), "{request}");
        assert!(request.contains("X-AgentHub-Token: tok123"));
        assert!(request.ends_with(std::str::from_utf8(json).unwrap()));
    }

    #[test]
    fn budget_is_respected_when_nothing_listens() {
        let dir = tempfile::tempdir().unwrap();
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        std::fs::write(dir.path().join("port.json"), format!(r#"{{"port":{port},"token":"t"}}"#)).unwrap();
        let started = Instant::now();
        let out = run_with(dir.path(), br#"{"context_window":{"used_percentage":1}}"#);
        assert_eq!(out, b"ctx 1%");
        assert!(started.elapsed() < Duration::from_millis(HUB_BUDGET_MS + 300), "{:?}", started.elapsed());
    }

    #[test]
    fn no_port_file_and_garbage_stdin_are_silent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(run_with(dir.path(), b"not json").is_empty());
        assert!(run_with(dir.path(), b"").is_empty());
    }

    #[test]
    fn wrapped_command_output_replaces_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":"echo wrapped-ok"}"#).unwrap();
        let out = run_with(dir.path(), br#"{"context_window":{"used_percentage":1}}"#);
        assert_eq!(String::from_utf8(out).unwrap().trim(), "wrapped-ok");
    }

    #[test]
    fn wrapped_command_output_gets_limits_and_cache_appended() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":"echo Opus ctx 6%"}"#).unwrap();
        let payload = json!({
            "rate_limits": {"five_hour": {"used_percentage": 16, "resets_at": NOW + 37 * 60}, "seven_day": {"used_percentage": 47}},
            "prompt_cache": {"warm": false, "hit_ratio": 0.9},
            "context_window": {"used_percentage": 6}
        })
        .to_string();
        let out = run_with(dir.path(), payload.as_bytes());
        assert_eq!(String::from_utf8(out).unwrap(), "Opus ctx 6% \u{b7} 5h 16% (37m) \u{b7} wk 47% \u{b7} cache 90% cold");
    }

    #[test]
    fn wrapped_command_gets_the_same_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let echo_stdin = if cfg!(windows) { r#"findstr "^""# } else { "cat" };
        let config = serde_json::json!({ "wrappedCommand": echo_stdin }).to_string();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), config).unwrap();
        let out = run_with(dir.path(), br#"{"x":1}"#);
        assert_eq!(String::from_utf8(out).unwrap().trim(), r#"{"x":1}"#);
    }

    #[test]
    fn wrapped_command_runs_when_the_hub_is_down_and_a_failing_command_still_returns() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("port.json"), r#"{"port":1,"token":"t"}"#).unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":"echo partial && exit 3"}"#).unwrap();
        let out = run_with(dir.path(), b"{}");
        assert_eq!(String::from_utf8(out).unwrap().trim(), "partial");
    }

    #[test]
    fn a_wrapped_command_that_prints_nothing_shows_the_summary() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":"exit 1"}"#).unwrap();
        let out = run_with(dir.path(), br#"{"context_window":{"used_percentage":37}}"#);
        assert_eq!(String::from_utf8(out).unwrap(), "ctx 37%");
    }

    #[test]
    fn a_slow_wrapped_command_is_killed_after_the_timeout() {
        let dir = tempfile::tempdir().unwrap();
        // No `>nul`: on Windows the command runs in Git Bash when present, which creates a file
        // named `nul` in the working directory. Partial ping output may be kept; only time matters.
        let sleeper = if cfg!(windows) { "ping -n 20 127.0.0.1" } else { "sleep 20" };
        let config = serde_json::json!({ "wrappedCommand": sleeper }).to_string();
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), config).unwrap();
        let started = Instant::now();
        let _ = run(&env_for(dir.path()), &mut &b"{}"[..], NOW, Duration::from_millis(50), Duration::from_millis(300));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn wrapped_command_config_ignores_blank_or_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(wrapped_command(dir.path()), None);
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":"  "}"#).unwrap();
        assert_eq!(wrapped_command(dir.path()), None);
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), "{").unwrap();
        assert_eq!(wrapped_command(dir.path()), None);
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), r#"{"wrappedCommand":null}"#).unwrap();
        assert_eq!(wrapped_command(dir.path()), None);
    }
}
