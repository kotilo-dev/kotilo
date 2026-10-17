//! Platform layer (AGENTS.md rule 7, D-007): OS-specific code lives here behind plain
//! functions, so callers never carry `#[cfg]` themselves. New platform code goes here;
//! the older inline `#[cfg(windows)]` blocks imported from AgentDeck move in over time.

pub mod assistant;
pub mod conpty;
pub mod dictation;
pub mod fonts;
pub mod hook_endpoint;
pub mod hotkeys;
pub mod idle;
pub mod mascot;
pub mod taskbar;
pub mod webview;
pub mod wt_settings;
#[cfg(windows)]
pub(crate) mod overlay_window;

use std::process::Command;

/// Configures `cmd` to start a background process without a console window.
pub fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the hub is a console-subsystem exe; without this flag Windows
        // would open a console window for it.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Which shells `pty` looks for: the Windows set (pwsh, Windows PowerShell, cmd, Git Bash,
/// WSL) or the Unix set (the login shell, zsh, bash, fish, pwsh).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    Windows,
    Unix,
}

pub fn shell_family() -> ShellFamily {
    if cfg!(windows) {
        ShellFamily::Windows
    } else {
        ShellFamily::Unix
    }
}

/// Features that need OS code which exists only on some systems (U-2). The UI hides what is
/// `false` instead of offering settings that do nothing. All of these are Windows-only today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// System-wide shortcuts (dictation, assistant).
    pub global_hotkeys: bool,
    /// Dictation: overlay and typing the text into the focused window.
    pub dictation: bool,
    /// The desktop mascot window.
    pub mascot: bool,
    /// The "while you were away" summary (needs the user's idle time).
    pub away_summary: bool,
    /// Microsoft's bundled ConPTY.
    pub bundled_conpty: bool,
    /// Importing Windows Terminal colour schemes.
    pub windows_terminal_schemes: bool,
}

pub fn features() -> Features {
    let windows = cfg!(windows);
    Features {
        global_hotkeys: windows,
        dictation: windows,
        mascot: windows,
        away_summary: windows,
        bundled_conpty: windows,
        windows_terminal_schemes: windows,
    }
}

/// `"windows"`, `"macos"` or `"linux"` (Rust's `std::env::consts::OS`).
pub fn os_id() -> &'static str {
    std::env::consts::OS
}

/// File name of an executable on this platform (`name.exe` on Windows).
pub fn exe_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
}

/// Per-user settings root (state.json, settings.json): `%APPDATA%` on Windows,
/// `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (or `~/.config`) elsewhere.
pub fn roaming_data_root(env: &dyn Fn(&str) -> Option<String>) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let non_empty = |k: &str| env(k).filter(|v| !v.is_empty());
    if cfg!(windows) {
        non_empty("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        non_empty("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        non_empty("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| non_empty("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
}

/// The user's home folder (`%USERPROFILE%` / `$HOME`), masked in diagnostics.
pub fn home_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    env(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).filter(|v| !v.is_empty())
}

/// The user's login name (`%USERNAME%` / `$USER`), masked in diagnostics.
pub fn user_name(env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    env(if cfg!(windows) { "USERNAME" } else { "USER" }).filter(|v| !v.is_empty())
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// [`roaming_data_root`] from this process's environment.
pub fn roaming_data_dir() -> Option<std::path::PathBuf> {
    roaming_data_root(&process_env)
}

/// [`local_data_root`] from this process's environment.
pub fn local_data_dir() -> Option<std::path::PathBuf> {
    local_data_root(&process_env)
}

/// Per-user local data root: `%LOCALAPPDATA%` on Windows, `~/Library/Application
/// Support` on macOS, `$XDG_DATA_HOME` (or `~/.local/share`) elsewhere.
pub fn local_data_root(env: &dyn Fn(&str) -> Option<String>) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let non_empty = |k: &str| env(k).filter(|v| !v.is_empty());
    if cfg!(windows) {
        non_empty("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        non_empty("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"))
    } else {
        non_empty("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| non_empty("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn env(key: &str) -> Option<String> {
        match key {
            "APPDATA" => Some(r"C:\Users\x\AppData\Roaming".to_string()),
            "LOCALAPPDATA" => Some(r"C:\Users\x\AppData\Local".to_string()),
            "HOME" => Some("/home/x".to_string()),
            "XDG_DATA_HOME" => Some(String::new()),
            _ => None,
        }
    }

    #[test]
    fn data_roots_follow_the_os_convention() {
        let (roaming, local) = (roaming_data_root(&env).unwrap(), local_data_root(&env).unwrap());
        if cfg!(windows) {
            assert_eq!(roaming, PathBuf::from(r"C:\Users\x\AppData\Roaming"));
            assert_eq!(local, PathBuf::from(r"C:\Users\x\AppData\Local"));
        } else if cfg!(target_os = "macos") {
            assert_eq!(roaming, PathBuf::from("/home/x/Library/Application Support"));
            assert_eq!(local, roaming);
        } else {
            // An empty XDG variable counts as unset.
            assert_eq!(roaming, PathBuf::from("/home/x/.config"));
            assert_eq!(local, PathBuf::from("/home/x/.local/share"));
        }
        assert_eq!(roaming_data_root(&|_| None), None);
    }
}
