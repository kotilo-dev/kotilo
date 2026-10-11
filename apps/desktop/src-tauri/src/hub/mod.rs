//! The hub sidecar (ARCHITECTURE §2.1/§5): where it lives, how to reach it, and the
//! supervisor that keeps it running. The hub writes `port.json` (`{v, port, token, pid}`)
//! into its data dir once it listens; every request carries that token.

pub mod client;
pub mod stream;
pub mod supervisor;

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Header the hub checks on every request (`Hub.Contracts.HubApi.TokenHeader`). A protocol
/// name like the `AGENTHUB_*` env vars: it stays under any brand.
pub const TOKEN_HEADER: &str = "X-AgentHub-Token";
pub const PORT_FILE_NAME: &str = "port.json";
pub const HUB_EXE_STEM: &str = crate::brand::HUB_EXE_STEM;

/// Contents of the hub's `port.json` (`Hub.Contracts.PortFile`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PortFile {
    pub v: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

impl PortFile {
    /// `None` for anything that isn't a usable port file (same rule as the hub's own parser).
    pub fn parse(text: &str) -> Option<Self> {
        let file: PortFile = serde_json::from_str(text).ok()?;
        (file.port > 0 && !file.token.is_empty()).then_some(file)
    }

    pub fn read(data_dir: &Path) -> Option<Self> {
        std::fs::read_to_string(data_dir.join(PORT_FILE_NAME))
            .ok()
            .and_then(|t| Self::parse(&t))
    }
}

/// The hub's data dir: `AGENTHUB_DATA_DIR`, else `<local data root>/agent-hub/hub`
/// (`Hub.Infrastructure.AppPaths.FromEnvironment`).
pub fn data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    if let Some(dir) = env("AGENTHUB_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    crate::platform::local_data_root(env).map(|root| root.join(crate::brand::SLUG).join("hub"))
}

/// Where to find the hub executable, in order: `AGENTHUB_HUB_EXE`, next to this app's own
/// executable (the bundled sidecar), and — debug builds only — the repo's
/// `hub/Hub.Service` build output so `tauri dev` works after a plain `dotnet build`.
pub fn locate_hub_exe(env: &dyn Fn(&str) -> Option<String>, app_exe_dir: Option<&Path>) -> Option<PathBuf> {
    let exe = crate::platform::exe_name(HUB_EXE_STEM);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = env("AGENTHUB_HUB_EXE").filter(|p| !p.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Some(dir) = app_exe_dir {
        candidates.push(dir.join(&exe));
    }
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
        for config in ["Debug", "Release"] {
            candidates.push(
                repo.join("hub")
                    .join("Hub.Service")
                    .join("bin")
                    .join(config)
                    .join("net10.0")
                    .join(&exe),
            );
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_file_parses_the_hub_format() {
        let f = PortFile::parse(r#"{"v":1,"port":51234,"token":"abc","pid":42}"#).unwrap();
        assert_eq!(f.port, 51234);
        assert_eq!(f.token, "abc");
        assert_eq!(f.pid, 42);
    }

    #[test]
    fn port_file_rejects_unusable_content() {
        assert!(PortFile::parse("not json").is_none());
        assert!(PortFile::parse(r#"{"v":1,"port":0,"token":"abc","pid":1}"#).is_none());
        assert!(PortFile::parse(r#"{"v":1,"port":5,"token":"","pid":1}"#).is_none());
    }

    #[test]
    fn port_file_read_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(PortFile::read(dir.path()).is_none());
        std::fs::write(dir.path().join(PORT_FILE_NAME), r#"{"v":1,"port":7,"token":"t","pid":1}"#).unwrap();
        assert_eq!(PortFile::read(dir.path()).unwrap().port, 7);
    }

    #[test]
    fn data_dir_prefers_the_override() {
        let env = |k: &str| (k == "AGENTHUB_DATA_DIR").then(|| "C:/tmp/hubdata".to_string());
        assert_eq!(data_dir(&env).unwrap(), PathBuf::from("C:/tmp/hubdata"));
    }

    #[test]
    fn locate_hub_exe_prefers_the_env_override_then_the_app_dir() {
        let dir = tempfile::tempdir().unwrap();
        let override_exe = dir.path().join("custom-hub.exe");
        std::fs::write(&override_exe, b"").unwrap();
        let app_dir = dir.path().join("app");
        std::fs::create_dir(&app_dir).unwrap();
        let bundled = app_dir.join(crate::platform::exe_name(HUB_EXE_STEM));
        std::fs::write(&bundled, b"").unwrap();

        let path = override_exe.to_string_lossy().into_owned();
        let with_override = move |k: &str| (k == "AGENTHUB_HUB_EXE").then(|| path.clone());
        assert_eq!(locate_hub_exe(&with_override, Some(&app_dir)).unwrap(), override_exe);

        let no_env = |_: &str| None;
        assert_eq!(locate_hub_exe(&no_env, Some(&app_dir)).unwrap(), bundled);
    }
}
