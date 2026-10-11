//! In-memory workspace list + its persistence into the `"workspaces"` state slice
//! (Faz 2 spec §3, §8.3, §8.4, §8.9).
//!
//! Managed as Tauri app state. Every mutating method persists the whole new
//! [`WorkspacesState`] into [`StateStore`] before returning it; the caller (the
//! `workspace_*` commands) decides whether to additionally emit `workspaces:changed`
//! (all of them do, except `set_expanded` — see spec §8.3).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::error::{AppError, AppResult};
use crate::fsguard;
use crate::persistence::StateStore;

use super::model::{Workspace, WorkspacesState};

pub struct WorkspaceStore {
    inner: Mutex<WorkspacesState>,
}

impl WorkspaceStore {
    pub fn new(initial: WorkspacesState) -> Self {
        Self {
            inner: Mutex::new(initial),
        }
    }

    /// Loads the `"workspaces"` slice from `state_store` (missing/unparsable → empty
    /// state — a fresh install, or a hand-edited state.json).
    pub fn load_from_state_store(state_store: &StateStore) -> Self {
        let initial = state_store
            .get_slice("workspaces")
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        Self::new(initial)
    }

    fn lock(&self) -> MutexGuard<'_, WorkspacesState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self, state_store: &StateStore, snapshot: &WorkspacesState) -> AppResult<()> {
        let value = serde_json::to_value(snapshot)
            .map_err(|e| AppError::io(format!("failed to serialize workspaces slice: {e}")))?;
        state_store
            .set_slice("workspaces", value)
            .map_err(|e| AppError::io(e.to_string()))
    }

    pub fn list(&self) -> WorkspacesState {
        self.lock().clone()
    }

    /// Every workspace root currently registered, for starting/stopping the watcher at
    /// app startup.
    pub fn roots(&self) -> Vec<(String, String)> {
        self.lock()
            .workspaces
            .iter()
            .map(|w| (w.id.clone(), w.path.clone()))
            .collect()
    }

    pub fn find_path(&self, id: &str) -> AppResult<String> {
        self.lock()
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .map(|w| w.path.clone())
            .ok_or_else(|| AppError::not_found("workspace not found"))
    }

    pub fn add(&self, state_store: &StateStore, raw_path: &str) -> AppResult<WorkspacesState> {
        let path = Path::new(raw_path);
        let canonical = dunce::canonicalize(path)
            .map_err(|_| AppError::not_a_directory("folder not found"))?;
        if !canonical.is_dir() {
            return Err(AppError::not_a_directory("selected path is not a folder"));
        }
        // §8.9: reject drive roots (e.g. `C:\`) — they have no parent.
        if canonical.parent().is_none() {
            return Err(AppError::not_a_directory(
                "a drive root cannot be added as a workspace",
            ));
        }

        let mut guard = self.lock();
        for ws in &guard.workspaces {
            if fsguard::same_existing_path(Path::new(&ws.path), &canonical).unwrap_or(false) {
                return Err(AppError::duplicate_workspace("this folder has already been added"));
            }
        }

        let display_path = canonical.to_string_lossy().to_string();
        let name = canonical
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| display_path.clone());
        let id = uuid::Uuid::new_v4().to_string();
        guard.workspaces.push(Workspace {
            id: id.clone(),
            name,
            path: display_path,
            expanded_dirs: Vec::new(),
        });
        guard.active_id = Some(id);

        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)?;
        Ok(snapshot)
    }

    pub fn remove(&self, state_store: &StateStore, id: &str) -> AppResult<WorkspacesState> {
        let mut guard = self.lock();
        let before = guard.workspaces.len();
        guard.workspaces.retain(|w| w.id != id);
        if guard.workspaces.len() == before {
            return Err(AppError::not_found("workspace not found"));
        }
        if guard.active_id.as_deref() == Some(id) {
            guard.active_id = guard.workspaces.first().map(|w| w.id.clone());
        }

        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)?;
        Ok(snapshot)
    }

    pub fn rename(
        &self,
        state_store: &StateStore,
        id: &str,
        name: &str,
    ) -> AppResult<WorkspacesState> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::invalid_name("name must not be empty"));
        }
        let mut guard = self.lock();
        let ws = guard
            .workspaces
            .iter_mut()
            .find(|w| w.id == id)
            .ok_or_else(|| AppError::not_found("workspace not found"))?;
        ws.name = trimmed.to_string();

        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)?;
        Ok(snapshot)
    }

    /// Reorders workspaces to match `ids`. Per contract `ids` is a permutation of the
    /// current id set; defensively, an id in `ids` that no longer exists is skipped and
    /// an existing workspace missing from `ids` is kept, appended in its original
    /// relative order — a malformed call never silently drops a workspace.
    pub fn reorder(&self, state_store: &StateStore, ids: &[String]) -> AppResult<WorkspacesState> {
        let mut guard = self.lock();
        let mut remaining = guard.workspaces.clone();
        let mut new_order = Vec::with_capacity(remaining.len());
        for id in ids {
            if let Some(pos) = remaining.iter().position(|w| &w.id == id) {
                new_order.push(remaining.remove(pos));
            }
        }
        new_order.extend(remaining);
        guard.workspaces = new_order;

        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)?;
        Ok(snapshot)
    }

    pub fn set_active(&self, state_store: &StateStore, id: &str) -> AppResult<WorkspacesState> {
        let mut guard = self.lock();
        if !guard.workspaces.iter().any(|w| w.id == id) {
            return Err(AppError::not_found("workspace not found"));
        }
        guard.active_id = Some(id.to_string());

        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)?;
        Ok(snapshot)
    }

    /// §8.3: unknown id → silent no-op (`Ok`), not an error; never emits
    /// `workspaces:changed` (that's enforced by the caller not emitting after this).
    pub fn set_expanded(
        &self,
        state_store: &StateStore,
        id: &str,
        dirs: Vec<String>,
    ) -> AppResult<()> {
        let mut guard = self.lock();
        if let Some(ws) = guard.workspaces.iter_mut().find(|w| w.id == id) {
            ws.expanded_dirs = dirs;
        }
        let snapshot = guard.clone();
        drop(guard);
        self.persist(state_store, &snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_and_state() -> (WorkspaceStore, StateStore, tempfile::TempDir) {
        let state_dir = tempfile::tempdir().unwrap();
        let state_store = StateStore::load_from(state_dir.path().to_path_buf());
        let store = WorkspaceStore::new(WorkspacesState::default());
        (store, state_store, state_dir)
    }

    #[test]
    fn add_sets_active_and_derives_name_from_folder() {
        let (store, state_store, _guard) = store_and_state();
        let folder = tempfile::tempdir().unwrap();

        let result = store.add(&state_store, &folder.path().to_string_lossy()).unwrap();

        assert_eq!(result.workspaces.len(), 1);
        let ws = &result.workspaces[0];
        assert_eq!(result.active_id, Some(ws.id.clone()));
        let expected_name = folder.path().file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(ws.name, expected_name);
    }

    #[test]
    fn add_rejects_duplicate() {
        let (store, state_store, _guard) = store_and_state();
        let folder = tempfile::tempdir().unwrap();
        let path_str = folder.path().to_string_lossy().to_string();

        store.add(&state_store, &path_str).unwrap();
        let err = store.add(&state_store, &path_str).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::DuplicateWorkspace);
    }

    #[test]
    fn add_rejects_non_directory() {
        let (store, state_store, _guard) = store_and_state();
        let folder = tempfile::tempdir().unwrap();
        let file_path = folder.path().join("f.txt");
        std::fs::write(&file_path, b"x").unwrap();

        let err = store.add(&state_store, &file_path.to_string_lossy()).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotADirectory);
    }

    #[test]
    fn add_rejects_drive_root() {
        let (store, state_store, _guard) = store_and_state();
        let err = store.add(&state_store, "C:\\").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotADirectory);
    }

    #[test]
    fn remove_reassigns_active_to_first_remaining() {
        let (store, state_store, _guard) = store_and_state();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        store.add(&state_store, &a.path().to_string_lossy()).unwrap();
        let after_b = store.add(&state_store, &b.path().to_string_lossy()).unwrap();
        let a_id = after_b.workspaces[0].id.clone();
        let b_id = after_b.workspaces[1].id.clone();
        assert_eq!(after_b.active_id, Some(b_id.clone()));

        let after_remove = store.remove(&state_store, &b_id).unwrap();
        assert_eq!(after_remove.active_id, Some(a_id));
    }

    #[test]
    fn remove_unknown_id_is_not_found() {
        let (store, state_store, _guard) = store_and_state();
        let err = store.remove(&state_store, "nope").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn rename_rejects_empty_name() {
        let (store, state_store, _guard) = store_and_state();
        let folder = tempfile::tempdir().unwrap();
        let state = store.add(&state_store, &folder.path().to_string_lossy()).unwrap();
        let id = state.workspaces[0].id.clone();

        let err = store.rename(&state_store, &id, "   ").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidName);
    }

    #[test]
    fn reorder_applies_permutation() {
        let (store, state_store, _guard) = store_and_state();
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let c = tempfile::tempdir().unwrap();
        store.add(&state_store, &a.path().to_string_lossy()).unwrap();
        store.add(&state_store, &b.path().to_string_lossy()).unwrap();
        let state = store.add(&state_store, &c.path().to_string_lossy()).unwrap();
        let ids: Vec<String> = state.workspaces.iter().map(|w| w.id.clone()).collect();
        let reversed: Vec<String> = ids.iter().rev().cloned().collect();

        let result = store.reorder(&state_store, &reversed).unwrap();
        let result_ids: Vec<String> = result.workspaces.iter().map(|w| w.id.clone()).collect();
        assert_eq!(result_ids, reversed);
    }

    #[test]
    fn set_expanded_unknown_id_is_silent_ok() {
        let (store, state_store, _guard) = store_and_state();
        assert!(store
            .set_expanded(&state_store, "unknown", vec!["a".into()])
            .is_ok());
    }

    #[test]
    fn set_expanded_persists() {
        let (store, state_store, _guard) = store_and_state();
        let folder = tempfile::tempdir().unwrap();
        let state = store.add(&state_store, &folder.path().to_string_lossy()).unwrap();
        let id = state.workspaces[0].id.clone();

        store
            .set_expanded(&state_store, &id, vec!["src".into(), "src/lib".into()])
            .unwrap();

        let listed = store.list();
        assert_eq!(
            listed.workspaces[0].expanded_dirs,
            vec!["src".to_string(), "src/lib".to_string()]
        );
    }
}
