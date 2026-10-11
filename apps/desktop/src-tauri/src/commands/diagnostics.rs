//! Faz 7 §4/§9.6: `diagnostics_collect`/`diagnostics_open_logs` — thin IPC wrappers.
//! Every actual disk/zip operation happens in `crate::diagnostics::build_zip` (pure data
//! in, a zip path out); this module's only job is gathering that data from the in-memory
//! Tauri-managed state (never re-reading `settings.json`/`state.json` from disk — spec
//! §9.6: "bellekteki tek doğruluk kaynağından") and running it all in `spawn_blocking`.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::agents::AgentTracker;
use crate::diagnostics::{self, BuildZipInput};
use crate::error::{AppError, AppResult};
use crate::logging;
use crate::persistence::StateStore;
use crate::pty::PtyRegistry;
use crate::settings::SettingsStore;
use crate::workspace::WorkspaceStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsCollectResponse {
    pub path: String,
}

/// Spec §9.6: pane count + each pane's shell image name (never its full command line —
/// only the profile/executable, per the §1.1/§9.2 privacy rules).
fn runtime_panes_json(pty: &PtyRegistry) -> serde_json::Value {
    let panes: Vec<serde_json::Value> = pty
        .pane_summaries()
        .into_iter()
        .map(|p| {
            let shell_image = pty.shell_info(&p.pane_id).map(|(_, name)| name);
            serde_json::json!({ "shellImage": shell_image })
        })
        .collect();
    serde_json::Value::Array(panes)
}

/// Spec §4: the agent list with kind/state/source/issue CODE only — never a title, path,
/// or the issue's message text.
fn runtime_agents_json(tracker: &AgentTracker) -> serde_json::Value {
    let agents: Vec<serde_json::Value> = tracker
        .snapshot()
        .into_iter()
        .map(|a| {
            serde_json::json!({
                "kind": a.kind,
                "state": a.state,
                "source": a.source,
            })
        })
        .collect();
    serde_json::Value::Array(agents)
}

fn runtime_json(pty: &PtyRegistry, workspaces: &WorkspaceStore, tracker: &AgentTracker) -> serde_json::Value {
    let hooks_status = crate::commands::hooks::hooks_status(None);
    serde_json::json!({
        "workspaceCount": workspaces.list().workspaces.len(),
        "paneCount": pty.pane_summaries().len(),
        "panes": runtime_panes_json(pty),
        "agents": runtime_agents_json(tracker),
        "claudeIntegration": {
            "installed": hooks_status.installed,
            "upToDate": hooks_status.up_to_date,
            "hubAvailable": hooks_status.hub_available,
        },
    })
}

fn system_json(app: &AppHandle, verbose_logging: bool) -> AppResult<serde_json::Value> {
    let info = crate::commands::app::app_info(app.clone())?;
    Ok(serde_json::json!({
        "version": info.version,
        "gitSha": info.git_sha,
        "buildDate": info.build_date,
        "os": info.os,
        "arch": std::env::consts::ARCH,
        "webview2": info.webview2,
        "uptimeSeconds": logging::uptime().as_secs(),
        "logLevel": if verbose_logging { "debug" } else { "info" },
        "collectedAt": chrono::Local::now().to_rfc3339(),
    }))
}

/// Spec §4/§9.6: builds the diagnostics zip and returns its path. The zip is written,
/// retention applied, and the "diagnostics saved" line logged all from `spawn_blocking`
/// (only the in-memory JSON gathering above runs on the async side, since it's cheap and
/// needs `State`/`AppHandle`, neither `Send`-friendly to carry into a blocking closure
/// unmodified — everything crossing that boundary here is plain owned data).
#[tauri::command(async)]
pub async fn diagnostics_collect(
    app: AppHandle,
    settings: State<'_, SettingsStore>,
    state_store: State<'_, StateStore>,
    pty: State<'_, PtyRegistry>,
    workspaces: State<'_, WorkspaceStore>,
    tracker: State<'_, AgentTracker>,
) -> AppResult<DiagnosticsCollectResponse> {
    let settings_value = settings.get();
    let verbose_logging = settings_value.diagnostics.verbose_logging;

    let system_json = system_json(&app, verbose_logging)?;
    let runtime_json = runtime_json(&pty, &workspaces, &tracker);
    // M4: saved composer prompts are user-authored text – only their count goes into the zip.
    let settings_json = crate::settings::settings_for_diagnostics(&settings_value);
    let state_json = diagnostics::allow_listed_state(&state_store.snapshot(), &diagnostics::ALLOWED_STATE_SLICES);

    let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
    let username = std::env::var("USERNAME").unwrap_or_default();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    let input = BuildZipInput {
        system_json,
        runtime_json,
        settings_json,
        state_json,
        log_dir: logging::log_dir(),
        out_dir: logging::diagnostics_dir(),
        user_profile,
        username,
        stamp,
    };

    // Spec §9.6: logs are read only after a flush, so the active file's tail actually
    // reflects everything logged up to (and including) this collection request.
    log::logger().flush();

    let zip_path = tauri::async_runtime::spawn_blocking(move || {
        let zip_path = diagnostics::build_zip(&input)?;
        diagnostics::apply_retention(&input_out_dir(&zip_path), diagnostics::DIAGNOSTICS_RETENTION);
        std::io::Result::Ok(zip_path)
    })
    .await
    .map_err(|e| AppError::io(e.to_string()))?
    .map_err(|e| AppError::io(e.to_string()))?;

    // Spec §9.6: reveal in Explorer from Rust (no capability needed) — best-effort, never
    // fails the command itself (the zip already exists either way).
    if let Err(e) = app.opener().reveal_item_in_dir(&zip_path) {
        log::warn!("diagnostics: failed to reveal {} in Explorer: {e}", zip_path.display());
    }

    // Spec §9.6: this line is written AFTER the zip (so it doesn't retroactively bloat
    // the very log file the zip's own `logs/` entry just captured).
    log::info!("diagnostics saved path={}", zip_path.display());

    Ok(DiagnosticsCollectResponse {
        path: zip_path.to_string_lossy().into_owned(),
    })
}

fn input_out_dir(zip_path: &std::path::Path) -> std::path::PathBuf {
    zip_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(logging::diagnostics_dir)
}

/// Spec §4.2: `Help: Open logs folder` — opens `%LOCALAPPDATA%\kotilo\logs` in
/// Explorer.
#[tauri::command(async)]
pub fn diagnostics_open_logs(app: AppHandle) -> AppResult<()> {
    let dir = logging::log_dir();
    // A fresh install may not have logged anything yet on this exact call path (should
    // not happen in practice — the logger creates the folder at startup — but opening a
    // directory that doesn't exist would otherwise surface a confusing OS error).
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io(e.to_string()))?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::io(e.to_string()))
}
