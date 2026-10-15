//! Per-workspace file watching (Faz 2 spec §4, §5, §8.6, §8.10).
//!
//! One `notify-debouncer-mini` (150 ms) per workspace, started on load/add and stopped
//! on remove. Batches are post-filtered against the same hidden-name set as
//! `fs_read_dir`, deduplicated to parent directories, and emitted as a single
//! `fs:changed { workspaceId, dirs }`; a watch/backend error is reported as
//! `fs:rescan { workspaceId }` so the frontend can fall back to reloading everything it
//! has loaded for that workspace.
//!
//! Deliberately `notify-debouncer-mini`, not `-full`: `-full` builds a whole-tree
//! file-id cache up front to detect renames, which is exactly the "walk the whole tree
//! at startup" cost the spec calls out as unwanted (§8.10). `-mini` only tracks paths
//! it has actually seen an event for.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::gitignore_tree::GitignoreTreeCache;
use crate::quickopen::QuickOpenIndex;
use crate::settings::SettingsStore;

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    workspace_id: String,
    dirs: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FsRescanPayload {
    workspace_id: String,
}

struct WatchHandle {
    // Held only to keep the watcher alive — dropping it stops the debounce thread and
    // the underlying OS watch.
    _debouncer: Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>,
}

/// Managed as Tauri app state. Keyed by workspace id.
#[derive(Default)]
pub struct WatcherRegistry {
    handles: Mutex<HashMap<String, WatchHandle>>,
}

impl WatcherRegistry {
    fn handles(&self) -> MutexGuard<'_, HashMap<String, WatchHandle>> {
        self.handles.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Starts (or restarts) watching `root_path` for `workspace_id`. A root that
    /// doesn't exist, or a watcher that fails to start, is logged to stderr and
    /// skipped — never crashes the app (spec §5: "Watcher başlatma hatası uygulamayı
    /// çökertmez").
    pub fn start(&self, app: AppHandle, workspace_id: String, root_path: String) {
        self.stop(&workspace_id);

        let root = PathBuf::from(&root_path);
        if !root.is_dir() {
            log::warn!("watcher: workspace root missing, not watching (workspace={workspace_id}: {root_path})");
            return;
        }

        let cb_app = app.clone();
        let cb_workspace_id = workspace_id.clone();
        let cb_root = root.clone();
        let mut debouncer = match new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
            handle_debounce_result(&cb_app, &cb_workspace_id, &cb_root, result);
        }) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("watcher could not be created for workspace={workspace_id}: {e}");
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
            log::warn!("watch() failed for workspace={workspace_id}: {e}");
            return;
        }

        self.handles().insert(
            workspace_id,
            WatchHandle {
                _debouncer: debouncer,
            },
        );
    }

    /// Stops watching `workspace_id`, if it was being watched. No-op otherwise.
    pub fn stop(&self, workspace_id: &str) {
        self.handles().remove(workspace_id);
    }
}

/// Faz 6 §10.14: the watcher's own hidden-name check is no longer an independent
/// hardcoded list — it reads the same compiled `GlobSet` `fs_read_dir` and the
/// quick-open walker use (`SettingsStore::hidden_globset`), so a `hiddenPatterns` change
/// takes effect here too without a second place to update.
fn is_hidden_rel(rel: &str, hidden: &globset::GlobSet) -> bool {
    rel.split('/').any(|segment| hidden.is_match(segment))
}

/// Case-insensitive `strip_prefix(root)`, normalized to `/`. Returns `None` if `path` is
/// not under `root` (triggers `fs:rescan` — the watch is on a stale/foreign path).
fn to_rel_ci(root: &Path, path: &Path) -> Option<String> {
    crate::fsguard::rel_under_ci(root, path)
}

