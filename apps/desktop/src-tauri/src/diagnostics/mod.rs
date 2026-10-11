//! Faz 7 §4/§9.6: "Collect diagnostics" — builds a zip of `system.json`/`runtime.json`/
//! `settings.json`/`state.json`/`logs/`/`README.txt` at
//! `%LOCALAPPDATA%\kotilo\diagnostics`.
//!
//! Everything that can be pure (path masking, log-file size capping, retention) is a
//! standalone function taking plain data, tested against temp dirs / synthetic bytes —
//! never the real `%LOCALAPPDATA%\kotilo`. [`build_zip`] is the one function that
//! actually touches disk (reading `input.log_dir`, writing into `input.out_dir`); the
//! `commands::diagnostics` IPC wrapper is the only caller, always from `spawn_blocking`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::logging::{list_log_files, LOG_FILE_STEM};

/// `<exePrefix>-diagnostics-`, the start of every diagnostics zip name.
fn diagnostics_file_prefix() -> String {
    format!("{}-diagnostics-", crate::brand::EXE_PREFIX)
}
/// Spec §9.6: keep the newest 5 diagnostics zips.
pub const DIAGNOSTICS_RETENTION: usize = 5;
/// Spec §9.6: the active log file's last 2 MB only (rotated files are included whole).
pub const MAX_ACTIVE_LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// Spec §9.6: the whole zip must never exceed 10 MB.
pub const MAX_ZIP_TOTAL_BYTES: u64 = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------------
// §9.6 masking — pure, order matters (profile path forms, then the username-as-a-whole
// -path-segment pass over whatever text is left). ASCII byte-indexed on purpose: Windows
// user profile paths/usernames are ASCII in every realistic case, and staying in bytes
// (rather than `to_lowercase()`-ing the whole haystack) means every match position is
// guaranteed to land on a UTF-8 char boundary — see `find_ci_ascii`'s doc comment.
// ---------------------------------------------------------------------------------

/// Case-insensitive (ASCII-only) search for `needle` in `haystack`, starting at byte
/// offset `from`. Safe to slice `haystack` at the returned offset (and offset +
/// `needle.len()`): a match can only occur where `haystack`'s bytes are themselves plain
/// ASCII bytes (a UTF-8 continuation byte, `>= 0x80`, can never `eq_ignore_ascii_case` an
/// ASCII byte), and a run of ASCII bytes is always aligned on char boundaries.
fn find_ci_ascii(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() || from + nb.len() > hb.len() {
        return None;
    }
    (from..=hb.len() - nb.len()).find(|&i| hb[i..i + nb.len()].eq_ignore_ascii_case(nb))
}

fn replace_ci_ascii(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let mut result = String::with_capacity(haystack.len());
    let mut last_end = 0usize;
    let mut pos = 0usize;
    while let Some(found) = find_ci_ascii(haystack, needle, pos) {
        result.push_str(&haystack[last_end..found]);
        result.push_str(replacement);
        last_end = found + needle.len();
        pos = last_end;
    }
    result.push_str(&haystack[last_end..]);
    result
}

/// Flips every `\` to `/` and vice versa — used to derive the "other slash style" of
/// `%USERPROFILE%` to mask (spec §9.6: "hem `\` hem `/` ... biçimlerinde").
fn flip_slashes(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\\' => '/',
            '/' => '\\',
            other => other,
        })
        .collect()
}

/// Spec §9.6 (1): `%USERPROFILE%` in `\`, `/`, and `\\?\`-prefixed forms -> literal
/// `%USERPROFILE%`. The `\\?\` form needs no special case: replacing the plain
/// `user_profile` substring wherever it occurs already turns `\\?\C:\Users\x\...` into
/// `\\?\%USERPROFILE%\...`, since the profile path is a contiguous substring right after
/// the `\\?\` prefix either way.
fn mask_user_profile(text: &str, user_profile: &str) -> String {
    let trimmed = user_profile.trim();
    if trimmed.is_empty() {
        return text.to_string();
    }
    let mut out = replace_ci_ascii(text, trimmed, "%USERPROFILE%");
    let alt = flip_slashes(trimmed);
    if alt != trimmed {
        out = replace_ci_ascii(&out, &alt, "%USERPROFILE%");
    }
    out
}

