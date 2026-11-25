//! The real `agenthub-statusline` binary: whatever Claude feeds it, it exits 0 (a non-zero exit
//! blanks Claude's status line) and prints only the expected line.

use std::io::Write;
use std::process::{Command, Stdio};

fn run(data_dir: &std::path::Path, stdin: &[u8]) -> (Option<i32>, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agenthub-statusline"))
        .env("AGENTHUB_DATA_DIR", data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.stderr.is_empty(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    (out.status.code(), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn exits_zero_for_garbage_empty_and_valid_input() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(run(dir.path(), b"\xff\xfe not json"), (Some(0), String::new()));
    assert_eq!(run(dir.path(), b""), (Some(0), String::new()));
    assert_eq!(
        run(dir.path(), br#"{"context_window":{"used_percentage":37}}"#),
        (Some(0), "ctx 37%".to_string())
    );
}

#[test]
fn exits_zero_with_a_failing_wrapped_command_and_no_hub() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("port.json"), r#"{"port":1,"token":"t"}"#).unwrap();
    std::fs::write(dir.path().join("statusline.json"), r#"{"wrappedCommand":"echo from-user && exit 7"}"#).unwrap();
    let (code, out) = run(dir.path(), b"{}");
    assert_eq!(code, Some(0));
    assert_eq!(out.trim(), "from-user");
}
