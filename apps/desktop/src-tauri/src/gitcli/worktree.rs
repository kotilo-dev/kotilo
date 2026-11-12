//! 0.6 worktrees for parallel agents: Kotilo-managed git worktrees under
//! `<workspace root>/.kotilo/worktrees/<name>` on branch `<branchPrefix><name>`, plus
//! list/compare/merge/remove through the git CLI.
//!
//! Reads go through [`run_git`] (5 s, no optional locks); writes through
//! [`run_git_write`] (120 s, stderr kept for `detail`). Only supported when the workspace
//! root is the repo's top level and `HEAD` has a commit. The user's `.gitignore` is never
//! touched: `.kotilo/*` goes into the repo's `info/exclude`, except `.kotilo/docs.toml`
//! (0.7 Docs config, committed with the repo).

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{
    count_lines, field, parse_numstat_z, parse_status_v2_z, run_git, run_git_write, ChangedFile, FileStatus,
    GitError, GitOutput, GIT_TIMEOUT, GIT_WRITE_TIMEOUT, LINE_COUNT_MAX_FILES, MAX_ENTRIES,
};
use crate::error::{AppError, AppResult};

/// Workspace-relative folder that holds the managed worktrees.
pub const WORKTREES_REL: &str = ".kotilo/worktrees";
/// The lines Kotilo writes to `info/exclude` under its comment line: everything in `.kotilo/`
/// is hidden from git except the committed Docs config (0.7).
const EXCLUDE_LINES: [&str; 2] = [".kotilo/*", "!.kotilo/docs.toml"];
/// The single line 0.6 wrote; migrated in place.
const EXCLUDE_LINE_V06: &str = ".kotilo/";
const SLUG_MAX_CHARS: usize = 40;
const DETAIL_MAX_CHARS: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeUnsupported {
    NoGit,
    NotRepo,
    NotRepoRoot,
    NoCommit,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub rel: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub base: Option<String>,
    pub managed: bool,
    pub locked: bool,
    pub prunable: bool,
    pub dirty: u64,
    pub ahead: u64,
    pub behind: u64,
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeList {
    pub supported: bool,
    pub reason: Option<WorktreeUnsupported>,
    pub current_branch: Option<String>,
    pub main_dirty: bool,
    pub worktrees: Vec<WorktreeInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChanges {
    pub base: Option<String>,
    pub files: Vec<ChangedFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeStatus {
    Merged,
    UpToDate,
    Conflict,
    MainDirty,
    WorktreeDirty,
    NotOnBase,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub status: MergeStatus,
    pub conflicts: Vec<String>,
    pub detail: Option<String>,
}

impl MergeResult {
    fn status(status: MergeStatus) -> Self {
        Self { status, conflicts: Vec::new(), detail: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoveStatus {
    Removed,
    Dirty,
    Unmerged,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub status: RemoveStatus,
    pub branch_deleted: bool,
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------------
// Pure parts: porcelain parser, slug
// ---------------------------------------------------------------------------------

/// One `git worktree list --porcelain` record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PorcelainWorktree {
    pub path: String,
    pub head: Option<String>,
    /// Short branch name (`refs/heads/` stripped); `None` when detached.
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Parses `git worktree list --porcelain`: records separated by a blank line, each
/// starting with `worktree <path>`; unknown lines are ignored.
pub fn parse_worktree_porcelain(out: &str) -> Vec<PorcelainWorktree> {
    let mut records = Vec::new();
    let mut current: Option<PorcelainWorktree> = None;
    for line in out.lines().map(|l| l.trim_end_matches('\r')) {
        if let Some(path) = line.strip_prefix("worktree ") {
            records.extend(current.take());
            current = Some(PorcelainWorktree { path: path.to_string(), ..Default::default() });
            continue;
        }
        let Some(rec) = current.as_mut() else { continue };
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "" => records.extend(current.take()),
            "HEAD" => rec.head = Some(value.to_string()).filter(|v| !v.is_empty()),
            "branch" => rec.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string()),
            "detached" => rec.branch = None,
            "bare" => rec.bare = true,
            "locked" => rec.locked = true,
            "prunable" => rec.prunable = true,
            _ => {}
        }
    }
    records.extend(current);
    records
}

/// Worktree name → folder slug: lowercase `[a-z0-9-]`, every other run → `-`, trimmed,
/// at most 40 chars; `invalid_name` when nothing is left.
pub fn slugify(name: &str) -> AppResult<String> {
    let mut slug = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(SLUG_MAX_CHARS).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() {
        return Err(AppError::invalid_name(format!("not a usable worktree name: {name}")));
    }
    Ok(slug)
}

/// The last `DETAIL_MAX_CHARS` characters of a command's stderr (stdout when stderr is
/// empty, e.g. merge conflicts), or `None` when both are empty.
fn detail(out: &GitOutput) -> Option<String> {
    let text = if out.stderr.iter().all(u8::is_ascii_whitespace) { &out.stdout } else { &out.stderr };
    let text = field(text).trim().to_string();
    if text.is_empty() {
        return None;
    }
    let count = text.chars().count();
    Some(text.chars().skip(count.saturating_sub(DETAIL_MAX_CHARS)).collect())
}

// ---------------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------------

/// A read command; `Ok(None)` when git exits non-zero.
fn read(cwd: &Path, args: &[&str]) -> AppResult<Option<Vec<u8>>> {
    run_git(cwd, args, GIT_TIMEOUT).map_err(git_error)
}

/// A read command's trimmed first output line; `None` when it fails or prints nothing.
fn read_line(cwd: &Path, args: &[&str]) -> AppResult<Option<String>> {
    Ok(read(cwd, args)?
        .map(|out| field(&out).lines().next().unwrap_or_default().trim().to_string())
        .filter(|s| !s.is_empty()))
}

fn write(cwd: &Path, args: &[&str]) -> AppResult<GitOutput> {
    run_git_write(cwd, args, GIT_WRITE_TIMEOUT).map_err(git_error)
}

fn git_error(e: GitError) -> AppError {
    match e {
        GitError::NotInstalled => AppError::io("git is not installed"),
        GitError::Timeout => AppError::io("git timed out"),
        GitError::Io(e) => AppError::io(format!("git: {e}")),
    }
}

fn current_branch(cwd: &Path) -> AppResult<Option<String>> {
    read_line(cwd, &["symbolic-ref", "-q", "--short", "HEAD"])
}

fn ref_exists(cwd: &Path, refname: &str) -> AppResult<bool> {
    Ok(read(cwd, &["rev-parse", "-q", "--verify", refname])?.is_some())
}

fn is_ancestor(cwd: &Path, ancestor: &str, of: &str) -> AppResult<bool> {
    Ok(read(cwd, &["merge-base", "--is-ancestor", ancestor, of])?.is_some())
}

/// Tracked changes + untracked files in a checkout.
fn dirty_count(cwd: &Path) -> AppResult<u64> {
    Ok(read(cwd, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?
        .map(|out| parse_status_v2_z(&out).len() as u64)
        .unwrap_or(0))
}

fn main_dirty(root: &Path) -> AppResult<bool> {
    Ok(read(root, &["status", "--porcelain", "--untracked-files=no"])?.is_some_and(|out| !out.is_empty()))
}

/// Why the workspace can't use worktrees, or `None` when it can.
fn unsupported_reason(root: &Path) -> AppResult<Option<WorktreeUnsupported>> {
    let prefix = match run_git(root, &["rev-parse", "--show-prefix"], GIT_TIMEOUT) {
        Err(GitError::NotInstalled) => return Ok(Some(WorktreeUnsupported::NoGit)),
        Err(e) => return Err(git_error(e)),
        Ok(None) => return Ok(Some(WorktreeUnsupported::NotRepo)),
        Ok(Some(out)) => field(&out).trim().to_string(),
    };
    if !prefix.is_empty() {
        return Ok(Some(WorktreeUnsupported::NotRepoRoot));
    }
    if !ref_exists(root, "HEAD^{commit}")? {
        return Ok(Some(WorktreeUnsupported::NoCommit));
    }
    Ok(None)
}

fn require_supported(root: &Path) -> AppResult<()> {
    match unsupported_reason(root)? {
        None => Ok(()),
        Some(reason) => Err(AppError::invalid_argument(format!("worktrees are not supported here ({reason:?})"))),
    }
}

/// A path git printed → workspace-relative, `/`-separated; also tried on canonical paths
/// (macOS `/var` → `/private/var`, Windows 8.3 names).
fn rel_in_root(root: &Path, path: &str) -> Option<String> {
    let path = Path::new(path);
    if let Some(rel) = crate::fsguard::rel_under_ci(root, path) {
        return Some(rel);
    }
    let canon_root = dunce::canonicalize(root).ok()?;
    let canon_path = canonicalize_existing_prefix(path)?;
    crate::fsguard::rel_under_ci(&canon_root, &canon_path)
}

/// Canonicalizes the deepest existing ancestor and re-appends the rest, so a worktree whose
/// folder was deleted (prunable) still maps through `/private/var` or 8.3 names.
fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    let mut tail = Vec::new();
    let mut current = path;
    loop {
        if let Ok(canon) = dunce::canonicalize(current) {
            return Some(tail.iter().rev().fold(canon, |p, s| p.join(s)));
        }
        tail.push(current.file_name()?);
        current = current.parent()?;
    }
}

fn is_managed_rel(rel: &str) -> bool {
    rel.strip_prefix(WORKTREES_REL)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|name| !name.is_empty() && !name.contains('/'))
}

fn rel_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s))
}

/// The `kotiloBase` a worktree branch was created with, else the main checkout's branch.
fn base_of(root: &Path, branch: Option<&str>, fallback: Option<&str>) -> AppResult<Option<String>> {
    if let Some(branch) = branch {
        let key = format!("branch.{branch}.kotiloBase");
        if let Some(base) = read_line(root, &["config", "--get", &key])? {
            return Ok(Some(base));
        }
    }
    Ok(fallback.map(str::to_string))
}

/// The worktrees git knows about that lie inside the workspace (main checkout and bare
/// entries left out), without stats.
fn listed(root: &Path) -> AppResult<Vec<(String, PorcelainWorktree)>> {
    let out = read(root, &["worktree", "list", "--porcelain"])?.unwrap_or_default();
    let mut records = parse_worktree_porcelain(&field(&out));
    if !records.is_empty() {
        records.remove(0);
    }
    Ok(records
        .into_iter()
        .filter(|r| !r.bare)
        .filter_map(|r| rel_in_root(root, &r.path).filter(|rel| !rel.is_empty()).map(|rel| (rel, r)))
        .collect())
}

/// One worktree with its stats against `base`.
fn info_for(root: &Path, rel: String, rec: &PorcelainWorktree, current: Option<&str>) -> AppResult<WorktreeInfo> {
    let name = rel.rsplit('/').next().unwrap_or_default().to_string();
    let base = base_of(root, rec.branch.as_deref(), current)?;
    let mut info = WorktreeInfo {
        name,
        managed: is_managed_rel(&rel),
        rel,
        branch: rec.branch.clone(),
        head: rec.head.clone(),
        base,
        locked: rec.locked,
        prunable: rec.prunable,
        ..Default::default()
    };
    let dir = rel_path(root, &info.rel);
    if info.prunable || !dir.is_dir() {
        info.prunable = true;
        return Ok(info);
    }
    info.dirty = dirty_count(&dir)?;
    let Some(base) = info.base.clone() else { return Ok(info) };
    let range = format!("{base}...HEAD");
    if let Some(out) = read(&dir, &["rev-list", "--left-right", "--count", &range])? {
        let text = field(&out);
        let mut counts = text.split_whitespace().map(|n| n.parse::<u64>().unwrap_or(0));
        info.behind = counts.next().unwrap_or(0);
        info.ahead = counts.next().unwrap_or(0);
    }
    if let Some(mb) = read_line(&dir, &["merge-base", &base, "HEAD"])? {
        let numstat = read(&dir, &["diff", "--no-ext-diff", "--numstat", "-z", &mb])?.unwrap_or_default();
        for entry in parse_numstat_z(&numstat) {
            info.added += entry.added.unwrap_or(0);
            info.removed += entry.removed.unwrap_or(0);
        }
    }
    Ok(info)
}

/// Finds a listed worktree by folder name (managed ones first) or by `rel`.
fn find(root: &Path, name: &str) -> AppResult<(String, PorcelainWorktree)> {
    let mut all = listed(root)?;
    all.sort_by_key(|(rel, _)| !is_managed_rel(rel));
    all.into_iter()
        .find(|(rel, _)| rel == name || rel.rsplit('/').next() == Some(name))
        .ok_or_else(|| AppError::not_found(format!("no worktree named {name}")))
}

fn find_managed(root: &Path, name: &str) -> AppResult<(String, PorcelainWorktree)> {
    let found = find(root, name)?;
    if !is_managed_rel(&found.0) {
        return Err(AppError::invalid_name(format!("{name} is not a Kotilo worktree")));
    }
    Ok(found)
}

// ---------------------------------------------------------------------------------
// Commands (blocking cores)
// ---------------------------------------------------------------------------------

/// `worktree_list` core.
pub fn list_at(root: &Path) -> AppResult<WorktreeList> {
    if let Some(reason) = unsupported_reason(root)? {
        return Ok(WorktreeList { reason: Some(reason), ..Default::default() });
    }
    let current = current_branch(root)?;
    let mut worktrees = Vec::new();
    for (rel, rec) in listed(root)? {
        worktrees.push(info_for(root, rel, &rec, current.as_deref())?);
    }
    worktrees.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.rel.cmp(&b.rel)));
    Ok(WorktreeList {
        supported: true,
        reason: None,
        main_dirty: main_dirty(root)?,
        current_branch: current,
        worktrees,
    })
}

