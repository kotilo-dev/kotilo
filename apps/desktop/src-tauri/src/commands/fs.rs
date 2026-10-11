//! `fs_*` commands (Faz 2 spec §3, §5, §8.5, §8.7, §8.8; Faz 3 spec §1, §5): everything
//! the file tree, quick filter and viewer need, addressed as `(workspaceId, rel)` and
//! resolved through [`fsguard::resolve`] so a command can never read/write/delete outside
//! a workspace root.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fsguard;
use crate::gitignore_tree::GitignoreTreeCache;
use crate::settings::SettingsStore;
use crate::textfile::{self, Eol, TextEncoding};
use crate::workspace::WorkspaceStore;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub rel: String,
    pub is_dir: bool,
}

/// Faz 3 spec §1, §5.1: what `fs_read_text` hands the viewer for a text document.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    pub encoding: TextEncoding,
    pub eol: Eol,
    pub mixed_eol: bool,
    pub hash: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub read_only: bool,
    /// Why `read_only` is set (`None` when it isn't) — the viewer shows a matching notice.
    pub read_only_reason: Option<ReadOnlyReason>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadOnlyReason {
    /// Larger than 5 MB.
    TooLarge,
    /// Decoded lossily (unmappable ANSI code page / invalid bytes) — writing back would corrupt it.
    LossyEncoding,
}

/// Faz 3 spec §5.4: `hash` is always populated, with no size cutoff.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: u64,
    pub hash: String,
}

/// Faz 3 spec §5.2: `fs_write_text`'s return value.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub hash: String,
    pub mtime_ms: u64,
}

/// Folders first, then case-insensitive name order (spec §5).
fn dir_entry_cmp(a: &DirEntry, b: &DirEntry) -> std::cmp::Ordering {
    b.is_dir
        .cmp(&a.is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

/// `true` if `new_name` is a same-entry, case-only rename of `old_name` — same
/// characters up to Unicode lowercasing but not byte-for-byte identical (finding #5).
/// Windows filenames are case-insensitive, so `new_path.exists()` is (correctly) true
/// for `Foo` -> `foo` even though nothing actually collides; this is what lets the
/// caller tell that apart from a real collision with some *other* entry.
fn is_case_only_rename(old_name: &str, new_name: &str) -> bool {
    old_name != new_name && old_name.to_lowercase() == new_name.to_lowercase()
}

fn child_rel(parent_rel: &str, name: &str) -> String {
    if parent_rel.is_empty() {
        name.to_string()
    } else {
        format!("{parent_rel}/{name}")
    }
}

fn workspace_root(store: &State<'_, WorkspaceStore>, workspace_id: &str) -> AppResult<PathBuf> {
    Ok(PathBuf::from(store.find_path(workspace_id)?))
}

/// Faz 4 spec §1.3: what `fs_resolve_link` hands the terminal's link provider for a
/// candidate that resolved to an existing file.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    pub rel: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Strips a trailing `:<digits>` suffix off `s` — used to peel `:line` and `:line:col`
/// suffixes one at a time from the right. Requires a non-empty `rest` before the colon
/// (so a bare `:42` isn't treated as a path) — this is also what keeps a Windows drive
/// colon (`C:\...`) from being mistaken for a line-number separator: the segment right
/// after *that* colon is never purely digits.
fn strip_trailing_number(s: &str) -> Option<(&str, u32)> {
    let idx = s.rfind(':')?;
    let (rest, num_str) = (&s[..idx], &s[idx + 1..]);
    if rest.is_empty() || num_str.is_empty() || !num_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((rest, num_str.parse().ok()?))
}

/// Pure candidate parser (spec §1.3, unit-tested): splits a terminal-provided path-ish
/// string into its bare path and an optional `line`/`column` suffix — `:line`,
/// `:line:col`, or the MSBuild/tsc `(line,col)` form.
pub fn parse_candidate(candidate: &str) -> (String, Option<u32>, Option<u32>) {
    let trimmed = candidate.trim();

    if trimmed.ends_with(')') {
        if let Some(open) = trimmed.rfind('(') {
            let inner = &trimmed[open + 1..trimmed.len() - 1];
            if let Some((line_s, col_s)) = inner.split_once(',') {
                if let (Ok(line), Ok(col)) = (line_s.trim().parse(), col_s.trim().parse()) {
                    let path = trimmed[..open].trim_end();
                    if !path.is_empty() {
                        return (path.to_string(), Some(line), Some(col));
                    }
                }
            }
        }
    }

    if let Some((rest1, last_num)) = strip_trailing_number(trimmed) {
        if let Some((rest2, prev_num)) = strip_trailing_number(rest1) {
            return (rest2.to_string(), Some(prev_num), Some(last_num));
        }
        return (rest1.to_string(), Some(last_num), None);
    }

    (trimmed.to_string(), None, None)
}

/// `/x/...` (Git Bash's view of `X:\...`) -> `X:/...`. `None` if `s` doesn't match.
fn strip_gitbash_drive(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        Some(format!("{}:/{}", bytes[1] as char, &s[3..]))
    } else {
        None
    }
}

/// `X:/...` (already `/`-normalized). Windows accepts `/` as a path separator directly,
/// so this is handed straight to `std::fs`/`canonicalize` rather than back-converted.
fn is_windows_drive_absolute(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// An absolute path (already drive-letter form) that resolves to an existing file under
/// `root` — case-insensitively, like every other workspace-relative address (spec §1.3).
fn resolve_absolute_under_root(root: &Path, abs_path: &str) -> Option<String> {
    let candidate = PathBuf::from(abs_path);
    if !candidate.is_file() {
        return None;
    }
    let canon_root = std::fs::canonicalize(root).ok()?;
    let canon_candidate = std::fs::canonicalize(&candidate).ok()?;
    fsguard::rel_under_ci(&canon_root, &canon_candidate)
}

/// Resolves `rel_candidate` (already `/`-separated, no drive letter) against `base_rel`
/// first, falling back to the workspace root — returning the *combined* rel only if it
/// names an existing **file** (spec §1.3: a directory or a missing target is `null`,
/// not an error).
fn resolve_relative_under_root(root: &Path, base_rel: &str, rel_candidate: &str) -> Option<String> {
    let combined = if base_rel.is_empty() {
        rel_candidate.to_string()
    } else {
        format!("{base_rel}/{rel_candidate}")
    };
    match fsguard::resolve(root, &combined) {
        Ok(path) if path.is_file() => Some(combined),
        _ => None,
    }
}

/// Root-relative core of `fs_resolve_link` — see [`read_text_at`] for why this split
/// exists.
fn resolve_link_at(root: &Path, base_rel: &str, candidate: &str) -> Option<ResolvedLink> {
    let (path_str, line, column) = parse_candidate(candidate);
    if path_str.is_empty() {
        return None;
    }
    let normalized = path_str.replace('\\', "/");

    let rel = if let Some(drive_form) = strip_gitbash_drive(&normalized) {
        resolve_absolute_under_root(root, &drive_form)
    } else if is_windows_drive_absolute(&normalized) {
        resolve_absolute_under_root(root, &normalized)
    } else {
        let rel_candidate = normalized.strip_prefix("./").unwrap_or(&normalized);
        (!base_rel.is_empty())
            .then(|| resolve_relative_under_root(root, base_rel, rel_candidate))
            .flatten()
            .or_else(|| resolve_relative_under_root(root, "", rel_candidate))
    }?;

    Some(ResolvedLink { rel, line, column })
}

/// Faz 4 spec §1.3: resolves a path-ish string copied out of a terminal pane (a
/// relative path, a `.\`-prefixed one, an absolute Windows path, or a Git Bash `/c/...`
/// one — each optionally carrying a `:line`, `:line:col`, or `(line,col)` suffix) to an
/// existing file under the workspace, for the terminal's Ctrl+click link provider.
/// `null` for anything that doesn't resolve to an existing file (including "resolves,
/// but outside the workspace") — never an error, since most candidates a link provider
/// tries are never meant to be files at all.
#[tauri::command(async)]
pub fn fs_resolve_link(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    base_rel: String,
    candidate: String,
) -> AppResult<Option<ResolvedLink>> {
    let root = workspace_root(&store, &workspace_id)?;
    Ok(resolve_link_at(&root, &base_rel, &candidate))
}

#[tauri::command(async)]
pub async fn fs_read_dir(
    store: State<'_, WorkspaceStore>,
    settings: State<'_, SettingsStore>,
    gitignore_cache: State<'_, GitignoreTreeCache>,
    workspace_id: String,
    rel: String,
) -> AppResult<Vec<DirEntry>> {
    let root = workspace_root(&store, &workspace_id)?;
    let target = fsguard::resolve(&root, &rel)?;
    if !target.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{rel}' is not a folder"
        )));
    }

    let hidden = settings.hidden_globset();
    // Faz 6 spec §4/§10.16, review finding #4: only consulted (and only built/cached)
    // when the setting is on — a workspace that never turns it on never pays for the
    // `.gitignore` walk. Building is single-flight per workspace and the (possibly slow)
    // discovery walk always runs in `spawn_blocking`, never on this async command's own
    // task (see `GitignoreTreeCache::get_or_build`).
    let gitignore_tree = if settings.respect_gitignore() {
        Some(gitignore_cache.get_or_build(&workspace_id, &root).await)
    } else {
        None
    };

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&target)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if hidden.is_match(&name) {
            continue;
        }
        // `DirEntry::file_type()` reads the type without following a symlink/junction
        // (spec §8.8): a junction reports `is_dir() == true` at the Windows attribute
        // level but `is_symlink() == true` too, so we exclude it from `isDir` on
        // purpose — the tree must not recurse into it and the watcher must not either.
        let file_type = entry.file_type()?;
        let is_dir = file_type.is_dir() && !file_type.is_symlink();
        if let Some(tree) = &gitignore_tree {
            if crate::gitignore_tree::is_ignored(tree, &entry.path(), is_dir) {
                continue;
            }
        }
        entries.push(DirEntry {
            rel: child_rel(&rel, &name),
            name,
            is_dir,
        });
    }
    entries.sort_by(dir_entry_cmp);
    Ok(entries)
}