fn handle_debounce_result(
    app: &AppHandle,
    workspace_id: &str,
    root: &Path,
    result: DebounceEventResult,
) {
    let events = match result {
        Ok(events) => events,
        Err(_) => {
            emit_rescan(app, workspace_id);
            return;
        }
    };

    let hidden = app
        .try_state::<SettingsStore>()
        .map(|s| s.hidden_globset())
        .unwrap_or_default();

    let mut dirs: Vec<String> = Vec::new();
    // 0.3.2: membership check for `dirs` (a big batch made `Vec::contains` quadratic);
    // `dirs` itself keeps the batch's first-seen order.
    let mut dir_set: HashSet<String> = HashSet::new();
    // Faz 6 §10.3, review finding #5: the whole debounce batch's effect on the quick-open
    // index is applied in one `apply_events` call (one `entries()` lock acquisition)
    // instead of once per event.
    let mut quickopen_events: Vec<(String, bool, bool)> = Vec::new();
    let mut gitignore_changed = false;

    for event in events {
        // A changed path's *parent* is what the tree needs to re-read; a change to the
        // root itself (parent has no strippable remainder) surfaces as `""` (spec §8.6).
        let parent = event.path.parent().unwrap_or(&event.path);
        match to_rel_ci(root, parent) {
            Some(rel) => {
                if !is_hidden_rel(&rel, &hidden) && dir_set.insert(rel.clone()) {
                    dirs.push(rel);
                }
            }
            None => {
                emit_rescan(app, workspace_id);
                return;
            }
        }

        // Faz 6 §10.3/§10.16: collect this event's quick-open effect and note whether a
        // `.gitignore` itself changed — best-effort (a fresh app run before either piece
        // of state exists yet, e.g. very early in `setup`, is a harmless no-op via
        // `try_state`).
        if let Some(rel) = to_rel_ci(root, &event.path) {
            if is_hidden_rel(&rel, &hidden) {
                continue;
            }
            let exists = event.path.exists();
            let is_file = exists && event.path.is_file();
            quickopen_events.push((rel, exists, is_file));

            let is_gitignore = event
                .path
                .file_name()
                .map(|n| n.eq_ignore_ascii_case(".gitignore"))
                .unwrap_or(false);
            if is_gitignore {
                gitignore_changed = true;
            }
        }
    }

    // Review finding #11: a `.gitignore` change must also emit `fs:rescan` (not just
    // invalidate the caches) so the frontend reloads every expanded dir for this
    // workspace, exactly like a watcher/backend error already does. `emit_rescan` already
    // invalidates both the quick-open index and the tree gitignore matcher cache, so it
    // fully supersedes applying the incremental batch below for this workspace.
    if gitignore_changed {
        emit_rescan(app, workspace_id);
    } else if !quickopen_events.is_empty() {
        if let Some(index) = app.try_state::<QuickOpenIndex>() {
            index.apply_events(
                workspace_id,
                quickopen_events
                    .iter()
                    .map(|(rel, exists, is_file)| (rel.as_str(), *exists, *is_file)),
            );
        }
    }

    if !dirs.is_empty() {
        let _ = app.emit(
            "fs:changed",
            FsChangedPayload {
                workspace_id: workspace_id.to_string(),
                dirs,
            },
        );
    }
}

/// Spec §10.3: `fs:rescan` counts as "dirty" for the quick-open index and drops the tree
/// gitignore matcher cache too — both are rebuilt fresh from disk on next use.
fn emit_rescan(app: &AppHandle, workspace_id: &str) {
    if let Some(index) = app.try_state::<QuickOpenIndex>() {
        index.invalidate(workspace_id);
    }
    if let Some(cache) = app.try_state::<GitignoreTreeCache>() {
        cache.invalidate(workspace_id);
    }
    let _ = app.emit(
        "fs:rescan",
        FsRescanPayload {
            workspace_id: workspace_id.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_rel_ci_handles_root_and_children_case_insensitively() {
        let root = Path::new(r"C:\Work\Proj");
        assert_eq!(to_rel_ci(root, Path::new(r"C:\WORK\proj")), Some(String::new()));
        assert_eq!(
            to_rel_ci(root, Path::new(r"c:\work\proj\src\lib.rs")),
            Some("src/lib.rs".to_string())
        );
        assert_eq!(to_rel_ci(root, Path::new(r"C:\Other\thing")), None);
        assert_eq!(to_rel_ci(root, Path::new(r"C:\Work\Project\x")), None);

        // Turkish İ lowercases to two chars; a byte-offset strip would misalign here.
        let tr_root = Path::new(r"C:\Users\İpek\Proj");
        assert_eq!(
            to_rel_ci(tr_root, Path::new(r"c:\users\i̇pek\proj\src\İş.rs")),
            Some("src/İş.rs".to_string())
        );
    }

    #[test]
    fn is_hidden_rel_matches_any_path_segment() {
        let hidden = crate::settings::build_hidden_globset(&[
            ".git".to_string(),
            "node_modules".to_string(),
            "dist".to_string(),
            "target".to_string(),
            ".DS_Store".to_string(),
        ]);
        assert!(is_hidden_rel("node_modules", &hidden));
        assert!(is_hidden_rel("src/node_modules/pkg", &hidden));
        assert!(is_hidden_rel(".git", &hidden));
        assert!(!is_hidden_rel("src/lib.rs", &hidden));
        assert!(!is_hidden_rel("", &hidden));
    }
}
