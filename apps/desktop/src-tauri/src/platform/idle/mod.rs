//! D-056: "back at the desk". A background watcher polls how long the user has been idle
//! (no keyboard/mouse input, system-wide) and, when input resumes after at least
//! `agents.awaySummaryMinutes`, emits `user:returned { awayMs }` once, so the main window
//! can show one "while you were away" summary. The OS query lives in `win.rs`; other
//! systems report no idle time and the event never fires.

#[cfg(windows)]
mod win;

use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::SettingsStore;

pub const USER_RETURNED_EVENT: &str = "user:returned";
const POLL_EVERY: Duration = Duration::from_secs(5);

#[cfg(windows)]
mod os {
    pub use super::win::idle_ms;
}

#[cfg(not(windows))]
mod os {
    pub fn idle_ms() -> Option<u64> {
        None
    }
}

/// Milliseconds since the last keyboard/mouse input anywhere on the system, if known.
pub fn idle_ms() -> Option<u64> {
    os::idle_ms()
}

/// Idle time from two 32-bit millisecond tick counts (`GetTickCount` wraps after ~49.7 days).
pub fn idle_from_ticks(now: u32, last_input: u32) -> u64 {
    u64::from(now.wrapping_sub(last_input))
}

/// The away/return decision, fed one idle reading per poll.
#[derive(Debug, Default)]
pub struct AwayTracker {
    /// Idle time at the previous poll.
    last_idle_ms: u64,
}

impl AwayTracker {
    /// `elapsed_ms` is the time since the previous poll. Input since the previous poll shows
    /// as a smaller idle time; the away stretch then is the previous idle time plus the part
    /// of the gap before that input. Returns the away time when it reached `threshold_ms`
    /// and the summary is on – at most once per away stretch.
    pub fn step(&mut self, idle_ms: u64, elapsed_ms: u64, threshold_ms: u64, enabled: bool) -> Option<u64> {
        let previous = std::mem::replace(&mut self.last_idle_ms, idle_ms);
        if idle_ms >= previous {
            return None;
        }
        let away = previous + elapsed_ms.saturating_sub(idle_ms);
        (enabled && away >= threshold_ms).then_some(away)
    }
}

/// Starts the watcher thread for the app's lifetime (settings are read on every poll).
pub fn start_watcher(app: AppHandle) {
    if idle_ms().is_none() {
        log::info!("idle: no idle-time source on this system; away summary off");
        return;
    }
    let spawned = std::thread::Builder::new().name("idle-watcher".into()).spawn(move || {
        let mut tracker = AwayTracker::default();
        let mut last_poll = Instant::now();
        loop {
            std::thread::sleep(POLL_EVERY);
            let Some(idle) = idle_ms() else { continue };
            let elapsed = u64::try_from(last_poll.elapsed().as_millis()).unwrap_or(u64::MAX);
            last_poll = Instant::now();
            let Some(store) = app.try_state::<SettingsStore>() else { continue };
            let agents = store.get().agents;
            let threshold = u64::from(agents.away_summary_minutes) * 60_000;
            if let Some(away_ms) = tracker.step(idle, elapsed, threshold, agents.away_summary) {
                log::info!("idle: user returned after {} min", away_ms / 60_000);
                let _ = app.emit(USER_RETURNED_EVENT, serde_json::json!({ "awayMs": away_ms }));
            }
        }
    });
    if let Err(err) = spawned {
        log::warn!("idle: watcher thread could not start: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60_000;
    const POLL: u64 = 5_000;

    #[test]
    fn idle_handles_tick_wrap() {
        assert_eq!(idle_from_ticks(10_000, 4_000), 6_000);
        assert_eq!(idle_from_ticks(1_000, u32::MAX - 999), 2_000);
        assert_eq!(idle_from_ticks(5, 5), 0);
    }

    /// Feeds idle readings one poll apart; returns every emitted away time.
    fn run(readings: &[u64], threshold: u64, enabled: bool) -> Vec<u64> {
        let mut tracker = AwayTracker::default();
        readings.iter().filter_map(|&idle| tracker.step(idle, POLL, threshold, enabled)).collect()
    }

    #[test]
    fn returns_once_after_a_long_absence() {
        // Idle grows to 12 min, then input 1 s before the next poll.
        let mut readings: Vec<u64> = (0..=144).map(|i| i * POLL).collect();
        readings.extend([1_000, 6_000, 11_000]);
        let events = run(&readings, 10 * MIN, true);
        assert_eq!(events, vec![144 * POLL + POLL - 1_000]);
    }

    #[test]
    fn short_breaks_do_not_count() {
        let mut readings: Vec<u64> = (0..=60).map(|i| i * POLL).collect(); // 5 min
        readings.push(500);
        assert!(run(&readings, 10 * MIN, true).is_empty());
    }

    #[test]
    fn disabled_summary_never_fires() {
        let mut readings: Vec<u64> = (0..=200).map(|i| i * POLL).collect();
        readings.push(0);
        assert!(run(&readings, 10 * MIN, false).is_empty());
    }

    #[test]
    fn active_user_never_fires() {
        assert!(run(&[0, 300, 1_000, 200, 4_000, 0], MIN, true).is_empty());
    }

    #[test]
    fn a_jump_after_sleep_counts_as_away() {
        // The machine slept: one poll sees 2 h idle, the next sees fresh input.
        let mut tracker = AwayTracker::default();
        assert_eq!(tracker.step(0, POLL, 10 * MIN, true), None);
        assert_eq!(tracker.step(120 * MIN, 120 * MIN, 10 * MIN, true), None);
        assert_eq!(tracker.step(2_000, POLL, 10 * MIN, true), Some(120 * MIN + 3_000));
        assert_eq!(tracker.step(100, POLL, 10 * MIN, true), None);
    }
}