#[tauri::command(async)]
pub fn fs_create_file(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    dir_rel: String,
    name: String,
) -> AppResult<String> {
    fsguard::validate_name(&name)?;
    let root = workspace_root(&store, &workspace_id)?;
    let dir = fsguard::resolve(&root, &dir_rel)?;
    if !dir.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{dir_rel}' is not a folder"
        )));
    }
    let target = dir.join(&name);
    if target.exists() {
        return Err(AppError::already_exists(format!(
            "'{name}' already exists"
        )));
    }
    std::fs::File::create_new(&target)?;
    Ok(child_rel(&dir_rel, &name))
}

#[tauri::command(async)]
pub fn fs_create_dir(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    dir_rel: String,
    name: String,
) -> AppResult<String> {
    fsguard::validate_name(&name)?;
    let root = workspace_root(&store, &workspace_id)?;
    let dir = fsguard::resolve(&root, &dir_rel)?;
    if !dir.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{dir_rel}' is not a folder"
        )));
    }
    let target = dir.join(&name);
    if target.exists() {
        return Err(AppError::already_exists(format!(
            "'{name}' already exists"
        )));
    }
    std::fs::create_dir(&target)?;
    Ok(child_rel(&dir_rel, &name))
}

#[tauri::command(async)]
pub fn fs_rename(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
    new_name: String,
) -> AppResult<String> {
    if rel.is_empty() {
        return Err(AppError::invalid_name("cannot rename the workspace root"));
    }
    fsguard::validate_name(&new_name)?;
    let root = workspace_root(&store, &workspace_id)?;
    let old_path = fsguard::resolve(&root, &rel)?;
    // Defense in depth (finding #1): `rel.is_empty()` above is the primary root guard,
    // but refuse again here in case a future `rel` value ever resolved to the root by
    // some other route (e.g. a canonicalization edge case).
    if fsguard::same_existing_path(&old_path, &root).unwrap_or(false) {
        return Err(AppError::invalid_name("cannot rename the workspace root"));
    }
    let parent = old_path
        .parent()
        .ok_or_else(|| AppError::invalid_name("cannot rename the workspace root"))?;
    let new_path = parent.join(&new_name);
    let old_name = old_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if new_path.exists() && !is_case_only_rename(&old_name, &new_name) {
        return Err(AppError::already_exists(format!(
            "'{new_name}' already exists"
        )));
    }
    std::fs::rename(&old_path, &new_path)?;

    let parent_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    Ok(child_rel(parent_rel, &new_name))
}

