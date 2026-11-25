//! Thin binary shell around [`agenthub_hook::statusline::run`]: Claude Code's `statusLine`
//! command. Always prints at most one line and always exits 0 (a non-zero exit blanks Claude's
//! status line); never panics (no `unwrap`/indexing on input-controlled data).

use std::io::Write;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agenthub_hook::statusline::{run, HUB_BUDGET_MS, WRAPPED_TIMEOUT_MS};

fn main() {
    // Hard backstop behind "always exit 0": covers a stdin that never closes.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(WRAPPED_TIMEOUT_MS + 2_000));
        std::process::exit(0);
    });

    // Same data-folder fallbacks as the hook (an agent may run us with a thin environment).
    let env_lookup = |k: &str| {
        std::env::var(k).ok().filter(|v| !v.is_empty()).or_else(|| match k {
            "LOCALAPPDATA" => agenthub_hook::platform::known_local_app_data(),
            "HOME" => agenthub_hook::platform::known_home(),
            _ => None,
        })
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let output = run(
        &env_lookup,
        &mut std::io::stdin(),
        now,
        Duration::from_millis(HUB_BUDGET_MS),
        Duration::from_millis(WRAPPED_TIMEOUT_MS),
    );
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(&output).and_then(|_| stdout.flush());
    std::process::exit(0);
}
