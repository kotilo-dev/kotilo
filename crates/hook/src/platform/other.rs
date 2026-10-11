//! Non-Windows stubs: the desktop pipe and process-tree query are Windows-only for now
//! (D-007); the data folder matches .NET's `LocalApplicationData` on Unix.

use std::path::PathBuf;

use crate::ProcessRef;

pub fn process_chain(_self_pid: u32, _max_depth: usize) -> Vec<ProcessRef> {
    Vec::new()
}

pub fn real_connect(_endpoint: &str, _bytes: &[u8], _log: &dyn Fn(&str)) {}

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
