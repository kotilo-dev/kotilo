//! M4 changed files: the workspace's working-copy changes against `HEAD`, read through
//! the git CLI (no libgit2). Read-only: every call runs with `GIT_OPTIONAL_LOCKS=0`
//! (no index refresh writes), fsmonitor off, a 5 s timeout and no console window.
//!
//! Paths are `/`-separated and relative to the workspace root (equal to repo-relative
//! when the workspace is the repo root); changes outside a subfolder workspace are left
//! out. "No git", "not a repo" and "no commit yet" are normal results, never errors.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const GIT_TIMEOUT: Duration = Duration::from_secs(5);
/// Untracked files above this size get `added: null` (not read).
const LINE_COUNT_MAX_BYTES: u64 = 1024 * 1024;
/// At most this many untracked files are read for a line count per call.
const LINE_COUNT_MAX_FILES: usize = 500;
/// Entries beyond this are dropped and `truncated` is set.
const MAX_ENTRIES: usize = 5_000;
/// `git_show_head` refuses blobs above this size (`tooLarge`).
pub const SHOW_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitError {
    /// `git` is not on PATH.
    NotInstalled,
    Timeout,
    Io(String),
}

/// Runs `git <args>` in `cwd` and returns stdout when it exits with 0, `Ok(None)` when it
/// exits non-zero (not a repo, unknown revision, ...).
pub fn run_git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<Option<Vec<u8>>, GitError> {
    let mut cmd = Command::new("git");
    cmd.args(["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "diff.relative=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::platform::hide_console_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Io(e.to_string()),
    })?;
    // Read stdout on a helper thread so a full pipe never blocks the child.
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitError::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(GitError::Io(e.to_string())),
        }
    };
    let remaining = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(200));
    let stdout = rx.recv_timeout(remaining).map_err(|_| GitError::Timeout)?;
    Ok(status.success().then_some(stdout))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileStatus {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "?")]
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: FileStatus,
    /// `null` for binary files (and untracked files that are binary, ≥ 1 MB or unread).
    pub added: Option<u64>,
    pub removed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    pub repo: bool,
    /// Full commit id of `HEAD`; `null` before the first commit.
    pub head: Option<String>,
    pub files: Vec<ChangedFile>,
    /// More than [`MAX_ENTRIES`] changes; the rest are left out.
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadContent {
    /// Text normalized like `fs_read_text` (decoded, LF line ends); `null` when the file
    /// is not in `HEAD`, is binary or too large, or there is no repo.
    pub content: Option<String>,
    pub binary: bool,
    pub too_large: bool,
}

/// One `--numstat -z` record: counts (`None` = binary), path, and the old path of a rename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub path: String,
    pub old_path: Option<String>,
}

fn field(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Parses `git diff --numstat -z`: `A\tR\tpath\0`, or `A\tR\t\0old\0new\0` for a rename;
/// binary files have `-` counts.
pub fn parse_numstat_z(out: &[u8]) -> Vec<NumstatEntry> {
    let mut tokens = out.split(|b| *b == 0);
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        let mut parts = token.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let count = |s: &[u8]| std::str::from_utf8(s).ok().and_then(|s| s.parse::<u64>().ok());
        let (added, removed) = (count(a), count(r));
        if path.is_empty() {
            let (Some(old), Some(new)) = (tokens.next(), tokens.next()) else { break };
            entries.push(NumstatEntry { added, removed, path: field(new), old_path: Some(field(old)) });
        } else {
            entries.push(NumstatEntry { added, removed, path: field(path), old_path: None });
        }
    }
    entries
}

/// One `git status --porcelain=v2 -z` entry, already mapped to a change against `HEAD`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub status: FileStatus,
    pub old_path: Option<String>,
}

/// Maps the `XY` field (index, worktree) of an ordinary entry to the change against HEAD.
fn ordinary_status(xy: &[u8]) -> Option<FileStatus> {
    let (x, y) = (xy.first().copied()?, xy.get(1).copied()?);
    match (x, y) {
        // Added to the index, then deleted from the working tree: nothing against HEAD.
        (b'A', b'D') => None,
        (b'A', _) => Some(FileStatus::Added),
        (b'D', _) | (_, b'D') => Some(FileStatus::Deleted),
        _ => Some(FileStatus::Modified),
    }
}

