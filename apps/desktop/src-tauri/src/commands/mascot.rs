//! M6 mascot commands (D-052). From the main window: `mascot_set_config` (startup and every
//! settings change) and `mascot_update` (aggregate state changes). From the mascot page:
//! `mascot_ready`, `mascot_clicked`, `mascot_context_menu`, `mascot_drag`, `mascot_drag_end`.
//! All are async so they run off the UI thread (creating a window from a sync command
//! deadlocks on Windows, and the walker moves the window from its own thread).

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::platform::mascot::{Mascot, MascotConfig, MascotUpdate};

#[tauri::command]
pub async fn mascot_set_config(app: AppHandle, config: MascotConfig) {
    app.state::<Mascot>().set_config(&app, config);
}

#[tauri::command]
pub async fn mascot_update(app: AppHandle, update: MascotUpdate) {
    app.state::<Mascot>().update(&app, update);
}

#[tauri::command]
pub async fn mascot_ready(app: AppHandle) {
    app.state::<Mascot>().ready(&app);
}

#[tauri::command]
pub async fn mascot_clicked(app: AppHandle) {
    app.state::<Mascot>().clicked(&app);
}

#[tauri::command]
pub async fn mascot_context_menu(app: AppHandle) -> AppResult<()> {
    app.state::<Mascot>().context_menu(&app).map_err(|e| AppError::io(e.to_string()))
}

/// `dx`: horizontal pointer movement since the last call, in CSS px of the mascot page.
#[tauri::command]
pub async fn mascot_drag(app: AppHandle, dx: f64) {
    app.state::<Mascot>().drag(&app, dx);
}

#[tauri::command]
pub async fn mascot_drag_end(app: AppHandle) {
    app.state::<Mascot>().drag_end(&app);
}
