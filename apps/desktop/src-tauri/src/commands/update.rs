//! M5 self-update (`tauri-plugin-updater`). The feed URL comes from `brand.json`
//! (`updateEndpoint`, a `latest.json` on the public repo's releases) and the minisign public key
//! from `tauri.conf.json` (`plugins.updater.pubkey`). Either one empty means "not configured":
//! the app runs normally and `update_check` says so instead of failing. Whether to check on
//! start is a frontend preference; these commands only check and install on request.
//!
//! Contract (frontend):
//! - `update_check() -> UpdateCheck` (`status`: `not-configured` | `up-to-date` | `available` |
//!   `error`); a found update is kept for `update_install`.
//! - `update_install() -> Result<(), String>` downloads + verifies the kept update, emitting
//!   `update://progress` `{ downloaded, total }` and then `update://ready`, and installs it. On
//!   Windows the plugin starts the NSIS installer (passive, it relaunches the app) and exits this
//!   process; the installer's hook stops the hub sidecar (which also exits on its own once its
//!   parent is gone — the hub has no shutdown endpoint).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::brand;

pub const EVENT_UPDATE_PROGRESS: &str = "update://progress";
pub const EVENT_UPDATE_READY: &str = "update://ready";

/// Progress events are throttled to one per this many bytes (plus the final one).
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UpdateCheck {
    NotConfigured,
    UpToDate {
        current: String,
    },
    Available {
        current: String,
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// The update found by the last `update_check`, waiting for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

impl PendingUpdate {
    fn set(&self, update: Option<Update>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = update;
    }

    fn take(&self) -> Option<Update> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Where updates come from, resolved from the brand endpoint and the configured public key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedConfig {
    NotConfigured,
    Ready { endpoint: Url, pubkey: String },
    Invalid(String),
}

/// Pure: an empty endpoint or key means the build has no update feed (a dev or self-built
/// binary); a malformed or non-HTTPS endpoint is a configuration error worth showing.
pub fn feed_config(endpoint: &str, pubkey: &str) -> FeedConfig {
    let (endpoint, pubkey) = (endpoint.trim(), pubkey.trim());
    if endpoint.is_empty() || pubkey.is_empty() {
        return FeedConfig::NotConfigured;
    }
    match Url::parse(endpoint) {
        Ok(url) if url.scheme() == "https" => FeedConfig::Ready {
            endpoint: url,
            pubkey: pubkey.to_string(),
        },
        Ok(_) => FeedConfig::Invalid(format!("update endpoint must use https: {endpoint}")),
        Err(e) => FeedConfig::Invalid(format!("invalid update endpoint {endpoint}: {e}")),
    }
}

fn configured_pubkey(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .unwrap_or_default()
        .to_string()
}

fn available(update: &Update) -> UpdateCheck {
    UpdateCheck::Available {
        current: update.current_version.clone(),
        version: update.version.clone(),
        notes: update.body.clone().filter(|n| !n.trim().is_empty()),
        // The feed's own `pub_date` string (RFC 3339), not a reformatted one.
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|d| d.as_str())
            .map(str::to_string),
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<UpdateCheck, String> {
    let (endpoint, pubkey) = match feed_config(brand::UPDATE_ENDPOINT, &configured_pubkey(&app)) {
        FeedConfig::NotConfigured => return Ok(UpdateCheck::NotConfigured),
        FeedConfig::Invalid(message) => return Ok(UpdateCheck::Error { message }),
        FeedConfig::Ready { endpoint, pubkey } => (endpoint, pubkey),
    };
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|b| {
            b.pubkey(pubkey)
                // Windows: runs right before the plugin starts the installer and exits.
                .on_before_exit(move || crate::shutdown(&exit_app))
                .build()
        });
    let result = match updater {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    Ok(match result {
        Ok(Some(update)) => {
            log::info!("update: {} available (current {})", update.version, update.current_version);
            let check = available(&update);
            pending.set(Some(update));
            check
        }
        Ok(None) => {
            pending.set(None);
            UpdateCheck::UpToDate {
                current: app.package_info().version.to_string(),
            }
        }
        Err(e) => {
            log::warn!("update: check failed: {e}");
            UpdateCheck::Error { message: e.to_string() }
        }
    })
}

#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .take()
        .ok_or_else(|| "no update to install; run update_check first".to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - last_emitted >= PROGRESS_STEP_BYTES || total == Some(downloaded) {
                    last_emitted = downloaded;
                    let _ = app.emit(EVENT_UPDATE_PROGRESS, UpdateProgress { downloaded, total });
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("update: download failed: {e}");
            // Keep it so a retry does not need a new check.
            pending.set(Some(update));
            return Err(e.to_string());
        }
    };
    log::info!("update: {} downloaded and verified; installing", update.version);
    let _ = app.emit(EVENT_UPDATE_READY, ());
    update.install(bytes).map_err(|e| {
        log::warn!("update: install failed: {e}");
        e.to_string()
    })?;
    // Windows never gets here (the plugin exits after starting the installer); elsewhere the
    // new version runs after a restart.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_is_not_configured_without_endpoint_or_key() {
        assert_eq!(feed_config("", "key"), FeedConfig::NotConfigured);
        assert_eq!(feed_config("https://example.com/latest.json", "  "), FeedConfig::NotConfigured);
        assert_eq!(feed_config("", ""), FeedConfig::NotConfigured);
    }

    #[test]
    fn feed_is_ready_with_an_https_endpoint_and_a_key() {
        match feed_config(" https://example.com/releases/latest/download/latest.json ", "key") {
            FeedConfig::Ready { endpoint, pubkey } => {
                assert_eq!(endpoint.as_str(), "https://example.com/releases/latest/download/latest.json");
                assert_eq!(pubkey, "key");
            }
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn feed_rejects_plain_http_and_garbage() {
        assert!(matches!(feed_config("http://example.com/latest.json", "key"), FeedConfig::Invalid(_)));
        assert!(matches!(feed_config("not a url", "key"), FeedConfig::Invalid(_)));
    }

    #[test]
    fn update_check_serializes_to_the_frontend_contract() {
        let json = |c: UpdateCheck| serde_json::to_value(c).unwrap();
        assert_eq!(json(UpdateCheck::NotConfigured), serde_json::json!({ "status": "not-configured" }));
        assert_eq!(
            json(UpdateCheck::UpToDate { current: "0.1.0".into() }),
            serde_json::json!({ "status": "up-to-date", "current": "0.1.0" })
        );
        assert_eq!(
            json(UpdateCheck::Available {
                current: "0.1.0".into(),
                version: "0.2.0".into(),
                notes: None,
                date: Some("2026-10-09T00:00:00Z".into()),
            }),
            serde_json::json!({
                "status": "available",
                "current": "0.1.0",
                "version": "0.2.0",
                "notes": null,
                "date": "2026-10-09T00:00:00Z"
            })
        );
        assert_eq!(
            json(UpdateCheck::Error { message: "offline".into() }),
            serde_json::json!({ "status": "error", "message": "offline" })
        );
    }

    #[test]
    fn progress_payload_is_camel_case() {
        assert_eq!(
            serde_json::to_value(UpdateProgress { downloaded: 5, total: None }).unwrap(),
            serde_json::json!({ "downloaded": 5, "total": null })
        );
    }
}
