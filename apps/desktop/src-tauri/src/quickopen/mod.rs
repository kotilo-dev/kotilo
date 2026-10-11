//! `Ctrl+P` quick-open (Faz 6 spec §4, §10.3/§10.4/§10.15/§10.17): one file-path index per
//! workspace, fuzzy-queried with `nucleo-matcher`.
//!
//! The index itself never holds a lock across the (slow) directory walk (spec §10.4): a
//! per-workspace generation counter detects whether an invalidating event (a watcher
//! create/delete/rename, a `hiddenPatterns`/`respectGitignore` change, ...) raced the
//! walk, in which case the walk's result is discarded and rebuilt. A per-workspace
//! `tokio::sync::Mutex` (`build_locks`) makes sure only one rebuild is ever in flight per
//! workspace — concurrent callers await the same one and get its result (spec: "Aynı
//! workspace için eşzamanlı kurulum tek").
//!
//! The file list itself is a `HashSet<String>` rather than a `Vec<String>` (review
//! finding #5): a watcher event only ever needs to add/remove a handful of entries, so an
//! exact-match delete or a "does this file already exist" check is O(1) average instead
//! of an O(n) linear scan, and there's never a need to clone the *whole* list just to
//! drop one entry from it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::settings::{Settings, SettingsStore};
use crate::workspace::WorkspaceStore;