/// Writes Kotilo's block to the repo's `info/exclude`: migrates a 0.6 block (our comment line
/// followed by `.kotilo/`) in place, leaves a `.kotilo` line the user wrote alone, else appends.
pub fn ensure_exclude(root: &Path) -> AppResult<()> {
    let Some(path) = read_line(root, &["rev-parse", "--git-path", "info/exclude"])? else {
        return Err(AppError::io("could not resolve info/exclude"));
    };
    let path = Path::new(&path);
    let path = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let existing = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let Some(text) = exclude_update(&existing, crate::brand::NAME) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, text)?;
    Ok(())
}

/// The new `info/exclude` text, or `None` when nothing needs to change.
fn exclude_update(existing: &str, brand_name: &str) -> Option<String> {
    let comment = format!("# {brand_name} worktrees and attachments");
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    if let Some(i) = lines.iter().position(|l| l.trim() == comment) {
        let next = lines.get(i + 1).map(|l| l.trim().to_string());
        if next.as_deref() == Some(EXCLUDE_LINE_V06) || next.as_deref() == Some(EXCLUDE_LINES[0]) {
            let negation_present = lines.get(i + 2).is_some_and(|l| l.trim() == EXCLUDE_LINES[1]);
            if next.as_deref() == Some(EXCLUDE_LINES[0]) && negation_present {
                return None;
            }
            lines[i + 1] = EXCLUDE_LINES[0].to_string();
            if !negation_present {
                lines.insert(i + 2, EXCLUDE_LINES[1].to_string());
            }
            let mut text = lines.join("\n");
            text.push('\n');
            return Some(text);
        }
    }
    let user_line = existing.lines().map(str::trim).any(|l| {
        matches!(l, ".kotilo" | ".kotilo/" | "/.kotilo" | "/.kotilo/" | ".kotilo/*" | "/.kotilo/*")
    });
    if user_line {
        return None;
    }
    let mut text = existing.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("{comment}\n{}\n{}\n", EXCLUDE_LINES[0], EXCLUDE_LINES[1]));
    Some(text)
}

