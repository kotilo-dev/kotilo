//! M7 assistant popup (D-053), platform-free part: the settings the main window sends
//! (`assistant_set_config`), what the hotkey needs on each change, and the chat stream from
//! the hub ([`chat`]). The window and the OS hotkey live in `platform::assistant` and
//! `platform::hotkeys`. Nothing here keeps or logs conversation text (AGENTS rule 5).

pub mod chat;

use serde::{Deserialize, Serialize};

use crate::dictation::gesture::Gesture;

/// `assistant_set_config` argument (hub `buddy.enabled` / `buddy.hotkey`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConfig {
    pub enabled: bool,
    pub hotkey: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyStatus {
    /// Registered.
    Ok,
    /// Another program (or another of our hotkeys) already has it.
    Taken,
    /// Not a valid gesture (needs Ctrl, Alt or Win plus a key).
    Invalid,
    /// The assistant is off; nothing registered.
    Off,
}

/// `assistant:hotkey` payload for the main window. `hotkey` is the normalised gesture
/// (`Ctrl+Alt+Space`), or the text as given when it is not valid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyReport {
    pub status: HotkeyStatus,
    pub hotkey: String,
}

/// What to do with the OS hotkey for a new config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HotkeyStep {
    /// Nothing to change; report this.
    Keep(HotkeyReport),
    /// Unregister the current gesture; report this.
    Unregister(HotkeyReport),
    /// (Re-)register this gesture: `Ok` on success, `Taken` on failure.
    Register(Gesture),
}

/// `registered` is the gesture the OS currently holds for the assistant (`None` after a
/// failed attempt, so a taken hotkey is retried on the next config).
pub fn hotkey_step(registered: Option<&Gesture>, config: &AssistantConfig) -> HotkeyStep {
    let text = config.hotkey.trim().to_string();
    let not_registered = |status| {
        let report = HotkeyReport { status, hotkey: text.clone() };
        if registered.is_some() {
            HotkeyStep::Unregister(report)
        } else {
            HotkeyStep::Keep(report)
        }
    };
    if !config.enabled {
        return not_registered(HotkeyStatus::Off);
    }
    match Gesture::parse(&text) {
        None => not_registered(HotkeyStatus::Invalid),
        Some(g) if registered == Some(&g) => {
            HotkeyStep::Keep(HotkeyReport { status: HotkeyStatus::Ok, hotkey: g.text })
        }
        Some(g) => HotkeyStep::Register(g),
    }
}

/// What a hotkey press does with the popup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    /// Hidden: show a fresh chat.
    Open,
    /// Visible but another window has focus: bring it back as it is.
    Focus,
    /// Visible and focused: hide (the chat ends).
    Hide,
}

pub fn toggle_action(visible: bool, focused: bool) -> ToggleAction {
    match (visible, focused) {
        (false, _) => ToggleAction::Open,
        (true, false) => ToggleAction::Focus,
        (true, true) => ToggleAction::Hide,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(enabled: bool, hotkey: &str) -> AssistantConfig {
        AssistantConfig { enabled, hotkey: hotkey.into() }
    }

    fn report(status: HotkeyStatus, hotkey: &str) -> HotkeyReport {
        HotkeyReport { status, hotkey: hotkey.into() }
    }

    #[test]
    fn config_wire_format() {
        let c: AssistantConfig = serde_json::from_str(r#"{"enabled":true,"hotkey":"Ctrl+Alt+Space"}"#).unwrap();
        assert_eq!(c, config(true, "Ctrl+Alt+Space"));
        let v = serde_json::to_value(report(HotkeyStatus::Taken, "Ctrl+Alt+Space")).unwrap();
        assert_eq!(v, serde_json::json!({"status":"taken","hotkey":"Ctrl+Alt+Space"}));
        for (s, name) in [(HotkeyStatus::Ok, "ok"), (HotkeyStatus::Invalid, "invalid"), (HotkeyStatus::Off, "off")] {
            assert_eq!(serde_json::to_value(s).unwrap(), name);
        }
    }

    #[test]
    fn enabling_registers_the_normalised_gesture() {
        let HotkeyStep::Register(g) = hotkey_step(None, &config(true, " ctrl+alt+space ")) else { panic!() };
        assert_eq!(g.text, "Ctrl+Alt+Space");
    }

    #[test]
    fn unchanged_config_does_not_re_register() {
        let g = Gesture::parse("Ctrl+Alt+Space").unwrap();
        assert_eq!(
            hotkey_step(Some(&g), &config(true, "Ctrl+Alt+Space")),
            HotkeyStep::Keep(report(HotkeyStatus::Ok, "Ctrl+Alt+Space"))
        );
        // Same gesture written differently is still unchanged.
        assert_eq!(
            hotkey_step(Some(&g), &config(true, "alt + ctrl + space")),
            HotkeyStep::Keep(report(HotkeyStatus::Ok, "Ctrl+Alt+Space"))
        );
    }

    #[test]
    fn a_new_gesture_or_a_taken_one_registers_again() {
        let g = Gesture::parse("Ctrl+Alt+Space").unwrap();
        assert!(matches!(hotkey_step(Some(&g), &config(true, "Ctrl+Alt+A")), HotkeyStep::Register(n) if n.text == "Ctrl+Alt+A"));
        // After "taken" nothing is registered: the next config tries again.
        assert!(matches!(hotkey_step(None, &config(true, "Ctrl+Alt+Space")), HotkeyStep::Register(_)));
    }

    #[test]
    fn disabling_or_an_invalid_gesture_unregisters_once() {
        let g = Gesture::parse("Ctrl+Alt+Space").unwrap();
        assert_eq!(
            hotkey_step(Some(&g), &config(false, "Ctrl+Alt+Space")),
            HotkeyStep::Unregister(report(HotkeyStatus::Off, "Ctrl+Alt+Space"))
        );
        assert_eq!(hotkey_step(None, &config(false, "Ctrl+Alt+Space")), HotkeyStep::Keep(report(HotkeyStatus::Off, "Ctrl+Alt+Space")));
        assert_eq!(hotkey_step(Some(&g), &config(true, "Space")), HotkeyStep::Unregister(report(HotkeyStatus::Invalid, "Space")));
        assert_eq!(hotkey_step(None, &config(true, "")), HotkeyStep::Keep(report(HotkeyStatus::Invalid, "")));
    }

    #[test]
    fn toggle_opens_focuses_or_hides() {
        assert_eq!(toggle_action(false, false), ToggleAction::Open);
        assert_eq!(toggle_action(false, true), ToggleAction::Open);
        assert_eq!(toggle_action(true, false), ToggleAction::Focus);
        assert_eq!(toggle_action(true, true), ToggleAction::Hide);
    }
}