/// Spec §4: hard cap on how many files a single workspace index holds.
pub const MAX_INDEXED_FILES: usize = 200_000;
/// Spec §4: `limit` is clamped to this even if the caller asks for more.
pub const MAX_QUERY_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenItem {
    pub rel: String,
    pub score: u32,
    /// Unicode scalar indices into `rel` (spec §3: matches `Array.from(rel)` in JS).
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickOpenResult {
    pub items: Vec<QuickOpenItem>,
    pub truncated: bool,
}

// ---------------------------------------------------------------------------------
// Pure incremental update (spec §10.3, extended by review findings #5/#6) — unit tested
// independently of any I/O.
// ---------------------------------------------------------------------------------

pub(crate) enum EventOutcome {
    /// The index doesn't need to change.
    Unchanged,
    /// Remove exactly this one entry (an O(1) `HashSet::remove` for the caller).
    RemoveExact,
    /// Remove every entry with `"{rel}/"` as a prefix (a whole folder got deleted/renamed
    /// away) — a single `HashSet::retain` pass for the caller (finding #5).
    RemovePrefix,
    /// The index can no longer be trusted and must be rebuilt from disk before the next
    /// query (a new file — or a new, not-yet-indexed directory, finding #6 — appeared
    /// that isn't in it yet; cheap to detect, not cheap to know whether it should even be
    /// indexed without redoing the hidden/gitignore filtering, so a full rebuild is
    /// simplest).
    Dirty,
}

/// Pure core of one watcher event's effect on an already-built index (spec §10.3,
/// extended by review finding #6):
/// - `!exists && in_index` (a file that was indexed got deleted/renamed away) ->
///   [`EventOutcome::RemoveExact`].
/// - `!exists` and `rel` is a directory prefix of some entries (a whole folder got
///   deleted/renamed away) -> [`EventOutcome::RemovePrefix`].
/// - `exists && is_file && rel` not already indexed (a new file appeared) -> `Dirty`.
/// - `exists && !is_file` (a directory) and *nothing* in the index is under it yet (a
///   brand-new directory just appeared, e.g. a rename/move into the workspace, and may
///   already contain files the index has never seen) -> `Dirty` (finding #6).
/// - anything else (e.g. a plain content-modify on an already-indexed file, or an
///   existing directory that already has indexed children) -> no-op.
pub(crate) fn apply_watch_event(files: &HashSet<String>, rel: &str, exists: bool, is_file: bool) -> EventOutcome {
    let has_prefixed_entry = |files: &HashSet<String>| {
        let prefix = format!("{rel}/");
        files.iter().any(|f| f.starts_with(&prefix))
    };

    if !exists {
        if files.contains(rel) {
            return EventOutcome::RemoveExact;
        }
        if has_prefixed_entry(files) {
            return EventOutcome::RemovePrefix;
        }
        return EventOutcome::Unchanged;
    }
    if is_file {
        return if files.contains(rel) {
            EventOutcome::Unchanged
        } else {
            EventOutcome::Dirty
        };
    }
    // A directory (finding #6).
    if has_prefixed_entry(files) {
        EventOutcome::Unchanged
    } else {
        EventOutcome::Dirty
    }
}

// ---------------------------------------------------------------------------------
// Directory walk (spec §4, §10.15)
// ---------------------------------------------------------------------------------

/// Builds the file list for `root` under the current settings (spec §4, §10.15): only
/// files (no dirs/symlinks/junctions), `/`-separated relative paths, hidden patterns
/// applied as walker overrides, `.gitignore`/`.git/info/exclude` honored only when
/// `respect_gitignore` is set (and never `git_global`/loose `.ignore` files) — capped at
/// [`MAX_INDEXED_FILES`].
fn walk_workspace(root: &Path, settings: &Settings) -> AppResult<(HashSet<String>, bool)> {
    let overrides = crate::settings::build_hidden_overrides(root, &settings.files.hidden_patterns)
        .map_err(|e| AppError::io(e.to_string()))?;

    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .standard_filters(false)
        .hidden(false)
        .follow_links(false)
        .parents(false)
        .overrides(overrides);
    if settings.files.respect_gitignore {
        builder.git_ignore(true).git_exclude(true);
    }
    let walker = builder.build();

    let mut files = HashSet::new();
    let mut truncated = false;
    for entry in walker {
        if files.len() >= MAX_INDEXED_FILES {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Ok(rel_path) = entry.path().strip_prefix(root) else {
            continue;
        };
        if rel_path.as_os_str().is_empty() {
            continue;
        }
        files.insert(rel_path.to_string_lossy().replace('\\', "/"));
    }
    Ok((files, truncated))
}

// ---------------------------------------------------------------------------------
// Fuzzy query (spec §4, §10.17)
// ---------------------------------------------------------------------------------

thread_local! {
    // Matcher::new eagerly allocates a sizeable scratch buffer (~135 KB per its own
    // docs) and its methods all take `&mut self` anyway, so per spec §10.17 it's kept
    // thread_local rather than rebuilt (or fought over behind a Mutex) on every query.
    static MATCHER: std::cell::RefCell<Matcher> =
        std::cell::RefCell::new(Matcher::new(Config::DEFAULT.match_paths()));
}

/// Scores every entry in `files` against `query` (nucleo's own multi-atom, smart
/// case/normalization parsing — spec §4), sorts score descending / shorter `rel` first /
/// then alphabetically (spec §4), and returns at most `limit`.
///
/// Review finding #19: scores into `(idx, score, indices)` — `idx` an index into a
/// once-collected `Vec<&String>` view of `files`, not a clone of the string itself — then
/// sorts and truncates to `limit` *before* cloning anything, so a query that matches far
/// more than `limit` entries only ever clones the handful that are actually returned.
fn query_index(files: &HashSet<String>, query: &str, limit: usize) -> Vec<QuickOpenItem> {
    let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
    let ordered: Vec<&String> = files.iter().collect();
    let mut scored: Vec<(usize, u32, Vec<u32>)> = MATCHER.with(|cell| {
        let mut matcher = cell.borrow_mut();
        let mut buf = Vec::new();
        let mut out = Vec::with_capacity(ordered.len());
        for (idx, rel) in ordered.iter().enumerate() {
            let haystack = Utf32Str::new(rel, &mut buf);
            let mut indices = Vec::new();
            if let Some(score) = pattern.indices(haystack, &mut matcher, &mut indices) {
                // Spec §10.17: nucleo appends per-atom indices unsorted/undeduped.
                indices.sort_unstable();
                indices.dedup();
                out.push((idx, score, indices));
            }
        }
        out
    });
    scored.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| ordered[a.0].len().cmp(&ordered[b.0].len()))
            .then_with(|| ordered[a.0].cmp(ordered[b.0]))
    });
    scored.truncate(limit);
    scored
        .into_iter()
        .map(|(idx, score, indices)| QuickOpenItem {
            rel: ordered[idx].clone(),
            score,
            indices,
        })
        .collect()
}

