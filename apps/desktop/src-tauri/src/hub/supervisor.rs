//! Hub supervisor (ARCHITECTURE §2.1): starts `kotilo-hub` as a hidden background
//! process, restarts it with backoff when it dies, and leaves an already-running hub alone.
//! The hub gets `--parent-pid <our pid>` and shuts itself down once this app is gone, so
//! there is no kill path here (a kill would skip the hub's own drain of queued events).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// `Hub.Service` exits with this code when another hub already holds the instance mutex.
pub const EXIT_ALREADY_RUNNING: i32 = 2;
/// A hub that ran at least this long before dying counts as healthy: backoff restarts at 1 s.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How often to retry when another hub instance owns the mutex (it may go away).
const EXTERNAL_RECHECK: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum HubStatus {
    /// Supervisor not started yet.
    Stopped,
    /// No hub executable found (see `hub::locate_hub_exe`).
    NotFound,
    Running { pid: u32 },
    /// Another hub instance (e.g. started by a second copy of the app) is serving.
    External,
    /// Died; restarting after a backoff.
    Restarting { restarts: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NextStep {
    Restart { after: Duration, attempt: u32 },
    WaitForExternal { after: Duration },
}

/// 1 s, 2 s, 4 s, … capped at 30 s. `attempt` starts at 1.
pub fn backoff(attempt: u32) -> Duration {
    let secs = 1u64.checked_shl(attempt.saturating_sub(1)).unwrap_or(u64::MAX);
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

/// What to do after the hub exited with `exit_code` (None = killed / no code) having run
/// for `ran_for`; `attempt` is the number of consecutive quick failures so far.
pub fn next_step(exit_code: Option<i32>, ran_for: Duration, attempt: u32) -> NextStep {
    if exit_code == Some(EXIT_ALREADY_RUNNING) {
        return NextStep::WaitForExternal { after: EXTERNAL_RECHECK };
    }
    let attempt = if ran_for >= HEALTHY_RUN { 1 } else { attempt + 1 };
    NextStep::Restart { after: backoff(attempt), attempt }
}

#[derive(Clone)]
pub struct HubSupervisor {
    status: Arc<Mutex<HubStatus>>,
}

impl Default for HubSupervisor {
    fn default() -> Self {
        Self {
            status: Arc::new(Mutex::new(HubStatus::Stopped)),
        }
    }
}

impl HubSupervisor {
    pub fn status(&self) -> HubStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, status: HubStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    /// Starts the supervision thread. `tools_dir` holds `agenthub-hook` (this app's own
    /// folder); the hub copies it to its stable `bin` dir for agent hook commands.
    /// `adapters_dir` is the built-in adapter definitions folder (M3), passed as
    /// `AGENTHUB_ADAPTERS_DIR`.
    pub fn start(&self, hub_exe: Option<PathBuf>, tools_dir: Option<PathBuf>, adapters_dir: Option<PathBuf>) {
        let Some(exe) = hub_exe else {
            log::warn!("hub: executable not found; running without the background service");
            self.set(HubStatus::NotFound);
            return;
        };
        let this = self.clone();
        std::thread::spawn(move || this.run(&exe, tools_dir.as_deref(), adapters_dir.as_deref()));
    }

    fn run(&self, exe: &Path, tools_dir: Option<&Path>, adapters_dir: Option<&Path>) {
        let mut attempt = 0u32;
        loop {
            let started = Instant::now();
            let mut cmd = Command::new(exe);
            cmd.arg("--parent-pid")
                .arg(std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Some(dir) = tools_dir {
                cmd.env("AGENTHUB_TOOLS_DIR", dir);
            }
            if let Some(dir) = adapters_dir {
                cmd.env("AGENTHUB_ADAPTERS_DIR", dir);
            }
            crate::platform::hide_console_window(&mut cmd);

            let exit_code = match cmd.spawn() {
                Ok(mut child) => {
                    log::info!("hub: started pid={}", child.id());
                    self.set(HubStatus::Running { pid: child.id() });
                    child.wait().ok().and_then(|s| s.code())
                }
                Err(e) => {
                    log::warn!("hub: failed to start: {e}");
                    None
                }
            };

            match next_step(exit_code, started.elapsed(), attempt) {
                NextStep::WaitForExternal { after } => {
                    log::info!("hub: another instance is running");
                    self.set(HubStatus::External);
                    attempt = 0;
                    std::thread::sleep(after);
                }
                NextStep::Restart { after, attempt: next } => {
                    log::warn!("hub: exited code={exit_code:?}; restarting in {}s", after.as_secs());
                    self.set(HubStatus::Restarting { restarts: next });
                    attempt = next;
                    std::thread::sleep(after);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(2), Duration::from_secs(2));
        assert_eq!(backoff(5), Duration::from_secs(16));
        assert_eq!(backoff(6), Duration::from_secs(30));
        assert_eq!(backoff(200), Duration::from_secs(30));
    }

    #[test]
    fn quick_failures_back_off_further() {
        let step = next_step(Some(1), Duration::from_secs(2), 2);
        assert_eq!(step, NextStep::Restart { after: Duration::from_secs(4), attempt: 3 });
    }

    #[test]
    fn a_long_healthy_run_resets_the_backoff() {
        let step = next_step(None, Duration::from_secs(3600), 5);
        assert_eq!(step, NextStep::Restart { after: Duration::from_secs(1), attempt: 1 });
    }

    #[test]
    fn already_running_waits_instead_of_restarting() {
        assert_eq!(
            next_step(Some(EXIT_ALREADY_RUNNING), Duration::from_millis(200), 0),
            NextStep::WaitForExternal { after: EXTERNAL_RECHECK }
        );
    }

    #[test]
    fn missing_exe_reports_not_found() {
        let sup = HubSupervisor::default();
        assert_eq!(sup.status(), HubStatus::Stopped);
        sup.start(None, None, None);
        assert_eq!(sup.status(), HubStatus::NotFound);
    }
}