/// `worktree_create` core: folder + branch from the main checkout's `HEAD`, base recorded
/// as `branch.<branch>.kotiloBase`.
pub fn create_at(root: &Path, name: &str, branch_prefix: &str) -> AppResult<WorktreeInfo> {
    require_supported(root)?;
    let slug = slugify(name)?;
    let branch = format!("{branch_prefix}{slug}");
    if read(root, &["check-ref-format", "--branch", &branch])?.is_none() {
        return Err(AppError::invalid_name(format!("not a valid branch name: {branch}")));
    }
    let rel = format!("{WORKTREES_REL}/{slug}");
    let dir = rel_path(root, &rel);
    if dir.exists() {
        return Err(AppError::already_exists(format!("{rel} already exists")));
    }
    if ref_exists(root, &format!("refs/heads/{branch}"))? {
        return Err(AppError::already_exists(format!("branch {branch} already exists")));
    }
    let base = current_branch(root)?;
    let head = read_line(root, &["rev-parse", "HEAD^{commit}"])?
        .ok_or_else(|| AppError::io("could not resolve HEAD"))?;
    ensure_exclude(root)?;
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dir_arg = dir.to_string_lossy().into_owned();
    let out = write(root, &["worktree", "add", "-b", &branch, &dir_arg, &head])?;
    if !out.success {
        return Err(AppError::io(detail(&out).unwrap_or_else(|| "git worktree add failed".into())));
    }
    if let Some(base) = &base {
        let key = format!("branch.{branch}.kotiloBase");
        let out = write(root, &["config", &key, base])?;
        if !out.success {
            log::warn!("worktree: could not record the base branch of {branch}");
        }
    }
    let rec = PorcelainWorktree { path: dir_arg, head: Some(head), branch: Some(branch), ..Default::default() };
    info_for(root, rel, &rec, base.as_deref())
}

