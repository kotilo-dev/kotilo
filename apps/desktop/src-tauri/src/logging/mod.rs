//! Faz 7 §1 / §9.1 / §9.2: rotating file logger setup, the Rust panic hook, and the
//! small pure helpers (start/exit marker parsing, panic message truncation) that back
//! them. Every path is injectable (`*_in`/`*_for_dir` variants) so tests never touch the
//! real `%LOCALAPPDATA%\kotilo`.
//!
//! §9.6's path-masking lives in [`crate::diagnostics`] — it's diagnostics-zip-specific
//! (masks `%USERPROFILE%`/username in *copies* of state/settings, never in the live log
//! file itself).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use log::LevelFilter;
use tauri::plugin::TauriPlugin;
use tauri::Runtime;

static APP_START: OnceLock<Instant> = OnceLock::new();

/// Records "now" as the app's start time — called once, near the top of `run()`. A
/// second call is a no-op (the first one wins), so tests that call it are safe too.
pub fn mark_start() {
    let _ = APP_START.set(Instant::now());
}

/// How long ago [`mark_start`] was called — `system.json`'s `uptimeSeconds` (spec §4).
/// `Duration::ZERO` if `mark_start` was never called (should not happen outside tests).
pub fn uptime() -> Duration {
    APP_START.get().map(|start| start.elapsed()).unwrap_or_default()
}

/// Spec §9.1: the log file's base name (`<exePrefix>.log`; rotated files are
/// `<exePrefix>_<date>.log`, `tauri-plugin-log`'s own naming).
pub const LOG_FILE_STEM: &str = crate::brand::LOG_FILE_STEM;
/// Spec §1/§9.1: 1 MB per file, `KeepSome(5)`. `tauri-plugin-log`'s `RotatingFile::flush`
/// checks the size and rotates on every write, so rotation can happen mid-session, not
/// only at startup — unclean-exit detection and the diagnostics zip must read every log
/// file (oldest rotated first, then the active one), not just the current `<exePrefix>.log`.
pub const MAX_LOG_FILE_SIZE: u64 = 1_000_000;
pub const KEEP_LOG_FILES: usize = 5;
/// Spec §9.2: panic messages are truncated to 500 chars before being logged.
pub const PANIC_MESSAGE_MAX_CHARS: usize = 500;

/// `%LOCALAPPDATA%` (falls back to the current directory if unset — should not happen on
/// a real Windows machine, but keeps every caller here total).
pub fn local_app_data_dir() -> std::path::PathBuf {
    crate::platform::local_data_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Spec §1: `%LOCALAPPDATA%\kotilo\logs` — deliberately not `%APPDATA%` (must not
/// sync in a roaming profile).
pub fn log_dir() -> std::path::PathBuf {
    local_app_data_dir().join(crate::brand::SLUG).join("logs")
}

pub fn log_file_path() -> std::path::PathBuf {
    log_dir().join(format!("{LOG_FILE_STEM}.log"))
}

/// Spec §9.6/§4: `%LOCALAPPDATA%\kotilo\diagnostics`.
pub fn diagnostics_dir() -> std::path::PathBuf {
    local_app_data_dir().join(crate::brand::SLUG).join("diagnostics")
}

/// Spec §9.1 line format: `2026-09-28T17:42:04.123+03:00 INFO [agenthub_lib::agents]
/// message` — local time + offset, milliseconds, module target.
pub fn format_log_line(
    out: tauri_plugin_log::fern::FormatCallback,
    message: &std::fmt::Arguments,
    record: &log::Record,
) {
    let now = chrono::Local::now();
    out.finish(format_args!(
        "{} {} [{}] {}",
        now.format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
        record.level(),
        record.target(),
        message
    ));
}

/// Spec §9.1: the configured logger plugin — `Folder` target at `log_dir()` (+ `Stdout`
/// only in a debug build), local-time rotation, `KeepSome(5)` at 1 MB/file, `Warn` by
/// default with our own crate (`agenthub_lib`) and forwarded frontend logs (`webview`,
/// [`tauri_plugin_log::WEBVIEW_TARGET`]) allowed through at `Debug` — the live ceiling is
/// `log::set_max_level` ([`apply_verbose_logging`]), toggled by the `diagnostics.
/// verboseLogging` setting without a restart.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    plugin_for_dir(log_dir())
}

/// Same as [`plugin`], writing to `dir` instead of the real log directory — used by
/// tests that need to exercise the actual builder wiring against a temp dir.
pub fn plugin_for_dir<R: Runtime>(dir: std::path::PathBuf) -> TauriPlugin<R> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::Folder {
            path: dir,
            file_name: Some(LOG_FILE_STEM.to_string()),
        }))
        .format(format_log_line)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .max_file_size(MAX_LOG_FILE_SIZE.into())
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_LOG_FILES))
        .level(LevelFilter::Warn)
        .level_for("agenthub_lib", LevelFilter::Debug)
        .level_for(tauri_plugin_log::WEBVIEW_TARGET, LevelFilter::Debug)
        // Faz 7 §9.2: `portable-pty` itself `log::error!`s the unsanitized spawn-failure
        // text (full argv + cwd) before we ever see the error — silence its target
        // entirely rather than rely on level filtering to hide the message body.
        .level_for("portable_pty", LevelFilter::Off);

    // Spec §9.1: no webview target, no `attachConsole` — stdout only in a debug build,
    // purely for `npm run tauri dev` convenience.
    #[cfg(debug_assertions)]
    let builder = builder.target(Target::new(TargetKind::Stdout));

    builder.build()
}