/// Spec §9.6 (2): `%USERNAME%` as a whole path segment — preceded by start-of-string or
/// `\`/`/`, followed by end-of-string or `\`/`/` — case-insensitively, e.g.
/// `C:\Workspace\<user>`. A `username` occurring as part of a longer segment (not its own
/// whole segment) is left alone.
fn mask_username_segments(text: &str, username: &str) -> String {
    let trimmed = username.trim();
    if trimmed.is_empty() {
        return text.to_string();
    }
    let mut result = String::with_capacity(text.len());
    let mut last_end = 0usize;
    let mut pos = 0usize;
    let bytes = text.as_bytes();
    while let Some(found) = find_ci_ascii(text, trimmed, pos) {
        let end = found + trimmed.len();
        let preceded_ok = found == 0 || matches!(bytes[found - 1], b'\\' | b'/');
        let followed_ok = end == bytes.len() || matches!(bytes[end], b'\\' | b'/');
        if preceded_ok && followed_ok {
            result.push_str(&text[last_end..found]);
            result.push_str("<user>");
            last_end = end;
            pos = end;
        } else {
            pos = found + 1;
        }
    }
    result.push_str(&text[last_end..]);
    result
}

/// Spec §9.6: the full masking pass applied to every text file this zip contains (logs,
/// `state.json`, `settings.json` — anything that can carry a path). 8.3 short names are
/// explicitly out of scope (spec: "8.3 kısa adlar kapsam dışı"); `README.txt` says the
/// username may still appear in some paths.
pub fn mask_text(text: &str, user_profile: &str, username: &str) -> String {
    let masked_profile = mask_user_profile(text, user_profile);
    mask_username_segments(&masked_profile, username)
}

// ---------------------------------------------------------------------------------
// Log file size capping (spec §9.6): rotated files are included whole; the active file
// is capped to its last `MAX_ACTIVE_LOG_TAIL_BYTES`, snapped forward to the next line
// boundary so the kept tail always starts at a whole log line.
// ---------------------------------------------------------------------------------

