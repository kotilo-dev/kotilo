//! Unix implementations: the process-tree query (`/proc` on Linux, one `ps` on macOS), the
//! desktop app's Unix socket connect, and the data folder matching .NET's
//! `LocalApplicationData` on Unix (`~/Library/Application Support` on macOS, the XDG data folder elsewhere).

use std::collections::HashMap;
use std::path::PathBuf;

use crate::{chain_from_parents, ProcessRef, CONNECT_TIMEOUT_MS};

/// Ancestors of `self_pid`, nearest first (pid + executable name).
pub fn process_chain(self_pid: u32, max_depth: usize) -> Vec<ProcessRef> {
    chain_from_parents(&parents(self_pid, max_depth), self_pid, max_depth)
}

/// Linux: walks up through `/proc/<pid>/stat`, reading only the processes on the chain.
#[cfg(target_os = "linux")]
fn parents(self_pid: u32, max_depth: usize) -> HashMap<u32, (u32, String)> {
    let mut parents = HashMap::new();
    let mut pid = self_pid;
    for _ in 0..=max_depth {
        let Some((ppid, name)) = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|text| parse_proc_stat(&text))
        else {
            break;
        };
        parents.insert(pid, (ppid, name));
        if ppid == 0 {
            break;
        }
        pid = ppid;
    }
    parents
}

/// macOS (no `/proc`): one `ps` snapshot. Absolute path: hooks may run with an empty `PATH`.
#[cfg(not(target_os = "linux"))]
fn parents(_self_pid: u32, _max_depth: usize) -> HashMap<u32, (u32, String)> {
    std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid=,comm="])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_ps_line).collect())
        .unwrap_or_default()
}

/// `/proc/<pid>/stat`: `pid (comm) state ppid …`. `comm` may hold spaces or `)`, so the
/// fields after it are taken from the last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_stat(text: &str) -> Option<(u32, String)> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let name = text.get(open + 1..close)?.to_string();
    let ppid = text.get(close + 1..)?.split_whitespace().nth(1)?.parse().ok()?;
    Some((ppid, name))
}

/// One `ps -o pid=,ppid=,comm=` line; `comm` is the executable path (may hold spaces), kept
/// as its file name.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn parse_ps_line(line: &str) -> Option<(u32, (u32, String))> {
    let mut fields = line.trim_start().splitn(2, char::is_whitespace);
    let pid = fields.next()?.parse().ok()?;
    let mut rest = fields.next()?.trim_start().splitn(2, char::is_whitespace);
    let ppid = rest.next()?.parse().ok()?;
    let comm = rest.next()?.trim();
    let name = comm.rsplit('/').next().unwrap_or(comm).to_string();
    Some((pid, (ppid, name)))
}

/// The desktop app's hook socket for its process id (same path as its `platform::hook_endpoint`).
pub fn endpoint_for_pid(pid: u32) -> String {
    format!("/tmp/{}-{pid}.sock", agenthub_proto::brand::EXE_PREFIX)
}

/// Desktop socket connect + write, bounded by `CONNECT_TIMEOUT_MS`. A missing socket fails
/// at once; the listener's backlog absorbs bursts, so there is no retry loop.
pub fn real_connect(endpoint: &str, bytes: &[u8], log: &dyn Fn(&str)) {
    use std::io::Write;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut stream = match UnixStream::connect(endpoint) {
        Ok(stream) => stream,
        Err(err) => {
            log(&format!("socket connect failed: {err}"));
            return;
        }
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(CONNECT_TIMEOUT_MS as u64)));
    if let Err(err) = stream.write_all(bytes) {
        log(&format!("socket write failed: {err}"));
    }
}

pub fn known_local_app_data() -> Option<String> {
    None
}

/// The home folder when `HOME` is missing (an agent may start hooks with an empty environment, as
/// Codex does on Windows): the password database, the same fallback .NET uses for the hub's folders.
pub fn known_home() -> Option<String> {
    #[allow(deprecated)]
    std::env::home_dir().map(|h| h.to_string_lossy().into_owned()).filter(|h| !h.is_empty())
}

/// `<LocalApplicationData>/<brand slug>/hub`, the hub's default data folder (`AppPaths.FromEnvironment`).
pub fn default_data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    Some(local_app_data(cfg!(target_os = "macos"), env)?.join(agenthub_proto::brand::SLUG).join("hub"))
}

