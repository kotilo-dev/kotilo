//! Kotilo Deck companion client (D-072, `docs/companion-protocol.md`). The deck is a
//! second-screen app with a loopback WebSocket server; the desktop is its client. The webview
//! builds the snapshots from the stores it already has and answers deck decisions through the
//! permission card's own path; this module owns the socket, the token file and the handshake.
//!
//! Events to the webview: `companion:status` ([`Status`]) and `companion:message`
//! (`{type, payload}`: `approval.respond`, `pomodoro.state`).

pub mod auth;
pub mod client;
pub mod protocol;
pub mod token;

#[cfg(test)]
mod integration_tests;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

pub use client::Status;
use client::{Config, Notice, Shared, DECK_PORT};
use protocol::{AgentsState, OutgoingEvent, UsageToday};

pub const EVENT_STATUS: &str = "companion:status";
pub const EVENT_MESSAGE: &str = "companion:message";

/// Managed state: the outbox the connection thread drains.
pub struct Companion {
    shared: Arc<Shared>,
}

impl Companion {
    /// Starts the connection thread. Without a home folder there is no token file and the
    /// thread is not started (the status stays "not running").
    pub fn start(app: &AppHandle, enabled: bool, home: Option<PathBuf>) -> Self {
        let shared = Arc::new(Shared::new(enabled));
        if let Some(home) = home {
            let config = Config::loopback(DECK_PORT, token::token_path(&home), app.package_info().version.to_string());
            let thread_shared = Arc::clone(&shared);
            let app = app.clone();
            let spawned = std::thread::Builder::new().name("deck-companion".into()).spawn(move || {
                client::run(&thread_shared, &config, &|notice| match notice {
                    Notice::Status(status) => {
                        let _ = app.emit(EVENT_STATUS, status);
                    }
                    Notice::Deck(event) => {
                        let _ = app.emit(EVENT_MESSAGE, event);
                    }
                })
            });
            if let Err(e) = spawned {
                log::warn!("deck: could not start the companion thread: {e}");
            }
        }
        Self { shared }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.shared.set_enabled(enabled);
    }
}

#[tauri::command]
pub fn companion_status(companion: State<'_, Companion>) -> Status {
    companion.shared.status()
}

/// The full agents snapshot (sent after every `hello.ok` and on change, at most every 250 ms).
#[tauri::command]
pub fn companion_set_agents(companion: State<'_, Companion>, state: AgentsState) {
    companion.shared.set_agents(state);
}

/// Today's usage (sent at most every 5 s).
#[tauri::command]
pub fn companion_set_usage(companion: State<'_, Companion>, usage: UsageToday) {
    companion.shared.set_usage(usage);
}

/// A one-off event (`agent.approval.requested`/`resolved`, …); dropped while not connected.
#[tauri::command]
pub fn companion_send(companion: State<'_, Companion>, event: OutgoingEvent) {
    companion.shared.send(event);
}
