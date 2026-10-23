//! M2b dictation commands: `dictation_reload` (after a hub settings save, and on every hub
//! stream connect), `dictation_cancel` (the overlay's ✕), `dictation_status` and the M4
//! composer pair `dictation_start_composer` / `dictation_stop_composer`.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::dictation::controller::Event;
use crate::dictation::hub_client::HubDictation;
use crate::dictation::service::DictationService;
use crate::dictation::{DictationHub, DictationStatus};
use crate::hub::client::HubClient;
use crate::platform::dictation::{self as platform, DesktopPlatform};

/// Starts dictation: the controller thread and a first settings load. The overlay window is
/// created on the first dictation.
pub fn start(app: &AppHandle) {
    let Some(client) = HubClient::from_env() else {
        log::warn!("dictation: hub data folder unknown; dictation is off");
        return;
    };
    let hub: Arc<dyn DictationHub> = Arc::new(HubDictation::new(client));
    let handle = app.clone();
    let service = DictationService::start(move |events| DesktopPlatform::new(handle, events), hub, platform::delivery());
    service.send(Event::Reload);
    app.manage(service);
}

/// Hub came (back) up: its settings may have changed while it was away.
pub fn on_hub_connected(app: &AppHandle) {
    if let Some(service) = app.try_state::<DictationService>() {
        service.send(Event::Reload);
    }
}

#[tauri::command]
pub fn dictation_reload(service: State<'_, DictationService>) {
    service.send(Event::Reload);
}

#[tauri::command]
pub fn dictation_cancel(service: State<'_, DictationService>) {
    service.send(Event::Cancel);
}

/// M4 composer mic: starts a recording whose text comes back as `dictation:composer`
/// `{paneId, text, cleaned}` (or `{paneId, error}`), never inserted through the OS.
#[tauri::command]
pub fn dictation_start_composer(service: State<'_, DictationService>, pane_id: String) {
    service.send(Event::StartComposer(pane_id));
}

/// M4 composer mic, second click: stops the composer recording and transcribes it.
#[tauri::command]
pub fn dictation_stop_composer(service: State<'_, DictationService>) {
    service.send(Event::StopComposer);
}

#[tauri::command]
pub fn dictation_status(service: State<'_, DictationService>) -> DictationStatus {
    service.status()
}
