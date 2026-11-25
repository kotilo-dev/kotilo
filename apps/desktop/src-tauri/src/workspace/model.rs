//! Workspace data model (Faz 2 spec §3, §8.4). Serialized as the `"workspaces"` state
//! slice and as the `workspaces:changed` event payload — both camelCase.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// `dunce::canonicalize` output (§8.4) — what the UI displays and what "Yolu
    /// kopyala" copies.
    pub path: String,
    #[serde(default)]
    pub expanded_dirs: Vec<String>,
    /// D-080: id of the user group this workspace is listed under; `None` = ungrouped.
    /// A non-string value (hand-edited file) reads as ungrouped instead of failing the slice.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_group")]
    pub group: Option<String>,
}

/// D-080: a user-defined section of the Workspaces list ("Work", "Personal", …).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceGroup {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesState {
    /// Array order = order inside a group (and of the ungrouped section).
    pub workspaces: Vec<Workspace>,
    pub active_id: Option<String>,
    /// D-080: array order = display order of the group sections. Entries that do not
    /// parse are skipped, so a bad group never makes the whole slice unreadable.
    #[serde(default, deserialize_with = "lenient_groups")]
    pub groups: Vec<WorkspaceGroup>,
}

fn lenient_group<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d) {
        Ok(serde_json::Value::String(id)) if !id.is_empty() => Some(id),
        _ => None,
    })
}

fn lenient_groups<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<WorkspaceGroup>, D::Error> {
    let raw = Vec::<serde_json::Value>::deserialize(d).unwrap_or_default();
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

impl WorkspacesState {
    /// Drops broken group entries (empty id or name, repeated id) and clears workspace
    /// `group` references that point at no group. Run after loading a hand-edited or
    /// older `state.json`, so a bad group never hides or loses a workspace.
    pub fn normalize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.groups
            .retain(|g| !g.id.is_empty() && !g.name.trim().is_empty() && seen.insert(g.id.clone()));
        for ws in &mut self.workspaces {
            if ws.group.as_ref().is_some_and(|id| !seen.contains(id)) {
                ws.group = None;
            }
        }
    }

    /// Ids in display order: each group's workspaces in group order, then the ungrouped
    /// ones; inside a section the array order. Mirrors `groupedWorkspaces` in the UI.
    pub fn display_order(&self) -> Vec<String> {
        let mut order = Vec::with_capacity(self.workspaces.len());
        for g in &self.groups {
            order.extend(
                self.workspaces
                    .iter()
                    .filter(|w| w.group.as_deref() == Some(g.id.as_str()))
                    .map(|w| w.id.clone()),
            );
        }
        // A dangling reference counts as ungrouped, so no workspace ever drops out.
        order.extend(
            self.workspaces
                .iter()
                .filter(|w| w.group.as_ref().is_none_or(|id| !self.groups.iter().any(|g| &g.id == id)))
                .map(|w| w.id.clone()),
        );
        order
    }
}