pub fn tail_active_log(bytes: &[u8]) -> Vec<u8> {
    let max = MAX_ACTIVE_LOG_TAIL_BYTES as usize;
    if bytes.len() <= max {
        return bytes.to_vec();
    }
    let start = bytes.len() - max;
    let boundary = bytes[start..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    bytes[boundary..].to_vec()
}

/// Spec §9.6: "zip toplamı <= 10 MB" — a last-resort safety net (the active-file tail cap
/// plus the logger's own `KeepSome(5)` at 1 MB/file already keep this well under budget
/// in practice). Drops the OLDEST whole files first — never truncates a file it keeps —
/// until the total fits in `MAX_ZIP_TOTAL_BYTES` minus `reserved` (the other, small,
/// always-included entries: the JSON files + README). `files` must be oldest-first.
pub fn cap_log_files(mut files: Vec<(String, Vec<u8>)>, reserved: u64) -> Vec<(String, Vec<u8>)> {
    let budget = MAX_ZIP_TOTAL_BYTES.saturating_sub(reserved);
    loop {
        let total: u64 = files.iter().map(|(_, b)| b.len() as u64).sum();
        if total <= budget || files.is_empty() {
            return files;
        }
        files.remove(0);
    }
}

fn active_log_file_name() -> String {
    format!("{LOG_FILE_STEM}.log")
}

// ---------------------------------------------------------------------------------
// Retention (spec §9.6: keep the newest 5 diagnostics zips).
// ---------------------------------------------------------------------------------

/// Pure: given every existing diagnostics zip's path and mtime (any order) and how many
/// to keep, returns the ones to delete — sorted oldest-first by mtime, tie-broken by file
/// name. Mtime (not the file name's `yyyyMMdd-HHmmss[-n]` stamp) is the source of truth:
/// the `-n` collision suffix (two zips requested in the same second) sorts *before* the
/// bare name lexically (`-` < `.`), which would otherwise misorder the truly-newer `-1`
/// file as older than the base one it collided with.
pub fn files_to_delete_for_retention(mut existing: Vec<(PathBuf, SystemTime)>, keep: usize) -> Vec<PathBuf> {
    existing.sort_by(|(a_path, a_mtime), (b_path, b_mtime)| a_mtime.cmp(b_mtime).then_with(|| a_path.cmp(b_path)));
    if existing.len() <= keep {
        return Vec::new();
    }
    let drop_count = existing.len() - keep;
    existing.into_iter().take(drop_count).map(|(path, _)| path).collect()
}

/// Applies retention in `dir`: keeps the newest `keep` `<exePrefix>-diagnostics-*.zip`
/// files, best-effort deletes the rest (a delete failure is never fatal — the command
/// already succeeded in writing the new zip). A file whose mtime can't be read is treated
/// as the oldest possible (`UNIX_EPOCH`) rather than skipped, so a stray unreadable file
/// can never dodge retention by just failing `metadata()`.
pub fn apply_retention(dir: &Path, keep: usize) {
    let existing: Vec<(PathBuf, SystemTime)> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|name| name.starts_with(&diagnostics_file_prefix()) && name.ends_with(".zip"))
            })
            .map(|p| {
                let mtime = std::fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                (p, mtime)
            })
            .collect(),
        Err(_) => return,
    };
    for path in files_to_delete_for_retention(existing, keep) {
        let _ = std::fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------------
// Zip filename (spec §4/§9.6): `<exePrefix>-diagnostics-<yyyyMMdd-HHmmss>.zip`, unique even
// if two collections land in the same second.
// ---------------------------------------------------------------------------------

/// Pure: the base name for `stamp`, and `unique_zip_path` below appends `-1`, `-2`, ... if
/// that name is already taken in `dir`.
pub fn zip_file_name(stamp: &str) -> String {
    format!("{}{stamp}.zip", diagnostics_file_prefix())
}

fn unique_zip_path(dir: &Path, stamp: &str) -> PathBuf {
    let base = zip_file_name(stamp);
    let candidate = dir.join(&base);
    if !candidate.exists() {
        return candidate;
    }
    for n in 1.. {
        let name = format!("{}{stamp}-{n}.zip", diagnostics_file_prefix());
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("the loop above only terminates by returning")
}

// ---------------------------------------------------------------------------------
// README.txt (spec §4/§9.6: what is, and is NOT, included).
// ---------------------------------------------------------------------------------

fn readme_text() -> String {
    let title = format!("{} diagnostics", crate::brand::NAME);
    let underline = "=".repeat(title.chars().count());
    let body = "\n\
     This zip contains, to help diagnose a problem:\n\
     - system.json: app version, git commit, Windows version/build, architecture,\n\
       WebView2 version, how long the app had been running, the current log level.\n\
     - runtime.json: workspace/pane counts, pane shell profiles, the agent list (kind,\n\
       state, source only -- no titles or file contents) and Claude Code hook\n\
       integration status.\n\
     - settings.json: your __NAME__ settings.\n\
     - state.json: layout/workspace/terminal/viewer state, INCLUDING workspace and open\n\
       file PATHS -- kept because they are usually needed to reproduce a problem. Tab\n\
       titles and any typed agent-launch commands are removed.\n\
     - logs/: the __NAME__ log files (rotated files whole, the active file's last 2 MB).\n\
     \n\
     What is NOT included:\n\
     - Terminal input/output, file contents, or agent prompts/responses.\n\
     - Your clipboard, environment variables, or any ~/.claude/settings.json content.\n\
     - Full command lines (only executable names ever appear in logs).\n\
     \n\
     Your Windows user profile path is replaced with %USERPROFILE%, and your Windows\n\
     username is replaced with <user> wherever it appears as a whole path segment.\n\
     Some paths may still contain your Windows username in a form this pass didn't catch\n\
     (e.g. an 8.3 short name) -- please skim state.json/logs/ before sharing this zip.\n\
     \n\
     Nothing in this zip is sent anywhere automatically. Attach it yourself if you choose\n\
     to share it.\n"
        .replace("__NAME__", crate::brand::NAME);
    format!("{title}\n{underline}\n{body}")
}

// ---------------------------------------------------------------------------------
// state.json allow-list (spec §9.6): only these top-level slices are copied into the
// zip, and every key in `DENIED_STATE_KEYS` is stripped from what's kept, at any depth
// -- masking of remaining path-shaped values happens later, on the whole rendered JSON
// string (`mask_text`).
// ---------------------------------------------------------------------------------

pub const ALLOWED_STATE_SLICES: [&str; 4] = ["layout", "workspaces", "terminals", "viewer"];

/// Spec §9.6/§9.2: keys that never leave the machine, wherever they occur in a kept
/// `state.json` slice. `title` -- tab/window titles ("Sekme başlıkları çıkarılır").
/// `agentCommand` -- the exact command line a user typed into a terminal's agent-launch
/// field (`terminals` slice), covered by the same rule that keeps it out of logs (§9.2).
pub const DENIED_STATE_KEYS: [&str; 2] = ["title", "agentCommand"];

fn strip_denied_keys(value: &mut serde_json::Value, denied: &[&str]) {
    match value {
        serde_json::Value::Object(map) => {
            for key in denied {
                map.remove(*key);
            }
            for v in map.values_mut() {
                strip_denied_keys(v, denied);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_denied_keys(item, denied);
            }
        }
        _ => {}
    }
}

/// Pure: keeps only `keys` from `full` (a JSON object) and strips every key in
/// [`DENIED_STATE_KEYS`] (at any depth) from what's kept. A key present in `keys` but
/// absent from `full` is simply left out of the result.
pub fn allow_listed_state(full: &serde_json::Value, keys: &[&str]) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Some(obj) = full.as_object() {
        for key in keys {
            if let Some(value) = obj.get(*key) {
                let mut cloned = value.clone();
                strip_denied_keys(&mut cloned, &DENIED_STATE_KEYS);
                out.insert((*key).to_string(), cloned);
            }
        }
    }
    serde_json::Value::Object(out)
}

// ---------------------------------------------------------------------------------
// build_zip: the one function here that touches disk.
// ---------------------------------------------------------------------------------

pub struct BuildZipInput {
    pub system_json: serde_json::Value,
    pub runtime_json: serde_json::Value,
    pub settings_json: serde_json::Value,
    pub state_json: serde_json::Value,
    pub log_dir: PathBuf,
    pub out_dir: PathBuf,
    pub user_profile: String,
    pub username: String,
    /// The zip file name's timestamp (`yyyyMMdd-HHmmss`) — injected so tests are
    /// deterministic.
    pub stamp: String,
}

/// Masks every string LEAF value in a JSON tree, structurally, rather than
/// textually-masking the rendered JSON string. Structural masking sidesteps JSON string
/// escaping entirely — a path's `\` becomes `\\` once serialized, which would silently
/// defeat a plain substring search for the *unescaped* `user_profile`/`username`
/// patterns `mask_text` looks for.
fn mask_json_value(value: &serde_json::Value, user_profile: &str, username: &str) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(mask_text(s, user_profile, username)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|v| mask_json_value(v, user_profile, username)).collect())
        }
        serde_json::Value::Object(map) => {
            let masked = map
                .iter()
                .map(|(k, v)| (k.clone(), mask_json_value(v, user_profile, username)))
                .collect();
            serde_json::Value::Object(masked)
        }
        other => other.clone(),
    }
}

