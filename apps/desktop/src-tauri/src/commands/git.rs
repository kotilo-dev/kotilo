//! `git_head` (Faz 6 spec §6): the status bar's branch/detached-SHA indicator.
//!
//! D3 exception (read-only, no side effects): the only two files this ever reads are
//! `.git` itself (to find the actual git dir, for a worktree/submodule) and that dir's
//! `HEAD` — never anything else under `.git` (no refs, no packed-refs, no config).
//!
//! M4 adds `git_changes` / `git_show_head`, which run the git CLI (`crate::gitcli`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::gitcli;
use crate::workspace::WorkspaceStore;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum GitHead {
    Branch { name: String },
    Detached { sha: String },
}

/// Walks `start` and its ancestors (inclusive) looking for a `.git` entry — a directory
/// for an ordinary repo, or a file for a worktree/submodule checkout. `None` if no
/// ancestor has one (workspace isn't inside a git repo at all).
fn find_dot_git(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let candidate = d.join(".git");
        if candidate.exists() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

/// Resolves a `.git` entry to the directory that actually holds `HEAD` (spec §6): a
/// directory `.git` *is* that directory; a `.git` file contains a single
/// `gitdir: <path>` line, resolved relative to the file's own directory if `<path>`
/// isn't absolute.
fn resolve_git_dir(dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let contents = std::fs::read_to_string(dot_git).ok()?;
    let raw = contents.lines().next()?.trim().strip_prefix("gitdir:")?.trim();
    let path = Path::new(raw);
    if path.is_absolute() {
        Some(path.to_path_buf())
    } else {
        Some(dot_git.parent()?.join(path))
    }
}

/// Pure core (spec §6, unit tested): parses `HEAD`'s contents. `ref: refs/heads/<x>` is
/// a branch named `<x>` (kept verbatim, including any further `/`s); exactly 40 hex
/// characters is a detached checkout (only the first 7 are kept, spec: `sha[..7]`);
/// anything else (a ref outside `refs/heads/`, malformed content, ...) is `None`.
pub fn parse_head(contents: &str) -> Option<GitHead> {
    let trimmed = contents.trim();
    if let Some(rest) = trimmed.strip_prefix("ref:") {
        let branch = rest.trim().strip_prefix("refs/heads/")?;
        return (!branch.is_empty()).then(|| GitHead::Branch {
            name: branch.to_string(),
        });
    }
    if trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(GitHead::Detached {
            sha: trimmed[..7].to_string(),
        });
    }
    None
}

fn git_head_at(workspace_root: &Path) -> Option<GitHead> {
    let dot_git = find_dot_git(workspace_root)?;
    let git_dir = resolve_git_dir(&dot_git)?;
    let head_contents = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    parse_head(&head_contents)
}

/// `null` for anything that doesn't resolve (no repo, unreadable/malformed `HEAD`) —
/// never an error (spec §6).
#[tauri::command(async)]
pub fn git_head(store: State<'_, WorkspaceStore>, workspace_id: String) -> AppResult<Option<GitHead>> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    Ok(git_head_at(&root))
}

/// M4: working-copy changes against `HEAD` (see `crate::gitcli`). Never an error for
/// "no git / not a repo / no commit yet" — those come back as `repo: false` / `head: null`.
#[tauri::command]
pub async fn git_changes(store: State<'_, WorkspaceStore>, workspace_id: String) -> AppResult<gitcli::GitChanges> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    tauri::async_runtime::spawn_blocking(move || gitcli::changes_at(&root))
        .await
        .map_err(|e| AppError::io(e.to_string()))
}

/// M4: a file's `HEAD` content for the diff view. `path` is workspace-relative with `/`
/// separators; `..`, absolute paths and drive letters are rejected (`outside_workspace`).
#[tauri::command]
pub async fn git_show_head(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    path: String,
) -> AppResult<gitcli::HeadContent> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    gitcli::validate_rel(&path)?;
    tauri::async_runtime::spawn_blocking(move || gitcli::show_head_at(&root, &path))
        .await
        .map_err(|e| AppError::io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_head_branch_ref() {
        assert_eq!(
            parse_head("ref: refs/heads/main\n"),
            Some(GitHead::Branch { name: "main".to_string() })
        );
    }

    #[test]
    fn parse_head_branch_with_slash_in_name() {
        assert_eq!(
            parse_head("ref: refs/heads/feature/foo\n"),
            Some(GitHead::Branch {
                name: "feature/foo".to_string()
            })
        );
    }

    #[test]
    fn parse_head_detached_sha_keeps_first_seven_chars() {
        let sha = "abcdef0123456789abcdef0123456789abcdef01";
        assert_eq!(sha.len(), 40);
        assert_eq!(
            parse_head(sha),
            Some(GitHead::Detached {
                sha: "abcdef0".to_string()
            })
        );
    }

    #[test]
    fn parse_head_ref_outside_refs_heads_is_none() {
        assert_eq!(parse_head("ref: refs/tags/v1\n"), None);
    }

    #[test]
    fn parse_head_malformed_content_is_none() {
        assert_eq!(parse_head("garbage\n"), None);
        assert_eq!(parse_head(""), None);
        assert_eq!(parse_head("abc123"), None); // too short to be a sha
    }

    #[test]
    fn git_head_at_normal_repo_dir() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/faz6\n").unwrap();

        assert_eq!(
            git_head_at(dir.path()),
            Some(GitHead::Branch { name: "faz6".to_string() })
        );
    }

    #[test]
    fn git_head_at_worktree_dot_git_file_relative_gitdir() {
        let dir = tempfile::tempdir().unwrap();
        let real_git = dir.path().join("real.git");
        std::fs::create_dir(&real_git).unwrap();
        std::fs::write(real_git.join("HEAD"), "ref: refs/heads/wt-branch\n").unwrap();

        let worktree = dir.path().join("worktree");
        std::fs::create_dir(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../real.git\n").unwrap();

        assert_eq!(
            git_head_at(&worktree),
            Some(GitHead::Branch {
                name: "wt-branch".to_string()
            })
        );
    }

    #[test]
    fn git_head_at_searches_upward_from_a_subfolder_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let sub = dir.path().join("packages").join("app");
        std::fs::create_dir_all(&sub).unwrap();

        assert_eq!(
            git_head_at(&sub),
            Some(GitHead::Branch { name: "main".to_string() })
        );
    }

    #[test]
    fn git_head_at_no_repo_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(git_head_at(dir.path()), None);
    }

    #[test]
    fn git_head_at_corrupt_head_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "not a valid head file").unwrap();

        assert_eq!(git_head_at(dir.path()), None);
    }
}