#[tauri::command(async)]
pub fn fs_delete(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<()> {
    if rel.is_empty() {
        return Err(AppError::invalid_name(
            "the workspace root cannot be deleted",
        ));
    }
    let root = workspace_root(&store, &workspace_id)?;
    let target = fsguard::resolve(&root, &rel)?;
    // Defense in depth (finding #1): see the matching guard in `fs_rename`.
    if fsguard::same_existing_path(&target, &root).unwrap_or(false) {
        return Err(AppError::invalid_name(
            "the workspace root cannot be deleted",
        ));
    }

    // §8.11: `trash::delete` runs on its own thread — the underlying Windows shell API
    // (IFileOperation) requires a COM apartment that must not be the one Tauri's async
    // runtime happens to be using for this invoke.
    let handle = std::thread::spawn(move || trash::delete(&target));
    match handle.join() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(AppError::io(e.to_string())),
        Err(_) => Err(AppError::io("trash worker thread panicked")),
    }
}

#[tauri::command(async)]
pub fn fs_reveal(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<()> {
    let root = workspace_root(&store, &workspace_id)?;
    let target = fsguard::resolve(&root, &rel)?;
    if rel.is_empty() {
        // rel == "" -> open the workspace root folder itself (finding #11): revealing it
        // would instead select it inside its *parent*, which for the root is wrong.
        return tauri_plugin_opener::open_path(&target, None::<&str>)
            .map_err(|e| AppError::io(e.to_string()));
    }
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| AppError::io(e.to_string()))
}

/// Faz 3 spec §1: `fs_read_text` refuses anything over 50 MB (`too_large`) rather than
/// decoding it — even a valid encoding would make for a useless Monaco buffer at that
/// size.
const READ_TEXT_MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Faz 3 spec §1: past 5 MB the document is still opened, just `readOnly`.
const READ_TEXT_READONLY_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;
/// Faz 3 spec §1: `fs_read_bytes` (used for images/PDFs/etc., which don't get a
/// read-only middle ground) refuses anything over 100 MB.
const READ_BYTES_MAX_BYTES: u64 = 100 * 1024 * 1024;

fn mtime_millis(meta: &std::fs::Metadata) -> AppResult<u64> {
    let modified = meta.modified()?;
    let millis = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| AppError::io(format!("file modification time is before the epoch: {e}")))?
        .as_millis();
    Ok(millis as u64)
}

