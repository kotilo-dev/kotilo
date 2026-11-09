//! The only OS-specific code of the crate (AGENTS.md rule 7).

use std::process::Command;

/// Starts `git` without a console window (Windows: the app is a GUI process).
pub fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Whether ANSI colours render in the attached terminal. Unix terminals do; on Windows only
/// terminals known to enable VT processing (Windows Terminal, VS Code, a set `TERM`), since the
/// CLI does not switch the classic console into VT mode.
pub fn terminal_supports_ansi() -> bool {
    #[cfg(windows)]
    {
        ["WT_SESSION", "TERM_PROGRAM", "TERM"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
    }
    #[cfg(not(windows))]
    {
        true
    }
}
