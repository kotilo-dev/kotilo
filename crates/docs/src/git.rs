//! Read-only git CLI calls: `GIT_OPTIONAL_LOCKS=0` (no index refresh writes), fsmonitor off,
//! no prompts, a timeout and no console window – the same pattern as the desktop's `gitcli`.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::platform;

pub const GIT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitError {
    /// `git` is not on PATH.
    NotInstalled,
    Timeout,
    Io(String),
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::NotInstalled => f.write_str("git is not installed"),
            GitError::Timeout => f.write_str("git timed out"),
            GitError::Io(e) => write!(f, "git: {e}"),
        }
    }
}

fn read_pipe<R: Read + Send + 'static>(pipe: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut pipe) = pipe {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    rx
}

/// Runs `git <args>` in `cwd` (optionally feeding `stdin`) and returns stdout when it exits
/// with 0, `Ok(None)` when it exits non-zero (not a repo, unknown revision, ...).
pub fn run(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Option<Vec<u8>>, GitError> {
    let mut cmd = Command::new("git");
    cmd.args([
        "-c",
        "core.quotepath=off",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "log.follow=false",
        "-c",
        "log.showSignature=false",
    ])
    .args(args)
    .current_dir(cwd)
    .env("GIT_OPTIONAL_LOCKS", "0")
    .env("GIT_TERMINAL_PROMPT", "0")
    .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    platform::hide_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Io(e.to_string()),
    })?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let input = input.to_vec();
        // On a helper thread: a large input must not block while git fills stdout.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }
    let stdout_rx = read_pipe(child.stdout.take());
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(3)),
            Err(e) => return Err(GitError::Io(e.to_string())),
        }
    };
    let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
    let stdout = stdout_rx.recv_timeout(remaining).map_err(|_| GitError::Timeout)?;
    Ok(status.success().then_some(stdout))
}

/// First line of stdout, trimmed; `None` when git failed or printed nothing.
pub fn line(cwd: &Path, args: &[&str]) -> Result<Option<String>, GitError> {
    Ok(run(cwd, args, None)?.and_then(|out| {
        let text = String::from_utf8_lossy(&out);
        let first = text.lines().next().unwrap_or("").trim().to_string();
        (!first.is_empty()).then_some(first)
    }))
}

/// Undoes git's C-style quoting of a path (`"a\tb"`), used for names with control characters,
/// quotes or backslashes even with `core.quotepath=off`.
pub fn unquote(name: &str) -> String {
    let Some(inner) = name.strip_prefix('"').and_then(|n| n.strip_suffix('"')) else {
        return name.to_string();
    };
    let bytes = inner.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' || i + 1 >= bytes.len() {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        let octal = |b: u8| (b'0'..=b'7').contains(&b);
        if octal(next) && i + 3 < bytes.len() && octal(bytes[i + 2]) && octal(bytes[i + 3]) {
            let value = (u32::from(next - b'0') << 6) | (u32::from(bytes[i + 2] - b'0') << 3) | u32::from(bytes[i + 3] - b'0');
            out.push((value & 0xff) as u8);
            i += 4;
            continue;
        }
        out.push(match next {
            b'n' => b'\n',
            b't' => b'\t',
            b'r' => b'\r',
            b'a' => 0x07,
            b'b' => 0x08,
            b'f' => 0x0c,
            b'v' => 0x0b,
            other => other,
        });
        i += 2;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::unquote;

    #[test]
    fn unquotes_c_style_names() {
        assert_eq!(unquote("plain/name.rs"), "plain/name.rs");
        assert_eq!(unquote("\"a\\tb\""), "a\tb");
        assert_eq!(unquote("\"q\\\"x\\\\y\""), "q\"x\\y");
        assert_eq!(unquote("\"\\303\\274.md\""), "ü.md");
    }
}