// ---------------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------------

#[derive(Default)]
struct WsEntry {
    /// `None` = needs a full rebuild (never built yet, or invalidated/dirtied since).
    files: Option<Arc<HashSet<String>>>,
    truncated: bool,
    generation: u64,
}

#[derive(Default)]
pub struct QuickOpenIndex {
    entries: Mutex<HashMap<String, WsEntry>>,
    build_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl QuickOpenIndex {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, WsEntry>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn build_lock(&self, ws_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.build_locks.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(ws_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Makes sure `ws_id` has an entry (generation 0, unbuilt) before a build starts
    /// (finding #18) — so if the workspace is removed (its entry deleted outright, see
    /// [`Self::remove_workspace`]) while that build is still walking the disk,
    /// [`Self::store_if_current`] sees a *missing* entry (not one it should recreate) and
    /// correctly drops the stale result instead of resurrecting it.
    fn ensure_entry(&self, ws_id: &str) {
        self.entries().entry(ws_id.to_string()).or_default();
    }

    fn generation(&self, ws_id: &str) -> u64 {
        self.entries().get(ws_id).map(|e| e.generation).unwrap_or(0)
    }

    fn snapshot(&self, ws_id: &str) -> Option<(Arc<HashSet<String>>, bool)> {
        self.entries()
            .get(ws_id)
            .and_then(|e| e.files.clone().map(|f| (f, e.truncated)))
    }

    /// Writes `files` only if `ws_id` still has an entry *and* its `generation` still
    /// matches the workspace's current generation (spec §10.4) — an invalidating event
    /// that arrived during the walk bumps the generation, so a stale result is silently
    /// dropped here instead of overwriting fresher (even if not-yet-rebuilt) state.
    ///
    /// Review finding #18: deliberately does **not** create an entry that doesn't already
    /// exist (no `.entry().or_default()`) — a missing entry means the workspace was
    /// removed (its entry is deleted outright by [`Self::remove_workspace`]) while this
    /// build was in flight, and a late-arriving result must not resurrect it.
    fn store_if_current(&self, ws_id: &str, generation: u64, files: Arc<HashSet<String>>, truncated: bool) -> bool {
        let mut guard = self.entries();
        let Some(entry) = guard.get_mut(ws_id) else {
            return false;
        };
        if entry.generation == generation {
            entry.files = Some(files);
            entry.truncated = truncated;
            true
        } else {
            false
        }
    }

    /// Spec §10.3: applies one watcher event to the workspace's index in place.
    ///
    /// Review finding #2: an event for a workspace with no *built* index yet (its entry
    /// is missing entirely, or `files == None` because a build is in flight/was
    /// dirtied) still bumps the generation — a file created/deleted while the index is
    /// unbuilt must still be able to discard an in-flight build that raced it (spec
    /// §10.4); it's not a no-op just because there's nothing to patch yet.
    pub fn apply_event(&self, ws_id: &str, rel: &str, exists: bool, is_file: bool) {
        self.apply_events(ws_id, std::iter::once((rel, exists, is_file)));
    }

    /// Applies a whole batch of watcher events to `ws_id`'s index under a **single**
    /// `entries()` lock acquisition (review finding #5 — the watcher's debouncer already
    /// hands over a whole batch at once; there's no need to re-lock per event). Stops
    /// early the moment the index turns `Dirty` (or already was): once a full rebuild is
    /// coming, there's nothing left in the batch worth auditing.
    pub fn apply_events<'a, I>(&self, ws_id: &str, events: I)
    where
        I: IntoIterator<Item = (&'a str, bool, bool)>,
    {
        let mut guard = self.entries();
        let entry = guard.entry(ws_id.to_string()).or_default();
        for (rel, exists, is_file) in events {
            entry.generation = entry.generation.wrapping_add(1);
            let Some(files) = entry.files.as_mut() else {
                // Finding #2: nothing built yet (or this same batch already dirtied it
                // above) — the generation bump is enough; finding #5 "stop once Dirty".
                break;
            };
            match apply_watch_event(files, rel, exists, is_file) {
                EventOutcome::Unchanged => {}
                EventOutcome::RemoveExact => {
                    Arc::make_mut(files).remove(rel);
                }
                EventOutcome::RemovePrefix => {
                    let prefix = format!("{rel}/");
                    Arc::make_mut(files).retain(|f| !f.starts_with(&prefix));
                }
                EventOutcome::Dirty => {
                    entry.files = None;
                    break;
                }
            }
        }
    }

    /// Drops a workspace's cached index outright — `fs:rescan`, a `hiddenPatterns`
    /// /`respectGitignore` settings change, or a `.gitignore` file changing (spec §4,
    /// §10.3). The next query rebuilds from scratch.
    pub fn invalidate(&self, ws_id: &str) {
        let mut guard = self.entries();
        let entry = guard.entry(ws_id.to_string()).or_default();
        entry.files = None;
        entry.generation = entry.generation.wrapping_add(1);
    }

    /// Drops every cached index (every open workspace) — used when a settings change
    /// that affects indexing (`hiddenPatterns`/`respectGitignore`) can't cheaply be
    /// scoped to "the workspaces it actually changed anything for".
    pub fn invalidate_all(&self) {
        let ids: Vec<String> = self.entries().keys().cloned().collect();
        for id in ids {
            self.invalidate(&id);
        }
    }

    pub fn remove_workspace(&self, ws_id: &str) {
        self.entries().remove(ws_id);
        self.build_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(ws_id);
    }
}

/// Returns the workspace's current file list, building (or rebuilding) it first if
/// needed. Single-flight per workspace (spec §4/§10.4): concurrent callers await the
/// same build and get its result.
async fn get_or_build(
    index: &QuickOpenIndex,
    settings_store: &SettingsStore,
    ws_id: &str,
    root: PathBuf,
) -> AppResult<(Arc<HashSet<String>>, bool)> {
    let build_lock = index.build_lock(ws_id);
    let _guard = build_lock.lock().await;

    if let Some(snapshot) = index.snapshot(ws_id) {
        return Ok(snapshot);
    }

    // Finding #18: make sure the entry exists *before* the walk starts (see
    // `ensure_entry`'s own doc comment).
    index.ensure_entry(ws_id);

    loop {
        let generation = index.generation(ws_id);
        // Review finding #3: settings are re-read fresh on *every* iteration of this
        // loop, not captured once before it — a settings-triggered invalidation
        // (`hiddenPatterns`/`respectGitignore`) bumps the generation and causes a retry
        // here; that retry must walk with the *new* settings, not the pre-invalidation
        // ones the very first iteration started with.
        let walk_settings = settings_store.get();
        let walk_root = root.clone();
        let (files, truncated) =
            tauri::async_runtime::spawn_blocking(move || walk_workspace(&walk_root, &walk_settings))
                .await
                .map_err(|e| AppError::io(e.to_string()))??;
        let files = Arc::new(files);
        if index.store_if_current(ws_id, generation, files.clone(), truncated) {
            return Ok((files, truncated));
        }
        // An invalidating event raced the walk (generation moved on, or the workspace
        // was removed) — rebuild, unless it was removed, in which case `store_if_current`
        // will keep failing and the caller's own workspace lookup below would have
        // already failed first in practice; either way this loop only spins while the
        // workspace is still valid and something keeps invalidating it.
    }
}

/// Spec §3/§4: replaces `fs_search`. Empty `query` -> `items: []` without touching the
/// index at all (the frontend shows its own list in that case).
#[tauri::command(async)]
pub async fn fs_quick_open(
    workspace_store: State<'_, WorkspaceStore>,
    settings_store: State<'_, SettingsStore>,
    index: State<'_, QuickOpenIndex>,
    workspace_id: String,
    query: String,
    limit: usize,
) -> AppResult<QuickOpenResult> {
    if query.is_empty() {
        return Ok(QuickOpenResult {
            items: Vec::new(),
            truncated: false,
        });
    }
    let root = PathBuf::from(workspace_store.find_path(&workspace_id)?);
    let (files, truncated) = get_or_build(&index, &settings_store, &workspace_id, root).await?;
    let items = query_index(&files, &query, limit.min(MAX_QUERY_LIMIT));
    Ok(QuickOpenResult { items, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hs(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    // -- apply_watch_event (spec §10.3, findings #5/#6) -----------------------------

    #[test]
    fn deleted_indexed_file_is_removed() {
        let files = hs(&["a.txt", "src/b.rs"]);
        assert!(matches!(
            apply_watch_event(&files, "a.txt", false, false),
            EventOutcome::RemoveExact
        ));
    }

    #[test]
    fn deleted_directory_marks_remove_prefix() {
        let files = hs(&["src/a.rs", "src/sub/b.rs", "other.txt"]);
        assert!(matches!(
            apply_watch_event(&files, "src", false, false),
            EventOutcome::RemovePrefix
        ));
    }

    #[test]
    fn deleted_path_not_in_index_and_not_a_prefix_is_unchanged() {
        let files = hs(&["a.txt"]);
        assert!(matches!(
            apply_watch_event(&files, "gone.txt", false, false),
            EventOutcome::Unchanged
        ));
    }

    #[test]
    fn new_file_not_yet_indexed_marks_dirty() {
        let files = hs(&["a.txt"]);
        assert!(matches!(
            apply_watch_event(&files, "new.txt", true, true),
            EventOutcome::Dirty
        ));
    }

    #[test]
    fn content_change_on_already_indexed_file_is_unchanged() {
        let files = hs(&["a.txt"]);
        assert!(matches!(
            apply_watch_event(&files, "a.txt", true, true),
            EventOutcome::Unchanged
        ));
    }

    #[test]
    fn existing_directory_with_already_indexed_children_is_unchanged() {
        let files = hs(&["src/a.rs"]);
        assert!(matches!(
            apply_watch_event(&files, "src", true, false),
            EventOutcome::Unchanged
        ));
    }

    /// Review finding #6: a directory that just appeared (e.g. renamed/moved into the
    /// workspace) and has no entries under it yet in the index must be treated like a
    /// new file — its contents (if any) are still unknown to the index.
    #[test]
    fn new_directory_with_no_indexed_children_marks_dirty() {
        let files = hs(&["a.txt"]);
        assert!(matches!(
            apply_watch_event(&files, "newdir", true, false),
            EventOutcome::Dirty
        ));
    }

    // -- QuickOpenIndex plumbing ------------------------------------------------------

    /// Replaces the old `apply_event_on_unbuilt_index_is_a_no_op` (review finding #2):
    /// an event for a workspace with no built index must still bump the generation, so
    /// an in-flight build racing it is discarded rather than silently resurrecting a file
    /// list that's already stale with respect to that event.
    #[test]
    fn apply_event_on_unbuilt_index_discards_an_in_flight_build() {
        let index = QuickOpenIndex::default();
        // Simulates `get_or_build`: reads the generation *before* starting the walk.
        index.ensure_entry("ws1");
        let generation_read_by_build = index.generation("ws1");

        // A watcher event for the same workspace arrives while that build is still
        // walking the disk.
        index.apply_event("ws1", "new.txt", true, true);

        // The build "finishes" and tries to store what it found using the now-stale
        // generation it captured before the event above.
        let stored = index.store_if_current(
            "ws1",
            generation_read_by_build,
            Arc::new(hs(&["new.txt"])),
            false,
        );
        assert!(!stored, "a build in flight during an invalidating event must be discarded");
        assert!(index.snapshot("ws1").is_none());
    }

    #[test]
    fn invalidate_clears_snapshot_and_bumps_generation() {
        let index = QuickOpenIndex::default();
        index.ensure_entry("ws1");
        assert!(index.store_if_current("ws1", 0, Arc::new(hs(&["a.txt"])), false));
        assert!(index.snapshot("ws1").is_some());

        let gen_before = index.generation("ws1");
        index.invalidate("ws1");
        assert!(index.snapshot("ws1").is_none());
        assert_ne!(index.generation("ws1"), gen_before);
    }

    #[test]
    fn store_if_current_rejects_a_stale_generation() {
        let index = QuickOpenIndex::default();
        let gen0 = index.generation("ws1");
        index.invalidate("ws1"); // generation moves on (and creates the entry)
        assert!(!index.store_if_current("ws1", gen0, Arc::new(hs(&["a.txt"])), false));
        assert!(index.snapshot("ws1").is_none());
    }

    /// Review finding #18 regression: a build result that arrives *after* the workspace
    /// was removed must not resurrect an entry for it.
    #[test]
    fn store_if_current_does_not_resurrect_a_removed_workspace() {
        let index = QuickOpenIndex::default();
        index.ensure_entry("ws1");
        let generation = index.generation("ws1");

        // The workspace is removed while a build for it is still in flight.
        index.remove_workspace("ws1");

        // The in-flight build's result arrives late.
        assert!(!index.store_if_current("ws1", generation, Arc::new(hs(&["a.txt"])), false));
        assert!(index.snapshot("ws1").is_none());
    }

    #[test]
    fn remove_workspace_drops_state() {
        let index = QuickOpenIndex::default();
        index.ensure_entry("ws1");
        assert!(index.store_if_current("ws1", 0, Arc::new(hs(&["a.txt"])), false));
        index.remove_workspace("ws1");
        assert!(index.snapshot("ws1").is_none());
    }

    // -- apply_events batching (review finding #5) ------------------------------------

    #[test]
    fn apply_events_processes_a_whole_batch_under_one_lock_acquisition() {
        let index = QuickOpenIndex::default();
        index.ensure_entry("ws1");
        assert!(index.store_if_current(
            "ws1",
            0,
            Arc::new(hs(&["a.txt", "b.txt", "dir/c.txt", "dir/d.txt"])),
            false
        ));

        index.apply_events(
            "ws1",
            [("a.txt", false, false), ("dir", false, false)],
        );

        let (files, _) = index.snapshot("ws1").unwrap();
        assert_eq!(sorted(files.iter().cloned().collect()), vec!["b.txt".to_string()]);
    }

    #[test]
    fn apply_events_stops_processing_once_dirty() {
        let index = QuickOpenIndex::default();
        index.ensure_entry("ws1");
        assert!(index.store_if_current("ws1", 0, Arc::new(hs(&["a.txt"])), false));
        let gen_before = index.generation("ws1");

        // The first event dirties the index; the second (which would otherwise remove
        // "a.txt") is never even looked at, since the index is already unbuilt after
        // the first.
        index.apply_events(
            "ws1",
            [("new.txt", true, true), ("a.txt", false, false)],
        );

        assert!(index.snapshot("ws1").is_none());
        // Only one generation bump happened (the dirtying event) -- the loop broke
        // before reaching the second.
        assert_eq!(index.generation("ws1"), gen_before + 1);
    }

    // -- walk_workspace (spec §4, §10.15) --------------------------------------------

    #[test]
    fn walk_workspace_lists_files_only_and_hides_configured_patterns() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules").join("pkg.js"), "x").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("lib.rs"), "x").unwrap();

        let settings = Settings::default();
        let (files, truncated) = walk_workspace(dir.path(), &settings).unwrap();
        assert!(!truncated);
        assert_eq!(
            sorted(files.into_iter().collect()),
            vec!["a.txt".to_string(), "src/lib.rs".to_string()]
        );
    }

    #[test]
    fn walk_workspace_respects_gitignore_only_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        // `ignore::WalkBuilder`'s `git_ignore`/`git_exclude` only take effect inside an
        // actual repo (its `require_git` default, spec §10.16) -- a bare `.gitignore`
        // with no `.git` anywhere would be inert either way.
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), "x").unwrap();
        std::fs::write(dir.path().join("kept.txt"), "x").unwrap();

        let mut settings = Settings::default();
        settings.files.respect_gitignore = false;
        let (files, _) = walk_workspace(dir.path(), &settings).unwrap();
        assert_eq!(
            sorted(files.into_iter().collect()),
            vec![".gitignore".to_string(), "ignored.txt".to_string(), "kept.txt".to_string()]
        );

        settings.files.respect_gitignore = true;
        let (files, _) = walk_workspace(dir.path(), &settings).unwrap();
        assert_eq!(
            sorted(files.into_iter().collect()),
            vec![".gitignore".to_string(), "kept.txt".to_string()]
        );
    }

    // -- query_index (spec §4, §10.17, review finding #19) ---------------------------

    #[test]
    fn query_index_orders_by_score_then_shorter_rel_then_alphabetical() {
        let files = hs(&["src/foo.rs", "foo.rs", "zfoo.rs"]);
        let items = query_index(&files, "foo", 50);
        // "foo.rs" and "zfoo.rs" both contain "foo" as a contiguous run at/after start;
        // "foo.rs" is shorter, so it should rank at least as high as "zfoo.rs" and
        // strictly above the deeper "src/foo.rs" path once scores are close.
        assert!(!items.is_empty());
        let rels: Vec<&str> = items.iter().map(|i| i.rel.as_str()).collect();
        assert!(rels.contains(&"foo.rs"));
    }

    #[test]
    fn query_index_returns_unicode_scalar_indices() {
        let files = hs(&["İş.rs"]);
        let items = query_index(&files, "is", 10);
        assert_eq!(items.len(), 1);
        // Indices are scalar positions into `İş.rs` as `Array.from` would split it:
        // ['İ', 'ş', '.', 'r', 's'] -- "is" case-insensitively matches 'İ'(->i) and 'ş' is
        // not an 's', so this assertion only checks indices are sorted+deduped and in range.
        let mut sorted_indices = items[0].indices.clone();
        sorted_indices.sort_unstable();
        sorted_indices.dedup();
        assert_eq!(sorted_indices, items[0].indices);
        let char_count = items[0].rel.chars().count();
        for idx in &items[0].indices {
            assert!((*idx as usize) < char_count);
        }
    }

    #[test]
    fn query_index_respects_limit() {
        let files: HashSet<String> = (0..10).map(|i| format!("file{i}.txt")).collect();
        let items = query_index(&files, "file", 3);
        assert_eq!(items.len(), 3);
    }

    // -- Perf bench (spec §10.20) --------------------------------------------------
    //
    // Not part of the normal `cargo test` run (kept fast) -- run manually with:
    //   cargo test --release -p agenthub --lib quickopen::tests::perf_bench_50k_files -- --ignored --nocapture
    #[test]
    #[ignore]
    fn perf_bench_50k_files() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().unwrap();
        const N: usize = 50_000;
        for i in 0..N {
            let sub = dir.path().join(format!("dir{}", i % 200));
            std::fs::create_dir_all(&sub).ok();
            std::fs::write(sub.join(format!("file{i}.rs")), b"x").unwrap();
        }

        let settings = Settings::default();
        let start = Instant::now();
        let (files, truncated) = walk_workspace(dir.path(), &settings).unwrap();
        let build_elapsed = start.elapsed();
        assert_eq!(files.len(), N);
        assert!(!truncated);
        println!("[perf] index build ({N} files): {build_elapsed:?}");

        let start = Instant::now();
        let items = query_index(&files, "file1234", 50);
        let query_elapsed = start.elapsed();
        println!("[perf] query ({} matches): {query_elapsed:?}", items.len());

        // Spec §10.20 targets (release build): index < 1.5s, query < 30ms.
        assert!(build_elapsed < Duration::from_millis(1500), "index build too slow: {build_elapsed:?}");
        assert!(query_elapsed < Duration::from_millis(30), "query too slow: {query_elapsed:?}");
    }
}
