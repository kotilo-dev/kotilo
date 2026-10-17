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

/// File name of an executable on this platform (`name.exe` on Windows).
pub fn exe_name(stem: &str) -> String {
    format!("{stem}{}", std::env::consts::EXE_SUFFIX)
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