#[tauri::command(async)]
pub fn fs_read_text(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<TextFile> {
    let root = workspace_root(&store, &workspace_id)?;
    read_text_at(&root, &rel)
}

/// Root-relative core of [`fs_read_text`], kept `State`-free so it's directly unit
/// testable with a `tempfile::tempdir()` (the same split `fsguard`'s own tests rely on).
fn read_text_at(root: &Path, rel: &str) -> AppResult<TextFile> {
    let target = fsguard::resolve(root, rel)?;
    if !target.is_file() {
        return Err(AppError::not_a_directory(format!("'{rel}' is not a file")));
    }

    let meta = std::fs::metadata(&target)?;
    let size = meta.len();
    if size > READ_TEXT_MAX_BYTES {
        return Err(AppError::too_large(format!(
            "'{rel}' is larger than 50 MB"
        )));
    }

    let bytes = std::fs::read(&target)?;
    if textfile::is_binary(&bytes) {
        return Err(AppError::binary_file(format!(
            "'{rel}' does not look like a text file"
        )));
    }

    let decoded = textfile::decode(&bytes);
    let hash = textfile::hash_hex(&bytes);
    let mtime_ms = mtime_millis(&meta)?;
    let read_only_reason = if decoded.lossy {
        Some(ReadOnlyReason::LossyEncoding)
    } else if size > READ_TEXT_READONLY_THRESHOLD_BYTES {
        Some(ReadOnlyReason::TooLarge)
    } else {
        None
    };

    Ok(TextFile {
        text: decoded.text,
        encoding: decoded.encoding,
        eol: decoded.eol,
        mixed_eol: decoded.mixed_eol,
        hash,
        mtime_ms,
        size,
        read_only: read_only_reason.is_some(),
        read_only_reason,
    })
}

/// Atomically creates a same-directory temp file `.{name}.{pid}.{n}.tmp` (spec §5.11),
/// trying successive `n` until one succeeds.
///
/// Review finding #5: the previous version picked `n` via a separate `Path::exists`
/// check and only created the file afterwards — two concurrent writes to the same
/// `(workspaceId, rel)` (e.g. two saves racing, or a save racing an external tool) could
/// both observe the same `n` as free and then both write to the same tmp path, silently
/// corrupting one of the writes. `OpenOptions::create_new` makes the "is `n` free" check
/// and the file creation a single atomic filesystem operation, so two threads racing on
/// the same `n` never both "win" the same path — the loser gets `AlreadyExists` and moves
/// on to `n + 1`. `n` only ever climbs past 0 in that race or from a leftover temp file
/// from a previous crashed run.
pub(crate) fn create_unique_tmp_file(dir: &Path, name: &str) -> std::io::Result<(PathBuf, std::fs::File)> {
    let pid = std::process::id();
    let mut n = 0u32;
    loop {
        let candidate = dir.join(format!(".{name}.{pid}.{n}.tmp"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    }
}

/// Writes `bytes` to `tmp_file` (already created at `tmp_path` by
/// [`create_unique_tmp_file`]). Review finding #15: on failure, removes `tmp_path` before
/// returning the error — otherwise a write that fails partway through (disk full, quota,
/// ...) would leave a stray/partial `.tmp` file behind in the workspace forever, since
/// nothing else ever revisits it.
pub(crate) fn write_tmp_contents(
    tmp_path: &Path,
    tmp_file: &mut std::fs::File,
    bytes: &[u8],
) -> AppResult<()> {
    if let Err(e) = tmp_file.write_all(bytes) {
        let _ = std::fs::remove_file(tmp_path);
        return Err(AppError::io(e.to_string()));
    }
    Ok(())
}

#[cfg(windows)]
fn is_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn is_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Re-applies the hidden attribute after an atomic replace (spec §5.11): `fs::rename`'s
/// `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)` takes the *new* file's (the temp file's)
/// attributes, which silently drops "hidden" on the original — this restores it.
#[cfg(windows)]
fn set_hidden(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_FLAGS_AND_ATTRIBUTES,
        INVALID_FILE_ATTRIBUTES,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a valid NUL-terminated UTF-16 string alive for both calls below.
    unsafe {
        let current = GetFileAttributesW(PCWSTR(wide.as_ptr()));
        if current == INVALID_FILE_ATTRIBUTES {
            return;
        }
        let _ = SetFileAttributesW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(current | FILE_ATTRIBUTE_HIDDEN.0),
        );
    }
}

#[cfg(not(windows))]
fn set_hidden(_path: &Path) {}

/// Renames `tmp` onto `target` (an atomic replace on Windows — see `persistence`'s doc
/// comment on `fs::rename`), retrying up to 3 times on failure with a 50 ms pause (spec
/// §5.11: another process briefly holding a sharing lock on the target, e.g. a virus
/// scanner or the OS's own change notification consumer).
pub(crate) fn atomic_replace(tmp: &Path, target: &Path) -> AppResult<()> {
    const MAX_ATTEMPTS: u32 = 4; // 1 initial try + 3 retries
    const RETRY_DELAY: Duration = Duration::from_millis(50);

    let mut last_err = None;
    for attempt in 0..MAX_ATTEMPTS {
        match std::fs::rename(tmp, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt + 1 < MAX_ATTEMPTS {
                    std::thread::sleep(RETRY_DELAY);
                }
            }
        }
    }
    let _ = std::fs::remove_file(tmp);
    Err(AppError::io(format!(
        "File is read-only or locked by another process ({})",
        last_err.expect("loop always sets last_err before falling through")
    )))
}

#[tauri::command(async)]
pub fn fs_write_text(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
    text: String,
    encoding: TextEncoding,
    eol: Eol,
    expected_hash: Option<String>,
) -> AppResult<WriteResult> {
    let root = workspace_root(&store, &workspace_id)?;
    write_text_at(&root, &rel, &text, encoding, eol, expected_hash.as_deref())
}

/// Root-relative core of [`fs_write_text`] — see [`read_text_at`] for why this split
/// exists.
fn write_text_at(
    root: &Path,
    rel: &str,
    text: &str,
    encoding: TextEncoding,
    eol: Eol,
    expected_hash: Option<&str>,
) -> AppResult<WriteResult> {
    if rel.is_empty() {
        return Err(AppError::invalid_name("cannot write the workspace root"));
    }
    let file_name = rel
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| AppError::invalid_name("rel must not end with '/'"))?;
    fsguard::validate_name(file_name)?;
    let dir_rel = rel.rsplit_once('/').map(|(p, _)| p).unwrap_or("");

    // The target itself is allowed to not exist yet — re-saving a document whose file
    // was deleted out from under it (spec, Frontend-A §"Deleted on disk") must recreate
    // it, so only the *parent* is resolved through fsguard (which requires it to
    // already exist); the validated leaf name is then joined on, exactly like
    // `fs_create_file`.
    let dir = fsguard::resolve(root, dir_rel)?;
    if !dir.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{dir_rel}' is not a folder"
        )));
    }
    let target = dir.join(file_name);

    // Faz 3 spec §1: `expectedHash` given but no longer matching what's on disk ->
    // `conflict`, nothing is written. This only applies when the target *exists* — a
    // missing target is always (re)created regardless of `expectedHash`: the frontend's
    // documentStore always sends the document's last-known hash (never `null`), and
    // relies on this to silently recreate a file that was deleted out from under a dirty
    // document (spec, Frontend-A §"Deleted on disk": "kaydet → yeniden oluşturur"). A
    // *modified* (not deleted) file with a different hash still conflicts below.
    //
    // Review finding #2: this is also where we cheaply learn whether the file *currently
    // on disk* decodes lossily (we already have to read its bytes for the hash check) —
    // if it does, a write must never proceed: whatever Monaco has in memory came from a
    // lossy decode (unmappable ANSI / invalid bytes) and blindly overwriting would
    // permanently destroy the bytes that didn't round-trip, with no way back. This check
    // runs regardless of whether `expected_hash` was passed, so it still catches a save
    // with no `expectedHash` at all.
    if target.is_file() {
        let on_disk = std::fs::read(&target)?;
        if let Some(expected) = expected_hash {
            let actual = textfile::hash_hex(&on_disk);
            if actual != expected {
                return Err(AppError::conflict(
                    "the file has changed on disk since it was opened",
                ));
            }
        }
        if textfile::decode(&on_disk).lossy {
            return Err(AppError::io(
                "File cannot be saved without data loss (encoding)",
            ));
        }
    }

    let bytes = textfile::encode(text, encoding, eol).map_err(AppError::io)?;

    let was_hidden = if target.is_file() {
        let meta = std::fs::metadata(&target)?;
        if meta.permissions().readonly() {
            return Err(AppError::io(
                "File is read-only or locked by another process",
            ));
        }
        is_hidden(&meta)
    } else {
        false
    };

    let (tmp_path, mut tmp_file) = create_unique_tmp_file(&dir, file_name)?;
    write_tmp_contents(&tmp_path, &mut tmp_file, &bytes)?;
    // Close the handle before renaming — `atomic_replace` needs `tmp_path` to be free of
    // this process's own writer handle for the replace to succeed reliably.
    drop(tmp_file);
    atomic_replace(&tmp_path, &target)?;
    if was_hidden {
        set_hidden(&target);
    }

    let hash = textfile::hash_hex(&bytes);
    let mtime_ms = mtime_millis(&std::fs::metadata(&target)?)?;
    Ok(WriteResult { hash, mtime_ms })
}

