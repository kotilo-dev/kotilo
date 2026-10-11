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
    pub expanded_dirs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesState {
    /// Array order = display order (drag/"move up/down" reorders this).
    pub workspaces: Vec<Workspace>,
    pub active_id: Option<String>,
}
