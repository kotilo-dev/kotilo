//! Faz 5 §1.6: agent-tracking commands. All decision logic lives in
//! `crate::agents::AgentTracker` — these are thin IPC wrappers. M3: adapter definitions
//! and `pane_send_keys`.

use tauri::State;

use crate::adapters::user::{self, UserDefinitionError};
use crate::adapters::{AdapterDefinition, AdapterDirs, DefinitionsView};
use crate::agents::{Agent, AgentTracker};
use crate::error::{AppError, AppResult};
use crate::pty::PtyRegistry;

#[tauri::command(async)]
pub fn agents_list(tracker: State<'_, AgentTracker>) -> Vec<Agent> {
    tracker.snapshot()
}

/// `done -> idle`; no-op for an unknown pane or one not currently `done` (spec §1.6).
#[tauri::command(async)]
pub fn agent_ack(tracker: State<'_, AgentTracker>, pane_id: String) -> AppResult<()> {
    tracker.ack(&pane_id);
    Ok(())
}

/// Spec §1.6: the frontend calls this on every visible-terminal change and window
/// focus/blur change (its own 100 ms debounce) — the backend applies it immediately.
#[tauri::command(async)]
pub fn agent_set_focus(
    tracker: State<'_, AgentTracker>,
    visible_pane_id: Option<String>,
    window_focused: bool,
) -> AppResult<()> {
    tracker.set_focus(visible_pane_id, window_focused);
    Ok(())
}

/// M3: the loaded adapter definitions (built-in + user) and the files that failed to load.
#[tauri::command(async)]
pub fn agents_definitions(tracker: State<'_, AgentTracker>) -> DefinitionsView {
    tracker.definitions().view()
}

/// M3: re-reads every definition (after the user edits or adds an adapter file).
#[tauri::command(async)]
pub fn agents_definitions_reload(
    tracker: State<'_, AgentTracker>,
    dirs: State<'_, AdapterDirs>,
) -> DefinitionsView {
    tracker.set_definitions(dirs.load());
    tracker.definitions().view()
}

/// M3: ids of the loaded definitions whose `detect.executables` are on `PATH` (the launch
/// menu offers only these). A plain file lookup per `PATH` entry, no process is started.
#[tauri::command(async)]
pub fn agents_installed(tracker: State<'_, AgentTracker>) -> Vec<String> {
    user::installed_ids(&tracker.definitions(), &user::path_dirs())
}

fn map_user_error(e: UserDefinitionError) -> AppError {
    match e {
        UserDefinitionError::Invalid(_) | UserDefinitionError::BuiltInId(_) => AppError::invalid_argument(e.to_string()),
        UserDefinitionError::Exists(_) => AppError::already_exists(e.to_string()),
        UserDefinitionError::NotFound(_) => AppError::not_found(e.to_string()),
        UserDefinitionError::Io(_) => AppError::io(e.to_string()),
    }
}

fn user_dir_of(dirs: &AdapterDirs) -> AppResult<&std::path::Path> {
    dirs.user
        .as_deref()
        .ok_or_else(|| AppError::io("the user adapter folder is not known"))
}

/// M3: writes a custom agent's `adapter.json` (validated like the loader; built-in ids and,
/// without `overwrite`, existing files are refused) and reloads every definition. The hub
/// re-reads its copy on `POST /v1/adapters/reload`, which the UI calls next.
/// Errors: `invalid_argument`, `already_exists`, `io`.
#[tauri::command(async)]
pub fn agents_save_user_definition(
    tracker: State<'_, AgentTracker>,
    dirs: State<'_, AdapterDirs>,
    definition: AdapterDefinition,
    overwrite: Option<bool>,
) -> AppResult<DefinitionsView> {
    let builtin = user::builtin_ids(&tracker.definitions(), dirs.builtin.as_deref());
    user::save_user_definition(user_dir_of(&dirs)?, &builtin, definition, overwrite.unwrap_or(false)).map_err(map_user_error)?;
    tracker.set_definitions(dirs.load());
    Ok(tracker.definitions().view())
}

/// M3: deletes a custom agent's `adapter.json` and reloads. Errors: `invalid_argument`
/// (built-in or malformed id), `not_found`, `io`.
#[tauri::command(async)]
pub fn agents_delete_user_definition(
    tracker: State<'_, AgentTracker>,
    dirs: State<'_, AdapterDirs>,
    id: String,
) -> AppResult<DefinitionsView> {
    let builtin = user::builtin_ids(&tracker.definitions(), dirs.builtin.as_deref());
    user::delete_user_definition(user_dir_of(&dirs)?, &builtin, &id).map_err(map_user_error)?;
    tracker.set_definitions(dirs.load());
    Ok(tracker.definitions().view())
}

/// M3: writes a key sequence in `adapters::keys` notation (`Esc`, `Enter`, `Right`, `1`,
/// `y`, `Ctrl+C`, `Down Enter`, ...) to a pane — the permission card's keys. Unknown
/// pane -> no-op, like `pty_write`.
#[tauri::command(async)]
pub fn pane_send_keys(registry: State<'_, PtyRegistry>, pane_id: String, keys: String) -> AppResult<()> {
    let bytes = crate::adapters::keys::parse_keys(&keys).map_err(AppError::invalid_argument)?;
    crate::pty::write_bytes_to_pane(&registry, &pane_id, &bytes)
}
