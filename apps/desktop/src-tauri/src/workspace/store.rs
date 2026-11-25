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

use super::model::{Workspace, WorkspaceGroup, WorkspacesState};

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
            .and_then(|v| serde_json::from_value::<WorkspacesState>(v).ok())
            .map(|mut state| {
                state.normalize();
                state
            })
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
            group: None,
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
            guard.active_id = guard.display_order().into_iter().next();
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

    // ---- D-080: user groups. Each method is one atomic change (one persist, one event).

    /// Applies `change` to a copy under the lock and adopts it only after it was persisted;
    /// nothing is kept when `change` or the write fails.
    fn commit(
        &self,
        state_store: &StateStore,
        change: impl FnOnce(&mut WorkspacesState) -> AppResult<()>,
    ) -> AppResult<WorkspacesState> {
        let mut guard = self.lock();
        let mut next = guard.clone();
        change(&mut next)?;
        // Persist before adopting: a failed write leaves memory and disk on the old state.
        self.persist(state_store, &next)?;
        *guard = next.clone();
        Ok(next)
    }

    /// Creates a group at the end of the list and, when `workspace_id` is given, moves
    /// that workspace into it in the same step (the "New group…" menu item).
    pub fn create_group(
        &self,
        state_store: &StateStore,
        name: &str,
        workspace_id: Option<&str>,
    ) -> AppResult<WorkspacesState> {
        self.commit(state_store, |state| {
            let name = valid_group_name(state, name, None)?;
            if let Some(ws_id) = workspace_id {
                if !state.workspaces.iter().any(|w| w.id == ws_id) {
                    return Err(AppError::not_found("workspace not found"));
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            state.groups.push(WorkspaceGroup { id: id.clone(), name });
            if let Some(ws) = workspace_id.and_then(|ws_id| state.workspaces.iter_mut().find(|w| w.id == ws_id)) {
                ws.group = Some(id);
            }
            Ok(())
        })
    }

    pub fn rename_group(&self, state_store: &StateStore, id: &str, name: &str) -> AppResult<WorkspacesState> {
        self.commit(state_store, |state| {
            let name = valid_group_name(state, name, Some(id))?;
            let group = state
                .groups
                .iter_mut()
                .find(|g| g.id == id)
                .ok_or_else(|| AppError::not_found("group not found"))?;
            group.name = name;
            Ok(())
        })
    }

    /// Removes the group; its workspaces become ungrouped (never removed).
    pub fn remove_group(&self, state_store: &StateStore, id: &str) -> AppResult<WorkspacesState> {
        self.commit(state_store, |state| {
            let before = state.groups.len();
            state.groups.retain(|g| g.id != id);
            if state.groups.len() == before {
                return Err(AppError::not_found("group not found"));
            }
            for ws in &mut state.workspaces {
                if ws.group.as_deref() == Some(id) {
                    ws.group = None;
                }
            }
            Ok(())
        })
    }

    /// Moves the group one place up (`delta < 0`) or down; at either end a no-op.
    pub fn move_group(&self, state_store: &StateStore, id: &str, delta: i32) -> AppResult<WorkspacesState> {
        self.commit(state_store, |state| {
            let idx = state
                .groups
                .iter()
                .position(|g| g.id == id)
                .ok_or_else(|| AppError::not_found("group not found"))?;
            let target = if delta < 0 { idx.checked_sub(1) } else { Some(idx + 1) };
            if let Some(t) = target.filter(|t| *t < state.groups.len()) {
                state.groups.swap(idx, t);
            }
            Ok(())
        })
    }

    /// Puts a workspace into a group (`None` = ungrouped). It goes to the end of the
    /// target section, so it shows up where the user looks for it.
    pub fn set_group(
        &self,
        state_store: &StateStore,
        workspace_id: &str,
        group_id: Option<&str>,
    ) -> AppResult<WorkspacesState> {
        self.commit(state_store, |state| {
            if let Some(gid) = group_id {
                if !state.groups.iter().any(|g| g.id == gid) {
                    return Err(AppError::not_found("group not found"));
                }
            }
            let pos = state
                .workspaces
                .iter()
                .position(|w| w.id == workspace_id)
                .ok_or_else(|| AppError::not_found("workspace not found"))?;
            let mut ws = state.workspaces.remove(pos);
            ws.group = group_id.map(str::to_string);
            state.workspaces.push(ws);
            Ok(())
        })
    }
}

/// Trimmed, non-empty and unique (ignoring case) among the other groups.
fn valid_group_name(state: &WorkspacesState, name: &str, except_id: Option<&str>) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_name("group name must not be empty"));
    }
    let folded = fold_name(trimmed);
    if state
        .groups
        .iter()
        .any(|g| Some(g.id.as_str()) != except_id && fold_name(&g.name) == folded)
    {
        return Err(AppError::already_exists("a group with this name already exists"));
    }
    Ok(trimmed.to_string())
}

