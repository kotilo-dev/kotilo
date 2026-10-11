//! [`DictationHub`] over the hub's loopback API (`docs/hub-api.md` → Dictation).

use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::dictation::{audio, Cleanup, DictationHub, DictationSettings, HubCallError, SaveRequest, SaveResult, Transcript};
use crate::hub::client::{Body, HubClient, HubError};

const SHORT: Duration = Duration::from_secs(10);
/// Whisper on the CPU runs at about a third of real time for the large model, and a
/// recording may be 30 minutes long; Esc cancels earlier.
const TRANSCRIBE: Duration = Duration::from_secs(60 * 60);
/// The hub gives AI cleanup 60 s, then answers with the raw text.
const CLEANUP: Duration = Duration::from_secs(90);

pub struct HubDictation {
    client: HubClient,
}

impl HubDictation {
    pub fn new(client: HubClient) -> Self {
        Self { client }
    }

    fn call<T: DeserializeOwned>(&self, method: &str, path: &str, body: Body<'_>, timeout: Duration) -> Result<T, HubCallError> {
        let value = self.client.request_body(method, path, body, timeout).map_err(map_error)?;
        serde_json::from_value(value).map_err(|e| HubCallError::Other(e.to_string()))
    }
}

fn map_error(e: HubError) -> HubCallError {
    match e {
        HubError::Unavailable => HubCallError::Unavailable,
        HubError::Status { error: Some(code), .. } if code == "modelMissing" => HubCallError::ModelMissing,
        HubError::Status { error: Some(code), .. } if code == "busy" => HubCallError::Busy,
        other => HubCallError::Other(other.to_string()),
    }
}

impl DictationHub for HubDictation {
    fn settings(&self) -> Result<DictationSettings, HubCallError> {
        let mut all: serde_json::Value = self.call("GET", "/v1/settings", Body::None, SHORT)?;
        serde_json::from_value(all["dictation"].take()).map_err(|e| HubCallError::Other(e.to_string()))
    }

    fn preload(&self) -> Result<(), HubCallError> {
        self.client.request_body("POST", "/v1/dictation/preload", Body::None, SHORT).map(|_| ()).map_err(map_error)
    }

    fn transcribe(&self, samples: &[f32]) -> Result<Transcript, HubCallError> {
        self.call("POST", "/v1/dictation/transcribe", Body::Bytes(&audio::to_le_bytes(samples)), TRANSCRIBE)
    }

    fn cleanup(&self, text: &str) -> Result<Cleanup, HubCallError> {
        self.call("POST", "/v1/dictation/cleanup", Body::Json(&serde_json::json!({ "text": text })), CLEANUP)
    }

    fn cancel(&self) {
        if let Err(e) = self.client.request_body("POST", "/v1/dictation/cancel", Body::None, SHORT) {
            log::warn!("dictation: cancel failed: {e}");
        }
    }

    fn save(&self, request: &SaveRequest) -> Result<SaveResult, HubCallError> {
        let body = serde_json::to_value(request).map_err(|e| HubCallError::Other(e.to_string()))?;
        self.call("POST", "/v1/dictations", Body::Json(&body), SHORT)
    }

    fn latest_text(&self) -> Result<Option<String>, HubCallError> {
        let list: Vec<serde_json::Value> = self.call("GET", "/v1/dictations?limit=1", Body::None, SHORT)?;
        Ok(list.first().and_then(|d| d["finalText"].as_str()).map(str::to_owned))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictation::{InsertMethod, TranscriptStatus};
    use crate::hub::client::tests::{client_for, fake_hub};

    #[test]
    fn settings_come_from_the_dictation_section() {
        let (port, server) = fake_hub(
            "200 OK",
            r#"{"language":"tr-TR","dictation":{"enabled":true,"hotkey":"Ctrl+Alt+K","pasteLastHotkey":"Ctrl+Alt+L","model":"large","aiCleanup":true,"outputFocused":true,"insertMethod":"type","outputClipboard":false,"soundCues":false,"maxMinutes":2}}"#,
        );
        let (_dir, client) = client_for(port);
        let s = HubDictation::new(client).settings().unwrap();
        assert_eq!(s.hotkey, "Ctrl+Alt+K");
        assert_eq!(s.insert_method, InsertMethod::Type);
        assert!(s.ai_cleanup && !s.sound_cues);
        assert_eq!(s.max_minutes, 2);
        assert!(server.join().unwrap().starts_with("GET /v1/settings "));
    }

    #[test]
    fn transcribe_sends_little_endian_floats_and_reads_the_result() {
        let (port, server) = fake_hub("200 OK", r#"{"status":"noSpeech","rawText":"","speechSeconds":0.1,"model":"large","language":"tr"}"#);
        let (_dir, client) = client_for(port);
        let t = HubDictation::new(client).transcribe(&[0.5, -0.25]).unwrap();
        assert_eq!(t.status, TranscriptStatus::NoSpeech);
        let head = server.join().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("post /v1/dictation/transcribe "));
        assert!(head.contains("content-type: application/octet-stream"));
        assert!(head.contains("content-length: 8"));
    }

    #[test]
    fn hub_error_codes_map_to_dictation_errors() {
        let (port, server) = fake_hub("409 Conflict", r#"{"error":"modelMissing","message":"Download the model first."}"#);
        let (_dir, client) = client_for(port);
        assert_eq!(HubDictation::new(client).preload(), Err(HubCallError::ModelMissing));
        server.join().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let offline = HubDictation::new(HubClient::new(dir.path().to_path_buf()));
        assert_eq!(offline.preload(), Err(HubCallError::Unavailable));
    }

    #[test]
    fn latest_text_reads_the_newest_history_entry() {
        let (port, server) = fake_hub("200 OK", r#"[{"id":3,"finalText":"son dikte"}]"#);
        let (_dir, client) = client_for(port);
        assert_eq!(HubDictation::new(client).latest_text().unwrap().as_deref(), Some("son dikte"));
        assert!(server.join().unwrap().starts_with("GET /v1/dictations?limit=1 "));
    }
}
