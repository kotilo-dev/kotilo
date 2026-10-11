//! One shortcut for both styles (CCC spec §22.1): hold to talk, or tap to start and tap
//! again to stop. RegisterHotKey only reports the press, so the controller polls whether
//! the key is still down and feeds it here. Port of `Hub.Core/Dictation/HoldToTalk.cs`.

use serde::Serialize;

pub const HOLD_THRESHOLD_MS: u64 = 350;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TalkMode {
    /// Just pressed; not yet known whether the key is held or tapped.
    Undecided,
    /// Held past the threshold: releasing the key stops.
    Hold,
    /// Tapped: recording runs until the shortcut is pressed again.
    Toggle,
}

#[derive(Debug, Clone)]
pub struct HoldToTalk {
    pressed_at: u64,
    pub mode: TalkMode,
}

impl HoldToTalk {
    pub fn begin(now_ms: u64) -> Self {
        Self { pressed_at: now_ms, mode: TalkMode::Undecided }
    }

    /// True when the recording should stop now (the held key was released).
    pub fn observe(&mut self, key_down: bool, now_ms: u64) -> bool {
        let held = now_ms.saturating_sub(self.pressed_at) >= HOLD_THRESHOLD_MS;
        match self.mode {
            TalkMode::Undecided if key_down => {
                if held {
                    self.mode = TalkMode::Hold;
                }
                false
            }
            // Released: a quick tap toggles; a release first seen after the threshold is a hold.
            TalkMode::Undecided if !held => {
                self.mode = TalkMode::Toggle;
                false
            }
            TalkMode::Undecided => {
                self.mode = TalkMode::Hold;
                true
            }
            TalkMode::Hold => !key_down,
            TalkMode::Toggle => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quick_tap_toggles_and_keeps_recording() {
        let mut h = HoldToTalk::begin(0);
        assert!(!h.observe(true, 100));
        assert!(!h.observe(false, 150));
        assert_eq!(h.mode, TalkMode::Toggle);
        assert!(!h.observe(false, 5_000));
    }

    #[test]
    fn holding_past_the_threshold_stops_on_release() {
        let mut h = HoldToTalk::begin(0);
        assert!(!h.observe(true, 400));
        assert_eq!(h.mode, TalkMode::Hold);
        assert!(!h.observe(true, 2_000));
        assert!(h.observe(false, 2_040));
    }

    #[test]
    fn release_detected_late_after_the_threshold_still_counts_as_hold() {
        let mut h = HoldToTalk::begin(0);
        assert!(h.observe(false, 500));
        assert_eq!(h.mode, TalkMode::Hold);
    }
}