/// Review finding #10: lets the frontend cheaply check whether a `rel` still exists as a
/// file on disk (e.g. before re-saving a tab tagged "Deleted on disk") without paying for
/// a full read or hash. `resolve`'s `not_found` collapses to `Ok(false)` — a missing
/// target isn't an error condition here — but every other `fsguard` error (path escape,
/// unknown workspace, ...) still propagates, since those are real problems the frontend
/// should surface rather than silently treat as "doesn't exist".
#[tauri::command(async)]
pub fn fs_exists(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<bool> {
    let root = workspace_root(&store, &workspace_id)?;
    exists_at(&root, &rel)
}

/// Root-relative core of [`fs_exists`] — see [`read_text_at`] for why this split exists.
fn exists_at(root: &Path, rel: &str) -> AppResult<bool> {
    match fsguard::resolve(root, rel) {
        Ok(target) => Ok(target.is_file()),
        Err(e) if e.code == crate::error::ErrorCode::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn hash_file_streaming(path: &Path) -> AppResult<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = xxhash_rust::xxh3::Xxh3::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(textfile::hash_from_digest(hasher.digest()))
}

#[tauri::command(async)]
pub fn fs_stat(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<FileStat> {
    let root = workspace_root(&store, &workspace_id)?;
    stat_at(&root, &rel)
}

fn stat_at(root: &Path, rel: &str) -> AppResult<FileStat> {
    let target = fsguard::resolve(root, rel)?;
    let meta = std::fs::metadata(&target)?;
    let size = meta.len();
    let mtime_ms = mtime_millis(&meta)?;
    let hash = hash_file_streaming(&target)?;
    Ok(FileStat {
        size,
        mtime_ms,
        hash,
    })
}

#[tauri::command(async)]
pub fn fs_read_bytes(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<tauri::ipc::Response> {
    let root = workspace_root(&store, &workspace_id)?;
    let target = fsguard::resolve(&root, &rel)?;
    if !target.is_file() {
        return Err(AppError::not_a_directory(format!("'{rel}' is not a file")));
    }
    let meta = std::fs::metadata(&target)?;
    if meta.len() > READ_BYTES_MAX_BYTES {
        return Err(AppError::too_large(format!(
            "'{rel}' is larger than 100 MB"
        )));
    }
    let bytes = std::fs::read(&target)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Review finding #7: extensions the OS would otherwise hand off to a shell that can
/// execute code (a `.exe`, a script interpreter, an installer, a shortcut, ...) rather
/// than just display/open the file passively — checked case-insensitively against the
/// *last* extension only (`a.exe.txt` opens as a text file, `FOO.EXE` is refused).
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "com", "scr", "pif", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js",
    "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "jar", "appref-ms", "application",
];

/// `true` if `rel`'s final extension is on [`EXECUTABLE_EXTENSIONS`] (case-insensitive).
/// Pure and `rel`-based (not filesystem-based) so it's directly unit testable and applies
/// equally regardless of whether the target exists.
fn is_executable_ext(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.as_str()))
}

#[tauri::command(async)]
pub fn fs_open_default(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    rel: String,
) -> AppResult<()> {
    if is_executable_ext(&rel) {
        return Err(AppError::invalid_name("Refusing to open executable files"));
    }
    let root = workspace_root(&store, &workspace_id)?;
    let target = fsguard::resolve(&root, &rel)?;
    tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|e| AppError::io(e.to_string()))
}

/// Faz 7 §11: a `mailto:` link is allowed only when everything after the scheme is
/// exactly one plain address — no `?` (subject/body/cc query params), no commas (multiple
/// recipients). Pure, unit-tested.
fn is_single_plain_mailto_address(rest: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
            .expect("mailto address pattern is a valid regex")
    });
    re.is_match(rest)
}

/// Faz 3 spec §5.7 (extended by Faz 7 §11): the allow-list `open_external_url` enforces —
/// `http://`/`https://` outright, or a `mailto:` link whose remainder is exactly one plain
/// address. Pure, unit-tested independently of the command (which also needs a real
/// OS opener, unavailable in a unit test).
fn is_openable_external_url(url: &str) -> bool {
    url.starts_with("http://")
        || url.starts_with("https://")
        || url
            .strip_prefix("mailto:")
            .is_some_and(is_single_plain_mailto_address)
}

