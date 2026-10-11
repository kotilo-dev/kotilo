//! Tree `.gitignore` support for `fs_read_dir` (Faz 6 spec §4, §10.16): when
//! `respectGitignore` is on, entries the workspace's `.gitignore`s (and
//! `.git/info/exclude`) would exclude are hidden from the tree the same way the
//! quick-open walker (`ignore::WalkBuilder(git_ignore(true))`) already hides them.
//!
//! `ignore::gitignore::GitignoreBuilder` only anchors its patterns to the *root it was
//! constructed with* — adding a nested directory's `.gitignore` file into a builder
//! rooted at the workspace root does **not** scope that file's patterns to its own
//! subtree (verified by reading `ignore`'s `add_line`, which never folds the added
//! file's own directory into the compiled glob). So this keeps one small
//! [`ignore::gitignore::Gitignore`] *per directory that actually has a `.gitignore`*,
//! each rooted at that directory, and checks an entry against every level from the
//! workspace root down to (and including) the entry's own directory — shallowest first,
//! so the deepest matcher that renders a verdict wins (spec §10.16), exactly like
//! `ignore::WalkBuilder`'s own per-directory matcher stack.
//!
//! Review finding #10: `.gitignore` support isn't an all-or-nothing "does the workspace
//! root have a `.git`" switch — `ignore` 0.4.33 gates `git_ignore`/`git_exclude` matching
//! *per directory* (`ignore::dir`'s `require_git`: `IgnoreInner::has_git` is computed per
//! directory from `dir.join(".git").exists()`, and `matched_ignore` only consults a
//! level's git-derived matchers once the walk has crossed into a directory — at or below
//! the entry — that itself has a `.git`; see `dir.rs`'s `add_child_path_with_found_ignore_files`
//! and `matched_ignore`). So a workspace whose root is *not* a repo but which *contains*
//! one (e.g. a vendored `repoA/.git`) must still honor `repoA`'s own `.gitignore` for
//! paths inside it, while a `.gitignore` above `repoA` stays inert. [`GitignoreTree`]
//! mirrors this by recording every directory that itself has a `.git` entry
//! ([`GitignoreTree::git_dirs`]) and, for each checked path, only applying the levels at
//! or below the *nearest* such directory on its way up to the workspace root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

/// One pass over the tree collecting both every `.gitignore` file (shallowest first —
/// the order [`build_workspace_gitignore`] turns into matcher levels, so a deeper file's
/// verdict is checked, and so takes precedence over, a shallower one's) and every
/// directory that itself directly contains a `.git` entry (finding #10) — mirroring
/// `ignore` 0.4.33's own per-directory `require_git` check, which treats a `.git` file
/// (e.g. a worktree pointer) exactly the same as a `.git` directory: it never descends
/// into it either way, but its mere presence is what matters.
fn discover_git_state(root: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut gitignores = Vec::new();
    let mut git_dirs = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name();
            if name == ".git" {
                git_dirs.push(dir.clone());
                continue;
            }
            if file_type.is_dir() {
                if file_type.is_symlink() {
                    continue;
                }
                stack.push(entry.path());
            } else if name == ".gitignore" {
                gitignores.push(entry.path());
            }
        }
    }
    gitignores.sort_by_key(|p| p.components().count());
    (gitignores, git_dirs)
}

/// One directory's compiled `.gitignore` (or `.git/info/exclude`), paired with the
/// directory it applies to.
struct Level {
    dir: PathBuf,
    matcher: Gitignore,
}

/// A whole workspace's merged gitignore state (spec §10.16, finding #10): an ordered
/// (shallowest first) list of per-directory matchers, rooted at the workspace root, plus
/// every directory that is itself a git boundary (has its own `.git` entry).
pub struct GitignoreTree {
    root: PathBuf,
    levels: Vec<Level>,
    /// Directories that directly contain a `.git` entry (file or dir) — see the module
    /// doc comment and finding #10.
    git_dirs: Vec<PathBuf>,
}

