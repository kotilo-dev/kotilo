//! `hub_request` / `hub_export`: the webview's only way to reach the hub's REST API. The
//! token is added here and never crosses into the webview; paths are limited to `/v1/`.

use crate::error::{AppError, AppResult};
use crate::hub::client::{HubClient, HubError};

const ALLOWED_METHODS: [&str; 4] = ["GET", "POST", "PUT", "DELETE"];

/// Accepts only relative hub API paths: `/v1/...`, no scheme/host, no `..`, no backslash
/// or whitespace/control characters (the path is pasted into an HTTP request line).
pub fn validate_path(path: &str) -> AppResult<()> {
    let ok = path.starts_with("/v1/")
        && !path.contains("..")
        && !path.contains("//")
        && !path.contains('\\')
        && !path.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok {
        Ok(())
    } else {
        Err(AppError::invalid_argument(format!("not a hub API path: {path}")))
    }
}

fn client() -> AppResult<HubClient> {
    HubClient::from_env().ok_or_else(|| AppError::hub_unavailable("hub data folder could not be resolved"))
}

/// Hub errors as app errors; the hub's own `{error, message, fields}` body becomes the
/// message and the per-field messages.
pub fn map_error(e: HubError) -> AppError {
    match &e {
        HubError::Unavailable => AppError::hub_unavailable(e.to_string()),
        HubError::Status { code: 404, .. } => AppError::not_found(e.to_string()),
        HubError::Status { code: 400 | 422, message, fields, .. } => AppError {
            fields: fields.clone(),
            ..AppError::invalid_argument(message.clone().unwrap_or_else(|| e.to_string()))
        },
        _ => AppError::io(e.to_string()),
    }
}

#[tauri::command(async)]
pub fn hub_request(method: String, path: String, body: Option<serde_json::Value>) -> AppResult<serde_json::Value> {
    let method = method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(AppError::invalid_argument(format!("method not allowed: {method}")));
    }
    validate_path(&path)?;
    client()?.request_json(&method, &path, body.as_ref()).map_err(map_error)
}

/// Saves a hub download (report export) to `dest`, a path the user picked in a save dialog.
#[tauri::command(async)]
pub fn hub_export(path: String, dest: String) -> AppResult<()> {
    validate_path(&path)?;
    let bytes = client()?.download(&path).map_err(map_error)?;
    std::fs::write(&dest, bytes).map_err(|e| AppError::io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_path_accepts_hub_api_paths_only() {
        for ok in ["/v1/usage/daily?days=30", "/v1/tasks/12", "/v1/reports/cost?format=csv&from=2026-10-01"] {
            assert!(validate_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/v2/x",
            "v1/x",
            "http://evil/v1/x",
            "/v1/../admin",
            "//v1/x",
            "/v1//x",
            "/v1/x y",
            "/v1/x\r\nHost: evil",
            "/v1\\x",
        ] {
            assert!(validate_path(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn hub_errors_map_to_app_codes() {
        use crate::error::ErrorCode;
        assert_eq!(map_error(HubError::Unavailable).code, ErrorCode::HubUnavailable);
        let fields = std::collections::BTreeMap::from([("tasksGlob".to_string(), vec!["required".to_string()])]);
        let bad = HubError::Status {
            code: 400,
            error: Some("invalidRequest".into()),
            message: Some("Some settings are not valid.".into()),
            fields: Some(fields.clone()),
        };
        let e = map_error(bad);
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert_eq!(e.message, "Some settings are not valid.");
        assert_eq!(e.fields, Some(fields));
        let json = serde_json::to_value(&e).expect("serialize");
        assert_eq!(json["fields"]["tasksGlob"][0], "required");
        let plain = serde_json::to_value(map_error(HubError::Unavailable)).expect("serialize");
        assert!(plain.get("fields").is_none(), "no fields key unless the hub sent some");
        assert_eq!(map_error(HubError::Status { code: 500, error: None, message: None, fields: None }).code, ErrorCode::Io);
    }
}
