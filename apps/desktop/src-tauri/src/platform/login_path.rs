//! U-3: the login shell's `PATH` on macOS. An app started from Finder or the Dock gets
//! launchd's `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so agent detection, git and the hub
//! (started with this process's environment) would miss Homebrew, npm globals and
//! `~/.local/bin`. At start the user's login shell prints its `PATH` between two markers
//! (`$SHELL -i -l -c`, at most [`TIMEOUT`]); its entries go first, then the ones this
//! process already had. Failures are ignored. Other systems: nothing to do (a Linux
//! desktop session already carries the profile's `PATH`).

use std::time::Duration;

/// How long the login shell may take (an rc file with nvm/conda can be slow).
pub const TIMEOUT: Duration = Duration::from_secs(3);

const BEGIN: &str = "__AGENTHUB_LOGIN_PATH_BEGIN__";
const END: &str = "__AGENTHUB_LOGIN_PATH_END__";

/// What [`apply`] did, for the log (counts only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Not macOS, or started from a terminal (the `PATH` is the shell's already).
    Skipped,
    /// The shell failed, timed out or printed nothing usable.
    Failed,
    Applied { added: usize },
}

/// Merges the login shell's `PATH` into this process's environment. Call once, first thing
/// in `run()`, before any thread reads the environment.
pub fn apply() -> Outcome {
    if !cfg!(target_os = "macos") || std::env::var_os("TERM").is_some() {
        return Outcome::Skipped;
    }
    let shell = login_shell(std::env::var("SHELL").ok().as_deref());
    let Some(login) = read_login_path(&shell) else {
        return Outcome::Failed;
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_path(&login, &current);
    let added = count_entries(&merged) - count_entries(&current);
    if merged != current {
        // Single-threaded at this point (see the doc comment), so no reader races this.
        std::env::set_var("PATH", merged);
    }
    Outcome::Applied { added }
}

/// `$SHELL` when it is an absolute path, else zsh (macOS's default login shell).
pub fn login_shell(shell_env: Option<&str>) -> String {
    match shell_env {
        Some(s) if s.starts_with('/') => s.to_string(),
        _ => "/bin/zsh".to_string(),
    }
}

/// The `-c` script: works in sh, bash, zsh and fish (fish's `$PATH` is a list, so the
/// value comes from `printenv`, which prints the exported, colon-joined form).
pub fn probe_script() -> String {
    format!("printf '%s' '{BEGIN}'; /usr/bin/printenv PATH; printf '%s' '{END}'")
}

/// The `PATH` between the markers (rc files may print banners around it); `None` while the
/// end marker has not arrived yet or the value is empty.
pub fn extract_path(output: &str) -> Option<String> {
    let start = output.find(BEGIN)? + BEGIN.len();
    let len = output[start..].find(END)?;
    let path = output[start..start + len].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// `login`'s entries first, then `current`'s that are not in it; empty entries and
/// duplicates dropped. `:`-separated (macOS only, so not `std::env::join_paths`).
pub fn merge_path(login: &str, current: &str) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in login.split(':').chain(current.split(':')) {
        if !entry.is_empty() && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(":")
}

fn count_entries(path: &str) -> usize {
    path.split(':').filter(|e| !e.is_empty()).count()
}

#[cfg(target_os = "macos")]
fn read_login_path(shell: &str) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(shell);
    cmd.args(["-i", "-l", "-c", &probe_script()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: `setsid` is async-signal-safe. Its own session keeps an interactive shell
    // away from a terminal this app may have been started from (no job-control fights).
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    // Stops reading at the end marker: a daemon started by an rc file can keep the pipe
    // open long after the shell exited.
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(path) = extract_path(&String::from_utf8_lossy(&buf)) {
                let _ = tx.send(path);
                return;
            }
        }
    });
    let path = rx.recv_timeout(TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    path
}

#[cfg(not(target_os = "macos"))]
fn read_login_path(_shell: &str) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_path_reads_between_the_markers_and_ignores_banners() {
        let out = format!("Welcome!\n{BEGIN}/opt/homebrew/bin:/usr/bin\n{END}motd");
        assert_eq!(extract_path(&out).as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(extract_path(&format!("{BEGIN}/usr/bin")), None, "end marker not there yet");
        assert_eq!(extract_path(&format!("{BEGIN} \n{END}")), None);
        assert_eq!(extract_path("no markers"), None);
    }

    #[test]
    fn merge_path_puts_login_entries_first_without_duplicates() {
        assert_eq!(
            merge_path("/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin", "/usr/bin:/bin:/usr/sbin::/sbin"),
            "/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin:/bin:/usr/sbin:/sbin"
        );
        assert_eq!(merge_path("", "/usr/bin:/bin"), "/usr/bin:/bin");
        assert_eq!(count_entries("/a::/b:"), 2);
    }

    #[test]
    fn login_shell_falls_back_to_zsh() {
        assert_eq!(login_shell(Some("/opt/homebrew/bin/fish")), "/opt/homebrew/bin/fish");
        assert_eq!(login_shell(Some("fish")), "/bin/zsh");
        assert_eq!(login_shell(Some("")), "/bin/zsh");
        assert_eq!(login_shell(None), "/bin/zsh");
    }

    #[test]
    fn probe_script_prints_path_between_the_markers() {
        let script = probe_script();
        assert!(script.contains(BEGIN) && script.contains(END) && script.contains("printenv PATH"));
    }

    /// The real probe against `/bin/sh` (non-interactive flags differ, so `-c` only).
    #[cfg(unix)]
    #[test]
    fn probe_script_runs_in_sh() {
        let out = std::process::Command::new("/bin/sh")
            .args(["-c", &probe_script()])
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("sh runs");
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(extract_path(&text).as_deref(), Some("/usr/bin:/bin"));
    }
}
