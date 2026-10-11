//! M2b live dictation (D-020): global hotkey → microphone → the hub's Whisper → text into
//! the window that had focus. This module is platform-free: the controller runs over the
//! [`Platform`], [`Delivery`] and [`DictationHub`] traits; the Windows implementations live
//! in `crate::platform::dictation`, the hub client in [`hub_client`]. Behaviour follows
//! CCC's `DictationController` (spec §22).

pub mod audio;
pub mod controller;
pub mod gesture;
pub mod hold;
pub mod hub_client;
pub mod service;

use serde::{Deserialize, Serialize};

use crate::dictation::audio::Recording;
use crate::dictation::gesture::Gesture;
use crate::dictation::hold::TalkMode;

/// Opaque native window handle (an HWND on Windows); 0 is never a window.
pub type WindowId = isize;

/// The `dictation` section of the hub settings (`GET /v1/settings`), as far as the desktop
/// side needs it. Whisper, cleanup, file and history options are applied by the hub.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictationSettings {
    pub enabled: bool,
    pub hotkey: String,
    pub paste_last_hotkey: String,
    pub ai_cleanup: bool,
    pub output_focused: bool,
    pub insert_method: InsertMethod,
    pub output_clipboard: bool,
    pub sound_cues: bool,
    pub max_minutes: u32,
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: "Ctrl+Alt+D".into(),
            paste_last_hotkey: "Ctrl+Alt+Shift+D".into(),
            ai_cleanup: false,
            output_focused: true,
            insert_method: InsertMethod::Paste,
            output_clipboard: false,
            sound_cues: true,
            max_minutes: 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertMethod {
    /// Clipboard + Ctrl+V (Shift+Insert in terminals); the old clipboard comes back.
    Paste,
    /// Unicode key events.
    Type,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Hidden,
    Recording,
    Transcribing,
    Cleaning,
    Result,
}

/// Result line of the overlay (UI strings live in the frontend, keyed by this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationMessage {
    Inserted,
    Done,
    Cancelled,
    NoSpeech,
    Silent,
    NoMicrophone,
    ModelMissing,
    CleanupFailed,
    ElevatedTarget,
    NoTarget,
    FileFailed,
    HubUnavailable,
    Failed,
}

impl DictationMessage {
    pub fn is_ok(self) -> bool {
        matches!(self, DictationMessage::Inserted | DictationMessage::Done)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sound {
    Start,
    Stop,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayResult {
    pub ok: bool,
    pub message: DictationMessage,
    /// Error text for `failed` (shown after the message).
    pub detail: Option<String>,
}

/// Payload of the `dictation:overlay` event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub phase: Phase,
    pub mode: TalkMode,
    pub elapsed_ms: u64,
    pub level: f32,
    pub result: Option<OverlayResult>,
    pub sound: Option<Sound>,
}

impl OverlayState {
    pub fn hidden() -> Self {
        Self { phase: Phase::Hidden, mode: TalkMode::Undecided, elapsed_ms: 0, level: 0.0, result: None, sound: None }
    }
}

/// Payload of the `dictation:composer` event (M4): either `{paneId, text, cleaned}` or
/// `{paneId, error, detail?}`. Exactly one per composer dictation.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerResult {
    pub pane_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleaned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DictationMessage>,
    /// Error text for `failed` (`"busy"` when another dictation is running).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ComposerResult {
    pub fn error(pane_id: String, error: DictationMessage, detail: Option<String>) -> Self {
        Self { pane_id, text: None, cleaned: None, error: Some(error), detail }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HotkeyId {
    Dictation,
    PasteLast,
    Escape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyError {
    /// The setting is not a valid gesture.
    Invalid,
    /// Another program already registered it.
    Taken,
}

/// Outcome of inserting text into a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertResult {
    Pasted,
    Typed,
    /// The target runs elevated; Windows blocks input from a normal process (UIPI).
    Elevated,
    /// The window is gone or could not be brought to the front.
    NoTarget,
}

/// OS side of dictation. Implemented per platform; tests use a fake.
pub trait Platform: Send {
    fn foreground_window(&self) -> Option<WindowId>;
    fn key_down(&self, vk: u32) -> bool;
    /// Registers (`Some`) or unregisters (`None`) a global hotkey; presses arrive as
    /// [`controller::Event::Hotkey`].
    fn register_hotkey(&mut self, id: HotkeyId, gesture: Option<&Gesture>) -> Result<(), HotkeyError>;
    fn start_recording(&mut self) -> Result<(), String>;
    /// RMS of the latest microphone buffer, 0..1.
    fn level(&self) -> f32;
    fn stop_recording(&mut self) -> Recording;
    fn play(&self, sound: Sound);
    fn show_overlay(&self, state: &OverlayState, target: Option<WindowId>);
    /// `dictation:done` for the Dictation screen.
    fn dictation_done(&self, id: Option<i64>);
    /// `dictation:composer` for the main window's composer (no OS text insertion).
    fn composer_result(&self, result: &ComposerResult);
}

/// Putting text into another program (blocking: waits for modifier release, clipboard restore).
pub trait Delivery: Send + Sync {
    fn insert(&self, target: WindowId, text: &str, method: InsertMethod, keep_on_clipboard: bool) -> InsertResult;
    /// True when the clipboard now holds `text`.
    fn copy(&self, text: &str) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HubCallError {
    Unavailable,
    ModelMissing,
    Busy,
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptStatus {
    Ok,
    NoSpeech,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub status: TranscriptStatus,
    #[serde(default)]
    pub raw_text: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub final_text: String,
    pub cleaned: bool,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub duration_seconds: f64,
    pub raw_text: String,
    pub final_text: String,
    pub cleaned: bool,
    pub outputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub id: Option<i64>,
    #[serde(default)]
    pub file_error: Option<String>,
}

/// The hub's dictation routes (`docs/hub-api.md`). Blocking.
pub trait DictationHub: Send + Sync {
    fn settings(&self) -> Result<DictationSettings, HubCallError>;
    fn preload(&self) -> Result<(), HubCallError>;
    /// 16 kHz mono samples.
    fn transcribe(&self, samples: &[f32]) -> Result<Transcript, HubCallError>;
    fn cleanup(&self, text: &str) -> Result<Cleanup, HubCallError>;
    fn cancel(&self);
    fn save(&self, request: &SaveRequest) -> Result<SaveResult, HubCallError>;
    /// Final text of the newest dictation in the history.
    fn latest_text(&self) -> Result<Option<String>, HubCallError>;
}

/// `dictation_status` payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    pub gesture: String,
    pub error: Option<HotkeyError>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub enabled: bool,
    pub hotkey: HotkeyStatus,
    pub paste_last_hotkey: HotkeyStatus,
    pub phase: Phase,
}

impl Default for DictationStatus {
    fn default() -> Self {
        let none = HotkeyStatus { gesture: String::new(), error: None };
        Self { enabled: false, hotkey: none.clone(), paste_last_hotkey: none, phase: Phase::Hidden }
    }
}