/// Parses `git status --porcelain=v2 -z` (ordinary `1`, rename/copy `2`, unmerged `u`,
/// untracked `?`; headers and ignored entries are skipped).
pub fn parse_status_v2_z(out: &[u8]) -> Vec<StatusEntry> {
    let mut tokens = out.split(|b| *b == 0);
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        match token.first() {
            Some(b'1') => {
                let parts: Vec<&[u8]> = token.splitn(9, |b| *b == b' ').collect();
                if let (Some(xy), Some(path)) = (parts.get(1), parts.get(8)) {
                    if let Some(status) = ordinary_status(xy) {
                        entries.push(StatusEntry { path: field(path), status, old_path: None });
                    }
                }
            }
            Some(b'2') => {
                let parts: Vec<&[u8]> = token.splitn(10, |b| *b == b' ').collect();
                let orig = tokens.next();
                if let (Some(xy), Some(path), Some(orig)) = (parts.get(1), parts.get(9), orig) {
                    if xy.get(1) == Some(&b'D') {
                        // Renamed in the index, then deleted: against HEAD the old file is gone.
                        entries.push(StatusEntry { path: field(orig), status: FileStatus::Deleted, old_path: None });
                    } else if xy.first() == Some(&b'C') {
                        entries.push(StatusEntry { path: field(path), status: FileStatus::Added, old_path: None });
                    } else {
                        entries.push(StatusEntry { path: field(path), status: FileStatus::Renamed, old_path: Some(field(orig)) });
                    }
                }
            }
            Some(b'u') => {
                let parts: Vec<&[u8]> = token.splitn(11, |b| *b == b' ').collect();
                if let Some(path) = parts.get(10) {
                    entries.push(StatusEntry { path: field(path), status: FileStatus::Modified, old_path: None });
                }
            }
            Some(b'?') if token.len() > 2 => {
                entries.push(StatusEntry { path: field(&token[2..]), status: FileStatus::Untracked, old_path: None });
            }
            _ => {}
        }
    }
    entries
}

/// Repo path → workspace-relative path; `None` when it lies outside the workspace or
/// does not pass the workspace path rules (`..`, absolute, drive letters).
fn under_prefix(path: &str, prefix: &str) -> Option<String> {
    let rel = path.strip_prefix(prefix)?;
    validate_rel(rel).ok()?;
    Some(rel.to_string())
}

/// The `rel` rules of `fsguard` (no empty, `.`, `..`, absolute or backslash/drive parts).
pub fn validate_rel(rel: &str) -> AppResult<()> {
    if rel.is_empty() {
        return Err(AppError::outside_workspace("path must not be empty"));
    }
    crate::fsguard::join_rel(Path::new(""), rel).map(|_| ())
}

