//! Unix implementations: the desktop app's Unix socket connect; the process-tree query is
//! still a stub (D-007), and the data folder matches .NET's `LocalApplicationData` on Unix.

use std::path::PathBuf;

use crate::{ProcessRef, CONNECT_TIMEOUT_MS};

pub fn process_chain(_self_pid: u32, _max_depth: usize) -> Vec<ProcessRef> {
    Vec::new()
}

/// The desktop app's hook socket for its process id (same path as its `platform::hook_endpoint`).
pub fn endpoint_for_pid(pid: u32) -> String {
    std::env::temp_dir()
        .join(format!("{}-{pid}.sock", agenthub_proto::brand::EXE_PREFIX))
        .to_string_lossy()
        .into_owned()
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

pub fn default_data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let base = env("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env("HOME")
                .filter(|v| !v.is_empty())
                .map(|h| PathBuf::from(h).join(".local").join("share"))
        })?;
    Some(base.join(agenthub_proto::brand::SLUG).join("hub"))
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
    fn endpoint_for_pid_is_a_socket_in_the_temp_dir() {
        let name = endpoint_for_pid(7);
        assert!(PathBuf::from(&name).starts_with(std::env::temp_dir()));
        assert!(name.ends_with(&format!("{}-7.sock", agenthub_proto::brand::EXE_PREFIX)), "{name}");
    }
}