/// Spec §9.1: the live level ceiling — `Debug` when "Verbose logging" is on, `Info`
/// otherwise. Callable any time (settings load at startup, `settings_set` afterwards);
/// `log::set_max_level` is a process-global atomic, so this takes effect immediately,
/// no restart required.
pub fn level_for_verbose(verbose: bool) -> LevelFilter {
    if verbose {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    }
}

pub fn apply_verbose_logging(verbose: bool) {
    log::set_max_level(level_for_verbose(verbose));
}

// ---------------------------------------------------------------------------------
// Start/exit markers (spec §9.1) — pure parsing, tested against synthetic log contents.
// ---------------------------------------------------------------------------------

const START_MARKER: &str = "--- start";
const EXIT_MARKER: &str = "--- exit";

/// Spec §9.1: `--- start pid=<pid> v=<version> sha=<sha> os=<ver/build>
/// webview2=<ver> level=<lvl>`.
pub fn start_message(pid: u32, version: &str, sha: &str, os: &str, webview2: &str, level: &str) -> String {
    format!("{START_MARKER} pid={pid} v={version} sha={sha} os={os} webview2={webview2} level={level}")
}

/// Spec §9.1: `--- exit pid=<pid>`.
pub fn exit_message(pid: u32) -> String {
    format!("{EXIT_MARKER} pid={pid}")
}

/// Every `<exePrefix>*.log` file under `log_dir`, oldest first (the plugin's own rotated
/// naming — `<exePrefix>_<date>.log` — sorts chronologically as plain strings; the active
/// `<exePrefix>.log` always sorts last since it has no `_<date>` suffix... except it
/// doesn't, lexically, once dated files exist (`<exePrefix>.log` < `<exePrefix>_2026...`
/// because `.` < `_`) — so the active file is identified by exact name, not by sort
/// position, everywhere this list is consumed (see [`read_previous_log_contents_all`],
/// and `crate::diagnostics::build_zip`'s log ordering).
pub fn list_log_files(log_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut files = match std::fs::read_dir(log_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name.starts_with(LOG_FILE_STEM) && name.ends_with(".log"))
            })
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    files.sort();
    files
}