fn build_level(dir: &Path, gitignore_path: &Path) -> Option<Level> {
    let mut builder = GitignoreBuilder::new(dir);
    builder.add(gitignore_path);
    builder.build().ok().map(|matcher| Level {
        dir: dir.to_path_buf(),
        matcher,
    })
}

/// Builds the whole per-workspace matcher stack (spec §10.16, finding #10). Every
/// `.gitignore` under `root` is discovered regardless of whether `root` itself is a repo
/// — `git_dirs` (and [`nearest_git_boundary`]) is what actually decides, per path,
/// whether any of them apply, exactly mirroring `ignore::WalkBuilder`'s own per-directory
/// `require_git` gate rather than a single workspace-wide switch.
pub fn build_workspace_gitignore(root: &Path) -> GitignoreTree {
    let (gitignore_files, git_dirs) = discover_git_state(root);

    let mut levels = Vec::new();

    // `.git/info/exclude` first -- the shallowest, lowest-precedence source -- only when
    // the workspace root itself is a git boundary (a nested repo's own `info/exclude` is
    // out of scope: the spec's `.git/info/exclude` support is root-only, §10.16).
    if git_dirs.iter().any(|d| d == root) {
        let exclude = root.join(".git").join("info").join("exclude");
        if exclude.is_file() {
            if let Some(level) = build_level(root, &exclude) {
                levels.push(level);
            }
        }
    }

    for gitignore_path in gitignore_files {
        let dir = gitignore_path.parent().unwrap_or(root);
        if let Some(level) = build_level(dir, &gitignore_path) {
            levels.push(level);
        }
    }

    GitignoreTree {
        root: root.to_path_buf(),
        levels,
        git_dirs,
    }
}

/// The deepest directory in `tree.git_dirs` that is an ancestor-or-self of `dir` — the
/// nearest git boundary on `dir`'s way up to the workspace root (finding #10). `None` if
/// no directory on that chain has a `.git` at all (gitignore support is fully inert for
/// anything under `dir`, mirroring `ignore`'s `require_git` with no `.git` anywhere in
/// scope).
fn nearest_git_boundary<'a>(tree: &'a GitignoreTree, dir: &Path) -> Option<&'a Path> {
    let mut best: Option<&Path> = None;
    for g in &tree.git_dirs {
        if dir.starts_with(g) {
            let deeper = best.is_none_or(|b| g.components().count() > b.components().count());
            if deeper {
                best = Some(g.as_path());
            }
        }
    }
    best
}

/// One directory's own verdict (not counting whether any of *its* ancestors are
/// ignored): every level whose directory is an ancestor-or-self of `path`, *and* whose
/// directory is at or below the nearest git boundary above `path` (finding #10, mirroring
/// `ignore`'s per-directory `require_git`/`saw_git` gate), is consulted shallowest first,
/// and the deepest one that renders a verdict wins (spec §10.16) — a later `Whitelist`
/// (`!pattern`) can re-include what an earlier level ignored. No git boundary at all
/// above `path` -> always `false` (fully inert).
fn matched_here(tree: &GitignoreTree, path: &Path, is_dir: bool) -> bool {
    // Whether `path` itself is ignored is a property of what's *around* it (its parent's
    // own git/gitignore context) -- mirrors `ignore::dir::Ignore::matched`, which is
    // always evaluated using the *containing directory's* matcher stack, never the
    // entry's own (a directory that happens to itself be a repo root doesn't get to
    // exempt itself from a rule an enclosing `.gitignore` applies to its name).
    let parent_dir = path.parent().unwrap_or(&tree.root);
    let Some(boundary) = nearest_git_boundary(tree, parent_dir) else {
        return false;
    };

    let mut ignored = false;
    for level in &tree.levels {
        if !level.dir.starts_with(boundary) {
            // Shallower than the crossed git boundary -- `ignore` stops consulting
            // matchers once it steps outside the nearest enclosing repo.
            continue;
        }
        if !path.starts_with(&level.dir) {
            continue;
        }
        match level.matcher.matched(path, is_dir) {
            Match::None => {}
            Match::Ignore(_) => ignored = true,
            Match::Whitelist(_) => ignored = false,
        }
    }
    ignored
}

