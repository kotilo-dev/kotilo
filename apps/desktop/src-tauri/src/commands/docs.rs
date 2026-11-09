//! 0.7 docs: thin Tauri wrappers around the `agenthub-docs` crate (shared with the
//! `kotilo-docs` CLI). See D-074.

use std::path::PathBuf;

use agenthub_docs::{CheckOptions, DocsError, DocsReport};
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::workspace::WorkspaceStore;

fn map_err(e: DocsError) -> AppError {
    match e {
        DocsError::Io(e) => e.into(),
        e @ DocsError::InvalidConfig { .. } => AppError::invalid_config(e.to_string()),
        e @ (DocsError::NotARepo | DocsError::NoCommit | DocsError::UnknownDoc) => {
            AppError::invalid_argument(e.to_string())
        }
        DocsError::Git(m) => AppError::io(m),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::io(format!("docs task failed: {e}")))?
}

/// Missing paths and stale docs of a workspace.
#[tauri::command]
pub async fn docs_check(store: State<'_, WorkspaceStore>, workspace_id: String) -> AppResult<DocsReport> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    blocking(move || agenthub_docs::check(&root, &CheckOptions::default()).map_err(map_err)).await
}

#[derive(Debug, Serialize)]
pub struct MarkReviewed {
    pub commit: String,
}

/// Records `HEAD` as the doc's `reviewed` commit in `.kotilo/docs.toml`.
#[tauri::command]
pub async fn docs_mark_reviewed(
    store: State<'_, WorkspaceStore>,
    workspace_id: String,
    path: String,
) -> AppResult<MarkReviewed> {
    let root = PathBuf::from(store.find_path(&workspace_id)?);
    blocking(move || {
        agenthub_docs::mark_reviewed(&root, &path).map(|commit| MarkReviewed { commit }).map_err(map_err)
    })
    .await
}
