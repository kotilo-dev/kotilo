//! 0.9 Context (D-076): thin Tauri wrappers around `crate::context`.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::adapters::Definitions;
use crate::agents::AgentTracker;
use crate::context::{self, ContextError, ContextReport, ContextText};
use crate::error::{AppError, AppResult};
use crate::workspace::WorkspaceStore;

fn map_err(e: ContextError) -> AppError {
    match e {
        e @ (ContextError::UnknownAgent(_) | ContextError::NotListed) => AppError::invalid_argument(e.to_string()),
        ContextError::Io(e) => e.into(),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::io(format!("context task failed: {e}")))?
}

fn home() -> Option<PathBuf> {
    crate::platform::home_dir(&|k| std::env::var(k).ok()).map(PathBuf::from)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAgent {
    pub id: String,
    pub display_name: String,
    /// The adapter has a `context` section.
    pub supported: bool,
}

/// Every loaded adapter and whether it describes its context.
#[tauri::command]
pub fn context_agents(tracker: State<'_, AgentTracker>) -> Vec<ContextAgent> {
    tracker
        .definitions()
        .items
        .iter()
        .map(|d| ContextAgent {
            id: d.def.id.clone(),
            display_name: d.def.display_name.clone(),
            supported: d.def.context.is_some(),
        })
        .collect()
}

fn definition(defs: &Arc<Definitions>, agent: &str) -> AppResult<crate::adapters::AdapterDefinition> {
    defs.get(agent)
        .map(|d| d.def.clone())
        .ok_or_else(|| map_err(ContextError::UnknownAgent(agent.to_string())))
}

/// Instruction files, rules, skills and MCP servers `agent` picks up in the workspace.
#[tauri::command]
pub async fn context_report(
    store: State<'_, WorkspaceStore>,
    tracker: State<'_, AgentTracker>,
    workspace_id: String,
    agent: String,
) -> AppResult<ContextReport> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    let def = definition(&tracker.definitions(), &agent)?;
    blocking(move || Ok(context::report(&def, &root, home().as_deref(), crate::platform::os_id()))).await
}

/// Text of a file `context_report` lists under `files` or `skills` (at most 256 KiB).
#[tauri::command]
pub async fn context_read(
    store: State<'_, WorkspaceStore>,
    tracker: State<'_, AgentTracker>,
    workspace_id: String,
    agent: String,
    path: String,
) -> AppResult<ContextText> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    let def = definition(&tracker.definitions(), &agent)?;
    blocking(move || {
        context::read(&def, &root, home().as_deref(), crate::platform::os_id(), &path).map_err(map_err)
    })
    .await
}