/// Line count as git's numstat would report it for a new text file; `None` for binary,
/// large or unreadable files.
fn count_lines(file: &Path) -> Option<u64> {
    let meta = std::fs::metadata(file).ok()?;
    if !meta.is_file() || meta.len() >= LINE_COUNT_MAX_BYTES {
        return None;
    }
    let bytes = std::fs::read(file).ok()?;
    if crate::textfile::is_binary(&bytes) {
        return None;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    let unterminated = u64::from(!bytes.is_empty() && bytes.last() != Some(&b'\n'));
    Some(newlines + unterminated)
}

fn git_ok(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    match run_git(root, args, GIT_TIMEOUT) {
        Ok(out) => out,
        Err(e) => {
            log::info!("git {}: {e:?}", args.first().copied().unwrap_or_default());
            None
        }
    }
}

/// `git_changes` core (blocking).
pub fn changes_at(root: &Path) -> GitChanges {
    // Not a repo / no git → repo:false. The prefix is the workspace's place in the repo.
    let Some(prefix) = git_ok(root, &["rev-parse", "--show-prefix"]) else {
        return GitChanges::default();
    };
    let prefix = field(&prefix).trim_end_matches(['\r', '\n']).to_string();
    let head = git_ok(root, &["rev-parse", "-q", "--verify", "HEAD^{commit}"])
        .map(|out| field(&out).trim().to_string())
        .filter(|s| !s.is_empty());
    let numstat = match &head {
        Some(_) => git_ok(root, &["diff", "--no-ext-diff", "--numstat", "-z", "-M", "HEAD"])
            .map(|out| parse_numstat_z(&out))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let status = git_ok(root, &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"])
        .map(|out| parse_status_v2_z(&out))
        .unwrap_or_default();

    let mut files = Vec::new();
    let mut counted = 0usize;
    let mut truncated = false;
    for entry in status {
        let Some(path) = under_prefix(&entry.path, &prefix) else { continue };
        if files.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let stat = numstat.iter().find(|n| n.path == entry.path);
        let (added, removed) = match (stat, entry.status) {
            (Some(n), _) => (n.added, n.removed),
            // No numstat for untracked files (and anything staged before the first commit).
            (None, FileStatus::Untracked | FileStatus::Added) if counted < LINE_COUNT_MAX_FILES => {
                counted += 1;
                (count_lines(&root.join(&path)), Some(0))
            }
            _ => (None, None),
        };
        let removed = if added.is_none() && stat.is_none() { None } else { removed };
        let old_path = entry.old_path.as_deref().and_then(|p| under_prefix(p, &prefix));
        files.push(ChangedFile { path, status: entry.status, added, removed, old_path });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    GitChanges { repo: true, head, files, truncated }
}

/// `git_show_head` core (blocking). `rel` must already be validated with [`validate_rel`].
pub fn show_head_at(root: &Path, rel: &str) -> HeadContent {
    let spec = format!("HEAD:./{rel}");
    let Some(size) = git_ok(root, &["cat-file", "-s", &spec]) else {
        return HeadContent::default();
    };
    let size: u64 = field(&size).trim().parse().unwrap_or(u64::MAX);
    if size > SHOW_MAX_BYTES {
        return HeadContent { content: None, binary: false, too_large: true };
    }
    let Some(bytes) = git_ok(root, &["cat-file", "blob", &spec]) else {
        return HeadContent::default();
    };
    if crate::textfile::is_binary(&bytes) {
        return HeadContent { content: None, binary: true, too_large: false };
    }
    HeadContent { content: Some(crate::textfile::decode(&bytes).text), binary: false, too_large: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn numstat_parses_plain_binary_and_renamed_records() {
        let out = b"3\t1\tsrc/a b.rs\0-\t-\timg.png\x000\t0\t\0old name.txt\0new name.txt\0";
        let entries = parse_numstat_z(out);
        assert_eq!(
            entries,
            vec![
                NumstatEntry { added: Some(3), removed: Some(1), path: "src/a b.rs".into(), old_path: None },
                NumstatEntry { added: None, removed: None, path: "img.png".into(), old_path: None },
                NumstatEntry { added: Some(0), removed: Some(0), path: "new name.txt".into(), old_path: Some("old name.txt".into()) },
            ]
        );
    }

    #[test]
    fn status_v2_maps_entries_against_head() {
        let mut out = Vec::new();
        out.extend_from_slice(b"1 .M N... 100644 100644 100644 aaa aaa m.txt\0");
        out.extend_from_slice(b"1 A. N... 000000 100644 100644 000 bbb new file.txt\0");
        out.extend_from_slice(b"1 AD N... 000000 100644 000000 000 bbb gone.txt\0");
        out.extend_from_slice(b"1 .D N... 100644 100644 000000 ccc ccc d.txt\0");
        out.extend_from_slice(b"2 R. N... 100644 100644 100644 ddd ddd R100 r new.txt\0r old.txt\0");
        out.extend_from_slice(b"u UU N... 100644 100644 100644 100644 e f g conflict.txt\0");
        out.extend_from_slice("? ünï.txt\0".as_bytes());
        out.extend_from_slice(b"! ignored.log\0");
        let entries = parse_status_v2_z(&out);
        let got: Vec<(&str, FileStatus, Option<&str>)> =
            entries.iter().map(|e| (e.path.as_str(), e.status, e.old_path.as_deref())).collect();
        assert_eq!(
            got,
            vec![
                ("m.txt", FileStatus::Modified, None),
                ("new file.txt", FileStatus::Added, None),
                ("d.txt", FileStatus::Deleted, None),
                ("r new.txt", FileStatus::Renamed, Some("r old.txt")),
                ("conflict.txt", FileStatus::Modified, None),
                ("ünï.txt", FileStatus::Untracked, None),
            ]
        );
    }

    #[test]
    fn rel_paths_must_stay_inside_the_workspace() {
        for bad in ["", "../x", "a/../../x", "/etc/passwd", "C:/Windows/win.ini", "a\\b", "./a", "a//b"] {
            assert!(validate_rel(bad).is_err(), "{bad} must be rejected");
        }
        assert!(validate_rel("src/ok file.rs").is_ok());
        assert_eq!(under_prefix("pkg/app/x.rs", "pkg/app/"), Some("x.rs".into()));
        assert_eq!(under_prefix("other/x.rs", "pkg/app/"), None);
    }

    #[test]
    fn changed_file_serializes_to_the_contract() {
        let json = serde_json::to_value(GitChanges {
            repo: true,
            head: Some("abc".into()),
            files: vec![
                ChangedFile { path: "a.txt".into(), status: FileStatus::Untracked, added: Some(2), removed: Some(0), old_path: None },
                ChangedFile { path: "b.txt".into(), status: FileStatus::Renamed, added: None, removed: None, old_path: Some("c.txt".into()) },
            ],
            truncated: false,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"repo": true, "head": "abc", "truncated": false, "files": [
                {"path": "a.txt", "status": "?", "added": 2, "removed": 0},
                {"path": "b.txt", "status": "R", "added": null, "removed": null, "oldPath": "c.txt"}
            ]})
        );
    }

    // --- against a real repository made with the git CLI (skipped when git is missing) ---

    fn git(dir: &Path, args: &[&str]) {
        let out = run_git(dir, args, Duration::from_secs(30)).expect("git runs");
        assert!(out.is_some(), "git {args:?} failed");
    }

    fn temp_repo() -> Option<(tempfile::TempDir, PathBuf)> {
        if run_git(Path::new("."), &["--version"], Duration::from_secs(10)) == Err(GitError::NotInstalled) {
            eprintln!("git not on PATH; skipping");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        Some((dir, root))
    }

    fn write(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn find<'a>(c: &'a GitChanges, path: &str) -> &'a ChangedFile {
        c.files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} missing in {:?}", c.files))
    }

    #[test]
    fn not_a_repo_is_repo_false() {
        if temp_repo().is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        // A temp dir could sit inside a repo on a dev machine; only check when it doesn't.
        if run_git(dir.path(), &["rev-parse", "--show-prefix"], GIT_TIMEOUT) == Ok(None) {
            assert_eq!(changes_at(dir.path()), GitChanges::default());
            assert_eq!(show_head_at(dir.path(), "a.txt"), HeadContent::default());
        }
    }

    #[test]
    fn fresh_repo_has_no_head_but_lists_new_files() {
        let Some((_dir, root)) = temp_repo() else { return };
        write(&root, "a.txt", b"one\ntwo");
        let c = changes_at(&root);
        assert!(c.repo);
        assert_eq!(c.head, None);
        assert_eq!(find(&c, "a.txt"), &ChangedFile { path: "a.txt".into(), status: FileStatus::Untracked, added: Some(2), removed: Some(0), old_path: None });
        assert_eq!(show_head_at(&root, "a.txt"), HeadContent::default());
    }

    #[test]
    fn lists_every_kind_of_change_against_head() {
        let Some((_dir, root)) = temp_repo() else { return };
        write(&root, "mod.txt", b"a\nb\nc\n");
        write(&root, "del.txt", b"x\ny\n");
        write(&root, "old name.txt", b"same content\nline 2\nline 3\n");
        write(&root, "bin.dat", &[0, 1, 2, 3]);
        write(&root, "dir/ünïcødé ş.txt", b"1\r\n2\r\n");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);

        write(&root, "mod.txt", b"a\nB\nc\nd\n");
        std::fs::remove_file(root.join("del.txt")).unwrap();
        git(&root, &["mv", "old name.txt", "new name.txt"]);
        write(&root, "bin.dat", &[0, 9, 9, 9, 9]);
        write(&root, "staged.txt", b"s\n");
        git(&root, &["add", "staged.txt"]);
        write(&root, "untracked dir/ünï new.txt", b"1\n2\n3\n");
        write(&root, "untracked.bin", &[0, 0, 7]);
        write(&root, "dir/ünïcødé ş.txt", b"1\r\n2\r\n3\r\n");

        let c = changes_at(&root);
        assert!(c.repo);
        assert_eq!(c.head.as_ref().map(String::len), Some(40));
        let m = find(&c, "mod.txt");
        assert_eq!((m.status, m.added, m.removed), (FileStatus::Modified, Some(2), Some(1)));
        let d = find(&c, "del.txt");
        assert_eq!((d.status, d.added, d.removed), (FileStatus::Deleted, Some(0), Some(2)));
        let r = find(&c, "new name.txt");
        assert_eq!((r.status, r.old_path.as_deref(), r.added, r.removed), (FileStatus::Renamed, Some("old name.txt"), Some(0), Some(0)));
        let b = find(&c, "bin.dat");
        assert_eq!((b.status, b.added, b.removed), (FileStatus::Modified, None, None));
        let a = find(&c, "staged.txt");
        assert_eq!((a.status, a.added, a.removed), (FileStatus::Added, Some(1), Some(0)));
        let u = find(&c, "untracked dir/ünï new.txt");
        assert_eq!((u.status, u.added, u.removed), (FileStatus::Untracked, Some(3), Some(0)));
        let ub = find(&c, "untracked.bin");
        assert_eq!((ub.status, ub.added, ub.removed), (FileStatus::Untracked, None, None));
        let uni = find(&c, "dir/ünïcødé ş.txt");
        assert_eq!((uni.status, uni.added, uni.removed), (FileStatus::Modified, Some(1), Some(0)));
        assert_eq!(c.files.len(), 8, "{:?}", c.files);

        // HEAD content: text normalized to LF, binary flagged, missing files null.
        assert_eq!(show_head_at(&root, "mod.txt").content.as_deref(), Some("a\nb\nc\n"));
        assert_eq!(show_head_at(&root, "dir/ünïcødé ş.txt").content.as_deref(), Some("1\n2\n"));
        assert_eq!(show_head_at(&root, "old name.txt").content.as_deref(), Some("same content\nline 2\nline 3\n"));
        assert_eq!(show_head_at(&root, "bin.dat"), HeadContent { content: None, binary: true, too_large: false });
        assert_eq!(show_head_at(&root, "staged.txt"), HeadContent::default());
        assert_eq!(show_head_at(&root, "dir"), HeadContent::default(), "a tree is not a file");
    }

    #[test]
    fn subfolder_workspace_sees_only_its_own_changes() {
        let Some((_dir, root)) = temp_repo() else { return };
        write(&root, "pkg/app/a.txt", b"a\n");
        write(&root, "other.txt", b"o\n");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        write(&root, "pkg/app/a.txt", b"a\nb\n");
        write(&root, "other.txt", b"o\np\n");
        let ws = root.join("pkg").join("app");
        let c = changes_at(&ws);
        assert_eq!(c.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a.txt"]);
        assert_eq!(show_head_at(&ws, "a.txt").content.as_deref(), Some("a\n"));
    }

    #[test]
    fn large_head_blobs_are_refused() {
        let Some((_dir, root)) = temp_repo() else { return };
        write(&root, "big.txt", &vec![b'x'; (SHOW_MAX_BYTES + 1) as usize]);
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "big"]);
        assert_eq!(show_head_at(&root, "big.txt"), HeadContent { content: None, binary: false, too_large: true });
    }
}
