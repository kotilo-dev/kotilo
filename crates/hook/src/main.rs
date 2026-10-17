//! Thin binary shell around [`agenthub_hook::run`] (see `lib.rs` for the actual decision
//! logic and its tests). Two things live only here, since they are real process-level
//! side effects rather than pure logic:
//!
//! 1. A watchdog thread that force-exits 0 shortly after the connect budget
//!    (`HUB_BUDGET_MS` + `CONNECT_TIMEOUT_MS`) no matter what the main path is doing — the
//!    hard backstop behind "always exit 0" even if some future change to the delivery code
//!    ever blocks longer than intended.
//!    Cursor's stdout answer is written before any delivery I/O, so the watchdog can't
//!    cut it off.
//! 2. The final `std::process::exit(0)` — never falls off the end of `main` in a way
//!    that could return a non-zero code, and never panics (no `unwrap`/`expect`/
//!    indexing on hook-controlled input anywhere in this crate).

use std::ffi::OsString;
use std::time::Duration;

/// Spec §4 finding 12: `std::env::args()` panics if any argv isn't valid Unicode —
/// `args_os()` + a lossy conversion never does, so a hook firing with a genuinely
/// non-Unicode argument (however unlikely) can't take the whole process down before it
/// even reaches `run`'s own no-panic guarantees. This binary's whole contract is "always
/// exit 0, never panic".
fn collect_args(args: impl Iterator<Item = OsString>) -> Vec<String> {
    args.map(|a| a.to_string_lossy().into_owned()).collect()
}

fn main() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(
            agenthub_hook::HUB_BUDGET_MS as u64 + agenthub_hook::CONNECT_TIMEOUT_MS as u64 + 250,
        ));
        std::process::exit(0);
    });

    let args = collect_args(std::env::args_os());
    // Codex runs hooks with an empty environment on Windows, so the data folder falls back
    // to the known-folder API when LOCALAPPDATA is absent (tests never take this path:
    // they call `run` with their own lookup).
    let env_lookup = |k: &str| {
        std::env::var(k).ok().filter(|v| !v.is_empty()).or_else(|| {
            (k == "LOCALAPPDATA")
                .then(agenthub_hook::platform::known_local_app_data)
                .flatten()
        })
    };
    let mut stdin = std::io::stdin();
    agenthub_hook::run(&args, &env_lookup, &mut stdin, &agenthub_hook::real_connect);

    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use super::*;

    #[test]
    fn collect_args_never_panics_on_non_unicode_argv() {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            // A lone UTF-16 surrogate: not representable as valid Unicode — exactly the
            // case `std::env::args()` would panic on (`args_os()` + `to_string_lossy()`
            // never does).
            let bad = OsString::from_wide(&[0xD800]);
            let args = collect_args(vec![OsString::from("agenthub-hook"), bad].into_iter());
            assert_eq!(args.len(), 2);
            assert_eq!(args[0], "agenthub-hook");
        }
    }
}
