//! `hooks_status`/`hooks_install`/`hooks_uninstall`: agent hook integration, owned by the
//! hub (one writer for every agent config file, M1). These commands only forward to the
//! hub's adapter API; `adapterId` defaults to Claude Code, the integration the UI shows.

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::hub::client::{HubClient, HubError};

const DEFAULT_ADAPTER: &str = "claude-code";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    /// False when the hub isn't reachable; every other field is then a default.
    pub hub_available: bool,
    pub installed: bool,
    pub up_to_date: bool,
    /// Hub's hook state: `missing | installed | outdated | invalidConfig | unsupported`.
    pub state: Option<String>,
    pub settings_path: Option<String>,
}

impl HooksStatus {
    fn unavailable() -> Self {
        Self {
            hub_available: false,
            installed: false,
            up_to_date: false,
            state: None,
            settings_path: None,
        }
    }

    fn from_state(state: &str, settings_path: Option<String>) -> Self {
        Self {
            hub_available: true,
            installed: matches!(state, "installed" | "outdated"),
            up_to_date: state == "installed",
            state: Some(state.to_string()),
            settings_path,
        }
    }
}

fn client() -> AppResult<HubClient> {
    HubClient::from_env().ok_or_else(|| AppError::hub_unavailable("hub data folder could not be resolved"))
}

fn map_hub_error(e: HubError) -> AppError {
    match &e {
        HubError::Unavailable => AppError::hub_unavailable(e.to_string()),
        HubError::Status { error: Some(code), message, .. } if code == "invalidConfig" => {
            AppError::invalid_json(message.clone().unwrap_or_else(|| e.to_string()))
        }
        HubError::Status { code: 404, .. } => AppError::not_found(e.to_string()),
        _ => AppError::io(e.to_string()),
    }
}

/// Never errors: an unreachable hub reports `hubAvailable: false`.
#[tauri::command(async)]
pub fn hooks_status(adapter_id: Option<String>) -> HooksStatus {
    let id = adapter_id.as_deref().unwrap_or(DEFAULT_ADAPTER);
    let Ok(client) = client() else {
        return HooksStatus::unavailable();
    };
    match client.adapters() {
        Ok(adapters) => adapters
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| match a.hooks {
                Some(h) => HooksStatus::from_state(&h.state, h.config_path),
                None => HooksStatus::from_state("unsupported", None),
            })
            .unwrap_or_else(|| HooksStatus::from_state("unsupported", None)),
        Err(_) => HooksStatus::unavailable(),
    }
}

/// Errors: `hub_unavailable`, `invalid_json` (the agent's config file can't be parsed —
/// left untouched by the hub), `not_found` (unknown adapter), `io`.
#[tauri::command(async)]
pub fn hooks_install(adapter_id: Option<String>) -> AppResult<()> {
    let id = adapter_id.as_deref().unwrap_or(DEFAULT_ADAPTER);
    let result = client()?.install_hooks(id).map(|_| ()).map_err(map_hub_error);
    match &result {
        Ok(()) => log::info!("hooks install {id}: ok"),
        Err(e) => log::warn!("hooks install {id} failed: code={:?} {}", e.code, e.message),
    }
    result
}

/// Errors: as `hooks_install`. Removing an absent installation is a no-op.
#[tauri::command(async)]
pub fn hooks_uninstall(adapter_id: Option<String>) -> AppResult<()> {
    let id = adapter_id.as_deref().unwrap_or(DEFAULT_ADAPTER);
    let result = client()?.uninstall_hooks(id).map(|_| ()).map_err(map_hub_error);
    match &result {
        Ok(()) => log::info!("hooks uninstall {id}: ok"),
        Err(e) => log::warn!("hooks uninstall {id} failed: code={:?} {}", e.code, e.message),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_maps_hub_states() {
        let s = HooksStatus::from_state("installed", Some("C:/c/settings.json".into()));
        assert!(s.hub_available && s.installed && s.up_to_date);
        let s = HooksStatus::from_state("outdated", None);
        assert!(s.installed && !s.up_to_date);
        let s = HooksStatus::from_state("missing", None);
        assert!(!s.installed && !s.up_to_date);
        let s = HooksStatus::from_state("invalidConfig", None);
        assert!(!s.installed);
        assert!(!HooksStatus::unavailable().hub_available);
    }

    #[test]
    fn hub_errors_map_to_app_error_codes() {
        use crate::error::ErrorCode;
        assert_eq!(map_hub_error(HubError::Unavailable).code, ErrorCode::HubUnavailable);
        let invalid = HubError::Status { code: 422, error: Some("invalidConfig".into()), message: Some("bad".into()), fields: None };
        let e = map_hub_error(invalid);
        assert_eq!(e.code, ErrorCode::InvalidJson);
        assert_eq!(e.message, "bad");
        let unknown = HubError::Status { code: 404, error: None, message: None, fields: None };
        assert_eq!(map_hub_error(unknown).code, ErrorCode::NotFound);
    }
}
