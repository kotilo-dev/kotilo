//! Windows implementations: Toolhelp process snapshot, named-pipe connect, and
//! `%LOCALAPPDATA%\<brand slug>\hub`.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::{chain_from_parents, ProcessRef, CONNECT_TIMEOUT_MS};

/// The desktop app's hook pipe for its process id (same name as its `platform::hook_endpoint`).
pub fn endpoint_for_pid(pid: u32) -> String {
    format!(r"\\.\pipe\{}-{pid}", agenthub_proto::brand::EXE_PREFIX)
}

pub fn default_data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    env("LOCALAPPDATA")
        .filter(|v| !v.is_empty())
        .map(|d| PathBuf::from(d).join(agenthub_proto::brand::SLUG).join("hub"))
}

/// Windows uses `LOCALAPPDATA`, never `HOME`, for the data folder.
pub fn known_home() -> Option<String> {
    None
}

/// `%LOCALAPPDATA%` from the shell's known-folder API, for when the environment doesn't carry it:
/// Codex starts hooks with an empty environment on Windows (verified with codex-cli 0.160.0).
pub fn known_local_app_data() -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

    // SAFETY: plain shell API call; the returned buffer is freed with CoTaskMemFree once
    // copied into a String.
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None).ok()?;
        let text = path.to_string().ok();
        CoTaskMemFree(Some(path.0 as *const _));
        text.filter(|t| !t.is_empty())
    }
}

/// Ancestors of `self_pid`, nearest first, from one Toolhelp snapshot. Agents may start
/// the hook through a short-lived shell, so the hub needs the whole chain to find the
/// long-lived agent process. Empty on any failure.
pub fn process_chain(self_pid: u32, max_depth: usize) -> Vec<ProcessRef> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: plain Win32 call; the returned handle is closed below.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };

    let mut parents: HashMap<u32, (u32, String)> = HashMap::with_capacity(512);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry.dwSize` is set as the API requires; `snapshot` is valid.
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(entry.szExeFile.get(..len).unwrap_or_default());
            parents.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
            // SAFETY: as above.
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    // SAFETY: `snapshot` came from `CreateToolhelp32Snapshot` and is closed exactly once.
    let _ = unsafe { CloseHandle(snapshot) };

    chain_from_parents(&parents, self_pid, max_depth)
}

/// Desktop pipe connect + write: `CreateFileW`, retrying via `WaitNamedPipeW` while the
/// server pipe is momentarily busy, bounded by `CONNECT_TIMEOUT_MS`.
pub fn real_connect(endpoint: &str, bytes: &[u8], log: &dyn Fn(&str)) {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    use std::time::{Duration, Instant};
    use windows::core::HSTRING;
    use windows::Win32::Foundation::GENERIC_WRITE;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
    };
    use windows::Win32::System::Pipes::WaitNamedPipeW;

    let deadline = Instant::now() + Duration::from_millis(CONNECT_TIMEOUT_MS as u64);
    let pipe_path = HSTRING::from(endpoint);

    loop {
        // SAFETY: plain Win32 call with a valid wide path.
        let opened = unsafe {
            CreateFileW(
                &pipe_path,
                GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        match opened {
            Ok(handle) => {
                // SAFETY: `handle` is a fresh, uniquely-owned HANDLE from `CreateFileW`;
                // `File` takes ownership and closes it on drop.
                let mut file = unsafe { std::fs::File::from_raw_handle(handle.0) };
                if let Err(err) = file.write_all(bytes) {
                    log(&format!("pipe write failed: {err}"));
                }
                return;
            }
            Err(err) => {
                let now = Instant::now();
                if now >= deadline {
                    log(&format!("pipe connect timed out: {err}"));
                    return;
                }
                let remaining_ms = deadline
                    .saturating_duration_since(now)
                    .as_millis()
                    .min(u32::MAX as u128) as u32;
                // Returns promptly (failed) if the pipe doesn't exist at all, so this
                // never loops against a server that isn't running.
                // SAFETY: plain Win32 call with a valid wide path.
                let waited = unsafe { WaitNamedPipeW(&pipe_path, remaining_ms) };
                if !waited.as_bool() || Instant::now() >= deadline {
                    log("wait for pipe timed out or failed");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_connect_returns_promptly_when_pipe_does_not_exist() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        real_connect(r"\\.\pipe\agenthub-hook-test-does-not-exist", b"{}", &|_| {});
        assert!(start.elapsed() < Duration::from_millis(CONNECT_TIMEOUT_MS as u64 + 300));
    }

    #[test]
    fn process_chain_starts_at_this_process_parent() {
        let chain = process_chain(std::process::id(), 8);
        assert!(!chain.is_empty(), "a test process always has a parent");
        assert!(chain.iter().all(|p| p.pid != std::process::id()));
    }

    #[test]
    fn known_local_app_data_resolves_without_the_environment() {
        let dir = known_local_app_data().expect("known folder");
        assert!(std::path::Path::new(&dir).is_dir());
    }

    #[test]
    fn default_data_dir_uses_localappdata() {
        let env = |k: &str| (k == "LOCALAPPDATA").then(|| r"C:\Users\x\AppData\Local".to_string());
        assert_eq!(
            default_data_dir(&env),
            Some(PathBuf::from(r"C:\Users\x\AppData\Local").join(agenthub_proto::brand::SLUG).join("hub"))
        );
        assert_eq!(default_data_dir(&|_| None), None);
    }
}