/// Spec §9.1: rotation can happen mid-session — `tauri-plugin-log`'s `RotatingFile::flush`
/// checks the file size and rotates on every write it makes, not only at startup — so the
/// previous session's `--- start`/matching `--- exit` markers can end up split across a
/// rotated file and the current active `<exePrefix>.log`. Reads every `<exePrefix>*.log` file
/// under `log_dir` and concatenates their contents in chronological order (oldest rotated
/// first, the active file last — never by [`list_log_files`]'s raw sort, which puts the
/// active file first; see its doc comment) for [`previous_session_unclean`] to scan.
/// Best-effort: a missing directory (fresh install) or an unreadable file both just drop
/// out silently, never an error.
pub fn read_previous_log_contents_all(log_dir: &std::path::Path) -> String {
    let active_name = format!("{LOG_FILE_STEM}.log");
    let (active, rotated): (Vec<_>, Vec<_>) = list_log_files(log_dir)
        .into_iter()
        .partition(|p| p.file_name().and_then(|n| n.to_str()) == Some(active_name.as_str()));
    let mut ordered = rotated;
    ordered.extend(active);

    let mut out = String::new();
    for path in ordered {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            out.push_str(&contents);
            if !contents.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

/// Spec §9.1 acceptance: "önceki oturumun start'ının eşleşen exit'i yoksa warn" — pure,
/// tested against synthetic multi-line log contents. A line "matches" a marker if it
/// merely *contains* the marker text (the real line also carries a timestamp/level/target
/// prefix); the last `--- start` line must be followed, somewhere after it, by a
/// `--- exit` line, or the previous session is considered to have ended uncleanly (abort,
/// WebView2 crash, `taskkill`, ... — anything that skips the panic hook and the normal
/// `RunEvent::Exit` path).
pub fn previous_session_unclean(contents: &str) -> bool {
    let mut last_start: Option<usize> = None;
    let mut last_exit: Option<usize> = None;
    for (i, line) in contents.lines().enumerate() {
        if line.contains(START_MARKER) {
            last_start = Some(i);
        } else if line.contains(EXIT_MARKER) {
            last_exit = Some(i);
        }
    }
    match last_start {
        None => false,
        Some(start_idx) => !matches!(last_exit, Some(exit_idx) if exit_idx > start_idx),
    }
}

// ---------------------------------------------------------------------------------
// Panic hook (spec §2/§9.2).
// ---------------------------------------------------------------------------------

/// Spec §9.2: truncates a panic (or any other overlong) message to `max_chars`
/// characters (not bytes — panic messages can contain non-ASCII text), appending an
/// ellipsis when truncated. Pure, unit-tested.
pub fn truncate_panic_message(msg: &str, max_chars: usize) -> String {
    let char_count = msg.chars().count();
    if char_count <= max_chars {
        msg.to_string()
    } else {
        let mut truncated: String = msg.chars().take(max_chars).collect();
        truncated.push('\u{2026}'); // '…'
        truncated
    }
}

/// Faz 7 §9.2: where in `<needle>\<index-dir>\<crate>-<version>\...` the crate+version
/// component starts — the byte offset right after the first `\`/`/` that follows `needle`.
/// Shared by [`sanitize_panic_file`]'s two separator variants.
fn skip_one_path_component_after(file: &str, needle: &str, sep: char) -> Option<usize> {
    let after_needle = file.find(needle)? + needle.len();
    let rest = &file[after_needle..];
    let skip = rest.find(sep).map(|i| i + 1).unwrap_or(rest.len());
    Some(after_needle + skip)
}

/// Faz 7 §9.2: `std::panic::Location::file()` is whatever source path `rustc` recorded for
/// that crate — for this crate (and any workspace/path crate) that's already
/// workspace-relative (`src\...`), but for a `crates.io` dependency it's the *absolute*
/// path under `~/.cargo/registry/src/...`, including the Windows user profile and
/// username. Sanitizes it to a short, path-free location: for a registry dependency,
/// `<crate>-<version>\<rest>` (dropping the profile path, `registry\src\`, and the
/// index-hash directory); otherwise, the path starting at its own `src\`/`src/` (a no-op
/// for an already-relative local path). Falls back to the untouched input if neither
/// pattern is found (should not happen for any real panic location, but never worse than
/// today's unsanitized behavior).
fn sanitize_panic_file(file: &str) -> &str {
    for (needle, sep) in [("registry\\src\\", '\\'), ("registry/src/", '/')] {
        if let Some(idx) = skip_one_path_component_after(file, needle, sep) {
            return &file[idx..];
        }
    }
    if let Some(idx) = file.find("src\\").or_else(|| file.find("src/")) {
        return &file[idx..];
    }
    file
}

fn panic_payload_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Spec §9.1/§9.2: installed as the very first statement of `run()`. Logs the (truncated)
/// panic message, its location, and the panicking thread's name at `error`, flushes the
/// logger unconditionally (so the line survives even if the process is about to abort —
/// spec: panic strategy is never changed away from Rust's default `unwind`/the profile's
/// own `panic = "abort"`), then chains into whatever hook was previously installed.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = truncate_panic_message(&panic_payload_message(info), PANIC_MESSAGE_MAX_CHARS);
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", sanitize_panic_file(l.file()), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        log::error!("panic: {message} at {location} (thread: {thread})");
        log::logger().flush();
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- truncate_panic_message -----------------------------------------------------

    #[test]
    fn truncate_panic_message_keeps_short_messages_untouched() {
        assert_eq!(truncate_panic_message("hello", 500), "hello");
    }

    #[test]
    fn truncate_panic_message_truncates_and_appends_ellipsis() {
        let long = "a".repeat(600);
        let out = truncate_panic_message(&long, 500);
        assert_eq!(out.chars().count(), 501); // 500 chars + the ellipsis
        assert!(out.ends_with('\u{2026}'));
        assert!(out.starts_with(&"a".repeat(500)));
    }

    #[test]
    fn truncate_panic_message_exact_length_is_not_truncated() {
        let exact = "a".repeat(500);
        assert_eq!(truncate_panic_message(&exact, 500), exact);
    }

    #[test]
    fn truncate_panic_message_counts_unicode_chars_not_bytes() {
        // Each 'İ' is 2 bytes in UTF-8 but must count as one char.
        let text = "İ".repeat(10);
        assert_eq!(truncate_panic_message(&text, 20), text);
        let truncated = truncate_panic_message(&text, 5);
        assert_eq!(truncated.chars().count(), 6); // 5 chars + ellipsis
    }

    // -- sanitize_panic_file -----------------------------------------------------------

    #[test]
    fn sanitize_panic_file_strips_registry_path_down_to_crate_and_version_backslash() {
        let file = r"C:\Users\alice\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\portable-pty-0.9.0\src\win\psuedocon.rs";
        assert_eq!(sanitize_panic_file(file), r"portable-pty-0.9.0\src\win\psuedocon.rs");
    }

    #[test]
    fn sanitize_panic_file_strips_registry_path_down_to_crate_and_version_forward_slash() {
        let file = "/home/user/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/anyhow-1.0.104/src/error.rs";
        assert_eq!(sanitize_panic_file(file), "anyhow-1.0.104/src/error.rs");
    }

    #[test]
    fn sanitize_panic_file_keeps_an_already_relative_local_path_unchanged() {
        assert_eq!(sanitize_panic_file(r"src\pty\mod.rs"), r"src\pty\mod.rs");
        assert_eq!(sanitize_panic_file("src/pty/mod.rs"), "src/pty/mod.rs");
    }

    #[test]
    fn sanitize_panic_file_strips_an_absolute_local_path_down_to_src() {
        let file = r"C:\Users\alice\my app\src-tauri\src\pty\mod.rs";
        assert_eq!(sanitize_panic_file(file), r"src\pty\mod.rs");
    }

    #[test]
    fn sanitize_panic_file_never_leaks_the_user_profile_path() {
        let registry = r"C:\Users\alice\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\portable-pty-0.9.0\src\win\psuedocon.rs";
        let local = r"C:\Users\alice\my app\src-tauri\src\pty\mod.rs";
        for file in [registry, local] {
            assert!(!sanitize_panic_file(file).contains("alice"));
            assert!(!sanitize_panic_file(file).contains("Users"));
        }
    }

    #[test]
    fn sanitize_panic_file_falls_back_to_the_input_when_no_pattern_matches() {
        assert_eq!(sanitize_panic_file("weird.rs"), "weird.rs");
    }

    // -- previous_session_unclean -----------------------------------------------------

    #[test]
    fn no_previous_content_is_not_unclean() {
        assert!(!previous_session_unclean(""));
    }

    #[test]
    fn start_followed_by_exit_is_clean() {
        let log = "2026-01-01T00:00:00+03:00 INFO [x] --- start pid=1 v=0.1 sha=a os=w webview2=1 level=info\n\
                   2026-01-01T00:00:01+03:00 INFO [x] some other line\n\
                   2026-01-01T00:00:02+03:00 INFO [x] --- exit pid=1\n";
        assert!(!previous_session_unclean(log));
    }

    #[test]
    fn start_without_a_following_exit_is_unclean() {
        let log = "2026-01-01T00:00:00+03:00 INFO [x] --- start pid=1 v=0.1 sha=a os=w webview2=1 level=info\n\
                   2026-01-01T00:00:01+03:00 WARN [x] something else\n";
        assert!(previous_session_unclean(log));
    }

    #[test]
    fn exit_before_the_last_start_still_counts_as_unclean() {
        // First session started and exited cleanly; a SECOND session started and never
        // exited -- the *last* start must be the one checked.
        let log = "... --- start pid=1 ...\n\
                   ... --- exit pid=1\n\
                   ... --- start pid=2 ...\n";
        assert!(previous_session_unclean(log));
    }

    #[test]
    fn multiple_clean_sessions_in_a_row_are_clean() {
        let log = "... --- start pid=1 ...\n\
                   ... --- exit pid=1\n\
                   ... --- start pid=2 ...\n\
                   ... --- exit pid=2\n";
        assert!(!previous_session_unclean(log));
    }

    // -- start/exit message formatting -------------------------------------------------

    #[test]
    fn start_message_formats_every_field() {
        let msg = start_message(1234, "0.1.0", "abc1234", "Windows 11 (10.0.26100)", "128.0", "info");
        assert_eq!(
            msg,
            "--- start pid=1234 v=0.1.0 sha=abc1234 os=Windows 11 (10.0.26100) webview2=128.0 level=info"
        );
    }

    #[test]
    fn exit_message_formats_pid() {
        assert_eq!(exit_message(1234), "--- exit pid=1234");
    }

    // -- level mapping ------------------------------------------------------------------

    #[test]
    fn level_for_verbose_maps_debug_and_info() {
        assert_eq!(level_for_verbose(true), LevelFilter::Debug);
        assert_eq!(level_for_verbose(false), LevelFilter::Info);
    }

    // -- dir helpers respect LOCALAPPDATA ------------------------------------------------

    #[test]
    fn log_dir_is_under_local_app_data() {
        let dir = log_dir();
        assert!(dir.ends_with(std::path::Path::new(crate::brand::SLUG).join("logs")));
    }

    #[test]
    fn diagnostics_dir_is_under_local_app_data() {
        let dir = diagnostics_dir();
        assert!(dir.ends_with(std::path::Path::new(crate::brand::SLUG).join("diagnostics")));
    }

    // -- list_log_files / read_previous_log_contents_all ---------------------------------

    #[test]
    fn read_previous_log_contents_all_returns_empty_for_a_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert_eq!(read_previous_log_contents_all(&missing), "");
    }

    #[test]
    fn read_previous_log_contents_all_reads_only_the_active_file_when_nothing_rotated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(format!("{LOG_FILE_STEM}.log")), "line one\nline two\n").unwrap();
        assert_eq!(read_previous_log_contents_all(dir.path()), "line one\nline two\n");
    }

    #[test]
    fn read_previous_log_contents_all_orders_rotated_before_active_regardless_of_name_sort() {
        // "<stem>.log" sorts *before* "<stem>_2026...log" lexically ('.' < '_'), but
        // chronologically the rotated file is older -- the concatenation must reflect
        // creation order (rotated first, active last), not raw name sort.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(format!("{LOG_FILE_STEM}_2026-09-27_00-00-00.log")), "rotated line\n").unwrap();
        std::fs::write(dir.path().join(format!("{LOG_FILE_STEM}.log")), "active line\n").unwrap();
        assert_eq!(read_previous_log_contents_all(dir.path()), "rotated line\nactive line\n");
    }

    #[test]
    fn unclean_exit_detected_when_the_start_marker_was_rotated_out_of_the_active_file() {
        // The session's `--- start` landed in a now-rotated file; the active file (written
        // to after the mid-session rotation) has neither marker. Reading only the active
        // file would wrongly report "no previous session" (false negative); reading every
        // file must still find the unmatched `--- start`.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(format!("{LOG_FILE_STEM}_2026-09-27_00-00-00.log")),
            "2026-09-27T00:00:00+03:00 INFO [x] --- start pid=1 v=0.1 sha=a os=w webview2=1 level=info\n",
        )
        .unwrap();
        std::fs::write(dir.path().join(format!("{LOG_FILE_STEM}.log")), "2026-09-27T00:00:01+03:00 INFO [x] some other line\n").unwrap();

        let contents = read_previous_log_contents_all(dir.path());
        assert!(previous_session_unclean(&contents));
    }

    #[test]
    fn clean_exit_detected_across_a_rotation_boundary() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(format!("{LOG_FILE_STEM}_2026-09-27_00-00-00.log")),
            "2026-09-27T00:00:00+03:00 INFO [x] --- start pid=1 v=0.1 sha=a os=w webview2=1 level=info\n",
        )
        .unwrap();
        std::fs::write(dir.path().join(format!("{LOG_FILE_STEM}.log")), "2026-09-27T00:00:01+03:00 INFO [x] --- exit pid=1\n").unwrap();

        let contents = read_previous_log_contents_all(dir.path());
        assert!(!previous_session_unclean(&contents));
    }
}