/// .NET 8+ `SpecialFolder.LocalApplicationData` on Unix: `~/Library/Application Support` on macOS,
/// else `$XDG_DATA_HOME` or `~/.local/share`.
fn local_app_data(macos: bool, env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let home = || env("HOME").filter(|v| !v.is_empty()).map(PathBuf::from);
    if macos {
        return home().map(|h| h.join("Library").join("Application Support"));
    }
    env("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".local").join("share")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_connect_writes_the_message_to_the_socket() {
        use std::io::Read;
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hook.sock");
        let listener = UnixListener::bind(&path).unwrap();
        real_connect(path.to_str().unwrap(), b"{\"a\":1}", &|line| panic!("{line}"));
        let (mut conn, _) = listener.accept().unwrap();
        let mut buf = Vec::new();
        conn.read_to_end(&mut buf).unwrap();
        assert_eq!(buf, b"{\"a\":1}");
    }

    #[test]
    fn real_connect_logs_a_missing_socket() {
        let dir = tempfile::tempdir().unwrap();
        let logged = std::cell::RefCell::new(Vec::new());
        real_connect(dir.path().join("none.sock").to_str().unwrap(), b"{}", &|line| logged.borrow_mut().push(line.to_string()));
        assert_eq!(logged.borrow().len(), 1);
    }

    #[test]
    fn endpoint_for_pid_is_a_socket_in_tmp() {
        assert_eq!(endpoint_for_pid(7), format!("/tmp/{}-7.sock", agenthub_proto::brand::EXE_PREFIX));
    }

    #[test]
    fn parse_proc_stat_reads_ppid_and_a_name_with_spaces_and_parens() {
        assert_eq!(parse_proc_stat("4321 (zsh) S 1200 4321 4321 34816"), Some((1200, "zsh".to_string())));
        assert_eq!(parse_proc_stat("77 (my (odd) app) R 1 77"), Some((1, "my (odd) app".to_string())));
        assert_eq!(parse_proc_stat("garbage"), None);
    }

    #[test]
    fn parse_ps_line_keeps_the_executable_file_name() {
        assert_eq!(
            parse_ps_line("  812   1 /Applications/Kotilo.app/Contents/MacOS/Kotilo"),
            Some((812, (1, "Kotilo".to_string())))
        );
        assert_eq!(parse_ps_line("900 812 -zsh"), Some((900, (812, "-zsh".to_string()))));
        assert_eq!(parse_ps_line("1 0 /sbin/launchd with space"), Some((1, (0, "launchd with space".to_string()))));
        assert_eq!(parse_ps_line("x 1 bad"), None);
    }

    #[test]
    fn local_app_data_on_macos_is_application_support_and_ignores_xdg() {
        let env = |k: &str| match k {
            "HOME" => Some("/Users/u".to_string()),
            "XDG_DATA_HOME" => Some("/x/data".to_string()),
            _ => None,
        };
        assert_eq!(local_app_data(true, &env), Some(PathBuf::from("/Users/u/Library/Application Support")));
        assert_eq!(local_app_data(true, &|_| None), None);
    }

    #[test]
    fn local_app_data_elsewhere_is_xdg_data_home_or_local_share() {
        let xdg = |k: &str| match k {
            "HOME" => Some("/home/u".to_string()),
            "XDG_DATA_HOME" => Some("/x/data".to_string()),
            _ => None,
        };
        assert_eq!(local_app_data(false, &xdg), Some(PathBuf::from("/x/data")));
        let home = |k: &str| (k == "HOME").then(|| "/home/u".to_string());
        assert_eq!(local_app_data(false, &home), Some(PathBuf::from("/home/u/.local/share")));
        assert_eq!(local_app_data(false, &|_| None), None);
    }

    #[test]
    fn default_data_dir_is_the_brand_hub_folder_for_this_os() {
        let env = |k: &str| (k == "HOME").then(|| "/h".to_string());
        let base = if cfg!(target_os = "macos") { "/h/Library/Application Support" } else { "/h/.local/share" };
        assert_eq!(
            default_data_dir(&env),
            Some(PathBuf::from(base).join(agenthub_proto::brand::SLUG).join("hub"))
        );
    }

    #[test]
    fn known_home_is_not_empty() {
        assert!(known_home().is_some_and(|h| h.starts_with('/')));
    }

    #[test]
    fn process_chain_reaches_this_test_process_parent() {
        let chain = process_chain(std::process::id(), 8);
        assert!(!chain.is_empty(), "a test process always has a parent");
        assert!(chain.iter().all(|p| p.pid != std::process::id()));
    }
}
