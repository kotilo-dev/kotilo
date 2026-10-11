//! Dictation's OS side (D-020): global hotkeys (through the app-wide `platform::hotkeys`,
//! M7), microphone, overlay window, sounds and text insertion. [`DesktopPlatform`]
//! implements `dictation::Platform` over the per-OS helpers below; only Windows is
//! implemented in v1, other systems get inert stubs.

pub mod recorder;
pub mod sounds;

#[cfg(windows)]
mod win_input;
#[cfg(windows)]
mod win_window;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::dictation::audio::Recording;
use crate::dictation::controller::Event;
use crate::dictation::gesture::Gesture;
use crate::dictation::{ComposerResult, Delivery, HotkeyError, HotkeyId, OverlayState, Phase, Platform, Sound, WindowId};
use crate::platform::hotkeys::{self, Consumer, HotkeySlot, Hotkeys};
use recorder::Recorder;

pub const OVERLAY_LABEL: &str = "dictation-overlay";
/// Overlay size in DIPs and its distance from the bottom of the work area (CCC overlay).
const OVERLAY_SIZE: (f64, f64) = (380.0, 58.0);
const OVERLAY_MARGIN: f64 = 28.0;

#[cfg(windows)]
mod os {
    pub use super::win_input::WinDelivery as OsDelivery;
    pub use super::win_window::{foreground_window, overlay_rect, play_wav, show_without_activation};
}

#[cfg(not(windows))]
mod os {
    use crate::dictation::{Delivery, InsertMethod, InsertResult, WindowId};

    pub fn foreground_window() -> Option<WindowId> {
        None
    }
    pub fn overlay_rect(_t: Option<WindowId>, _s: (f64, f64), _m: f64) -> Option<(i32, i32, u32, u32)> {
        None
    }
    pub fn show_without_activation(_hwnd: isize) {}
    pub fn play_wav(_wav: &'static [u8]) {}
    pub struct OsDelivery;
    impl Delivery for OsDelivery {
        fn insert(&self, _t: WindowId, _text: &str, _m: InsertMethod, _k: bool) -> InsertResult {
            InsertResult::NoTarget
        }
        fn copy(&self, _text: &str) -> bool {
            false
        }
    }
}

pub fn delivery() -> Arc<dyn Delivery> {
    Arc::new(os::OsDelivery)
}

/// Creates the hidden overlay window up front so its page is loaded before the first
/// dictation (events sent to a page that is still loading would be lost).
pub fn create_overlay_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html?view=dictation-overlay".into()))
        .title("Dictation")
        .inner_size(OVERLAY_SIZE.0, OVERLAY_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map(|_| ())
}

pub struct DesktopPlatform {
    app: AppHandle,
    hotkeys: Option<Hotkeys>,
    recorder: Recorder,
    overlay_visible: AtomicBool,
}

impl DesktopPlatform {
    pub fn new(app: AppHandle, events: Sender<Event>) -> Self {
        // M7: the hotkey thread is app-wide; dictation owns its three slots.
        let hotkeys = app.try_state::<Hotkeys>().map(|h| h.inner().clone());
        if let Some(h) = &hotkeys {
            h.set_handler(Consumer::Dictation, move |slot| {
                if let HotkeySlot::Dictation(id) = slot {
                    let _ = events.send(Event::Hotkey(id));
                }
            });
        }
        Self { app, hotkeys, recorder: Recorder::default(), overlay_visible: AtomicBool::new(false) }
    }
}

impl Platform for DesktopPlatform {
    fn foreground_window(&self) -> Option<WindowId> {
        os::foreground_window()
    }

    fn key_down(&self, vk: u32) -> bool {
        hotkeys::key_down(vk)
    }

    fn register_hotkey(&mut self, id: HotkeyId, gesture: Option<&Gesture>) -> Result<(), HotkeyError> {
        match &self.hotkeys {
            Some(h) => h.register(HotkeySlot::Dictation(id), gesture),
            None if gesture.is_none() => Ok(()),
            None => Err(HotkeyError::Taken),
        }
    }

    fn start_recording(&mut self) -> Result<(), String> {
        self.recorder.start()
    }

    fn level(&self) -> f32 {
        self.recorder.level()
    }

    fn stop_recording(&mut self) -> Recording {
        self.recorder.stop()
    }

    fn play(&self, sound: Sound) {
        os::play_wav(sounds::wav_for(sound));
    }

    fn show_overlay(&self, state: &OverlayState, target: Option<WindowId>) {
        let Some(window) = self.app.get_webview_window(OVERLAY_LABEL) else { return };
        let _ = self.app.emit_to(OVERLAY_LABEL, "dictation:overlay", state);
        if state.phase == Phase::Hidden {
            if self.overlay_visible.swap(false, Ordering::Relaxed) {
                let _ = window.hide();
            }
            return;
        }
        if !self.overlay_visible.swap(true, Ordering::Relaxed) {
            if let Some((x, y, w, h)) = os::overlay_rect(target, OVERLAY_SIZE, OVERLAY_MARGIN) {
                let _ = window.set_size(tauri::PhysicalSize::new(w, h));
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
            match window.hwnd() {
                Ok(hwnd) => os::show_without_activation(hwnd.0 as isize),
                Err(_) => {
                    let _ = window.show();
                }
            }
        }
    }

    fn dictation_done(&self, id: Option<i64>) {
        let _ = self.app.emit("dictation:done", serde_json::json!({ "id": id }));
    }

    fn composer_result(&self, result: &ComposerResult) {
        let _ = self.app.emit("dictation:composer", result);
    }
}