/// Parses `git diff --name-status -z`: `X\0path\0`, or `R<score>\0old\0new\0` for a
/// rename/copy.
fn parse_name_status_z(out: &[u8]) -> Vec<(FileStatus, String, Option<String>)> {
    let mut tokens = out.split(|b| *b == 0);
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        let Some(kind) = token.first() else { continue };
        let Some(path) = tokens.next() else { break };
        match kind {
            b'R' | b'C' => {
                let Some(new) = tokens.next() else { break };
                if *kind == b'R' {
                    entries.push((FileStatus::Renamed, field(new), Some(field(path))));
                } else {
                    entries.push((FileStatus::Added, field(new), None));
                }
            }
            b'A' => entries.push((FileStatus::Added, field(path), None)),
            b'D' => entries.push((FileStatus::Deleted, field(path), None)),
            _ => entries.push((FileStatus::Modified, field(path), None)),
        }
    }
    entries
}

/// `worktree_changes` core: committed + uncommitted + untracked changes of a worktree
/// against `merge-base(base, HEAD)` (or `HEAD` when there is none), paths prefixed with
/// the worktree's `rel`.
pub fn changes_at(root: &Path, name: &str) -> AppResult<WorktreeChanges> {
    require_supported(root)?;
    let (rel, rec) = find(root, name)?;
    let dir = rel_path(root, &rel);
    if !dir.is_dir() {
        return Ok(WorktreeChanges::default());
    }
    let current = current_branch(root)?;
    let base_branch = base_of(root, rec.branch.as_deref(), current.as_deref())?;
    let merge_base = match &base_branch {
        Some(b) => read_line(&dir, &["merge-base", b, "HEAD"])?,
        None => None,
    };
    let left = merge_base.clone().unwrap_or_else(|| "HEAD".to_string());
    let numstat = read(&dir, &["diff", "--no-ext-diff", "--numstat", "-z", "-M", &left])?
        .map(|out| parse_numstat_z(&out))
        .unwrap_or_default();
    let statuses = read(&dir, &["diff", "--no-ext-diff", "--name-status", "-z", "-M", &left])?
        .map(|out| parse_name_status_z(&out))
        .unwrap_or_default();
    let untracked = read(&dir, &["ls-files", "--others", "--exclude-standard", "-z"])?.unwrap_or_default();

    let mut files = Vec::new();
    let mut truncated = false;
    let prefixed = |p: &str| format!("{rel}/{p}");
    for (status, path, old_path) in statuses {
        if files.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let stat = numstat.iter().find(|n| n.path == path);
        files.push(ChangedFile {
            path: prefixed(&path),
            status,
            added: stat.and_then(|n| n.added),
            removed: stat.and_then(|n| n.removed),
            old_path: old_path.as_deref().map(prefixed),
        });
    }
    let mut counted = 0usize;
    for path in untracked.split(|b| *b == 0).filter(|p| !p.is_empty()).map(field) {
        if files.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let added = if counted < LINE_COUNT_MAX_FILES {
            counted += 1;
            count_lines(&rel_path(&dir, &path))
        } else {
            None
        };
        let removed = added.map(|_| 0);
        files.push(ChangedFile { path: prefixed(&path), status: FileStatus::Untracked, added, removed, old_path: None });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorktreeChanges { base: merge_base, files, truncated })
}

/// Paths with unresolved conflicts in `cwd`.
fn conflicted(cwd: &Path) -> AppResult<Vec<String>> {
    Ok(read(cwd, &["diff", "--name-only", "--diff-filter=U", "-z"])?
        .map(|out| out.split(|b| *b == 0).filter(|p| !p.is_empty()).map(field).collect())
        .unwrap_or_default())
}

/// A failed merge: collect the conflicts, then put the main checkout back as it was.
fn abort_merge(root: &Path, out: &GitOutput, squash: bool) -> AppResult<MergeResult> {
    let conflicts = conflicted(root)?;
    let abort = if squash { write(root, &["reset", "--merge"])? } else { write(root, &["merge", "--abort"])? };
    if !abort.success {
        log::warn!("worktree: merge abort failed");
    }
    let status = if conflicts.is_empty() { MergeStatus::Failed } else { MergeStatus::Conflict };
    Ok(MergeResult { status, conflicts, detail: detail(out) })
}