/// Case-insensitive key for duplicate group names. Plain `to_lowercase` maps "İ" to "i" plus a
/// combining dot, so "İş" and "iş" never matched; the dotted/dotless i variants fold to one letter.
fn fold_name(name: &str) -> String {
    name.chars()
        .flat_map(|c| match c {
            'İ' | 'I' | 'ı' => 'i'.to_lowercase(),
            other => other.to_lowercase(),
        })
        .filter(|&c| c != '\u{307}')
        .collect()
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

    // ---- D-080 groups

    fn three(store: &WorkspaceStore, state_store: &StateStore) -> (Vec<String>, Vec<tempfile::TempDir>) {
        let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
        for d in &dirs {
            store.add(state_store, &d.path().to_string_lossy()).unwrap();
        }
        let ids = store.list().workspaces.iter().map(|w| w.id.clone()).collect();
        (ids, dirs)
    }

    #[test]
    fn old_state_without_groups_loads() {
        let json = serde_json::json!({
            "workspaces": [{ "id": "a", "name": "a", "path": "C:\\a", "expandedDirs": [] }],
            "activeId": "a"
        });
        let state: WorkspacesState = serde_json::from_value(json).unwrap();
        assert!(state.groups.is_empty());
        assert_eq!(state.workspaces[0].group, None);
    }

    #[test]
    fn load_drops_broken_groups_but_keeps_every_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let state_store = StateStore::load_from(dir.path().to_path_buf());
        state_store
            .set_slice(
                "workspaces",
                serde_json::json!({
                    "workspaces": [
                        { "id": "a", "name": "a", "path": "C:\\a", "expandedDirs": [], "group": "gone" },
                        { "id": "b", "name": "b", "path": "C:\\b", "expandedDirs": [], "group": "g1" }
                    ],
                    "activeId": "a",
                    "groups": [{ "id": "g1", "name": "Work" }, { "name": "no id" }, { "id": "g1", "name": "dup" }, 42]
                }),
            )
            .unwrap();
        let state = WorkspaceStore::load_from_state_store(&state_store).list();
        assert_eq!(state.workspaces.len(), 2);
        assert_eq!(state.groups, vec![WorkspaceGroup { id: "g1".into(), name: "Work".into() }]);
        assert_eq!(state.workspaces[0].group, None);
        assert_eq!(state.workspaces[1].group.as_deref(), Some("g1"));
    }

    #[test]
    fn a_non_string_group_reads_as_ungrouped() {
        let json = serde_json::json!({
            "workspaces": [{ "id": "a", "name": "a", "path": "C:\\a", "expandedDirs": [], "group": 42 }],
            "activeId": "a"
        });
        let state: WorkspacesState = serde_json::from_value(json).unwrap();
        assert_eq!(state.workspaces.len(), 1);
        assert_eq!(state.workspaces[0].group, None);
    }

    #[test]
    fn create_group_with_workspace_is_one_step() {
        let (store, state_store, _guard) = store_and_state();
        let (ids, _dirs) = three(&store, &state_store);
        let state = store.create_group(&state_store, "  Work ", Some(&ids[1])).unwrap();
        assert_eq!(state.groups.len(), 1);
        assert_eq!(state.groups[0].name, "Work");
        let moved = state.workspaces.iter().find(|w| w.id == ids[1]).unwrap();
        assert_eq!(moved.group.as_deref(), Some(state.groups[0].id.as_str()));
        // Grouped first, then the ungrouped in their order.
        assert_eq!(state.display_order(), vec![ids[1].clone(), ids[0].clone(), ids[2].clone()]);
    }

    #[test]
    fn group_names_are_trimmed_unique_and_not_empty() {
        let (store, state_store, _guard) = store_and_state();
        store.create_group(&state_store, "Work", None).unwrap();
        let err = store.create_group(&state_store, "work", None).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists);
        let err = store.create_group(&state_store, "   ", None).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidName);
        let state = store.create_group(&state_store, "Games", None).unwrap();
        let games = state.groups[1].id.clone();
        // Renaming to its own name in another case is fine; to another group's is not.
        assert!(store.rename_group(&state_store, &games, "GAMES").is_ok());
        let err = store.rename_group(&state_store, &games, "WORK").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists);
    }

    #[test]
    fn turkish_dotted_and_dotless_i_count_as_the_same_name() {
        let (store, state_store, _guard) = store_and_state();
        store.create_group(&state_store, "İş", None).unwrap();
        for dup in ["iş", "IŞ", "İŞ", " iş "] {
            let err = store.create_group(&state_store, dup, None).unwrap_err();
            assert_eq!(err.code, crate::error::ErrorCode::AlreadyExists, "{dup}");
        }
    }

    #[test]
    fn create_group_with_unknown_workspace_changes_nothing() {
        let (store, state_store, _guard) = store_and_state();
        let err = store.create_group(&state_store, "Work", Some("nope")).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
        assert!(store.list().groups.is_empty());
    }

    #[test]
    fn remove_group_ungroups_its_workspaces() {
        let (store, state_store, _guard) = store_and_state();
        let (ids, _dirs) = three(&store, &state_store);
        let state = store.create_group(&state_store, "Work", Some(&ids[0])).unwrap();
        let gid = state.groups[0].id.clone();
        let state = store.remove_group(&state_store, &gid).unwrap();
        assert!(state.groups.is_empty());
        assert_eq!(state.workspaces.len(), 3);
        assert!(state.workspaces.iter().all(|w| w.group.is_none()));
    }

    #[test]
    fn move_group_swaps_and_stops_at_the_ends() {
        let (store, state_store, _guard) = store_and_state();
        store.create_group(&state_store, "A", None).unwrap();
        let state = store.create_group(&state_store, "B", None).unwrap();
        let b = state.groups[1].id.clone();
        let state = store.move_group(&state_store, &b, -1).unwrap();
        assert_eq!(state.groups[0].name, "B");
        let state = store.move_group(&state_store, &b, -1).unwrap();
        assert_eq!(state.groups[0].name, "B");
    }

    #[test]
    fn set_group_validates_and_moves_to_the_section_end() {
        let (store, state_store, _guard) = store_and_state();
        let (ids, _dirs) = three(&store, &state_store);
        let state = store.create_group(&state_store, "Work", Some(&ids[2])).unwrap();
        let gid = state.groups[0].id.clone();
        let err = store.set_group(&state_store, &ids[0], Some("nope")).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
        let state = store.set_group(&state_store, &ids[0], Some(&gid)).unwrap();
        assert_eq!(state.display_order(), vec![ids[2].clone(), ids[0].clone(), ids[1].clone()]);
        let state = store.set_group(&state_store, &ids[2], None).unwrap();
        assert_eq!(state.display_order(), vec![ids[0].clone(), ids[1].clone(), ids[2].clone()]);
    }

    #[test]
    fn remove_picks_the_first_workspace_in_display_order() {
        let (store, state_store, _guard) = store_and_state();
        let (ids, _dirs) = three(&store, &state_store);
        store.create_group(&state_store, "Work", Some(&ids[1])).unwrap();
        store.set_active(&state_store, &ids[2]).unwrap();
        let state = store.remove(&state_store, &ids[2]).unwrap();
        assert_eq!(state.active_id.as_deref(), Some(ids[1].as_str()));
    }
}
