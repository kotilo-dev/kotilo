//! `workspace_*` commands (Faz 2 spec §3, §8.3): thin wrappers around
//! [`WorkspaceStore`] that additionally persist via [`StateStore`], start/stop the
//! per-workspace watcher, and — except `workspace_set_expanded` — emit
//! `workspaces:changed`.

use tauri::{AppHandle, Emitter, State};

use crate::error::AppResult;
use crate::gitignore_tree::GitignoreTreeCache;
use crate::persistence::StateStore;
use crate::quickopen::QuickOpenIndex;
use crate::watcher::WatcherRegistry;
use crate::workspace::{Workspace, WorkspaceStore, WorkspacesState};

const EVENT_WORKSPACES_CHANGED: &str = "workspaces:changed";

#[tauri::command]
pub fn workspace_list(store: State<'_, WorkspaceStore>) -> AppResult<WorkspacesState> {
    Ok(store.list())
}

#[tauri::command]
pub fn workspace_add(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    watchers: State<'_, WatcherRegistry>,
    path: String,
) -> AppResult<Workspace> {
    let snapshot = store.add(&state_store, &path)?;
    let added = snapshot
        .workspaces
        .last()
        .cloned()
        .expect("add() always pushes the new workspace last");
    watchers.start(app.clone(), added.id.clone(), added.path.clone());
    let _ = app.emit(EVENT_WORKSPACES_CHANGED, &snapshot);
    Ok(added)
}

#[tauri::command]
pub fn workspace_remove(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    watchers: State<'_, WatcherRegistry>,
    quick_open: State<'_, QuickOpenIndex>,
    gitignore_cache: State<'_, GitignoreTreeCache>,
    id: String,
) -> AppResult<()> {
    let snapshot = store.remove(&state_store, &id)?;
    watchers.stop(&id);
    // Faz 6 §4/§10.16 (finding #4/#18): a removed workspace's cached index/gitignore
    // matcher are meaningless (and would otherwise just leak, including the per-workspace
    // build-lock entry) once its id can never come back -- `remove_workspace` drops the
    // whole entry rather than just invalidating it, so a late-arriving in-flight build
    // can't resurrect it either.
    quick_open.remove_workspace(&id);
    gitignore_cache.remove_workspace(&id);
    let _ = app.emit(EVENT_WORKSPACES_CHANGED, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn workspace_rename(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    id: String,
    name: String,
) -> AppResult<()> {
    let snapshot = store.rename(&state_store, &id, &name)?;
    let _ = app.emit(EVENT_WORKSPACES_CHANGED, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn workspace_reorder(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    ids: Vec<String>,
) -> AppResult<()> {
    let snapshot = store.reorder(&state_store, &ids)?;
    let _ = app.emit(EVENT_WORKSPACES_CHANGED, &snapshot);
    Ok(())
}

#[tauri::command]
pub fn workspace_set_active(
    app: AppHandle,
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    id: String,
) -> AppResult<()> {
    let snapshot = store.set_active(&state_store, &id)?;
    let _ = app.emit(EVENT_WORKSPACES_CHANGED, &snapshot);
    Ok(())
}

/// §8.3: persists but never emits `workspaces:changed` — the frontend's own `expanded`
/// state is the single source of truth after startup, this just makes it durable across
/// restarts.
#[tauri::command]
pub fn workspace_set_expanded(
    store: State<'_, WorkspaceStore>,
    state_store: State<'_, StateStore>,
    id: String,
    dirs: Vec<String>,
) -> AppResult<()> {
    store.set_expanded(&state_store, &id, dirs)
}
