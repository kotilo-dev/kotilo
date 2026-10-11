//! `settings_*` commands (Faz 6 spec §1.2): thin wrappers around [`SettingsStore`] that
//! additionally emit `settings:changed` after a successful write.

use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::gitignore_tree::GitignoreTreeCache;
use crate::quickopen::QuickOpenIndex;
use crate::settings::{Settings, SettingsStore};

const EVENT_SETTINGS_CHANGED: &str = "settings:changed";

#[tauri::command(async)]
pub fn settings_get(store: State<'_, SettingsStore>) -> AppResult<Settings> {
    Ok(store.get())
}

/// Full replace: `settings` is normalized/validated (§1.1), persisted atomically, and
/// the write guard is released *before* the event is emitted (§10.5) — a listener that
/// reacts to `settings:changed` by reading `SettingsStore` again always sees the value
/// that was just written, never an earlier one.
///
/// Spec §4: a `files.hiddenPatterns`/`files.respectGitignore` change invalidates every
/// open workspace's quick-open index (content itself isn't re-checked incrementally —
/// see `quickopen`'s §10.3 pure function) and the tree gitignore matcher cache.
#[tauri::command(async)]
pub fn settings_set(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    quick_open: State<'_, QuickOpenIndex>,
    gitignore_cache: State<'_, GitignoreTreeCache>,
    settings: Settings,
) -> AppResult<Settings> {
    let before = store.get();
    let saved = store.set(settings)?;
    if before.files != saved.files {
        quick_open.invalidate_all();
        gitignore_cache.invalidate_all();
    }
    if before.diagnostics != saved.diagnostics {
        // Faz 7 §9.1: "Verbose logging" takes effect immediately, no restart — this is
        // the live global level ceiling, applied at startup too (see `lib.rs::run`).
        crate::logging::apply_verbose_logging(saved.diagnostics.verbose_logging);
    }
    let _ = app.emit(EVENT_SETTINGS_CHANGED, &saved);
    Ok(saved)
}