fn masked_json_bytes(value: &serde_json::Value, user_profile: &str, username: &str) -> Vec<u8> {
    let masked = mask_json_value(value, user_profile, username);
    serde_json::to_string_pretty(&masked)
        .unwrap_or_else(|_| "{}".to_string())
        .into_bytes()
}

/// Spec §4/§9.6: builds the diagnostics zip at `input.out_dir` and returns its path.
/// `input.log_dir` is read (never written); logs are collected via [`list_log_files`],
/// masked, size-capped ([`tail_active_log`]/[`cap_log_files`]), and written under `logs/`
/// in the zip. Every JSON entry is masked the same way. Does NOT apply retention or flush
/// the logger — both are the caller's job (flush must happen before this reads the active
/// log file; retention/reveal/the "diagnostics saved" log line all happen after).
pub fn build_zip(input: &BuildZipInput) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(&input.out_dir)?;
    let zip_path = unique_zip_path(&input.out_dir, &input.stamp);
    let file = std::fs::File::create(&zip_path)?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let write_entry = |writer: &mut zip::ZipWriter<std::fs::File>, name: &str, bytes: &[u8]| -> std::io::Result<()> {
        writer.start_file(name, options)?;
        writer.write_all(bytes)?;
        Ok(())
    };

    write_entry(
        &mut writer,
        "system.json",
        &masked_json_bytes(&input.system_json, &input.user_profile, &input.username),
    )?;
    write_entry(
        &mut writer,
        "runtime.json",
        &masked_json_bytes(&input.runtime_json, &input.user_profile, &input.username),
    )?;
    write_entry(
        &mut writer,
        "settings.json",
        &masked_json_bytes(&input.settings_json, &input.user_profile, &input.username),
    )?;
    write_entry(
        &mut writer,
        "state.json",
        &masked_json_bytes(&input.state_json, &input.user_profile, &input.username),
    )?;
    write_entry(&mut writer, "README.txt", readme_text().as_bytes())?;

    let active_name = active_log_file_name();
    // `cap_log_files` drops from the front when over budget, so entries here must be
    // strictly oldest-rotated -> newest-rotated -> active, LAST. `list_log_files`'s own
    // sort can't be trusted for this: "<exePrefix>.log" sorts *before* any dated
    // "<exePrefix>_<date>.log" ('.' < '_'), which would otherwise put the active file
    // first and drop it before any rotated file (see `list_log_files`'s doc comment) --
    // so the active entry is held out and appended last here instead.
    let mut rotated_entries: Vec<(String, Vec<u8>)> = Vec::new();
    let mut active_entry: Option<(String, Vec<u8>)> = None;
    for path in list_log_files(&input.log_dir) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let is_active = path.file_name().and_then(|n| n.to_str()) == Some(active_name.as_str());
        let capped = if is_active { tail_active_log(&bytes) } else { bytes };
        let text = String::from_utf8_lossy(&capped);
        let masked = mask_text(&text, &input.user_profile, &input.username).into_bytes();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(active_name.as_str())
            .to_string();
        if is_active {
            active_entry = Some((name, masked));
        } else {
            rotated_entries.push((name, masked));
        }
    }
    let mut log_entries = rotated_entries;
    log_entries.extend(active_entry);
    // Reserve a generous fixed budget for the small JSON/README entries above so
    // `cap_log_files`'s remaining budget is a safe (if slightly conservative) bound.
    let capped_logs = cap_log_files(log_entries, 64 * 1024);
    for (name, bytes) in capped_logs {
        write_entry(&mut writer, &format!("logs/{name}"), &bytes)?;
    }

    writer.finish()?;
    Ok(zip_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // -- masking ------------------------------------------------------------------

    #[test]
    fn masks_backslash_profile_path() {
        let out = mask_text(r"C:\Users\alice\project\file.txt", r"C:\Users\alice", "alice");
        assert_eq!(out, r"%USERPROFILE%\project\file.txt");
    }

    #[test]
    fn masks_forward_slash_profile_path() {
        let out = mask_text("C:/Users/alice/project/file.txt", r"C:\Users\alice", "alice");
        assert_eq!(out, "%USERPROFILE%/project/file.txt");
    }

    #[test]
    fn masks_extended_length_prefixed_profile_path() {
        let out = mask_text(r"\\?\C:\Users\alice\project", r"C:\Users\alice", "alice");
        assert_eq!(out, r"\\?\%USERPROFILE%\project");
    }

    #[test]
    fn profile_path_masking_is_case_insensitive() {
        let out = mask_text(r"c:\USERS\ALICE\file.txt", r"C:\Users\alice", "alice");
        assert_eq!(out, r"%USERPROFILE%\file.txt");
    }

    #[test]
    fn masks_username_as_a_whole_path_segment_elsewhere() {
        let out = mask_text(r"C:\Workspace\alice\repo", r"C:\Users\alice", "alice");
        assert_eq!(out, r"C:\Workspace\<user>\repo");
    }

    #[test]
    fn masks_username_segment_case_insensitively_and_forward_slash() {
        let out = mask_text("C:/Workspace/ALICE/repo", r"C:\Users\alice", "alice");
        assert_eq!(out, "C:/Workspace/<user>/repo");
    }

    #[test]
    fn does_not_mask_username_as_a_substring_of_a_longer_segment() {
        let out = mask_text(r"C:\Workspace\alice-backup\repo", r"C:\Users\alice", "alice");
        assert_eq!(out, r"C:\Workspace\alice-backup\repo");
    }

    #[test]
    fn masks_username_at_the_very_end_of_the_string() {
        let out = mask_text(r"C:\Workspace\alice", r"C:\Users\alice", "alice");
        assert_eq!(out, r"C:\Workspace\<user>");
    }

    #[test]
    fn masking_is_a_no_op_on_text_without_any_match() {
        let out = mask_text("nothing sensitive here", r"C:\Users\alice", "alice");
        assert_eq!(out, "nothing sensitive here");
    }

    #[test]
    fn empty_profile_and_username_are_handled_without_panicking() {
        let out = mask_text(r"C:\Users\alice\file.txt", "", "");
        assert_eq!(out, r"C:\Users\alice\file.txt");
    }

    // -- tail_active_log ------------------------------------------------------------

    #[test]
    fn tail_active_log_returns_everything_under_the_cap() {
        let bytes = b"short log content".to_vec();
        assert_eq!(tail_active_log(&bytes), bytes);
    }

    #[test]
    fn tail_active_log_caps_and_snaps_to_a_line_boundary() {
        // Build a file well over the cap, one short line at a time, so the boundary
        // snap is easy to verify precisely.
        let line = "0123456789\n"; // 11 bytes
        let repeat = (MAX_ACTIVE_LOG_TAIL_BYTES as usize / line.len()) + 10;
        let content = line.repeat(repeat);
        let tail = tail_active_log(content.as_bytes());
        assert!(tail.len() <= MAX_ACTIVE_LOG_TAIL_BYTES as usize);
        // The kept tail must start right after a '\n' (a whole line), and be a suffix of
        // the original content.
        assert!(content.as_bytes().ends_with(&tail));
        assert!(tail.starts_with(b"0123456789\n") || tail.is_empty());
    }

    // -- cap_log_files ----------------------------------------------------------------

    #[test]
    fn cap_log_files_keeps_everything_under_budget() {
        let files = vec![("a.log".to_string(), vec![0u8; 100]), ("b.log".to_string(), vec![0u8; 100])];
        let capped = cap_log_files(files.clone(), 0);
        assert_eq!(capped.len(), 2);
    }

    #[test]
    fn cap_log_files_drops_oldest_first_until_under_budget() {
        let big = (MAX_ZIP_TOTAL_BYTES / 2 + 1) as usize;
        let files = vec![
            ("oldest.log".to_string(), vec![0u8; big]),
            ("newer.log".to_string(), vec![0u8; big]),
        ];
        let capped = cap_log_files(files, 0);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].0, "newer.log");
    }

    // -- retention ----------------------------------------------------------------------

    #[test]
    fn retention_deletes_nothing_at_or_under_the_keep_count() {
        let base = SystemTime::UNIX_EPOCH;
        let files: Vec<(PathBuf, SystemTime)> = (0..5)
            .map(|i| (PathBuf::from(format!("z{i}.zip")), base + Duration::from_secs(i)))
            .collect();
        assert!(files_to_delete_for_retention(files, 5).is_empty());
    }

    #[test]
    fn retention_deletes_the_oldest_by_mtime() {
        let base = SystemTime::UNIX_EPOCH;
        let files = vec![
            (PathBuf::from("kotilo-diagnostics-20260101-000000.zip"), base + Duration::from_secs(1)),
            (PathBuf::from("kotilo-diagnostics-20260102-000000.zip"), base + Duration::from_secs(2)),
            (PathBuf::from("kotilo-diagnostics-20260103-000000.zip"), base + Duration::from_secs(3)),
        ];
        let to_delete = files_to_delete_for_retention(files, 2);
        assert_eq!(to_delete, vec![PathBuf::from("kotilo-diagnostics-20260101-000000.zip")]);
    }

    #[test]
    fn retention_breaks_mtime_ties_by_name() {
        // Same-second collision: `unique_zip_path` names the second zip with a `-1`
        // suffix, which sorts *before* the un-suffixed base name lexically ('-' < '.')
        // even though it was created strictly after it. Equal mtimes (as real zips
        // created in the same instant might have) must fall back to name order, which
        // for this pair happens to already put the true creation order first -- the
        // point of this test is that ties are broken deterministically at all, not that
        // it recovers real creation order (mtime equality means that's unrecoverable).
        let same = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        let files = vec![
            (PathBuf::from("kotilo-diagnostics-20260101-000000-1.zip"), same),
            (PathBuf::from("kotilo-diagnostics-20260101-000000.zip"), same),
        ];
        let to_delete = files_to_delete_for_retention(files, 1);
        assert_eq!(to_delete, vec![PathBuf::from("kotilo-diagnostics-20260101-000000-1.zip")]);
    }

    #[test]
    fn apply_retention_keeps_only_the_newest_files_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        for stamp in ["20260101-000000", "20260102-000000", "20260103-000000"] {
            std::fs::write(dir.path().join(zip_file_name(stamp)), b"x").unwrap();
        }
        apply_retention(dir.path(), 2);
        let mut remaining: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                "kotilo-diagnostics-20260102-000000.zip".to_string(),
                "kotilo-diagnostics-20260103-000000.zip".to_string(),
            ]
        );
    }

    // -- allow_listed_state ---------------------------------------------------------

    #[test]
    fn allow_listed_state_keeps_only_the_named_slices() {
        let full = serde_json::json!({
            "layout": {"a": 1},
            "workspaces": {"b": 2},
            "somethingSecret": {"c": 3},
        });
        let out = allow_listed_state(&full, &ALLOWED_STATE_SLICES);
        assert_eq!(out["layout"], serde_json::json!({"a": 1}));
        assert_eq!(out["workspaces"], serde_json::json!({"b": 2}));
        assert!(out.get("somethingSecret").is_none());
        assert!(out.get("terminals").is_none(), "absent slice is simply left out");
    }

    #[test]
    fn allow_listed_state_strips_title_keys_at_any_depth() {
        let full = serde_json::json!({
            "layout": {
                "title": "top level title",
                "tabs": [
                    {"title": "tab 1", "path": "a.rs"},
                    {"title": "tab 2", "path": "b.rs"}
                ]
            }
        });
        let out = allow_listed_state(&full, &ALLOWED_STATE_SLICES);
        assert!(out["layout"].get("title").is_none());
        assert!(out["layout"]["tabs"][0].get("title").is_none());
        assert!(out["layout"]["tabs"][1].get("title").is_none());
        assert_eq!(out["layout"]["tabs"][0]["path"], "a.rs");
    }

    #[test]
    fn allow_listed_state_strips_agent_command_keys_at_any_depth() {
        let full = serde_json::json!({
            "terminals": {
                "tabs": [
                    {"title": "claude", "agentCommand": "claude --dangerously-skip-permissions", "profileId": "pwsh"},
                    {"title": "shell", "agentCommand": null, "profileId": "pwsh"}
                ]
            }
        });
        let out = allow_listed_state(&full, &ALLOWED_STATE_SLICES);
        assert!(out["terminals"]["tabs"][0].get("agentCommand").is_none());
        assert!(out["terminals"]["tabs"][1].get("agentCommand").is_none());
        assert_eq!(out["terminals"]["tabs"][0]["profileId"], "pwsh");
    }

    // -- build_zip ----------------------------------------------------------------------

    fn sample_input(log_dir: PathBuf, out_dir: PathBuf) -> BuildZipInput {
        BuildZipInput {
            system_json: serde_json::json!({"version": "0.1.0"}),
            runtime_json: serde_json::json!({"workspaces": 1}),
            settings_json: serde_json::json!({"theme": "dark"}),
            state_json: serde_json::json!({"layout": {"path": r"C:\Users\alice\ws\file.rs"}}),
            log_dir,
            out_dir,
            user_profile: r"C:\Users\alice".to_string(),
            username: "alice".to_string(),
            stamp: "20260928-174204".to_string(),
        }
    }

    fn read_zip_entries(path: &Path) -> std::collections::HashMap<String, Vec<u8>> {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut out = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            let name = entry.name().to_string();
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf).unwrap();
            out.insert(name, buf);
        }
        out
    }

    #[test]
    fn build_zip_contains_every_required_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join(format!("{}.log", crate::logging::LOG_FILE_STEM)), b"2026 INFO hello\n").unwrap();
        let out_dir = tmp.path().join("diagnostics");

        let input = sample_input(log_dir, out_dir.clone());
        let zip_path = build_zip(&input).unwrap();
        assert!(zip_path.exists());
        assert_eq!(zip_path.parent().unwrap(), out_dir);

        let entries = read_zip_entries(&zip_path);
        let active_log = format!("logs/{}.log", crate::logging::LOG_FILE_STEM);
        for name in ["system.json", "runtime.json", "settings.json", "state.json", "README.txt", active_log.as_str()] {
            assert!(entries.contains_key(name), "missing entry: {name}");
        }
    }

    #[test]
    fn build_zip_masks_state_json_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let out_dir = tmp.path().join("diagnostics");

        let input = sample_input(log_dir, out_dir);
        let zip_path = build_zip(&input).unwrap();
        let entries = read_zip_entries(&zip_path);
        let state = String::from_utf8(entries["state.json"].clone()).unwrap();
        assert!(state.contains("%USERPROFILE%"));
        assert!(!state.contains("alice"));
    }

    #[test]
    fn build_zip_includes_rotated_logs_whole_and_caps_the_active_one() {
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        std::fs::write(log_dir.join(format!("{}_2026-09-27_00-00-00.log", crate::logging::LOG_FILE_STEM)), b"rotated content\n").unwrap();
        let big_line = "x".repeat(100);
        let big_content = format!("{big_line}\n").repeat((MAX_ACTIVE_LOG_TAIL_BYTES as usize / 101) + 100);
        std::fs::write(log_dir.join(format!("{}.log", crate::logging::LOG_FILE_STEM)), &big_content).unwrap();
        let out_dir = tmp.path().join("diagnostics");

        let input = sample_input(log_dir, out_dir);
        let zip_path = build_zip(&input).unwrap();
        let entries = read_zip_entries(&zip_path);
        assert_eq!(entries[&format!("logs/{}_2026-09-27_00-00-00.log", crate::logging::LOG_FILE_STEM)], b"rotated content\n");
        assert!(entries[&format!("logs/{}.log", crate::logging::LOG_FILE_STEM)].len() as u64 <= MAX_ACTIVE_LOG_TAIL_BYTES);
    }

    #[test]
    fn build_zip_drops_oversized_rotated_logs_before_the_active_one() {
        // Even when a rotated file alone blows the total budget, the active
        // `<exePrefix>.log` must survive -- it's the most recently written, most
        // relevant-to-the-current-problem log, and `list_log_files`'s lexical sort
        // ('.' < '_') would otherwise put it first in line to be dropped.
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let oversized = vec![b'x'; (MAX_ZIP_TOTAL_BYTES + 1) as usize];
        std::fs::write(log_dir.join(format!("{}_2026-09-27_00-00-00.log", crate::logging::LOG_FILE_STEM)), &oversized).unwrap();
        std::fs::write(log_dir.join(format!("{}.log", crate::logging::LOG_FILE_STEM)), b"active session content\n").unwrap();
        let out_dir = tmp.path().join("diagnostics");

        let input = sample_input(log_dir, out_dir);
        let zip_path = build_zip(&input).unwrap();
        let entries = read_zip_entries(&zip_path);
        assert!(
            !entries.contains_key(&format!("logs/{}_2026-09-27_00-00-00.log", crate::logging::LOG_FILE_STEM)),
            "the oversized rotated file must be the one dropped"
        );
        assert_eq!(entries[&format!("logs/{}.log", crate::logging::LOG_FILE_STEM)], b"active session content\n");
    }

    #[test]
    fn build_zip_gives_a_unique_name_when_called_twice_in_the_same_second() {
        let tmp = tempfile::tempdir().unwrap();
        let log_dir = tmp.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let out_dir = tmp.path().join("diagnostics");

        let input = sample_input(log_dir.clone(), out_dir.clone());
        let first = build_zip(&input).unwrap();
        let input2 = sample_input(log_dir, out_dir);
        let second = build_zip(&input2).unwrap();
        assert_ne!(first, second);
        assert!(first.exists());
        assert!(second.exists());
    }
}