/// Faz 3 spec §5.7 (extended by Faz 7 §11): opens `http(s)` URLs, or a `mailto:` link
/// whose remainder is exactly one plain address, in the user's default browser/mail
/// client — used by the Markdown renderer for external links, so a malicious/careless
/// `file://` or `javascript:` link in a previewed document can't do anything through this
/// command.
#[tauri::command(async)]
pub fn open_external_url(url: String) -> AppResult<()> {
    if !is_openable_external_url(&url) {
        return Err(AppError::invalid_name(
            "only http://, https://, and a single mailto: address can be opened",
        ));
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| AppError::io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_dir: bool) -> DirEntry {
        DirEntry {
            name: name.to_string(),
            rel: name.to_string(),
            is_dir,
        }
    }

    #[test]
    fn sorts_dirs_first_then_case_insensitive_name() {
        let mut entries = [
            entry("banana.txt", false),
            entry("Apple", true),
            entry("apple.txt", false),
            entry("zebra", true),
            entry("Banana", true),
        ];
        entries.sort_by(dir_entry_cmp);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Apple", "Banana", "zebra", "apple.txt", "banana.txt"]);
    }

    #[test]
    fn case_only_rename_is_detected() {
        assert!(is_case_only_rename("Foo", "foo"));
        assert!(is_case_only_rename("README.md", "readme.md"));
    }

    // -- Faz 7 §11: mailto: allow-list -------------------------------------------------

    #[test]
    fn mailto_single_plain_address_is_allowed() {
        assert!(is_single_plain_mailto_address("someone@example.com"));
        assert!(is_single_plain_mailto_address("first.last+tag@sub.example.co"));
    }

    #[test]
    fn mailto_rejects_query_params() {
        assert!(!is_single_plain_mailto_address("someone@example.com?subject=hi"));
    }

    #[test]
    fn mailto_rejects_multiple_recipients() {
        assert!(!is_single_plain_mailto_address("a@example.com,b@example.com"));
    }

    #[test]
    fn mailto_rejects_malformed_addresses() {
        assert!(!is_single_plain_mailto_address("not-an-address"));
        assert!(!is_single_plain_mailto_address("@example.com"));
        assert!(!is_single_plain_mailto_address("someone@"));
        assert!(!is_single_plain_mailto_address(""));
    }

    #[test]
    fn is_openable_external_url_accepts_http_https_and_plain_mailto() {
        assert!(is_openable_external_url("http://example.com"));
        assert!(is_openable_external_url("https://example.com/path?q=1"));
        assert!(is_openable_external_url("mailto:bugs@agenthub.dev"));
    }

    #[test]
    fn is_openable_external_url_rejects_other_schemes_and_mailto_variants() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com",
            "HTTP://example.com", // scheme match is case-sensitive by design
            "mailto:a@b.com?cc=c@d.com",
            "mailto:a@b.com,c@d.com",
            "not a url at all",
            "",
        ] {
            assert!(!is_openable_external_url(url), "should reject: {url}");
        }
    }

    #[test]
    fn open_external_url_rejects_file_and_javascript_schemes() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "mailto:a@b.com?cc=c@d.com"] {
            let err = open_external_url(url.to_string()).unwrap_err();
            assert_eq!(err.code, crate::error::ErrorCode::InvalidName);
        }
    }

    #[test]
    fn identical_name_is_not_a_case_only_rename() {
        assert!(!is_case_only_rename("foo", "foo"));
    }

    #[test]
    fn different_name_is_not_a_case_only_rename() {
        assert!(!is_case_only_rename("foo", "bar"));
    }

    // ---- fs_read_text / fs_write_text / fs_stat (Faz 3) ------------------------

    #[test]
    fn read_text_over_5_mb_is_read_only_with_too_large_reason() {
        let dir = tempfile::tempdir().unwrap();
        let body = "x".repeat((READ_TEXT_READONLY_THRESHOLD_BYTES + 1) as usize);
        std::fs::write(dir.path().join("big.txt"), body).unwrap();

        let file = read_text_at(dir.path(), "big.txt").unwrap();
        assert!(file.read_only);
        assert_eq!(file.read_only_reason, Some(ReadOnlyReason::TooLarge));
    }

    #[test]
    fn read_text_reports_utf8_lf_and_matching_hash() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"hello\nworld\n").unwrap();

        let file = read_text_at(dir.path(), "a.txt").unwrap();
        assert_eq!(file.text, "hello\nworld\n");
        assert_eq!(file.encoding, TextEncoding::Utf8);
        assert_eq!(file.eol, Eol::Lf);
        assert!(!file.mixed_eol);
        assert!(!file.read_only);
        assert_eq!(file.read_only_reason, None);
        assert_eq!(file.hash, textfile::hash_hex(b"hello\nworld\n"));
    }

    #[test]
    fn read_text_rejects_binary_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), b"\x00\x01\x02binary").unwrap();

        let err = read_text_at(dir.path(), "a.bin").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::BinaryFile);
    }

    #[test]
    fn read_text_on_directory_is_not_a_directory_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let err = read_text_at(dir.path(), "sub").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotADirectory);
    }

    /// Acceptance case (spec §4, §5.12): editing/saving a CRLF (BOM'd) XML file
    /// preserves CRLF end to end through the actual command-level read/write path, not
    /// just the pure `textfile` round trip.
    #[test]
    fn write_text_preserves_crlf_bom_xml_byte_identical_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut original = vec![0xEF, 0xBB, 0xBF];
        original.extend_from_slice(b"<?xml version=\"1.0\"?>\r\n<root>\r\n  <a/>\r\n</root>\r\n");
        std::fs::write(dir.path().join("doc.xml"), &original).unwrap();

        let file = read_text_at(dir.path(), "doc.xml").unwrap();
        write_text_at(
            dir.path(),
            "doc.xml",
            &file.text,
            file.encoding,
            file.eol,
            Some(&file.hash),
        )
        .unwrap();

        let on_disk = std::fs::read(dir.path().join("doc.xml")).unwrap();
        assert_eq!(on_disk, original);
    }

    #[test]
    fn write_text_only_changed_line_differs_eol_preserved() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"line1\r\nline2\r\nline3\r\n").unwrap();

        let file = read_text_at(dir.path(), "a.txt").unwrap();
        let edited = file.text.replace("line2", "LINE2 CHANGED");
        write_text_at(
            dir.path(),
            "a.txt",
            &edited,
            file.encoding,
            file.eol,
            Some(&file.hash),
        )
        .unwrap();

        let on_disk = std::fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(
            on_disk,
            b"line1\r\nLINE2 CHANGED\r\nline3\r\n".to_vec()
        );
    }

    #[test]
    fn write_text_with_stale_expected_hash_is_conflict_and_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"original\n").unwrap();

        let err = write_text_at(
            dir.path(),
            "a.txt",
            "changed\n",
            TextEncoding::Utf8,
            Eol::Lf,
            Some("0000000000000000"),
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Conflict);

        let on_disk = std::fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, b"original\n".to_vec());
    }

    #[test]
    fn write_text_without_expected_hash_overwrites_unconditionally() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"original\n").unwrap();

        write_text_at(dir.path(), "a.txt", "changed\n", TextEncoding::Utf8, Eol::Lf, None)
            .unwrap();

        let on_disk = std::fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, b"changed\n".to_vec());
    }

    /// Frontend-A's "Deleted on disk" flow (spec, viewer §"Dış değişiklik"): saving a
    /// document whose file was removed out from under it must recreate it rather than
    /// failing `not_found` — as long as the caller doesn't also pass a now-unmatchable
    /// `expectedHash`.
    #[test]
    fn write_text_recreates_a_deleted_file_when_no_expected_hash_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, b"original\n").unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!path.exists());

        write_text_at(dir.path(), "a.txt", "recreated\n", TextEncoding::Utf8, Eol::Lf, None)
            .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"recreated\n".to_vec());
    }

    /// The frontend's `documentStore.save()` always sends the document's last-known hash
    /// as `expectedHash` (never `null`), including for a tab tagged "Deleted on disk" —
    /// so a missing target must recreate unconditionally rather than conflict, or that
    /// flow could never actually save. A conflict still fires when the target *exists*
    /// with different content (the case just above).
    #[test]
    fn write_text_deleted_file_with_stale_expected_hash_still_recreates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, b"original\n").unwrap();
        let hash = textfile::hash_hex(b"original\n");
        std::fs::remove_file(&path).unwrap();

        write_text_at(
            dir.path(),
            "a.txt",
            "recreated\n",
            TextEncoding::Utf8,
            Eol::Lf,
            Some(&hash),
        )
        .unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"recreated\n".to_vec());
    }

    // ---- fs_write_text lossy-on-disk guard (Faz 3 review finding #2) ------------

    #[test]
    fn read_text_utf8_bom_with_invalid_byte_is_lossy_encoding_reason() {
        let dir = tempfile::tempdir().unwrap();
        // UTF-8 BOM followed by an invalid UTF-8 byte (0xFF is never valid in UTF-8).
        let bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF, 0xFF, b'x'];
        std::fs::write(dir.path().join("a.txt"), &bytes).unwrap();

        let file = read_text_at(dir.path(), "a.txt").unwrap();
        assert!(file.read_only);
        assert_eq!(file.read_only_reason, Some(ReadOnlyReason::LossyEncoding));
        assert_eq!(file.encoding, TextEncoding::Utf8Bom);
    }

    #[test]
    fn read_text_utf16_with_odd_trailing_byte_is_lossy_encoding_reason() {
        let dir = tempfile::tempdir().unwrap();
        // UTF-16LE BOM followed by a single trailing byte -> an incomplete code unit.
        let bytes: Vec<u8> = vec![0xFF, 0xFE, 0x41];
        std::fs::write(dir.path().join("a.txt"), &bytes).unwrap();

        let file = read_text_at(dir.path(), "a.txt").unwrap();
        assert!(file.read_only);
        assert_eq!(file.read_only_reason, Some(ReadOnlyReason::LossyEncoding));
        assert_eq!(file.encoding, TextEncoding::Utf16Le);
    }

    #[test]
    fn write_text_refuses_to_overwrite_lossy_utf8_bom_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF, 0xFF, b'x'];
        std::fs::write(dir.path().join("a.txt"), &bytes).unwrap();

        let err = write_text_at(
            dir.path(),
            "a.txt",
            "replacement\n",
            TextEncoding::Utf8Bom,
            Eol::Lf,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Io);

        let on_disk = std::fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, bytes, "a lossy-on-disk file must never be overwritten");
    }

    #[test]
    fn write_text_refuses_to_overwrite_lossy_utf16_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = vec![0xFF, 0xFE, 0x41];
        std::fs::write(dir.path().join("a.txt"), &bytes).unwrap();

        let err = write_text_at(
            dir.path(),
            "a.txt",
            "replacement\n",
            TextEncoding::Utf16Le,
            Eol::Lf,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Io);

        let on_disk = std::fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(on_disk, bytes, "a lossy-on-disk file must never be overwritten");
    }

    #[test]
    fn write_text_rejects_root() {
        let dir = tempfile::tempdir().unwrap();
        let err =
            write_text_at(dir.path(), "", "x", TextEncoding::Utf8, Eol::Lf, None).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidName);
    }

    #[test]
    fn write_text_no_tmp_file_left_behind_after_success() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a\n").unwrap();
        write_text_at(dir.path(), "a.txt", "b\n", TextEncoding::Utf8, Eol::Lf, None).unwrap();

        let leftover_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
        assert!(!leftover_tmp, "no .tmp file should remain after a successful write");
    }

    #[test]
    fn write_text_ansi_unmappable_character_does_not_write_lossy() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "original\n").unwrap();

        // U+20AC (EURO SIGN) has no windows-1254 mapping — but codepage 1254 depends on
        // the *live* system ACP here (this exercises the real `fs_write_text` path, not
        // `encode_with_codepage` directly), so only assert the outcome that's true
        // regardless of locale: either it's rejected as `io` (unmappable / unsupported
        // code page) and the file is untouched, or (uninteresting locale where this
        // isn't actually ANSI-unmappable) it succeeds — never a silent lossy write.
        let before = std::fs::read(dir.path().join("a.txt")).unwrap();
        let result = write_text_at(
            dir.path(),
            "a.txt",
            "price: 5\u{20AC}\n",
            TextEncoding::Ansi,
            Eol::Lf,
            None,
        );
        if result.is_err() {
            let after = std::fs::read(dir.path().join("a.txt")).unwrap();
            assert_eq!(after, before, "a failed ANSI encode must not touch the file");
        }
    }

    // ---- fs_exists (Faz 3 review finding #10) ----------------------------------

    #[test]
    fn exists_at_true_for_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"hi").unwrap();
        assert!(exists_at(dir.path(), "a.txt").unwrap());
    }

    #[test]
    fn exists_at_false_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!exists_at(dir.path(), "nope.txt").unwrap());
    }

    #[test]
    fn exists_at_false_for_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(!exists_at(dir.path(), "sub").unwrap());
    }

    #[test]
    fn exists_at_still_errors_on_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let err = exists_at(dir.path(), "../escape").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::OutsideWorkspace);
    }

    // ---- fs_open_default executable deny-list (Faz 3 review finding #7) --------

    #[test]
    fn is_executable_ext_is_case_insensitive() {
        assert!(is_executable_ext("FOO.EXE"));
        assert!(is_executable_ext("foo.exe"));
        assert!(is_executable_ext("dir/a.ps1"));
    }

    #[test]
    fn is_executable_ext_covers_the_full_deny_list() {
        for ext in [
            "exe", "com", "scr", "pif", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe",
            "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "jar", "appref-ms",
            "application",
        ] {
            assert!(is_executable_ext(&format!("a.{ext}")), "{ext} should be denied");
        }
    }

    #[test]
    fn is_executable_ext_allows_plain_files() {
        assert!(!is_executable_ext("a.txt"));
        assert!(!is_executable_ext("noext"));
    }

    #[test]
    fn is_executable_ext_only_checks_the_final_extension() {
        assert!(!is_executable_ext("a.exe.txt"));
    }

    #[test]
    fn stat_hash_matches_textfile_hash_hex() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"some content\n").unwrap();

        let stat = stat_at(dir.path(), "a.txt").unwrap();
        assert_eq!(stat.hash, textfile::hash_hex(b"some content\n"));
        assert_eq!(stat.size, 13);
    }

    #[test]
    fn stat_hash_has_no_size_cutoff_field_and_is_always_some() {
        // §5.4: unlike the old `fs_sniff`-era `FileStat`, there is no size threshold —
        // `hash` is a plain `String`, not an `Option`, so this is really a compile-time
        // guarantee; this test just exercises a small file to document the intent.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"x").unwrap();
        let stat = stat_at(dir.path(), "a.txt").unwrap();
        assert!(!stat.hash.is_empty());
    }

    #[test]
    fn create_unique_tmp_file_avoids_existing_collisions() {
        let dir = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        std::fs::write(dir.path().join(format!(".a.txt.{pid}.0.tmp")), b"stale").unwrap();

        let (candidate, _file) = create_unique_tmp_file(dir.path(), "a.txt").unwrap();
        assert_eq!(
            candidate.file_name().unwrap().to_string_lossy(),
            format!(".a.txt.{pid}.1.tmp")
        );
    }

    /// Review finding #5 regression: `create_unique_tmp_file` must actually create the
    /// file (not just compute a free-looking path) — a second call without writing the
    /// first candidate must not reuse the same `n`, exactly the race the atomic
    /// `create_new` is meant to close.
    #[test]
    fn create_unique_tmp_file_two_calls_never_collide() {
        let dir = tempfile::tempdir().unwrap();
        let (first_path, _first_file) = create_unique_tmp_file(dir.path(), "a.txt").unwrap();
        let (second_path, _second_file) = create_unique_tmp_file(dir.path(), "a.txt").unwrap();
        assert_ne!(first_path, second_path);
    }

    /// Review finding #15: `write_tmp_contents` — the exact helper `write_text_at` calls
    /// right after `create_unique_tmp_file` — must remove the tmp file when the write
    /// fails, rather than leaving a stray/partial `.tmp` file behind. A genuine ENOSPC is
    /// impractical to trigger in a test, so the failure is forced by handing it a
    /// read-only handle to the freshly-created tmp file instead; the cleanup path
    /// exercised is identical to the disk-full case.
    #[test]
    fn write_tmp_contents_removes_tmp_file_on_write_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (tmp_path, tmp_file) = create_unique_tmp_file(dir.path(), "a.txt").unwrap();
        drop(tmp_file);
        let mut readonly = std::fs::File::open(&tmp_path).unwrap();

        let err = write_tmp_contents(&tmp_path, &mut readonly, b"data").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Io);
        assert!(
            !tmp_path.exists(),
            "tmp file must be removed after a failed write"
        );
    }

    #[test]
    fn write_tmp_contents_succeeds_and_leaves_file_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (tmp_path, mut tmp_file) = create_unique_tmp_file(dir.path(), "a.txt").unwrap();

        write_tmp_contents(&tmp_path, &mut tmp_file, b"data").unwrap();
        drop(tmp_file);

        assert_eq!(std::fs::read(&tmp_path).unwrap(), b"data".to_vec());
    }

    // ---- fs_resolve_link (Faz 4 spec §1.3) --------------------------------------

    #[test]
    fn parse_candidate_plain_path_has_no_suffix() {
        assert_eq!(
            parse_candidate("src/foo.ts"),
            ("src/foo.ts".to_string(), None, None)
        );
    }

    #[test]
    fn parse_candidate_line_only() {
        assert_eq!(
            parse_candidate(r".\src\foo.ts:42"),
            (r".\src\foo.ts".to_string(), Some(42), None)
        );
    }

    #[test]
    fn parse_candidate_line_and_column() {
        assert_eq!(
            parse_candidate("src/foo.ts:42:7"),
            ("src/foo.ts".to_string(), Some(42), Some(7))
        );
    }

    #[test]
    fn parse_candidate_msbuild_paren_form() {
        assert_eq!(
            parse_candidate("src/foo.ts(42,7)"),
            ("src/foo.ts".to_string(), Some(42), Some(7))
        );
    }

    #[test]
    fn parse_candidate_windows_absolute_with_line_keeps_drive_colon_intact() {
        assert_eq!(
            parse_candidate(r"C:\dev\proj\src\foo.ts:42"),
            (r"C:\dev\proj\src\foo.ts".to_string(), Some(42), None)
        );
    }

    #[test]
    fn parse_candidate_gitbash_absolute_with_line_and_column() {
        assert_eq!(
            parse_candidate("/c/dev/proj/src/foo.ts:42:7"),
            ("/c/dev/proj/src/foo.ts".to_string(), Some(42), Some(7))
        );
    }

    fn workspace_with_file() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("foo.ts"), b"x").unwrap();
        dir
    }

    #[test]
    fn resolve_link_relative_to_base_rel() {
        let dir = workspace_with_file();
        let link = resolve_link_at(dir.path(), "src", "foo.ts:42").unwrap();
        assert_eq!(link.rel, "src/foo.ts");
        assert_eq!(link.line, Some(42));
        assert_eq!(link.column, None);
    }

    #[test]
    fn resolve_link_relative_to_root_when_not_under_base_rel() {
        let dir = workspace_with_file();
        // baseRel is some unrelated folder; the candidate is only valid relative to the
        // workspace root.
        std::fs::create_dir(dir.path().join("other")).unwrap();
        let link = resolve_link_at(dir.path(), "other", "src/foo.ts").unwrap();
        assert_eq!(link.rel, "src/foo.ts");
    }

    #[test]
    fn resolve_link_dot_slash_prefix() {
        let dir = workspace_with_file();
        let link = resolve_link_at(dir.path(), "", r".\src\foo.ts:42:7").unwrap();
        assert_eq!(link.rel, "src/foo.ts");
        assert_eq!(link.line, Some(42));
        assert_eq!(link.column, Some(7));
    }

    #[test]
    fn resolve_link_absolute_inside_workspace() {
        let dir = workspace_with_file();
        let abs = dir.path().join("src").join("foo.ts");
        let candidate = format!("{}:42", abs.to_string_lossy());
        let link = resolve_link_at(dir.path(), "", &candidate).unwrap();
        assert_eq!(link.rel, "src/foo.ts");
        assert_eq!(link.line, Some(42));
    }

    #[test]
    fn resolve_link_absolute_outside_workspace_is_null() {
        let dir = workspace_with_file();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), b"x").unwrap();
        let candidate = outside.path().join("secret.txt").to_string_lossy().into_owned();
        assert!(resolve_link_at(dir.path(), "", &candidate).is_none());
    }

    #[test]
    fn resolve_link_gitbash_absolute_path() {
        let dir = workspace_with_file();
        let abs = dir.path().join("src").join("foo.ts");
        // Emulate Git Bash's `/c/...` view of the same absolute Windows path.
        let abs_str = abs.to_string_lossy().replace('\\', "/");
        let mut chars = abs_str.chars();
        let drive = chars.next().unwrap().to_ascii_lowercase();
        let rest: String = chars.as_str().trim_start_matches(':').to_string();
        let gitbash_style = format!("/{drive}{rest}");

        let link = resolve_link_at(dir.path(), "", &gitbash_style).unwrap();
        assert_eq!(link.rel, "src/foo.ts");
    }

    #[test]
    fn resolve_link_directory_candidate_is_null() {
        let dir = workspace_with_file();
        assert!(resolve_link_at(dir.path(), "", "src").is_none());
    }

    #[test]
    fn resolve_link_missing_file_is_null() {
        let dir = workspace_with_file();
        assert!(resolve_link_at(dir.path(), "", "src/missing.ts").is_none());
    }

    #[test]
    fn resolve_link_paren_format_end_to_end() {
        let dir = workspace_with_file();
        let link = resolve_link_at(dir.path(), "", "src/foo.ts(42,7)").unwrap();
        assert_eq!(link.rel, "src/foo.ts");
        assert_eq!(link.line, Some(42));
        assert_eq!(link.column, Some(7));
    }
}
