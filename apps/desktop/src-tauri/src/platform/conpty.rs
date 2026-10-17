//! D-055: which ConPTY the terminals use. `portable-pty` loads `conpty.dll` through the normal
//! DLL search before falling back to the one in kernel32; Windows ships no `conpty.dll`, so
//! adding the bundled `conpty\` folder (next to the exe) to the search path makes every later
//! pseudo console use Microsoft's newer ConPTY + `OpenConsole.exe`, which passes sixel images
//! through. Must run before the first terminal is created.

use std::path::Path;

/// The folder next to the app exe that holds `conpty.dll` and `OpenConsole.exe`.
pub const FOLDER: &str = "conpty";

/// True when `dir` holds both files the bundled ConPTY needs.
pub fn is_complete(dir: &Path) -> bool {
    dir.join("conpty.dll").is_file() && dir.join("OpenConsole.exe").is_file()
}

/// Uses the bundled ConPTY when `use_bundled` and its files are installed; logs the choice.
pub fn select(use_bundled: bool) {
    if !super::features().bundled_conpty {
        return;
    }
    let dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|p| p.join(FOLDER)));
    match dir {
        Some(dir) if use_bundled && is_complete(&dir) => match os::add_dll_directory(&dir) {
            Ok(()) => log::info!("terminals: bundled ConPTY from {}", dir.display()),
            Err(e) => log::warn!("terminals: bundled ConPTY not used ({e}); using the system ConPTY"),
        },
        Some(_) if use_bundled => log::info!("terminals: bundled ConPTY not installed; using the system ConPTY"),
        _ => log::info!("terminals: using the system ConPTY"),
    }
}

#[cfg(windows)]
mod os {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::System::LibraryLoader::SetDllDirectoryW;

    pub fn add_dll_directory(dir: &Path) -> windows::core::Result<()> {
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call.
        unsafe { SetDllDirectoryW(PCWSTR(wide.as_ptr())) }
    }
}

#[cfg(not(windows))]
mod os {
    use std::path::Path;

    pub fn add_dll_directory(_dir: &Path) -> Result<(), String> {
        Err("not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_only_with_both_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!is_complete(dir.path()));
        std::fs::write(dir.path().join("conpty.dll"), b"x").expect("write");
        assert!(!is_complete(dir.path()));
        std::fs::write(dir.path().join("OpenConsole.exe"), b"x").expect("write");
        assert!(is_complete(dir.path()));
    }
}