/// `true` if `abs_path` (absolute, under the workspace root) is excluded. Mirrors a real
/// top-down walk: every ancestor directory between the workspace root and `abs_path`
/// (exclusive) is checked *first*, root to leaf — if any of them is itself ignored, the
/// whole subtree is ignored and `abs_path` never gets its own say (a real walker would
/// never even have descended into it, so no `!pattern` inside it could apply either).
/// Only once no ancestor is ignored does `abs_path` get checked on its own merits.
pub fn is_ignored(tree: &GitignoreTree, abs_path: &Path, is_dir: bool) -> bool {
    let mut ancestors: Vec<&Path> = Vec::new();
    let mut current = abs_path.parent();
    while let Some(dir) = current {
        if dir == tree.root || !dir.starts_with(&tree.root) {
            break;
        }
        ancestors.push(dir);
        current = dir.parent();
    }
    for dir in ancestors.into_iter().rev() {
        if matched_here(tree, dir, true) {
            return true;
        }
    }
    matched_here(tree, abs_path, is_dir)
}

/// Per-workspace cache (Tauri managed state): one [`GitignoreTree`] per workspace, built
/// lazily on first use and dropped (spec §10.16) whenever a `.gitignore` under that
/// workspace changes, or the workspace is removed.
///
/// Review finding #4: building is single-flight per workspace (same pattern as
/// [`crate::quickopen::QuickOpenIndex`]) — concurrent `fs_read_dir` calls for the same
/// workspace await the same build instead of each re-walking the tree — and the
/// (possibly slow) discovery walk always runs in `spawn_blocking`, never inline on the
/// async command's own task.
#[derive(Default)]
struct Entry {
    tree: Option<Arc<GitignoreTree>>,
    generation: u64,
}