/// `worktree_merge` core: merges a managed worktree's branch into its base in the main
/// checkout (`--no-ff`, or `--squash` + commit), aborting on conflicts.
pub fn merge_at(root: &Path, name: &str, squash: bool, message: Option<&str>) -> AppResult<MergeResult> {
    require_supported(root)?;
    let (rel, rec) = find_managed(root, name)?;
    let Some(branch) = rec.branch.clone() else {
        return Ok(MergeResult { detail: Some("the worktree is not on a branch".into()), ..MergeResult::status(MergeStatus::Failed) });
    };
    let current = current_branch(root)?;
    let base = base_of(root, Some(&branch), current.as_deref())?;
    if base.is_none() || base != current {
        return Ok(MergeResult::status(MergeStatus::NotOnBase));
    }
    if main_dirty(root)? {
        return Ok(MergeResult::status(MergeStatus::MainDirty));
    }
    let dir = rel_path(root, &rel);
    if dir.is_dir() && dirty_count(&dir)? > 0 {
        return Ok(MergeResult::status(MergeStatus::WorktreeDirty));
    }
    if is_ancestor(root, &branch, "HEAD")? {
        return Ok(MergeResult::status(MergeStatus::UpToDate));
    }
    if !squash {
        let out = write(root, &["merge", "--no-ff", "--no-edit", &branch])?;
        return if out.success { Ok(MergeResult::status(MergeStatus::Merged)) } else { abort_merge(root, &out, false) };
    }
    let out = write(root, &["merge", "--squash", &branch])?;
    if !out.success {
        return abort_merge(root, &out, true);
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    let message = message.unwrap_or_else(|| format!("Squash {branch}"));
    let out = write(root, &["commit", "-q", "-m", &message])?;
    if out.success {
        Ok(MergeResult::status(MergeStatus::Merged))
    } else {
        abort_merge(root, &out, true)
    }
}

/// `worktree_remove` core: refuses a dirty worktree / unmerged branch unless forced, then
/// `git worktree remove` (or `prune` for a missing folder) and optionally `git branch -d/-D`.
pub fn remove_at(root: &Path, name: &str, force: bool, delete_branch: bool, force_branch: bool) -> AppResult<RemoveResult> {
    require_supported(root)?;
    let (rel, rec) = find_managed(root, name)?;
    let dir = rel_path(root, &rel);
    let missing = rec.prunable || !dir.is_dir();
    let refuse = |status| Ok(RemoveResult { status, branch_deleted: false, detail: None });
    if !missing && !force && dirty_count(&dir)? > 0 {
        return refuse(RemoveStatus::Dirty);
    }
    let branch = rec.branch.clone().filter(|_| delete_branch);
    if let (Some(branch), false) = (&branch, force_branch) {
        let current = current_branch(root)?;
        let target = base_of(root, Some(branch), current.as_deref())?.unwrap_or_else(|| "HEAD".into());
        if !is_ancestor(root, branch, &target)? {
            return refuse(RemoveStatus::Unmerged);
        }
    }
    let out = if missing {
        write(root, &["worktree", "prune"])?
    } else {
        let dir_arg = dir.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&dir_arg);
        let out = write(root, &args)?;
        if !out.success {
            return Ok(RemoveResult { status: RemoveStatus::Failed, branch_deleted: false, detail: detail(&out) });
        }
        out
    };
    let mut result = RemoveResult { status: RemoveStatus::Removed, branch_deleted: false, detail: None };
    if !out.success {
        result.detail = detail(&out);
    }
    if let Some(branch) = branch {
        let out = write(root, &["branch", if force_branch { "-D" } else { "-d" }, &branch])?;
        result.branch_deleted = out.success;
        if out.success {
            let _ = write(root, &["config", "--remove-section", &format!("branch.{branch}")]);
        } else {
            result.detail = detail(&out);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn porcelain_parses_main_linked_detached_locked_prunable_and_bare() {
        let out = "worktree C:/src/app\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n\
worktree C:/src/app/.kotilo/worktrees/fix-login\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/kotilo/fix-login\nlocked reason here\n\n\
worktree /tmp/detached\r\nHEAD 3333333333333333333333333333333333333333\r\ndetached\r\nprunable gitdir file points to non-existent location\r\n\r\n\
worktree /srv/bare.git\nbare\n";
        let recs = parse_worktree_porcelain(out);
        assert_eq!(recs.len(), 4);
        assert_eq!(recs[0].branch.as_deref(), Some("main"));
        assert_eq!(recs[1].path, "C:/src/app/.kotilo/worktrees/fix-login");
        assert_eq!(recs[1].branch.as_deref(), Some("kotilo/fix-login"));
        assert!(recs[1].locked && !recs[1].prunable);
        assert_eq!(recs[2].path, "/tmp/detached");
        assert_eq!(recs[2].head.as_deref(), Some("3333333333333333333333333333333333333333"));
        assert_eq!(recs[2].branch, None);
        assert!(recs[2].prunable && !recs[2].locked);
        assert!(recs[3].bare);
        assert!(parse_worktree_porcelain("").is_empty());
    }

    #[test]
    fn slugs_are_lowercase_ascii_dashes_and_capped() {
        assert_eq!(slugify("Fix Login").unwrap(), "fix-login");
        assert_eq!(slugify("  --Ünïcode__Name!!  ").unwrap(), "n-code-name");
        assert_eq!(slugify("a/b\\c..d").unwrap(), "a-b-c-d");
        assert_eq!(slugify(&"x".repeat(60)).unwrap().len(), 40);
        assert_eq!(slugify(&format!("{}-tail", "y".repeat(39))).unwrap(), "y".repeat(39));
        for bad in ["", "   ", "!!!", "ğüş"] {
            assert_eq!(slugify(bad).unwrap_err().code, crate::error::ErrorCode::InvalidName, "{bad}");
        }
    }

    #[test]
    fn managed_rels_are_direct_children_of_the_worktrees_folder() {
        assert!(is_managed_rel(".kotilo/worktrees/a"));
        assert!(!is_managed_rel(".kotilo/worktrees"));
        assert!(!is_managed_rel(".kotilo/worktrees/a/b"));
        assert!(!is_managed_rel(".claude/worktrees/a"));
        assert!(!is_managed_rel(".kotilo/worktreesx/a"));
    }

    #[test]
    fn name_status_parses_renames_and_copies() {
        let out = b"M\0a.txt\0R087\0old.txt\0new.txt\0A\0n.txt\0D\0d.txt\0C100\0src.txt\0copy.txt\0T\0t\0";
        assert_eq!(
            parse_name_status_z(out),
            vec![
                (FileStatus::Modified, "a.txt".into(), None),
                (FileStatus::Renamed, "new.txt".into(), Some("old.txt".into())),
                (FileStatus::Added, "n.txt".into(), None),
                (FileStatus::Deleted, "d.txt".into(), None),
                (FileStatus::Added, "copy.txt".into(), None),
                (FileStatus::Modified, "t".into(), None),
            ]
        );
    }

    #[test]
    fn detail_keeps_the_tail_and_falls_back_to_stdout() {
        let out = GitOutput { success: false, stdout: b"CONFLICT (content)".to_vec(), stderr: b"  \n".to_vec() };
        assert_eq!(detail(&out).as_deref(), Some("CONFLICT (content)"));
        let long = GitOutput { success: false, stdout: Vec::new(), stderr: "é".repeat(3000).into_bytes() };
        assert_eq!(detail(&long).map(|d| d.chars().count()), Some(DETAIL_MAX_CHARS));
        assert_eq!(detail(&GitOutput::default()), None);
    }

    #[test]
    fn serializes_to_the_contract() {
        let list = WorktreeList { reason: Some(WorktreeUnsupported::NotRepoRoot), ..Default::default() };
        assert_eq!(
            serde_json::to_value(list).unwrap(),
            serde_json::json!({"supported": false, "reason": "notRepoRoot", "currentBranch": null, "mainDirty": false, "worktrees": []})
        );
        let merge = MergeResult::status(MergeStatus::UpToDate);
        assert_eq!(serde_json::to_value(merge).unwrap(), serde_json::json!({"status": "upToDate", "conflicts": [], "detail": null}));
        let remove = RemoveResult { status: RemoveStatus::Removed, branch_deleted: true, detail: None };
        assert_eq!(serde_json::to_value(remove).unwrap(), serde_json::json!({"status": "removed", "branchDeleted": true, "detail": null}));
        let info = serde_json::to_value(WorktreeInfo::default()).unwrap();
        for key in ["name", "rel", "branch", "head", "base", "managed", "locked", "prunable", "dirty", "ahead", "behind", "added", "removed"] {
            assert!(info.get(key).is_some(), "{key}");
        }
    }

    // --- against real repositories made with the git CLI (skipped when git is missing) ---

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = run_git_write(dir, args, Duration::from_secs(60)).expect("git runs");
        assert!(out.success, "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write_file(root: &Path, rel: &str, text: &str) {
        let path = rel_path(root, rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// A repo on `main` with one commit (`a.txt`, `b.txt`).
    fn repo() -> Option<(tempfile::TempDir, PathBuf)> {
        if run_git(Path::new("."), &["--version"], Duration::from_secs(10)) == Err(GitError::NotInstalled) {
            eprintln!("git not on PATH; skipping");
            return None;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "test@example.invalid"]);
        git(&root, &["config", "user.name", "Test"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        write_file(&root, "a.txt", "one\ntwo\nthree\n");
        write_file(&root, "b.txt", "b\n");
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        Some((dir, root))
    }

    fn commit_in(dir: &Path, rel: &str, text: &str, msg: &str) {
        write_file(dir, rel, text);
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", msg]);
    }

    fn wt(root: &Path, name: &str) -> PathBuf {
        rel_path(root, &format!("{WORKTREES_REL}/{name}"))
    }

    fn exclude_text(root: &Path) -> String {
        std::fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap_or_default()
    }

    #[test]
    fn create_makes_folder_branch_base_and_exclude() {
        let Some((_tmp, root)) = repo() else { return };
        let info = create_at(&root, "Fix Login", "kotilo/").unwrap();
        assert_eq!(info.name, "fix-login");
        assert_eq!(info.rel, ".kotilo/worktrees/fix-login");
        assert_eq!(info.branch.as_deref(), Some("kotilo/fix-login"));
        assert_eq!(info.base.as_deref(), Some("main"));
        assert_eq!(info.head.as_deref().map(str::len), Some(40));
        assert!(info.managed && !info.prunable);
        assert_eq!((info.dirty, info.ahead, info.behind), (0, 0, 0));
        assert!(wt(&root, "fix-login").join("a.txt").is_file());
        assert_eq!(git(&root, &["config", "--get", "branch.kotilo/fix-login.kotiloBase"]), "main");
        // `.kotilo/*` is excluded once, the main checkout stays clean.
        assert_eq!(exclude_text(&root).lines().filter(|l| *l == ".kotilo/*").count(), 1);
        assert_eq!(git(&root, &["status", "--porcelain"]), "");

        create_at(&root, "second", "").unwrap();
        assert_eq!(exclude_text(&root).lines().filter(|l| *l == ".kotilo/*").count(), 1, "exclude is idempotent");
        assert!(ref_exists(&root, "refs/heads/second").unwrap(), "empty prefix is allowed");

        // Existing folder or branch → already_exists; nothing usable → invalid_name.
        let err = create_at(&root, "fix login", "kotilo/").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists);
        git(&root, &["branch", "kotilo/taken"]);
        let err = create_at(&root, "taken", "kotilo/").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists);
        assert!(!wt(&root, "taken").exists());
        assert_eq!(create_at(&root, "???", "kotilo/").unwrap_err().code, crate::error::ErrorCode::InvalidName);
        assert_eq!(create_at(&root, "x", "bad..prefix/").unwrap_err().code, crate::error::ErrorCode::InvalidName);
    }

    #[test]
    fn unsupported_workspaces_are_reported_not_errors() {
        let Some((_tmp, root)) = repo() else { return };
        write_file(&root, "pkg/x.txt", "x\n");
        let sub = root.join("pkg");
        let list = list_at(&sub).unwrap();
        assert_eq!((list.supported, list.reason), (false, Some(WorktreeUnsupported::NotRepoRoot)));
        assert_eq!(create_at(&sub, "a", "kotilo/").unwrap_err().code, crate::error::ErrorCode::InvalidArgument);

        let fresh = _tmp.path().join("fresh");
        std::fs::create_dir(&fresh).unwrap();
        git(&fresh, &["init", "-q"]);
        assert_eq!(list_at(&fresh).unwrap().reason, Some(WorktreeUnsupported::NoCommit));

        let plain = tempfile::tempdir().unwrap();
        if run_git(plain.path(), &["rev-parse", "--show-prefix"], GIT_TIMEOUT) == Ok(None) {
            assert_eq!(list_at(plain.path()).unwrap().reason, Some(WorktreeUnsupported::NotRepo));
        }
    }

    #[test]
    fn exclude_respects_an_existing_entry_and_missing_newline() {
        let Some((_tmp, root)) = repo() else { return };
        let path = root.join(".git").join("info").join("exclude");
        std::fs::write(&path, "*.log").unwrap();
        ensure_exclude(&root).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, format!("*.log\n# {} worktrees and attachments\n.kotilo/*\n!.kotilo/docs.toml\n", crate::brand::NAME));
        // The Docs config stays visible to git, everything else in `.kotilo/` is hidden.
        write_file(&root, ".kotilo/docs.toml", "[[doc]]\n");
        write_file(&root, ".kotilo/worktrees/x/a.txt", "x\n");
        assert_eq!(git(&root, &["status", "--porcelain", "--untracked-files=all"]), "?? .kotilo/docs.toml");
        std::fs::write(&path, "/.kotilo/\n").unwrap();
        ensure_exclude(&root).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "/.kotilo/\n");
    }

    #[test]
    fn exclude_update_migrates_the_v06_block_in_place() {
        let name = "Kotilo";
        let block = "# Kotilo worktrees and attachments\n.kotilo/*\n!.kotilo/docs.toml\n";
        assert_eq!(exclude_update("", name).as_deref(), Some(block));
        assert_eq!(exclude_update(block, name), None, "up to date");
        let old = "# git ls-files --others --exclude-from=.git/info/exclude\n*.tmp\n# Kotilo worktrees and attachments\n.kotilo/\nafter\n";
        assert_eq!(
            exclude_update(old, name).as_deref(),
            Some("# git ls-files --others --exclude-from=.git/info/exclude\n*.tmp\n# Kotilo worktrees and attachments\n.kotilo/*\n!.kotilo/docs.toml\nafter\n")
        );
        // Our comment with `.kotilo/*` but no negation (hand-edited): the negation is added.
        assert_eq!(exclude_update("# Kotilo worktrees and attachments\n.kotilo/*\n", name).as_deref(), Some(block));
        // A `.kotilo` line the user wrote (no comment of ours before it) is left alone.
        for user in [".kotilo/\n", "# mine\n.kotilo\n", "/.kotilo/*\n"] {
            assert_eq!(exclude_update(user, name), None, "{user}");
        }
        // Another brand's comment is not ours.
        assert_eq!(exclude_update("# Other worktrees and attachments\n.kotilo/\n", name), None);
    }

    #[test]
    fn rel_in_root_maps_a_deleted_folder_through_another_spelling() {
        // `sub/..` stands in for `/var` vs `/private/var` or an 8.3 name: only the canonical form matches,
        // and the worktree folder itself no longer exists.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("sub")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".kotilo").join("worktrees")).unwrap();
        let root = tmp.path().join("sub").join("..");
        let gone = tmp.path().join(".kotilo").join("worktrees").join("gone");
        assert_eq!(rel_in_root(&root, gone.to_str().unwrap()).as_deref(), Some(".kotilo/worktrees/gone"));
    }

    #[test]
    fn list_reports_stats_managed_unmanaged_and_prunable() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "b-work", "kotilo/").unwrap();
        create_at(&root, "a-gone", "kotilo/").unwrap();
        let w = wt(&root, "b-work");
        commit_in(&w, "a.txt", "one\nTWO\nthree\nfour\n", "work");
        write_file(&w, "b.txt", "b\nmore\n");
        write_file(&w, "new.txt", "n\n");
        // An agent's own worktree inside the root, on its own branch.
        let other = root.join(".claude").join("worktrees").join("agent");
        git(&root, &["worktree", "add", "-q", "-b", "agent-branch", other.to_str().unwrap()]);
        commit_in(&root, "main.txt", "m\n", "main moves on");
        write_file(&root, "b.txt", "changed in main\n");
        std::fs::remove_dir_all(wt(&root, "a-gone")).unwrap();

        let list = list_at(&root).unwrap();
        assert!(list.supported);
        assert_eq!(list.current_branch.as_deref(), Some("main"));
        assert!(list.main_dirty);
        let names: Vec<&str> = list.worktrees.iter().map(|w| w.name.as_str()).collect();
        assert_eq!(names, vec!["a-gone", "agent", "b-work"]);
        let gone = &list.worktrees[0];
        assert!(gone.prunable && gone.managed);
        let agent = &list.worktrees[1];
        assert_eq!(agent.rel, ".claude/worktrees/agent");
        assert!(!agent.managed);
        assert_eq!(agent.base.as_deref(), Some("main"), "fallback = main's branch");
        assert_eq!((agent.ahead, agent.behind), (0, 1));
        let work = &list.worktrees[2];
        assert_eq!(work.dirty, 2, "modified b.txt + untracked new.txt");
        assert_eq!((work.ahead, work.behind), (1, 1));
        // a.txt: TWO for two, plus four (committed); b.txt: +more (uncommitted, tracked).
        assert_eq!((work.added, work.removed), (3, 1));
    }

    #[test]
    fn changes_include_committed_uncommitted_and_untracked_with_rel_prefix() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "feat", "kotilo/").unwrap();
        let w = wt(&root, "feat");
        commit_in(&w, "a.txt", "one\nTWO\nthree\n", "committed");
        std::fs::remove_file(w.join("b.txt")).unwrap();
        write_file(&w, "dir/new.txt", "1\n2\n");
        commit_in(&root, "main-only.txt", "m\n", "main moves on");

        let c = changes_at(&root, "feat").unwrap();
        assert_eq!(c.base.as_deref().map(str::len), Some(40));
        let got: Vec<(&str, FileStatus, Option<u64>, Option<u64>)> =
            c.files.iter().map(|f| (f.path.as_str(), f.status, f.added, f.removed)).collect();
        assert_eq!(
            got,
            vec![
                (".kotilo/worktrees/feat/a.txt", FileStatus::Modified, Some(1), Some(1)),
                (".kotilo/worktrees/feat/b.txt", FileStatus::Deleted, Some(0), Some(1)),
                (".kotilo/worktrees/feat/dir/new.txt", FileStatus::Untracked, Some(2), Some(0)),
            ]
        );
        assert!(!c.truncated);
        // The left side of the diff reads from the worktree's repo at the merge base.
        let left = super::super::show_at(&root, ".kotilo/worktrees/feat/a.txt", c.base.as_deref().unwrap());
        assert_eq!(left.content.as_deref(), Some("one\ntwo\nthree\n"));
        let head = super::super::show_head_at(&root, ".kotilo/worktrees/feat/a.txt");
        assert_eq!(head.content.as_deref(), Some("one\nTWO\nthree\n"), "HEAD of the worktree, not main");
        let deleted_dir = super::super::show_head_at(&root, ".kotilo/worktrees/feat/gone/x.txt");
        assert_eq!(deleted_dir.content, None);
        assert_eq!(changes_at(&root, "nope").unwrap_err().code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn merge_checks_preconditions_then_merges() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "feat", "kotilo/").unwrap();
        let w = wt(&root, "feat");
        assert_eq!(merge_at(&root, "feat", false, None).unwrap().status, MergeStatus::UpToDate);

        commit_in(&w, "feat.txt", "f\n", "feature");
        write_file(&w, "scratch.txt", "s\n");
        assert_eq!(merge_at(&root, "feat", false, None).unwrap().status, MergeStatus::WorktreeDirty);
        std::fs::remove_file(w.join("scratch.txt")).unwrap();

        write_file(&root, "a.txt", "dirty main\n");
        assert_eq!(merge_at(&root, "feat", false, None).unwrap().status, MergeStatus::MainDirty);
        git(&root, &["checkout", "-q", "--", "a.txt"]);

        git(&root, &["checkout", "-q", "-b", "elsewhere"]);
        assert_eq!(merge_at(&root, "feat", false, None).unwrap().status, MergeStatus::NotOnBase);
        git(&root, &["checkout", "-q", "main"]);

        let r = merge_at(&root, "feat", false, None).unwrap();
        assert_eq!(r, MergeResult::status(MergeStatus::Merged));
        assert!(root.join("feat.txt").is_file());
        assert_eq!(git(&root, &["rev-list", "--count", "--merges", "HEAD"]), "1", "--no-ff makes a merge commit");
        assert_eq!(merge_at(&root, "feat", false, None).unwrap().status, MergeStatus::UpToDate);
    }

    #[test]
    fn squash_merge_commits_one_change_with_the_message() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "sq", "kotilo/").unwrap();
        let w = wt(&root, "sq");
        commit_in(&w, "x.txt", "1\n", "one");
        commit_in(&w, "y.txt", "2\n", "two");
        let r = merge_at(&root, "sq", true, None).unwrap();
        assert_eq!(r.status, MergeStatus::Merged);
        assert_eq!(git(&root, &["log", "-1", "--format=%s"]), "Squash kotilo/sq");
        assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]), "2");
        assert!(root.join("y.txt").is_file());

        commit_in(&w, "z.txt", "3\n", "three");
        assert_eq!(merge_at(&root, "sq", true, Some("Add z")).unwrap().status, MergeStatus::Merged);
        assert_eq!(git(&root, &["log", "-1", "--format=%s"]), "Add z");
    }

    #[test]
    fn conflicts_are_aborted_and_main_stays_clean() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "c", "kotilo/").unwrap();
        commit_in(&wt(&root, "c"), "a.txt", "worktree\n", "theirs");
        commit_in(&root, "a.txt", "main\n", "ours");
        let head = git(&root, &["rev-parse", "HEAD"]);
        for squash in [false, true] {
            let r = merge_at(&root, "c", squash, None).unwrap();
            assert_eq!(r.status, MergeStatus::Conflict, "squash={squash}");
            assert_eq!(r.conflicts, vec!["a.txt".to_string()]);
            assert!(r.detail.is_some());
            assert_eq!(git(&root, &["status", "--porcelain", "--untracked-files=no"]), "");
            assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
            assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "main\n");
        }
    }

    #[test]
    fn remove_refuses_dirty_and_unmerged_unless_forced() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "r", "kotilo/").unwrap();
        let w = wt(&root, "r");
        commit_in(&w, "r.txt", "r\n", "unmerged work");
        write_file(&w, "untracked.txt", "u\n");

        assert_eq!(remove_at(&root, "r", false, true, false).unwrap().status, RemoveStatus::Dirty);
        assert_eq!(remove_at(&root, "r", true, true, false).unwrap().status, RemoveStatus::Unmerged);
        assert!(w.is_dir(), "nothing removed on a refusal");

        let r = remove_at(&root, "r", true, true, true).unwrap();
        assert_eq!(r, RemoveResult { status: RemoveStatus::Removed, branch_deleted: true, detail: None });
        assert!(!w.exists());
        assert!(!ref_exists(&root, "refs/heads/kotilo/r").unwrap());
        assert!(list_at(&root).unwrap().worktrees.is_empty());
    }

    #[test]
    fn remove_merged_worktree_keeps_or_deletes_the_branch() {
        let Some((_tmp, root)) = repo() else { return };
        create_at(&root, "keep", "kotilo/").unwrap();
        create_at(&root, "del", "kotilo/").unwrap();
        commit_in(&wt(&root, "del"), "d.txt", "d\n", "work");
        assert_eq!(merge_at(&root, "del", false, None).unwrap().status, MergeStatus::Merged);

        let r = remove_at(&root, "keep", false, false, false).unwrap();
        assert_eq!((r.status, r.branch_deleted), (RemoveStatus::Removed, false));
        assert!(ref_exists(&root, "refs/heads/kotilo/keep").unwrap());

        let r = remove_at(&root, "del", false, true, false).unwrap();
        assert_eq!((r.status, r.branch_deleted), (RemoveStatus::Removed, true));
        assert!(!ref_exists(&root, "refs/heads/kotilo/del").unwrap());

        // A folder deleted by hand is pruned.
        create_at(&root, "gone", "kotilo/").unwrap();
        std::fs::remove_dir_all(wt(&root, "gone")).unwrap();
        assert_eq!(remove_at(&root, "gone", false, true, false).unwrap().status, RemoveStatus::Removed);
        assert!(list_at(&root).unwrap().worktrees.is_empty());
    }

    #[test]
    fn unmanaged_worktrees_cannot_be_merged_or_removed() {
        let Some((_tmp, root)) = repo() else { return };
        let other = root.join(".claude").join("worktrees").join("agent");
        git(&root, &["worktree", "add", "-q", "-b", "agent-branch", other.to_str().unwrap()]);
        assert_eq!(merge_at(&root, "agent", false, None).unwrap_err().code, crate::error::ErrorCode::InvalidName);
        assert_eq!(remove_at(&root, "agent", true, true, true).unwrap_err().code, crate::error::ErrorCode::InvalidName);
        assert!(other.is_dir());
        assert!(changes_at(&root, "agent").unwrap().files.is_empty());
    }
}
