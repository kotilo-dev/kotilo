//! M7 assistant popup commands (D-053). From the main window: `assistant_set_config`
//! (startup and every settings change) and `assistant_open` (in-app button). From the
//! popup page: `assistant_hide`, `assistant_info`, `assistant_chat`, `assistant_stop`.
//! All run off the UI thread (window work from a sync command deadlocks on Windows).

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::assistant::chat::{self, ChatMessage, ChatSlot, Endpoint, Outcome};
use crate::assistant::{AssistantConfig, HotkeyReport};
use crate::commands::hub::map_error;
use crate::error::{AppError, AppResult};
use crate::hub::client::HubClient;
use crate::platform::assistant::Assistant;

/// Registers or drops the hotkey and emits `assistant:hotkey {status, hotkey}` to main;
/// the same report is returned.
#[tauri::command(async)]
pub fn assistant_set_config(app: AppHandle, config: AssistantConfig) -> HotkeyReport {
    app.state::<Assistant>().set_config(&app, config)
}

#[tauri::command(async)]
pub fn assistant_open(app: AppHandle) {
    app.state::<Assistant>().open(&app);
}

#[tauri::command(async)]
pub fn assistant_hide(app: AppHandle) {
    app.state::<Assistant>().hide(&app);
}

/// `GET /v1/assistant/info` as the hub returns it.
#[tauri::command(async)]
pub fn assistant_info() -> AppResult<serde_json::Value> {
    let client = HubClient::from_env().ok_or_else(|| AppError::hub_unavailable("hub data folder could not be resolved"))?;
    client.request_json("GET", "/v1/assistant/info", None).map_err(map_error)
}

/// Streams one answer: every NDJSON line of the hub's answer goes to `on_event` as JSON
/// (`meta`, `text`, `done`); returns when the stream ends or the chat is stopped.
#[tauri::command]
pub async fn assistant_chat(app: AppHandle, messages: Vec<ChatMessage>, on_event: Channel<serde_json::Value>) -> AppResult<()> {
    // Stops a running chat, then waits until its socket is closed (the hub is busy until then).
    let (id, stop) = app.state::<ChatSlot>().begin();
    let connection = app.state::<ChatSlot>().connection().await;
    let started = std::time::Instant::now();
    let outcome = chat::run(Endpoint::from_env(), &messages, stop, |line| {
        let _ = on_event.send(line);
    })
    .await;
    drop(connection);
    app.state::<ChatSlot>().end(id);
    // Counts only (AGENTS rule 5).
    let level = if outcome == Outcome::Failed { log::Level::Info } else { log::Level::Debug };
    log::log!(level, "assistant: chat {outcome:?} after {} ms, {} messages", started.elapsed().as_millis(), messages.len());
    Ok(())
}

/// Stops the running answer (the hub sees the connection close).
#[tauri::command]
pub fn assistant_stop(app: AppHandle) {
    app.state::<ChatSlot>().stop();
}
