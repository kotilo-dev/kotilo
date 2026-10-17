//! M7 assistant popup (D-053): the `assistant` window and its global hotkey. The main
//! window sends the settings (`assistant_set_config`); the hotkey, the mascot and an in-app
//! button open the popup; the page hides it (Esc, close).
//!
//! The window is created hidden once the assistant is on and kept alive between openings
//! so it opens fast. There is no history: every show sends `assistant:opened` (the page
//! starts a new chat and focuses its input), every hide stops the running answer and sends
//! `assistant:closed`. Unlike the overlay and the mascot this window takes focus.

pub mod geometry;
#[cfg(windows)]
mod win;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::assistant::chat::ChatSlot;
use crate::assistant::{hotkey_step, toggle_action, AssistantConfig, HotkeyReport, HotkeyStatus, HotkeyStep, ToggleAction};
use crate::dictation::gesture::Gesture;
use crate::platform::hotkeys::{Consumer, HotkeySlot, Hotkeys};

pub const ASSISTANT_LABEL: &str = "assistant";
const MAIN_LABEL: &str = "main";
/// Logical size and distance from the work area's edges.
const SIZE: (f64, f64) = (400.0, 580.0);
const MARGIN: f64 = 12.0;

#[cfg(windows)]
mod os {
    pub use super::win::{cursor_display, make_tool_window};

    pub fn handle(window: &tauri::WebviewWindow) -> Option<isize> {
        window.hwnd().ok().map(|h| h.0 as isize)
    }
}

#[cfg(not(windows))]
mod os {
    use super::geometry::Rect;