#[derive(Default)]
pub struct GitignoreTreeCache {
    entries: Mutex<HashMap<String, Entry>>,
    build_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitignoreTreeCache {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn build_lock(&self, workspace_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.build_locks.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(workspace_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Makes sure `workspace_id` has an entry (generation 0, unbuilt) before a build
    /// starts — mirrors [`crate::quickopen::QuickOpenIndex::ensure_entry`] (finding #18's
    /// fix, applied here too since this cache now uses the identical single-flight
    /// pattern): if the workspace is removed while a build is in flight,
    /// [`Self::store_if_current`] sees a missing entry and drops the stale result
    /// instead of resurrecting it.
    fn ensure_entry(&self, workspace_id: &str) {
        self.entries().entry(workspace_id.to_string()).or_default();
    }

    fn snapshot(&self, workspace_id: &str) -> Option<Arc<GitignoreTree>> {
        self.entries().get(workspace_id).and_then(|e| e.tree.clone())
    }

    fn generation(&self, workspace_id: &str) -> u64 {
        self.entries().get(workspace_id).map(|e| e.generation).unwrap_or(0)
    }

    /// Deliberately does **not** create a missing entry — see [`Self::ensure_entry`].
    fn store_if_current(&self, workspace_id: &str, generation: u64, tree: Arc<GitignoreTree>) -> bool {
        let mut guard = self.entries();
        let Some(entry) = guard.get_mut(workspace_id) else {
            return false;
        };
        if entry.generation == generation {
            entry.tree = Some(tree);
            true
        } else {
            false
        }
    }

    /// Finding #4: single-flight per workspace; the discovery walk itself always runs in
    /// `spawn_blocking` so it never blocks the calling async command's own task (in
    /// particular, `fs_read_dir`, which must never do this walk inline).
    pub async fn get_or_build(&self, workspace_id: &str, root: &Path) -> Arc<GitignoreTree> {
        let build_lock = self.build_lock(workspace_id);
        let _guard = build_lock.lock().await;

        if let Some(existing) = self.snapshot(workspace_id) {
            return existing;
        }
        self.ensure_entry(workspace_id);

        loop {
            let generation = self.generation(workspace_id);
            let walk_root = root.to_path_buf();
            let built = match tauri::async_runtime::spawn_blocking(move || build_workspace_gitignore(&walk_root)).await
            {
                Ok(tree) => Arc::new(tree),
                Err(_) => Arc::new(GitignoreTree {
                    root: root.to_path_buf(),
                    levels: Vec::new(),
                    git_dirs: Vec::new(),
                }),
            };
            if self.store_if_current(workspace_id, generation, built.clone()) {
                return built;
            }
        }
    }

    pub fn invalidate(&self, workspace_id: &str) {
        let mut guard = self.entries();
        let entry = guard.entry(workspace_id.to_string()).or_default();
        entry.tree = None;
        entry.generation = entry.generation.wrapping_add(1);
    }

    /// Drops every cached matcher (spec §1.4/§4: a `respectGitignore` settings change
    /// can affect any open workspace).
    pub fn invalidate_all(&self) {
        let ids: Vec<String> = self.entries().keys().cloned().collect();
        for id in ids {
            self.invalidate(&id);
        }
    }

    pub fn remove_workspace(&self, workspace_id: &str) {
        self.entries().remove(workspace_id);
        self.build_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(workspace_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    /// Spec §10.16: gitignore support is inert without a `.git` at the workspace root
    /// (same as `ignore::WalkBuilder`'s own `require_git` default) — every fixture below
    /// that isn't specifically testing *that* behavior needs one.
    fn init_git(root: &Path) {
        fs::create_dir_all(root.join(".git")).unwrap();
    }

    #[test]
    fn root_gitignore_excludes_matching_entries() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        write(&dir.path().join(".gitignore"), "*.log\nbuild/\n");
        write(&dir.path().join("a.log"), "x");
        write(&dir.path().join("keep.txt"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(is_ignored(&tree, &dir.path().join("a.log"), false));
        assert!(is_ignored(&tree, &dir.path().join("build"), true));
        assert!(!is_ignored(&tree, &dir.path().join("keep.txt"), false));
    }

    #[test]
    fn nested_gitignore_only_applies_within_its_own_subtree() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        write(&dir.path().join("src").join(".gitignore"), "*.tmp\n");
        write(&dir.path().join("src").join("a.tmp"), "x");
        // Same *.tmp name outside `src/` must NOT be affected by src/.gitignore.
        write(&dir.path().join("a.tmp"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(is_ignored(&tree, &dir.path().join("src").join("a.tmp"), false));
        assert!(!is_ignored(&tree, &dir.path().join("a.tmp"), false));
    }

    #[test]
    fn deeper_negation_overrides_a_shallower_ignore() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        write(&dir.path().join(".gitignore"), "*.log\n");
        write(&dir.path().join("keep").join(".gitignore"), "!important.log\n");
        write(&dir.path().join("keep").join("important.log"), "x");
        write(&dir.path().join("other.log"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(!is_ignored(&tree, &dir.path().join("keep").join("important.log"), false));
        assert!(is_ignored(&tree, &dir.path().join("other.log"), false));
    }

    #[test]
    fn git_info_exclude_is_honored_and_overridable_by_root_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(".git").join("info").join("exclude"), "excluded.txt\nboth.txt\n");
        write(&dir.path().join(".gitignore"), "!both.txt\n");
        write(&dir.path().join("excluded.txt"), "x");
        write(&dir.path().join("both.txt"), "x");
        write(&dir.path().join("kept.txt"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(is_ignored(&tree, &dir.path().join("excluded.txt"), false));
        // info/exclude is the shallowest source -- the root .gitignore's negation wins.
        assert!(!is_ignored(&tree, &dir.path().join("both.txt"), false));
        assert!(!is_ignored(&tree, &dir.path().join("kept.txt"), false));
    }

    #[test]
    fn inert_without_a_dot_git_at_the_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately no `init_git(dir.path())` -- a `.gitignore` with no `.git`
        // anywhere is not a real repo, spec §10.16: "`.git` içinde değilse (repo yok)
        // etkisizdir".
        write(&dir.path().join(".gitignore"), "*.log\n");
        write(&dir.path().join("a.log"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(!is_ignored(&tree, &dir.path().join("a.log"), false));
    }

    #[test]
    fn no_gitignore_anywhere_ignores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("a.txt"), "x");
        let tree = build_workspace_gitignore(dir.path());
        assert!(!is_ignored(&tree, &dir.path().join("a.txt"), false));
    }

    /// Review finding #10: a workspace root that is *not* itself a repo but *contains*
    /// one (e.g. a vendored `repoA/.git`) must still honor `repoA`'s own `.gitignore` for
    /// paths inside it, while staying fully inert for paths outside `repoA` (there's no
    /// `.git` anywhere in *their* ancestor chain up to the workspace root).
    #[test]
    fn nested_repo_gitignore_applies_only_within_that_repo_when_workspace_root_is_not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        // No `init_git(dir.path())` -- the workspace root itself is not a repo.
        init_git(&dir.path().join("repoA"));
        write(&dir.path().join("repoA").join(".gitignore"), "*.log\n");
        write(&dir.path().join("repoA").join("a.log"), "x");
        write(&dir.path().join("repoA").join("keep.txt"), "x");
        // A same-named file at the (non-repo) workspace root must NOT be affected.
        write(&dir.path().join("a.log"), "x");

        let tree = build_workspace_gitignore(dir.path());
        assert!(is_ignored(&tree, &dir.path().join("repoA").join("a.log"), false));
        assert!(!is_ignored(&tree, &dir.path().join("repoA").join("keep.txt"), false));
        assert!(!is_ignored(&tree, &dir.path().join("a.log"), false));
    }

    /// Exercises the same `store_if_current`/`generation`/`invalidate` plumbing the async
    /// `get_or_build` drives (see `quickopen`'s own tests for why the async wrapper
    /// itself isn't unit-tested directly — it needs a live Tauri async runtime).
    #[test]
    fn cache_store_if_current_and_invalidate() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        let cache = GitignoreTreeCache::default();

        cache.ensure_entry("ws1");
        let gen0 = cache.generation("ws1");
        let tree = Arc::new(build_workspace_gitignore(dir.path()));
        assert!(cache.store_if_current("ws1", gen0, tree.clone()));
        let cached = cache.snapshot("ws1").unwrap();
        assert!(Arc::ptr_eq(&tree, &cached));

        let gen_before = cache.generation("ws1");
        cache.invalidate("ws1");
        assert!(cache.snapshot("ws1").is_none());
        assert_ne!(cache.generation("ws1"), gen_before);
    }

    #[test]
    fn cache_store_if_current_rejects_a_stale_generation() {
        let cache = GitignoreTreeCache::default();
        let gen0 = cache.generation("ws1");
        cache.invalidate("ws1"); // generation moves on (and creates the entry)
        let tree = Arc::new(GitignoreTree {
            root: PathBuf::from("."),
            levels: Vec::new(),
            git_dirs: Vec::new(),
        });
        assert!(!cache.store_if_current("ws1", gen0, tree));
        assert!(cache.snapshot("ws1").is_none());
    }

    /// Review finding #18's fix, mirrored here (see [`GitignoreTreeCache::ensure_entry`]):
    /// a build result that arrives after the workspace was removed must not resurrect it.
    #[test]
    fn cache_store_if_current_does_not_resurrect_a_removed_workspace() {
        let cache = GitignoreTreeCache::default();
        cache.ensure_entry("ws1");
        let generation = cache.generation("ws1");
        cache.remove_workspace("ws1");
        let tree = Arc::new(GitignoreTree {
            root: PathBuf::from("."),
            levels: Vec::new(),
            git_dirs: Vec::new(),
        });
        assert!(!cache.store_if_current("ws1", generation, tree));
        assert!(cache.snapshot("ws1").is_none());
    }

    #[test]
    fn cache_remove_workspace_drops_state() {
        let cache = GitignoreTreeCache::default();
        cache.ensure_entry("ws1");
        let tree = Arc::new(GitignoreTree {
            root: PathBuf::from("."),
            levels: Vec::new(),
            git_dirs: Vec::new(),
        });
        assert!(cache.store_if_current("ws1", 0, tree));
        cache.remove_workspace("ws1");
        assert!(cache.snapshot("ws1").is_none());
    }

    /// Spec §10.16: this cache's verdict must agree with what an actual
    /// `ignore::WalkBuilder(git_ignore(true))` walk would visit, on a fixture that
    /// exercises root + nested `.gitignore`, a negation, and `.git/info/exclude`.
    fn walker_visited_files(dir: &Path) -> Vec<String> {
        let mut visited: Vec<String> = ignore::WalkBuilder::new(dir)
            .standard_filters(false)
            .hidden(false)
            .follow_links(false)
            .parents(false)
            .git_ignore(true)
            .git_exclude(true)
            .build()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| e.path().strip_prefix(dir).ok().map(|p| p.to_string_lossy().replace('\\', "/")))
            .filter(|rel| !rel.ends_with(".git/info/exclude"))
            .collect();
        visited.sort();
        visited
    }

    fn cache_visited_files(tree: &GitignoreTree, dir: &Path, candidates: &[&str]) -> Vec<String> {
        let mut visited: Vec<String> = candidates
            .iter()
            .filter(|rel| !is_ignored(tree, &dir.join(rel), false))
            .map(|s| s.to_string())
            .collect();
        visited.sort();
        visited
    }

    #[test]
    fn walker_equivalence() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(".gitignore"), "*.log\nbuild/\n");
        write(&dir.path().join(".git").join("info").join("exclude"), "excluded.txt\n");
        write(&dir.path().join("a.log"), "x");
        write(&dir.path().join("keep.txt"), "x");
        write(&dir.path().join("excluded.txt"), "x");
        write(&dir.path().join("build").join("out.bin"), "x");
        write(&dir.path().join("src").join(".gitignore"), "*.tmp\n!important.tmp\n");
        write(&dir.path().join("src").join("a.tmp"), "x");
        write(&dir.path().join("src").join("important.tmp"), "x");
        write(&dir.path().join("src").join("lib.rs"), "x");

        let candidates = [
            ".gitignore",
            "a.log",
            "keep.txt",
            "excluded.txt",
            "build/out.bin",
            "src/.gitignore",
            "src/a.tmp",
            "src/important.tmp",
            "src/lib.rs",
        ];

        let tree = build_workspace_gitignore(dir.path());
        assert_eq!(
            walker_visited_files(dir.path()),
            cache_visited_files(&tree, dir.path(), &candidates)
        );
    }

    /// Review finding #10: extends the walker-equivalence check to a workspace whose
    /// *root* is not a repo but which contains one (`repoA/.git`) — the deepest source of
    /// divergence this finding calls out.
    #[test]
    fn walker_equivalence_nested_repo_without_root_repo() {
        let dir = tempfile::tempdir().unwrap();
        // No `.git` at the workspace root.
        init_git(&dir.path().join("repoA"));
        write(&dir.path().join("repoA").join(".gitignore"), "*.log\n");
        write(&dir.path().join("repoA").join("a.log"), "x");
        write(&dir.path().join("repoA").join("keep.txt"), "x");
        write(&dir.path().join("a.log"), "x"); // outside repoA -- must survive
        write(&dir.path().join("other.txt"), "x");

        let candidates = ["repoA/.gitignore", "repoA/a.log", "repoA/keep.txt", "a.log", "other.txt"];

        let tree = build_workspace_gitignore(dir.path());
        assert_eq!(
            walker_visited_files(dir.path()),
            cache_visited_files(&tree, dir.path(), &candidates)
        );
    }

    /// Review finding #10: and a workspace with no `.git` anywhere at all.
    #[test]
    fn walker_equivalence_non_repo_workspace() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join(".gitignore"), "*.log\n");
        write(&dir.path().join("a.log"), "x");
        write(&dir.path().join("keep.txt"), "x");

        let candidates = [".gitignore", "a.log", "keep.txt"];

        let tree = build_workspace_gitignore(dir.path());
        assert_eq!(
            walker_visited_files(dir.path()),
            cache_visited_files(&tree, dir.path(), &candidates)
        );
    }
}