    pub fn cursor_display() -> Option<(Rect, f64)> {
        None
    }
    pub fn make_tool_window(_handle: isize) {}
    pub fn handle(_window: &tauri::WebviewWindow) -> Option<isize> {
        None
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Managed state behind the `assistant_*` window commands.
#[derive(Default)]
pub struct Assistant {
    enabled: AtomicBool,
    /// The gesture the OS holds for us; the lock also serialises config changes.
    registered: Mutex<Option<Gesture>>,
    /// Serialises window create/show/hide.
    window: Mutex<()>,
}

impl Assistant {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Routes the assistant hotkey to [`Assistant::toggle`] (call once at startup).
    pub fn install_hotkey(app: &AppHandle) {
        let Some(hotkeys) = app.try_state::<Hotkeys>() else { return };
        let handle = app.clone();
        hotkeys.set_handler(Consumer::Assistant, move |_| {
            // Never block the hotkey thread on window work.
            let app = handle.clone();
            let spawned = std::thread::Builder::new().name("assistant-toggle".into()).spawn(move || {
                if let Some(assistant) = app.try_state::<Assistant>() {
                    assistant.toggle(&app);
                }
            });
            if let Err(e) = spawned {
                log::error!("assistant: toggle thread could not start: {e}");
            }
        });
        // "Settings → AI" from the popup: the page hides itself and emits this; the main
        // window opens the section, and it has to come to the front to be seen.
        let handle = app.clone();
        app.listen_any("assistant:settings", move |_| {
            if let Some(main) = handle.get_webview_window(MAIN_LABEL) {
                let _ = main.unminimize();
                let _ = main.show();
                let _ = main.set_focus();
            }
        });
    }

    /// Applies the settings: (un)registers the hotkey, reports the outcome to the main
    /// window (`assistant:hotkey`), pre-creates the window when on, removes it when off.
    pub fn set_config(&self, app: &AppHandle, config: AssistantConfig) -> HotkeyReport {
        self.enabled.store(config.enabled, Ordering::Relaxed);
        let report = {
            let mut registered = lock(&self.registered);
            let hotkeys = app.try_state::<Hotkeys>();
            let register = |gesture: Option<&Gesture>| match &hotkeys {
                Some(h) => h.register(HotkeySlot::Assistant, gesture),
                None if gesture.is_none() => Ok(()),
                None => Err(crate::dictation::HotkeyError::Taken),
            };
            match hotkey_step(registered.as_ref(), &config) {
                HotkeyStep::Keep(report) => report,
                HotkeyStep::Unregister(report) => {
                    let _ = register(None);
                    *registered = None;
                    report
                }
                HotkeyStep::Register(gesture) => {
                    let status = match register(Some(&gesture)) {
                        Ok(()) => HotkeyStatus::Ok,
                        Err(_) => {
                            if super::features().global_hotkeys {
                                log::warn!("assistant: hotkey {} not registered (taken)", gesture.text);
                            }
                            HotkeyStatus::Taken
                        }
                    };
                    let hotkey = gesture.text.clone();
                    *registered = (status == HotkeyStatus::Ok).then_some(gesture);
                    HotkeyReport { status, hotkey }
                }
            }
        };
        let _ = app.emit_to(MAIN_LABEL, "assistant:hotkey", &report);
        if config.enabled {
            let _guard = lock(&self.window);
            if let Err(e) = window(app) {
                log::error!("assistant: window could not be created: {e}");
            }
        } else {
            self.hide(app);
            let _guard = lock(&self.window);
            if let Some(w) = app.get_webview_window(ASSISTANT_LABEL) {
                let _ = w.destroy();
            }
        }
        report
    }

    /// Shows the popup (creating it if needed) at the bottom-right of the monitor under the
    /// cursor with a new chat, and focuses it. Already visible: only focuses it.
    pub fn open(&self, app: &AppHandle) {
        let _guard = lock(&self.window);
        let w = match window(app) {
            Ok(w) => w,
            Err(e) => {
                log::error!("assistant: window could not be created: {e}");
                return;
            }
        };
        if w.is_visible().unwrap_or(false) {
            let _ = w.set_focus();
            return;
        }
        place(&w);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(ASSISTANT_LABEL, "assistant:opened", serde_json::json!({}));
    }

    /// Hides the popup and ends its chat (a running answer is stopped).
    pub fn hide(&self, app: &AppHandle) {
        if let Some(chat) = app.try_state::<ChatSlot>() {
            chat.stop();
        }
        let _guard = lock(&self.window);
        let Some(w) = app.get_webview_window(ASSISTANT_LABEL) else { return };
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            let _ = app.emit_to(ASSISTANT_LABEL, "assistant:closed", serde_json::json!({}));
        }
    }

    /// Hotkey: hidden → open, visible in the background → focus, focused → hide.
    pub fn toggle(&self, app: &AppHandle) {
        let (visible, focused) = app
            .get_webview_window(ASSISTANT_LABEL)
            .map(|w| (w.is_visible().unwrap_or(false), w.is_focused().unwrap_or(false)))
            .unwrap_or((false, false));
        match toggle_action(visible, focused) {
            ToggleAction::Open | ToggleAction::Focus => self.open(app),
            ToggleAction::Hide => self.hide(app),
        }
    }

    /// The main window is gone: drop the hotkey and the window.
    pub fn shutdown(&self, app: &AppHandle) {
        if let Some(chat) = app.try_state::<ChatSlot>() {
            chat.stop();
        }
        if lock(&self.registered).take().is_some() {
            if let Some(h) = app.try_state::<Hotkeys>() {
                let _ = h.register(HotkeySlot::Assistant, None);
            }
        }
        if let Some(w) = app.get_webview_window(ASSISTANT_LABEL) {
            let _ = w.destroy();
        }
    }
}

/// The popup window, created hidden on first use.
fn window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(ASSISTANT_LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(app, ASSISTANT_LABEL, WebviewUrl::App("index.html?view=assistant".into()))
        .title("Assistant")
        .inner_size(SIZE.0, SIZE.1)
        .decorations(false)
        // The page paints a rounded card on a transparent body (like the dictation overlay);
        // a native shadow would outline the square window behind the rounded corners.
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
    if let Some(handle) = os::handle(&w) {
        os::make_tool_window(handle);
    }
    if let Err(e) = crate::platform::webview::disable_browser_accelerator_keys(&w) {
        log::warn!("assistant: WebView2 browser accelerator keys could not be disabled: {e}");
    }
    Ok(w)
}

/// Moves the hidden window to the bottom-right of the cursor's monitor. Moved twice: the
/// first move may cross into a monitor with another DPI, which resizes the window.
fn place(w: &WebviewWindow) {
    let Some((work, scale)) = os::cursor_display() else { return };
    let r = geometry::popup_rect(work, scale, SIZE, MARGIN);
    let position = tauri::PhysicalPosition::new(r.left, r.top);
    let _ = w.set_position(position);
    let _ = w.set_size(tauri::PhysicalSize::new(r.width().max(1) as u32, r.height().max(1) as u32));
    let _ = w.set_position(position);
}
