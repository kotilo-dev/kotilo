//! PTY registry and shell-profile detection (Faz 1 risk spike → Faz 4 spec §1.1, §1.2,
//! §4 items 13-21).
//!
//! One `portable-pty` (ConPTY) pane per `pane_id`. Output is streamed to the frontend
//! as raw bytes through a Tauri IPC [`Channel`] (D2): a reader thread does blocking
//! reads off a cloned reader handle and hands chunks to a batching thread over an
//! `mpsc` channel; the batcher coalesces chunks for ~16 ms (or until 64 KB) before
//! calling `channel.send(InvokeResponseBody::Raw(bytes))`, which arrives in JS as an
//! `ArrayBuffer` (verified against `tauri-2.12.0/src/ipc/channel.rs`: `Channel<TSend>`
//! defaults to `TSend = InvokeResponseBody`, and sending `InvokeResponseBody::Raw` skips
//! the JSON path entirely).
//!
//! Every spawned child is assigned to a Windows Job Object with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (D8): closing the job's last handle (which we
//! do by dropping the pane's [`PaneHandle`] — on `pty_kill` or after the child exits)
//! terminates every process still assigned to the job, so `claude`'s whole subprocess
//! tree dies with the pane, not just the shell.
//!
//! ConPTY does not reliably EOF the master's reader when only the child exits (the
//! pseudoconsole keeps its output pipe open); a separate `child.wait()` thread detects
//! the exit, removes (and thus drops) the pane's `master`/`writer`/job handle — which
//! is what actually unblocks the reader thread's blocking `read()` — and only then
//! emits `pty:exit`.
//!
//! Each pane's writer lives in its own `Arc<Mutex<..>>` (spec §4.13): `pty_write*`
//! clone the `Arc` while holding the registry lock just long enough to look it up, then
//! drop that lock before actually writing — a large paste into one pane never blocks
//! `pty_write`/`pty_resize`/`pty_busy` on every other pane.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
#[cfg(windows)]
use windows::Win32::System::Console::SetConsoleCtrlHandler;
#[cfg(windows)]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    JobObjectBasicProcessIdList, QueryInformationJobObject, SetInformationJobObject,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
#[cfg(windows)]
use windows::core::PWSTR;

use crate::adapters::CloseStep;
use crate::error::{AppError, AppResult};
use crate::fsguard;
use crate::ipc_server;
use crate::workspace::WorkspaceStore;

/// A batch is flushed once it reaches this size even if 16 ms haven't elapsed.
const FLUSH_THRESHOLD_BYTES: usize = 64 * 1024;
/// A non-empty batch is flushed after this much time with no new data (D2).
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Spec §4.10: the backend clamps both `pty_spawn`'s initial size and every
/// `pty_resize` (once past the `0`-means-no-op case) to at least this, since ConPTY
/// doesn't tolerate a degenerate 0/1-cell pane.
const MIN_PTY_DIMENSION: u16 = 2;

// ---------------------------------------------------------------------------------
// Shell profiles (spec §1.1, §4.14)
// ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Pwsh,
    Powershell,
    Cmd,
    GitBash,
    Wsl,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: ShellKind,
    pub name: String,
    /// Absolute path, **never** `canonicalize`d (spec §4.14): Store's `pwsh` ships an
    /// app-execution alias at `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` that
    /// `canonicalize` fails on with OS error 1920, even though `exists()` succeeds and
    /// `CreateProcess` happily resolves the alias itself.
    pub program: String,
    pub args: Vec<String>,
}

type EnvLookup<'a> = dyn Fn(&str) -> Option<String> + 'a;
type PathExists<'a> = dyn Fn(&Path) -> bool + 'a;

/// Finds `filename` in `PATH`'s first matching directory. Shared by the `pwsh` and
/// `gitbash` detectors.
fn find_in_path(env: &EnvLookup, exists: &PathExists, filename: &str) -> Option<PathBuf> {
    let path_var = env("PATH")?;
    path_var
        .split(';')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(filename))
        .find(|candidate| exists(candidate))
}

/// pwsh candidates, in order (spec §4.14): PATH, `%ProgramFiles%\PowerShell\7\pwsh.exe`,
/// then the WindowsApps app-execution alias.
fn detect_pwsh(env: &EnvLookup, exists: &PathExists) -> Option<ShellProfile> {
    let program = find_in_path(env, exists, "pwsh.exe")
        .or_else(|| {
            env("ProgramFiles")
                .map(|p| Path::new(&p).join("PowerShell").join("7").join("pwsh.exe"))
                .filter(|c| exists(c))
        })
        .or_else(|| {
            env("LOCALAPPDATA")
                .map(|p| Path::new(&p).join("Microsoft").join("WindowsApps").join("pwsh.exe"))
                .filter(|c| exists(c))
        })?;
    Some(ShellProfile {
        id: ShellKind::Pwsh,
        name: "PowerShell 7".to_string(),
        program: program.to_string_lossy().into_owned(),
        args: vec!["-NoLogo".to_string()],
    })
}

fn detect_powershell(env: &EnvLookup, exists: &PathExists) -> Option<ShellProfile> {
    let system_root = env("SystemRoot").unwrap_or_else(|| r"C:\Windows".to_string());
    let candidate = Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !exists(&candidate) {
        return None;
    }
    Some(ShellProfile {
        id: ShellKind::Powershell,
        name: "Windows PowerShell".to_string(),
        program: candidate.to_string_lossy().into_owned(),
        args: vec!["-NoLogo".to_string()],
    })
}

fn detect_cmd(env: &EnvLookup, exists: &PathExists) -> Option<ShellProfile> {
    let program = env("ComSpec")
        .map(PathBuf::from)
        .filter(|c| exists(c))
        .or_else(|| {
            let system_root = env("SystemRoot").unwrap_or_else(|| r"C:\Windows".to_string());
            let fallback = Path::new(&system_root).join("System32").join("cmd.exe");
            exists(&fallback).then_some(fallback)
        })?;
    Some(ShellProfile {
        id: ShellKind::Cmd,
        name: "Command Prompt".to_string(),
        program: program.to_string_lossy().into_owned(),
        args: Vec::new(),
    })
}

/// Git Bash candidates, in order (spec §4.14): `%ProgramFiles%\Git\bin\bash.exe`,
/// `%ProgramFiles(x86)%\Git\bin\bash.exe`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`,
/// then — from wherever `git.exe` is found on `PATH` — both `<dir>\..\bin\bash.exe`
/// (covers `...\Git\cmd\git.exe`) and `<dir>\..\..\bin\bash.exe` (covers
/// `...\Git\mingw64\bin\git.exe`).
fn detect_gitbash(env: &EnvLookup, exists: &PathExists) -> Option<ShellProfile> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(v) = env("ProgramFiles") {
        candidates.push(Path::new(&v).join("Git").join("bin").join("bash.exe"));
    }
    if let Some(v) = env("ProgramFiles(x86)") {
        candidates.push(Path::new(&v).join("Git").join("bin").join("bash.exe"));
    }
    if let Some(v) = env("LOCALAPPDATA") {
        candidates.push(Path::new(&v).join("Programs").join("Git").join("bin").join("bash.exe"));
    }
    if let Some(git_exe) = find_in_path(env, exists, "git.exe") {
        if let Some(dir) = git_exe.parent() {
            if let Some(one_up) = dir.parent() {
                candidates.push(one_up.join("bin").join("bash.exe"));
                if let Some(two_up) = one_up.parent() {
                    candidates.push(two_up.join("bin").join("bash.exe"));
                }
            }
        }
    }

    let program = candidates.into_iter().find(|c| exists(c))?;
    Some(ShellProfile {
        id: ShellKind::GitBash,
        name: "Git Bash".to_string(),
        program: program.to_string_lossy().into_owned(),
        args: vec!["--login".to_string(), "-i".to_string()],
    })
}

fn detect_wsl(env: &EnvLookup, exists: &PathExists) -> Option<ShellProfile> {
    let system_root = env("SystemRoot").unwrap_or_else(|| r"C:\Windows".to_string());
    let candidate = Path::new(&system_root).join("System32").join("wsl.exe");
    if !exists(&candidate) {
        return None;
    }
    Some(ShellProfile {
        id: ShellKind::Wsl,
        name: "WSL".to_string(),
        program: candidate.to_string_lossy().into_owned(),
        args: Vec::new(),
    })
}

/// Pure detection core of `pty_profiles` (spec §1.1): only the profiles actually found
/// on this machine, in a fixed order (pwsh, powershell, cmd, gitbash, wsl) — the first
/// entry is the default profile used when `pty_spawn`'s `profileId` is `null`.
pub fn detect_profiles(env: &EnvLookup, exists: &PathExists) -> Vec<ShellProfile> {
    [
        detect_pwsh(env, exists),
        detect_powershell(env, exists),
        detect_cmd(env, exists),
        detect_gitbash(env, exists),
        detect_wsl(env, exists),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Cached for the app's lifetime (spec §1.1) — real file/PATH probing only happens once.
static PROFILES_CACHE: OnceLock<Vec<ShellProfile>> = OnceLock::new();

fn cached_profiles() -> &'static Vec<ShellProfile> {
    PROFILES_CACHE.get_or_init(|| {
        let env = |k: &str| std::env::var(k).ok();
        let exists = |p: &Path| p.exists();
        detect_profiles(&env, &exists)
    })
}

#[tauri::command(async)]
pub fn pty_profiles() -> Vec<ShellProfile> {
    cached_profiles().clone()
}

// ---------------------------------------------------------------------------------
// Agent command wrapping + pane env (spec §1.2, §4.16, §4.17, §4.18)
// ---------------------------------------------------------------------------------

/// PowerShell runs the user's profile before `-Command`, and a profile that changes the
/// location (`Set-Location ~` is common) would otherwise leave the pane outside the
/// workspace: the command first moves back to `cwd`. Single-quoted literal, so only the
/// quote characters PowerShell accepts as `'` (ASCII and the typographic ones) are doubled.
fn pwsh_set_location(cwd: &Path) -> String {
    let mut quoted = String::new();
    for ch in cwd.to_string_lossy().chars() {
        if matches!(ch, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            quoted.push(ch);
        }
        quoted.push(ch);
    }
    format!("Set-Location -LiteralPath '{quoted}'")
}

/// Pure (spec §1.2, unit-tested): the shell args that make the pane either sit at an
/// interactive prompt (`agent_command: None`) or run `agent_command` and then fall back
/// to an interactive shell once it exits. PowerShell always gets a `-Command` that
/// restores `cwd` after the profile (see `pwsh_set_location`).
pub fn wrap_agent_command(profile: &ShellProfile, cwd: &Path, agent_command: Option<&str>) -> Vec<String> {
    match (profile.id, agent_command) {
        (ShellKind::Pwsh | ShellKind::Powershell, _) => {
            let set_location = pwsh_set_location(cwd);
            let mut args = profile.args.clone();
            args.push("-NoExit".to_string());
            args.push("-Command".to_string());
            args.push(match agent_command {
                Some(agent) => format!("{set_location}; {agent}"),
                None => set_location,
            });
            args
        }
        (_, None) => profile.args.clone(),
        (ShellKind::Cmd, Some(agent)) => vec!["/K".to_string(), agent.to_string()],
        (ShellKind::GitBash, Some(agent)) => vec![
            "--login".to_string(),
            "-i".to_string(),
            "-c".to_string(),
            format!("{agent}; exec bash --login -i"),
        ],
        (ShellKind::Wsl, Some(agent)) => vec![
            "--".to_string(),
            "bash".to_string(),
            "-lic".to_string(),
            format!("{agent}; exec bash -li"),
        ],
    }
}

/// Spec §1.2: any `CLAUDECODE`/`CLAUDE_CODE_*` variable leaking from Kotilo's own
/// process env into a spawned pane closes a `claude` child's transcript (spike finding)
/// — checked case-insensitively since Windows env var names are case-insensitive.
pub fn should_remove_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper == "CLAUDECODE" || upper.starts_with("CLAUDE_CODE_")
}

/// Review item 17: the repo's `.cargo/config.toml` forces `CC=""`/`CXX=""` into every
/// `cargo run`/`tauri dev` invocation (a build-time-only override so the repo's own
/// build never picks up the user's real `CC=gcc`) — inherited by `CommandBuilder::new`
/// like the rest of Kotilo's own process env, it would otherwise leak into every
/// spawned pane's shell, where an EMPTY `CC`/`CXX` breaks anything in that shell which
/// shells out to a C/C++ compiler (an empty string is a very different thing from an
/// *unset* variable to most build tooling). Only a genuinely empty value is stripped — a
/// real one (the user's own `CC=gcc`, etc.) is left completely untouched.
pub fn should_strip_empty_toolchain_env(key: &str, value: &str) -> bool {
    if !value.is_empty() {
        return false;
    }
    matches!(key.to_ascii_uppercase().as_str(), "CC" | "CXX")
}

/// Pure (spec §1.2, §4.17, unit-tested): the pane-identifying + terminal-identifying env
/// vars `build_command` layers on top of the (scrubbed) parent env. `existing_wslenv` is
/// only consulted for `ShellKind::Wsl`, where the new Kotilo vars are appended to
/// whatever `WSLENV` already carries rather than replacing it.
pub fn pane_env_overrides(
    pane_id: &str,
    workspace_id: &str,
    endpoint: &str,
    shell: ShellKind,
    existing_wslenv: Option<&str>,
) -> Vec<(String, String)> {
    let mut overrides = vec![
        ("AGENTHUB_PANE_ID".to_string(), pane_id.to_string()),
        ("AGENTHUB_WORKSPACE_ID".to_string(), workspace_id.to_string()),
        ("AGENTHUB_ENDPOINT".to_string(), endpoint.to_string()),
        ("TERM_PROGRAM".to_string(), crate::brand::SLUG.to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        ("TERM".to_string(), "xterm-256color".to_string()),
    ];
    if shell == ShellKind::Wsl {
        const NEW_VARS: &str = "AGENTHUB_PANE_ID:AGENTHUB_WORKSPACE_ID:AGENTHUB_ENDPOINT";
        let merged = match existing_wslenv {
            Some(v) if !v.is_empty() => format!("{v}:{NEW_VARS}"),
            _ => NEW_VARS.to_string(),
        };
        overrides.push(("WSLENV".to_string(), merged));
    }
    overrides
}

/// Pure decision behind `build_command`'s agent-command validation (spec §4.18):
/// no profile accepts a command starting with `-` (would be parsed as a shell/exe flag),
/// and `cmd /K` specifically cannot carry an inner `"` (it has no way to re-quote it).
fn validate_agent_command(profile: &ShellProfile, agent: &str) -> AppResult<()> {
    if agent.starts_with('-') {
        return Err(AppError::invalid_name(
            "agent command must not start with '-'",
        ));
    }
    if profile.id == ShellKind::Cmd && agent.contains('"') {
        return Err(AppError::invalid_name(
            "cmd cannot run an agent command containing '\"'",
        ));
    }
    Ok(())
}

/// Builds the child process command for a pane (spec §4.16): pure aside from
/// `CommandBuilder::new`'s inherited parent environment, which is exactly what needs
/// scrubbing/augmenting here. Tests assert on the result via `get_argv()` and
/// `iter_full_env_as_str()`.
pub fn build_command(
    profile: &ShellProfile,
    cwd: &Path,
    agent_command: Option<&str>,
    pane_id: &str,
    workspace_id: &str,
    endpoint: &str,
) -> AppResult<CommandBuilder> {
    if let Some(agent) = agent_command {
        validate_agent_command(profile, agent)?;
    }

    let args = wrap_agent_command(profile, cwd, agent_command);

    let mut cmd = CommandBuilder::new(&profile.program);
    cmd.args(&args);
    cmd.cwd(cwd);

    let existing_wslenv = cmd
        .get_env("WSLENV")
        .map(|v| v.to_string_lossy().into_owned());

    let keys_to_remove: Vec<String> = cmd
        .iter_full_env_as_str()
        .filter(|(k, v)| should_remove_env_key(k) || should_strip_empty_toolchain_env(k, v))
        .map(|(k, _)| k.to_string())
        .collect();
    for key in keys_to_remove {
        cmd.env_remove(&key);
    }

    for (key, value) in pane_env_overrides(pane_id, workspace_id, endpoint, profile.id, existing_wslenv.as_deref())
    {
        cmd.env(key, value);
    }

    Ok(cmd)
}

fn image_filename(program: &str) -> String {
    Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.to_string())
}

/// Faz 7 spec §9.2: `portable-pty`'s spawn/openpty failures format their `Display`/`Debug`
/// as `CreateProcessW \`"<exe>" <all args>\` in cwd \`"<path>"\` failed: <os error>` — the
/// *entire* resolved command line and working directory, which must never be logged or
/// surfaced to the UI (it can carry an `agentCommand` the user typed, workspace paths,
/// etc). `portable-pty` also calls `log::error!` with the same unsanitized text itself
/// (silenced separately via the `portable_pty` target in `logging::init`).
///
/// This builds a sanitized replacement: the resolved executable's basename (never the
/// full path/args) plus the root OS error, recovered by walking the error's `source()`
/// chain for a `std::io::Error`. `portable-pty` raises these via `anyhow::bail!`, which
/// does not chain the underlying `std::io::Error` as a `source()` — it's already folded
/// into the message text — so the chain walk falls back to "unknown error" for the common
/// `CreateProcessW` failure; that trade favors never re-parsing the unsanitized message
/// over a more detailed but fragile text extraction.
///
/// Takes a `&dyn Error` (not `anyhow::Error` by name) deliberately: `anyhow` is only a
/// transitive dependency (via `portable-pty`), not a direct one, so this crate can't name
/// its `Error` type — only call through `std::error::Error` methods on values the compiler
/// already knows the (unnameable) concrete type of.
fn sanitize_spawn_error(program: &str, e: &(dyn std::error::Error + 'static)) -> String {
    let exe = image_filename(program);
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    let mut root_cause: Option<String> = None;
    while let Some(err) = cur {
        if let Some(io_err) = err.downcast_ref::<std::io::Error>() {
            root_cause = Some(io_err.to_string());
            break;
        }
        cur = err.source();
    }
    // portable-pty folds the OS error into a message that also carries argv/cwd (no
    // `source()`), so recover only the trailing `(os error N)` code and re-render it --
    // nothing else from that text is ever used.
    if root_cause.is_none() {
        root_cause = trailing_os_error_code(&e.to_string())
            .map(|code| std::io::Error::from_raw_os_error(code).to_string());
    }
    format!(
        "failed to launch {exe}: {}",
        root_cause.as_deref().unwrap_or("unknown error")
    )
}

/// `"... (os error 2)"` -> `Some(2)`; only a message *ending* in that suffix counts.
fn trailing_os_error_code(text: &str) -> Option<i32> {
    let rest = text.trim_end().strip_suffix(')')?;
    let (_, digits) = rest.rsplit_once("(os error ")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

// ---------------------------------------------------------------------------------
// Registry / spawn (spec §1.2, §4.13, §4.20)
// ---------------------------------------------------------------------------------

/// Windows Job Object handle, closed on drop. Closing the last handle to a job created
/// with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every process still assigned to
/// it (D8) — this is how `pty_kill` and "child exited" both tear down the whole
/// subprocess tree, not just the immediate shell.
#[cfg(windows)]
struct JobHandle(HANDLE);

#[cfg(windows)]
// SAFETY: a Win32 HANDLE is an opaque kernel object reference; it is valid to use from
// any thread as long as it isn't closed concurrently, which `Mutex<HashMap<..>>` in
// `PtyRegistry` already serializes.
unsafe impl Send for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// ---------------------------------------------------------------------------------
// Agent activity tracking (Faz 5 §1.4): cheap atomics updated on the pty reader thread
// (output) and by `pty_write*` (input) — the `agents` module's tick loop reads these
// without ever taking the registry lock's write path, so a busy pane's output never
// contends with agent bookkeeping for other panes.
// ---------------------------------------------------------------------------------

/// A new output chunk resets the "continuous output streak" if it arrives at least
/// this long after the previous chunk (Faz 5 §4 item 6: "kesintisiz = ardışık chunk'lar
/// arası boşluk < 300 ms").
pub(crate) const OUTPUT_STREAK_GAP_MS: u64 = 300;
/// Output arriving within this long after the last input is presumed to be the
/// terminal's own echo of what was just typed, not real agent activity (spec §1.4
/// heuristic fallback: "kullanıcı girdisinden sonraki 500 ms içindeki çıktı sayılmaz").
const ECHO_SUPPRESSION_MS: u64 = 500;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Default)]
pub struct PaneActivity {
    last_output_ms: AtomicU64,
    last_input_ms: AtomicU64,
    /// When the current run of gap-free output chunks began (reset whenever a chunk
    /// arrives `OUTPUT_STREAK_GAP_MS` or more after the previous one).
    output_streak_start_ms: AtomicU64,
    /// Like `last_output_ms`, but ignores chunks that arrived within
    /// `ECHO_SUPPRESSION_MS` of the last input (keystroke echo).
    last_meaningful_output_ms: AtomicU64,
}

/// Plain-data snapshot of a pane's [`PaneActivity`] (Faz 5 §1.4) — copied out from under
/// the registry lock so the `agents` tick loop can reason about it with its own single
/// `now_ms` rather than re-reading live atomics mid-calculation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PaneActivitySnapshot {
    pub last_output_ms: u64,
    pub last_input_ms: u64,
    pub output_streak_start_ms: u64,
    pub last_meaningful_output_ms: u64,
}

/// Called from the pty reader thread for every chunk read off the child (pure enough to
/// unit-test against a fake clock via the `*_at` variant below).
fn record_output_at(activity: &PaneActivity, now: u64) {
    let prev_output = activity.last_output_ms.swap(now, Ordering::Relaxed);
    if now.saturating_sub(prev_output) >= OUTPUT_STREAK_GAP_MS {
        activity.output_streak_start_ms.store(now, Ordering::Relaxed);
    }
    let last_input = activity.last_input_ms.load(Ordering::Relaxed);
    if now.saturating_sub(last_input) >= ECHO_SUPPRESSION_MS {
        activity.last_meaningful_output_ms.store(now, Ordering::Relaxed);
    }
}

fn record_output(activity: &PaneActivity) {
    record_output_at(activity, now_ms());
}

fn record_input(activity: &PaneActivity) {
    activity.last_input_ms.store(now_ms(), Ordering::Relaxed);
}

/// M3 screen rules (`adapters::screen`): a pane's terminal screen, kept by a `vt100`
/// parser that exists only while the `agents` tick enables it (the pane's agent has
/// `screenRules`), so other panes pay nothing but an uncontended lock per output chunk.
/// Parsing starts with whatever arrives after enabling; the agent's next redraw fills it.
pub struct PaneScreen {
    parser: Option<vt100::Parser>,
    rows: u16,
    cols: u16,
}

impl PaneScreen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self { parser: None, rows, cols }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        match (enabled, self.parser.is_some()) {
            (true, false) => self.parser = Some(vt100::Parser::new(self.rows, self.cols, 0)),
            (false, true) => self.parser = None,
            _ => {}
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        if let Some(parser) = self.parser.as_mut() {
            parser.process(bytes);
        }
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        if let Some(parser) = self.parser.as_mut() {
            parser.screen_mut().set_size(rows, cols);
        }
    }

    /// The visible rows, top to bottom (`None` while disabled).
    pub fn rows(&self) -> Option<Vec<String>> {
        let screen = self.parser.as_ref()?.screen();
        let (_, cols) = screen.size();
        Some(screen.rows(0, cols).collect())
    }
}

fn lock_screen(screen: &Mutex<PaneScreen>) -> MutexGuard<'_, PaneScreen> {
    screen.lock().unwrap_or_else(|e| e.into_inner())
}

/// Summary of one live pane for the `agents` heuristic tick (Faz 5 §1.4): everything it
/// needs to correlate a pane with the single per-tick system process snapshot, without
/// holding the registry lock for the whole tick.
#[derive(Debug, Clone)]
pub struct PaneSummary {
    pub pane_id: String,
    pub workspace_id: String,
    pub shell_pid: u32,
}

struct PaneHandle {
    spawned_at: Instant,
    workspace_id: String,
    activity: Arc<PaneActivity>,
    /// Declared *before* `master`: Rust drops struct fields in declaration order (top to
    /// bottom), so dropping `job` first closes the Job Object's last handle — which, via
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, hard-kills every process still assigned to it
    /// (the whole subprocess tree) — *before* `master` drops and calls
    /// `ClosePseudoConsole`. Closing the pseudo console while children are still alive
    /// can block on conhost winding them down; killing the tree first avoids that. Order
    /// matters here — do not reorder these two fields without preserving this relation.
    #[cfg(windows)]
    job: Option<JobHandle>,
    master: Box<dyn MasterPty + Send>,
    /// Own `Arc<Mutex<..>>` (spec §4.13) so `pty_write*` can clone it and release the
    /// registry lock before actually writing.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// The shell process's own pid and its program's image filename (e.g. `bash.exe`) —
    /// `pty_busy`'s decision needs both (spec §4.15).
    shell_pid: u32,
    shell_image_name: String,
    /// M3: shared with the reader thread, which feeds it while enabled.
    screen: Arc<Mutex<PaneScreen>>,
    /// 0.3.2: every descendant the `agents` heuristic tick has seen under this pane's
    /// shell (see [`merge_seen_descendants`]) — teardown and `pty_stop_leftovers` also
    /// reach orphans whose parent died, which the descendant walk no longer finds.
    seen_descendants: Vec<SeenProc>,
}

/// Shared PTY pane table. Managed as Tauri app state (`.manage(PtyRegistry::default())`).
#[derive(Default)]
pub struct PtyRegistry {
    panes: Mutex<HashMap<String, PaneHandle>>,
    /// Review item 5 (close-tab-then-quit): the completion `Receiver` of every graceful
    /// Claude close currently in flight from a single-pane `pty_kill` — unlike
    /// `clear_with`'s own waiters (returned straight to its caller), a `pty_kill`-started
    /// close previously had nowhere to hand its receiver to, so `RunEvent::Exit` never
    /// waited on it: a tab closed just before quitting could get hard-killed mid-`\x03`
    /// sequence instead of the grace period every other Claude pane gets. Registered by
    /// [`track_graceful_close`](Self::track_graceful_close), drained by
    /// [`take_pending_graceful_closes`](Self::take_pending_graceful_closes).
    pending_graceful: Mutex<Vec<std::sync::mpsc::Receiver<()>>>,
}

impl PtyRegistry {
    fn panes(&self) -> MutexGuard<'_, HashMap<String, PaneHandle>> {
        self.panes.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Resolves the dev-input helper's `"pane":"first"` (see `ipc_server`): the oldest
    /// pane that is still alive. Computed rather than remembered so a pane killed right
    /// after spawn (React StrictMode double-mounts the terminal in dev) never wins.
    pub fn first_pane_id(&self) -> Option<String> {
        self.panes()
            .iter()
            .min_by_key(|(_, pane)| pane.spawned_at)
            .map(|(id, _)| id.clone())
    }

    /// Clones the pane's writer `Arc` (spec §4.13) — callers must not keep the returned
    /// `PtyRegistry` lock held while writing through it. `None` for an unknown pane.
    fn writer_for(&self, pane_id: &str) -> Option<Arc<Mutex<Box<dyn Write + Send>>>> {
        self.panes().get(pane_id).map(|p| p.writer.clone())
    }

    /// The shell's own pid + its program's image filename, for `pty_busy` (spec §4.15).
    pub(crate) fn shell_info(&self, pane_id: &str) -> Option<(u32, String)> {
        self.panes()
            .get(pane_id)
            .map(|p| (p.shell_pid, p.shell_image_name.clone()))
    }

    /// The shell's own pid alone (Faz 5 §1.4: `agents` heuristic tick correlates panes
    /// against a single system-wide process snapshot via this).
    pub fn shell_pid(&self, pane_id: &str) -> Option<u32> {
        self.panes().get(pane_id).map(|p| p.shell_pid)
    }

    /// Every live pane's id/workspace/shell pid (Faz 5 §1.4), snapshotted under the lock
    /// and handed to the caller so the (comparatively expensive) system process walk
    /// never happens while the registry is locked.
    pub fn pane_summaries(&self) -> Vec<PaneSummary> {
        self.panes()
            .iter()
            .map(|(id, p)| PaneSummary {
                pane_id: id.clone(),
                workspace_id: p.workspace_id.clone(),
                shell_pid: p.shell_pid,
            })
            .collect()
    }

    /// Faz 5 §1.4: a plain-data copy of one pane's output/input activity timestamps.
    /// `None` for an unknown pane.
    pub fn activity_snapshot(&self, pane_id: &str) -> Option<PaneActivitySnapshot> {
        let panes = self.panes();
        let pane = panes.get(pane_id)?;
        Some(PaneActivitySnapshot {
            last_output_ms: pane.activity.last_output_ms.load(Ordering::Relaxed),
            last_input_ms: pane.activity.last_input_ms.load(Ordering::Relaxed),
            output_streak_start_ms: pane.activity.output_streak_start_ms.load(Ordering::Relaxed),
            last_meaningful_output_ms: pane
                .activity
                .last_meaningful_output_ms
                .load(Ordering::Relaxed),
        })
    }

    /// M3: turns the pane's screen parser on/off (no-op for an unknown pane or when it is
    /// already in that state).
    pub fn set_screen_enabled(&self, pane_id: &str, enabled: bool) {
        let screen = self.panes().get(pane_id).map(|p| p.screen.clone());
        if let Some(screen) = screen {
            lock_screen(&screen).set_enabled(enabled);
        }
    }

    /// M3: the pane's visible screen rows (`None` for an unknown pane or while disabled).
    pub fn screen_rows(&self, pane_id: &str) -> Option<Vec<String>> {
        let screen = self.panes().get(pane_id).map(|p| p.screen.clone())?;
        let rows = lock_screen(&screen).rows();
        rows
    }

    /// 0.3.2: folds this tick's descendant walk into the pane's remembered set (see
    /// [`merge_seen_descendants`]). `live` is every pid in this tick's process topology.
    pub(crate) fn remember_descendants(&self, pane_id: &str, observed: &[ProcSnapshotEntry], live: &HashSet<u32>) {
        if let Some(pane) = self.panes().get_mut(pane_id) {
            merge_seen_descendants(&mut pane.seen_descendants, observed, live);
        }
    }

    /// 0.3.2: the pane's remembered descendants that are still the same process, minus
    /// `exclude` (see [`surviving_seen`]). Empty for an unknown pane / off Windows.
    pub(crate) fn remembered_survivors(&self, pane_id: &str, exclude: &HashSet<u32>) -> Vec<(u32, Option<String>)> {
        let seen = self
            .panes()
            .get(pane_id)
            .map(|p| p.seen_descendants.clone())
            .unwrap_or_default();
        #[cfg(windows)]
        {
            surviving_seen(&seen, exclude, process_creation_time)
        }
        #[cfg(not(windows))]
        {
            let _ = (seen, exclude);
            Vec::new()
        }
    }

    /// Removes and returns a single pane's handle *without* holding the registry lock
    /// while that handle actually drops. `ClosePseudoConsole` (via `master`) and job
    /// teardown block until conhost/the process tree wind down — if the returned
    /// `PaneHandle` dropped while `self.panes()`'s `MutexGuard` were still alive (e.g.
    /// from a bare `self.panes().remove(pane_id)` expression statement, where the guard
    /// is still in scope for the whole statement), every other pane's
    /// `pty_write`/`pty_resize`/`pty_busy`/`pty_spawn` would stall on this same mutex for
    /// as long as that teardown takes. Binding the guard, removing, and `drop`-ping the
    /// guard *before* returning guarantees the lock is free by the time the caller's
    /// (possibly unbound) `PaneHandle` is dropped.
    fn take_pane(&self, pane_id: &str) -> Option<PaneHandle> {
        let mut panes = self.panes();
        let handle = panes.remove(pane_id);
        drop(panes);
        // BUG-1 fix: reap any descendant that escaped this pane's Job Object (e.g. the
        // Store/MSIX pwsh profile's own children — see `reap_stray_descendants`) before
        // `handle` drops and the job's KILL_ON_JOB_CLOSE fires for whatever *did* stay
        // in the job. Runs after the lock above is already released, so it never stalls
        // another pane the way holding the lock through pane teardown would (see this
        // fn's own doc comment).
        #[cfg(windows)]
        if let Some(pane) = handle.as_ref() {
            reap_stray_descendants(pane);
        }
        handle
    }

    /// Faz 8 (graceful Claude close): like [`take_pane`](Self::take_pane), but skips its
    /// immediate `reap_stray_descendants` pass — reaping an escaped descendant right away
    /// would hard-kill exactly the process a graceful close is trying to let exit on its
    /// own. The caller (the pane's graceful-close background thread) reaps *after* it's
    /// done trying, right before the handle itself drops.
    fn take_pane_no_reap(&self, pane_id: &str) -> Option<PaneHandle> {
        self.panes().remove(pane_id)
    }

    /// Writes `data` to the given pane's PTY input. Shared by the `pty_write` command
    /// and the dev-only named-pipe input control (`ipc_server`), so the orchestrator can
    /// type into a pane without focusing the window.
    pub fn write_to_pane(&self, pane_id: &str, data: &str) -> Result<(), String> {
        let Some(writer) = self.writer_for(pane_id) else {
            return Err(format!("unknown pane: {pane_id}"));
        };
        if let Some(activity) = self.panes().get(pane_id).map(|p| p.activity.clone()) {
            record_input(&activity);
        }
        let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
    }

    /// Faz 4 §4.20: drops every pane on `RunEvent::Exit` — closing each job's last
    /// handle kills every subprocess tree still alive when the app quits. As with
    /// `take_pane`, the map is taken out of the registry and the lock released *before*
    /// the panes themselves (and their `ClosePseudoConsole`/job teardown) actually drop.
    ///
    /// Faz 8: plain wrapper around [`clear_with`](Self::clear_with) that treats no pane as
    /// Claude (every existing caller/test that predates graceful close keeps its exact old
    /// behavior — immediate reap + drop for every pane).
    pub fn clear(&self) {
        let _ = self.clear_with(|_pane_id| None);
    }

    /// Faz 8 (graceful Claude close): like [`clear`](Self::clear), but a pane `close_plan`
    /// returns a key sequence for gets a graceful close (its own background thread — see
    /// [`spawn_graceful_close_thread`]) instead of the immediate reap-then-drop every
    /// other pane still gets here. Returns one completion receiver per pane handed off to
    /// a graceful-close thread, so a caller that must not return until every close is done
    /// (app exit) can wait on them with its own hard-capped timeout; a caller that must
    /// never block on them at all (the page-reload hook) simply drops the returned `Vec` —
    /// the threads keep running detached either way.
    ///
    /// As with `take_pane`/`clear`, the whole map is taken out of the registry and the
    /// lock released *before* any pane's (possibly blocking) teardown runs, so this never
    /// stalls a `pty_write`/`pty_resize`/`pty_busy`/`pty_spawn` racing it on another
    /// thread.
    pub fn clear_with(
        &self,
        mut close_plan: impl FnMut(&str) -> Option<Vec<CloseStep>>,
    ) -> Vec<std::sync::mpsc::Receiver<()>> {
        let mut panes = self.panes();
        let taken = std::mem::take(&mut *panes);
        drop(panes);

        let mut waiters = Vec::new();
        for (pane_id, pane) in taken {
            if let Some(steps) = close_plan(&pane_id) {
                let (tx, rx) = std::sync::mpsc::channel();
                waiters.push(rx);
                spawn_graceful_close_thread(pane_id, pane, steps, Some(tx));
            } else {
                // BUG-1 fix: same reap as `take_pane`, still after the lock above is
                // released.
                #[cfg(windows)]
                reap_stray_descendants(&pane);
                drop(pane);
            }
        }
        waiters
    }

    /// Review item 5 (close-tab-then-quit): registers one graceful-close completion
    /// receiver from a single-pane `pty_kill`, so `RunEvent::Exit` can wait on it too
    /// (see [`take_pending_graceful_closes`](Self::take_pending_graceful_closes)) — not
    /// just the ones `clear_with` starts at exit time itself. Prunes already-finished
    /// receivers first (an empty, disconnected channel — its `Sender` half already
    /// dropped once that pane's close thread finished) so this list never grows
    /// unbounded across a long session's worth of closed Claude tabs.
    fn track_graceful_close(&self, rx: std::sync::mpsc::Receiver<()>) {
        let mut pending = self.pending_graceful.lock().unwrap_or_else(|e| e.into_inner());
        pending.retain(|r| matches!(r.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
        pending.push(rx);
    }

    /// Review item 5 (close-tab-then-quit): drains every receiver registered by
    /// [`track_graceful_close`](Self::track_graceful_close) — called once, from
    /// `RunEvent::Exit`, alongside `clear_with`'s own waiters, so a graceful close that
    /// was already in flight from an earlier plain tab close is awaited under the exact
    /// same combined `EXIT_GRACEFUL_CAP` deadline.
    pub fn take_pending_graceful_closes(&self) -> Vec<std::sync::mpsc::Receiver<()>> {
        let mut pending = self.pending_graceful.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *pending)
    }
}

#[derive(Serialize)]
pub struct ProcessInfo {
    pid: u32,
    name: Option<String>,
    cmdline: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    pub pane_id: String,
    pub pid: u32,
}

/// Root-relative core of `pty_spawn`'s cwd resolution (spec §1.2: `cwdRel` via fsguard,
/// must be a folder) — split out so it's unit-testable without a `WorkspaceStore`.
fn resolve_spawn_cwd(root: &Path, cwd_rel: &str) -> AppResult<PathBuf> {
    let cwd = fsguard::resolve(root, cwd_rel)?;
    if !cwd.is_dir() {
        return Err(AppError::not_a_directory(format!(
            "'{cwd_rel}' is not a folder"
        )));
    }
    Ok(cwd)
}

/// BUG-2 root cause + fix: `SetConsoleCtrlHandler(NULL, TRUE)` sets a per-process
/// "ignore Ctrl+C/Ctrl+Break" flag. Windows documents this flag as inherited by every
/// process the calling process creates via `CreateProcess` — regardless of whether the
/// child gets a brand-new console or pseudoconsole, because the flag lives on the
/// *process*, not the console. If *our own* process inherited that flag from an
/// ancestor (a background shell, `npm`, or `cargo` that disables Ctrl+C for the child
/// processes it manages under its own job control — exactly what an agent-launched dev
/// loop looks like), then every pane's shell, and everything the shell spawns, inherits
/// "ignore" too, so the `CTRL_C_EVENT` ConPTY synthesizes from an incoming `0x03` byte
/// is silently ignored the whole way down (empirically confirmed in this very
/// environment — see `ctrl_c_tests` below, and the bug report's before/after `cargo
/// test` output for the run with this function's call temporarily removed).
///
/// Calling this once, before the first pane is ever spawned, clears *our* process's
/// flag so any child created afterwards starts from a clean slate. This cannot make
/// *our* process die from a stray Ctrl+C: `SetConsoleCtrlHandler` only changes how
/// console-control events already destined for this process get handled — it can never
/// cause an event to be *delivered* somewhere it wouldn't be otherwise, and console
/// control events are only ever delivered to processes attached to the console/
/// pseudoconsole whose process group the event targets. A packaged `agent-hub.exe` is a
/// GUI-subsystem binary; Windows only auto-attaches a *console-subsystem* child to its
/// parent's console, so the shipped app never has a console at all and this call is a
/// no-op-ish flag clear with nothing to affect. In `cargo tauri dev` the dev binary is
/// still GUI-subsystem, so the same holds. `cargo test`'s own binary *is*
/// console-subsystem and stays attached to whatever console launched it, but each pane
/// spawned in these tests gets its own pseudoconsole (a separate process group from that
/// ambient console) — the `\x03` written to a pane's PTY input only ever reaches that
/// pane's own process tree, never the test runner's console, so clearing the flag here
/// is safe there too (and simply restores normal default Ctrl+C handling for the test
/// binary itself, which is the correct outcome).
#[cfg(windows)]
fn clear_inherited_ctrl_c_ignore() {
    unsafe {
        let _ = SetConsoleCtrlHandler(None, false);
    }
}

/// Spawns a ConPTY pane, streaming its output through `on_data` (raw bytes, D2) and
/// returning the new pane's id + pid (spec §1.2).
// A Tauri command's parameters are exactly its IPC arg list (spec §1.2) — splitting
// them into a struct would just move the same names one level down, not reduce them.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    registry: State<'_, PtyRegistry>,
    workspaces: State<'_, WorkspaceStore>,
    workspace_id: String,
    cwd_rel: String,
    profile_id: Option<ShellKind>,
    agent_command: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> AppResult<SpawnResult> {
    let root = PathBuf::from(workspaces.find_path(&workspace_id)?);
    let cwd = resolve_spawn_cwd(&root, &cwd_rel)?;

    let profiles = cached_profiles();
    let profile = match &profile_id {
        Some(id) => profiles
            .iter()
            .find(|p| p.id == *id)
            .cloned()
            .ok_or_else(|| AppError::not_found("shell profile not found"))?,
        None => profiles
            .first()
            .cloned()
            .ok_or_else(|| AppError::not_found("no shell profile available on this machine"))?,
    };

    let pane_id = Uuid::new_v4().to_string();
    let endpoint = ipc_server::endpoint_name(std::process::id());
    let cmd = build_command(
        &profile,
        &cwd,
        agent_command.as_deref(),
        &pane_id,
        &workspace_id,
        &endpoint,
    )?;

    let cols = cols.max(MIN_PTY_DIMENSION);
    let rows = rows.max(MIN_PTY_DIMENSION);

    // BUG-2 fix: clear any inherited "ignore Ctrl+C" flag on our own process *before*
    // spawning the shell, so the new child (and everything it spawns) starts from a
    // clean slate — see `clear_inherited_ctrl_c_ignore`'s doc comment for why this is
    // both necessary and safe.
    #[cfg(windows)]
    clear_inherited_ctrl_c_ignore();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            // Faz 7 spec §1.2/§9.2: PTY spawn failures are logged at `warn` — profile +
            // a sanitized error, never the raw command line (see `sanitize_spawn_error`).
            let sanitized = sanitize_spawn_error(&profile.program, &*e);
            log::warn!("pty spawn: openpty failed for profile={:?}: {sanitized}", profile.id);
            AppError::spawn_failed(sanitized)
        })?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        let sanitized = sanitize_spawn_error(&profile.program, &*e);
        log::warn!("pty spawn: failed to launch profile={:?}: {sanitized}", profile.id);
        AppError::spawn_failed(sanitized)
    })?;
    let pid = child
        .process_id()
        .ok_or_else(|| AppError::spawn_failed("failed to read the child process id"))?;
    // Drop our copy of the slave handle so the master's read side can observe EOF once
    // the child (and anything it spawned that inherited the slave) is done with it.
    drop(pair.slave);

    #[cfg(windows)]
    let job = spawn_job_for(&*child);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::spawn_failed(e.to_string()))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::spawn_failed(e.to_string()))?;

    let shell_image_name = image_filename(&profile.program);
    let activity = Arc::new(PaneActivity::default());
    let screen = Arc::new(Mutex::new(PaneScreen::new(rows, cols)));

    {
        let mut panes = registry.panes();
        panes.insert(
            pane_id.clone(),
            PaneHandle {
                spawned_at: Instant::now(),
                workspace_id: workspace_id.clone(),
                activity: activity.clone(),
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                shell_pid: pid,
                shell_image_name,
                screen: screen.clone(),
                seen_descendants: Vec::new(),
                #[cfg(windows)]
                job,
            },
        );
    }

    spawn_reader_and_batcher(reader, on_data, activity, screen);
    spawn_wait_thread(app, pane_id.clone(), child);

    Ok(SpawnResult { pane_id, pid })
}

#[cfg(windows)]
fn spawn_job_for(child: &(dyn Child + Send + Sync)) -> Option<JobHandle> {
    // `as_raw_handle` here is `portable_pty::Child::as_raw_handle`, not
    // `std::os::windows::io::AsRawHandle` — already in scope via the `Child` import.
    let raw_handle = child.as_raw_handle()?;
    unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_ok();
        if !set_ok {
            let _ = CloseHandle(job);
            return None;
        }
        let process_handle = HANDLE(raw_handle);
        if AssignProcessToJobObject(job, process_handle).is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(JobHandle(job))
    }
}

/// Reader thread does blocking reads off the cloned PTY reader and forwards raw chunks
/// to the batcher thread, which coalesces them for `FLUSH_INTERVAL` (or until
/// `FLUSH_THRESHOLD_BYTES`) before sending a single `InvokeResponseBody::Raw` message.
fn spawn_reader_and_batcher(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<InvokeResponseBody>,
    activity: Arc<PaneActivity>,
    screen: Arc<Mutex<PaneScreen>>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Faz 5 §1.4: activity timestamps see every chunk here, on the same
                    // thread that already reads it — cheapest possible hook.
                    record_output(&activity);
                    // M3: the screen-rule parser (a no-op unless enabled for this pane).
                    lock_screen(&screen).process(&buf[..n]);
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping `tx` here unblocks the batcher's `recv_timeout` with `Disconnected`.
    });

    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match rx.recv_timeout(FLUSH_INTERVAL) {
                Ok(chunk) => {
                    pending.extend_from_slice(&chunk);
                    if pending.len() >= FLUSH_THRESHOLD_BYTES
                        && flush(&channel, &mut pending).is_err()
                    {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    if !pending.is_empty() && flush(&channel, &mut pending).is_err() {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        let _ = flush(&channel, &mut pending);
                    }
                    break;
                }
            }
        }
    });
}

fn flush(channel: &Channel<InvokeResponseBody>, pending: &mut Vec<u8>) -> tauri::Result<()> {
    let bytes = std::mem::take(pending);
    channel.send(InvokeResponseBody::Raw(bytes))
}

/// Spec §1.2: `pty:exit` payload is camelCase (`paneId`/`exitCode`) — the spike's
/// `pane_id`/`code` are both renamed here.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    pane_id: String,
    exit_code: i32,
}

fn spawn_wait_thread(app: AppHandle, pane_id: String, mut child: Box<dyn Child + Send + Sync>) {
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };

        // Faz 7 spec §1.2: pane exit is logged at `info` — short pane id + exit code.
        log::info!("pty pane={} exited code={code}", crate::agents::short_pane_id(&pane_id));

        // Removing (and thus dropping) the pane closes master + writer + job handle,
        // which is what unblocks the reader thread's blocking read (ConPTY doesn't
        // reliably EOF on its own) and, via JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, kills
        // any surviving descendants (e.g. a `claude` subprocess tree). `take_pane`
        // releases the registry lock before that (blocking) teardown runs, so it never
        // stalls another pane's `pty_write`/`pty_resize`/`pty_busy`/`pty_spawn`.
        if let Some(registry) = app.try_state::<PtyRegistry>() {
            registry.take_pane(&pane_id);
        }
        // Faz 5 §1.4: pane death removes its agent record outright, regardless of
        // source. Idempotent with `pty_kill`'s own call below (whichever runs first).
        if let Some(tracker) = app.try_state::<crate::agents::AgentTracker>() {
            tracker.pane_died(&pane_id);
        }

        let _ = app.emit(
            "pty:exit",
            ExitPayload {
                pane_id,
                exit_code: code,
            },
        );
    });
}

// ---------------------------------------------------------------------------------
// pty_write / pty_write_bytes / pty_resize / pty_kill (spec §1.2, §4.8, §4.13)
// ---------------------------------------------------------------------------------

pub(crate) fn write_bytes_to_pane(registry: &PtyRegistry, pane_id: &str, bytes: &[u8]) -> AppResult<()> {
    // Unknown pane -> no-op, not an error (spec §4.8: a write/resize racing a pane's
    // exit or the user's own `pty_kill` must never surface as a frontend error).
    let Some(writer) = registry.writer_for(pane_id) else {
        return Ok(());
    };
    // Faz 5 §1.4: stamps `last_input_ms` (blocked/working cancel fallback + the
    // hookless heuristic's echo suppression both key off this).
    if let Some(activity) = registry.panes().get(pane_id).map(|p| p.activity.clone()) {
        record_input(&activity);
    }
    let mut writer = writer.lock().unwrap_or_else(|e| e.into_inner());
    writer.write_all(bytes).map_err(|e| AppError::io(e.to_string()))
}

#[tauri::command(async)]
pub fn pty_write(registry: State<'_, PtyRegistry>, pane_id: String, data: String) -> AppResult<()> {
    write_bytes_to_pane(&registry, &pane_id, data.as_bytes())
}

/// xterm's `onBinary` (mouse reports etc.) hands over latin1 bytes as a plain number
/// array (spec §1.2) — `Vec<u8>` deserializes that directly.
#[tauri::command(async)]
pub fn pty_write_bytes(registry: State<'_, PtyRegistry>, pane_id: String, data: Vec<u8>) -> AppResult<()> {
    write_bytes_to_pane(&registry, &pane_id, &data)
}

#[tauri::command(async)]
pub fn pty_resize(registry: State<'_, PtyRegistry>, pane_id: String, cols: u16, rows: u16) -> AppResult<()> {
    if cols == 0 || rows == 0 {
        // Spec §1.2: 0 means "size not known yet" — a no-op, not an error.
        return Ok(());
    }
    let cols = cols.max(MIN_PTY_DIMENSION);
    let rows = rows.max(MIN_PTY_DIMENSION);
    let panes = registry.panes();
    if let Some(pane) = panes.get(&pane_id) {
        pane.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::io(e.to_string()))?;
        lock_screen(&pane.screen).resize(rows, cols);
    }
    // Unknown pane -> no-op (spec §4.8).
    Ok(())
}

// ---------------------------------------------------------------------------------
// Graceful Claude close (Faz 8): closing a terminal tab/reloading/quitting used to kill
// a Claude pane's whole process tree immediately via its Job Object, giving Claude Code
// no chance to shut down cleanly — its next launch then falls back to the classic
// renderer with a warning ("fullscreen renderer didn't finish starting last time").
// Empirically, `\x03` (Ctrl+C) x2 400 ms apart lets an idle Claude Code exit cleanly
// within ~1.2 s; a third `\x03` additionally handles a Claude that was still mid-task
// (the first ^C only interrupts the turn, back to its own prompt — from there the same
// ^C the idle case uses is what actually exits it). A hard kill (no chance to run its own
// shutdown) reproduces the warning.
//
// A pane gets a graceful close solely via `AgentTracker::close_plan` (M3: its agent's
// `adapter.json` `gracefulClose`, or the Claude sequence above for Claude Code, hook or
// heuristic source) at the moment it's torn down — every other pane (plain shells,
// agents without a sequence) keeps the pre-existing immediate kill.
// ---------------------------------------------------------------------------------

/// How often the exit-wait loop polls the shell pid.
const GRACEFUL_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// App exit (Faz 8 spec item 3): combined hard cap for every pane's graceful close
/// running in parallel, so a hung pane can never hang app shutdown itself. `pub(crate)` —
/// `lib.rs`'s `RunEvent::Exit` handler is the one caller that needs this outside `pty`.
pub(crate) const EXIT_GRACEFUL_CAP: Duration = Duration::from_millis(3500);

/// Pure sequencing core of a graceful close (unit-tested with an injectable
/// `write`/`sleep`/`has_exited` — no real process or real time needed). For each step:
/// writes its bytes `repeat` times, `gap` apart, then polls `has_exited` every
/// `poll_interval` until it returns `true` (done) or the step's `wait` has elapsed (next
/// step). Returns whether the process was observed to have exited.
pub(crate) fn graceful_close_sequence(
    mut write: impl FnMut(&[u8]),
    mut sleep: impl FnMut(Duration),
    mut has_exited: impl FnMut() -> bool,
    steps: &[CloseStep],
    poll_interval: Duration,
) -> bool {
    for step in steps {
        for i in 0..step.repeat {
            if i > 0 {
                sleep(step.gap);
            }
            write(&step.bytes);
        }

        let mut waited = Duration::ZERO;
        loop {
            if has_exited() {
                return true;
            }
            if waited >= step.wait {
                break;
            }
            let slice = poll_interval.min(step.wait - waited);
            sleep(slice);
            waited += slice;
        }
    }
    false
}

/// Best-effort "is this pid still alive" check for the graceful-close exit-wait loop —
/// `false` (treated as "already exited") whenever the pid can't even be opened, which is
/// exactly what happens once it's actually gone.
#[cfg(windows)]
fn pane_process_alive(pid: u32) -> bool {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code: u32 = 0;
        let result = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        // STILL_ACTIVE == 259 (a process legitimately exiting with that exact code would
        // be indistinguishable from "still running" here -- an accepted, harmless
        // edge case shared with every other STILL_ACTIVE-based liveness check).
        result.is_ok() && code == 259
    }
}

#[cfg(not(windows))]
fn pane_process_alive(_pid: u32) -> bool {
    false
}

/// Pure decision core of `agent_gone` (WSL blind-spot fix, review item 1): given whether
/// the shell process itself is still alive and the (already resolved) list of its
/// descendant processes — pid + image name, exactly `decide_busy`'s `job_procs` shape —
/// decides whether the agent is gone. Unit-tested without any real process or snapshot.
///
/// - Shell dead -> always gone, regardless of `shell_image`/`descendants`.
/// - **WSL blind spot**: `wsl.exe`'s Linux children run inside the Linux kernel and are
///   completely invisible to Toolhelp (`CreateToolhelp32Snapshot`) — for a `wsl.exe` shell,
///   "no visible children" is the NORMAL steady state for a live `claude` session, not
///   evidence it exited. So while the shell process itself is alive, a `wsl.exe` shell is
///   never considered gone from process visibility alone (this does mean a graceful close
///   under WSL always waits each close step's full `wait` — same tradeoff the doc
///   comment above already accepted for "shell outlives the agent").
/// - Otherwise: gone iff none of `descendants` counts as "busy" under the same shell-set
///   exclusion `pty_busy` uses (console host, the shell's own re-exec'd pid, ...).
pub(crate) fn agent_gone_from(
    shell_alive: bool,
    descendants: &[(u32, Option<String>)],
    shell_pid: u32,
    shell_image: &str,
) -> bool {
    if !shell_alive {
        return true;
    }
    if shell_image.eq_ignore_ascii_case("wsl.exe") {
        return false;
    }
    !decide_busy(descendants, shell_pid, shell_image).busy
}

/// The agent is gone once the shell itself exited or it has no child process left
/// (the shell outlives `claude`, so watching only the shell would always wait the full
/// cap — and delay app exit by that much). Review item 2: uses the same cheap
/// topology-only snapshot (`system_process_topology` + `walk_descendants_lazy`) the
/// `agents` heuristic tick uses — names only, no per-pid `OpenProcess`/`GetProcessTimes`
/// call for every process on the machine on every ~100 ms poll.
fn agent_gone(shell_pid: u32, shell_image: &str) -> bool {
    let shell_alive = pane_process_alive(shell_pid);
    #[cfg(windows)]
    {
        if !shell_alive {
            return agent_gone_from(false, &[], shell_pid, shell_image);
        }
        let topology = system_process_topology();
        let mut creation_time_cache: HashMap<u32, u64> = HashMap::new();
        let descendants = walk_descendants_lazy(
            &topology,
            shell_pid,
            &mut creation_time_cache,
            &mut process_creation_time_or_zero,
        );
        let procs: Vec<(u32, Option<String>)> =
            descendants.into_iter().map(|e| (e.pid, Some(e.name))).collect();
        agent_gone_from(shell_alive, &procs, shell_pid, shell_image)
    }
    #[cfg(not(windows))]
    {
        agent_gone_from(shell_alive, &[], shell_pid, shell_image)
    }
}

/// Runs one pane's graceful close on a background thread and returns its `JoinHandle`
/// (callers that don't need it just let the thread run detached). The pane is already out
/// of the registry map by the time this is spawned, so the `\x03` sequence writes through
/// the pane's own writer handle directly, never through `PtyRegistry::write_to_pane`.
/// `done`, when given, is dropped (closing the channel) once the pane handle has actually
/// been torn down — a caller (app exit) waits on the matching `Receiver` with its own
/// timeout instead of `JoinHandle::join`, which has none.
fn spawn_graceful_close_thread(
    pane_id: String,
    pane: PaneHandle,
    steps: Vec<CloseStep>,
    done: Option<std::sync::mpsc::Sender<()>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let short_id = crate::agents::short_pane_id(&pane_id).to_string();
        let writer = pane.writer.clone();
        let shell_pid = pane.shell_pid;
        let shell_image = pane.shell_image_name.clone();

        let start = Instant::now();
        let exited = graceful_close_sequence(
            |bytes| {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                let _ = w.write_all(bytes);
            },
            std::thread::sleep,
            || agent_gone(shell_pid, &shell_image),
            &steps,
            GRACEFUL_POLL_INTERVAL,
        );
        let after_ms = start.elapsed().as_millis();

        // Faz 7 spec §9.2: pane id only, never a title/command.
        log::info!("pty pane={short_id} graceful close: exited={exited} after={after_ms}ms");

        // Same BUG-1 reap `take_pane`/`clear` apply, just deferred until after we've
        // given the process a real chance to exit on its own — then the job handle drops
        // (KILL_ON_JOB_CLOSE) exactly as an immediate kill's teardown would.
        #[cfg(windows)]
        reap_stray_descendants(&pane);
        drop(pane);
        drop(done);
    })
}

#[tauri::command(async)]
pub fn pty_kill(app: AppHandle, registry: State<'_, PtyRegistry>, pane_id: String) -> AppResult<()> {
    // Spec item 1 / M3: a pane gets a graceful close iff the tracker has a record whose
    // agent has a close sequence -- checked *before* `pane_died` clears that very record.
    let close_plan = app
        .try_state::<crate::agents::AgentTracker>()
        .and_then(|t| t.close_plan(&pane_id));

    if let Some(steps) = close_plan {
        // Removed from the map right away (so other commands see it gone and new writes
        // fail as today) but *not* reaped yet -- its background thread tries a clean
        // shutdown first. Unknown pane -> no-op.
        if let Some(pane) = registry.take_pane_no_reap(&pane_id) {
            // Review item 5: unlike `clear_with` (whose caller gets the receiver
            // straight back), this close's only caller is the frontend's fire-and-forget
            // `pty_kill` invoke -- the receiver is registered with the registry itself so
            // `RunEvent::Exit` can still find and wait on it if the app quits before this
            // close finishes on its own.
            let (tx, rx) = std::sync::mpsc::channel();
            registry.track_graceful_close(rx);
            spawn_graceful_close_thread(pane_id.clone(), pane, steps, Some(tx));
        }
    } else {
        // Dropping the removed handle closes the job (kills the whole subprocess tree via
        // KILL_ON_JOB_CLOSE) and drops master/writer, unblocking the reader thread. Unknown
        // pane -> no-op (`HashMap::remove` on a missing key is already a no-op). `take_pane`
        // releases the registry lock before that teardown runs (see its doc comment).
        registry.take_pane(&pane_id);
    }
    // Faz 5 §1.4: don't wait for `spawn_wait_thread`'s own (idempotent) cleanup — an
    // explicit kill should clear the agent record immediately.
    if let Some(tracker) = app.try_state::<crate::agents::AgentTracker>() {
        tracker.pane_died(&pane_id);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------
// pty_busy (spec §1.2, §4.15)
// ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BusyInfo {
    pub busy: bool,
    pub processes: Vec<String>,
}

const CONSOLE_HOST_IMAGES: [&str; 2] = ["conhost.exe", "openconsole.exe"];

/// Strips a trailing `.exe` (case-insensitively), safe for non-ASCII image names.
/// Compares raw bytes rather than `str`-slicing `name[name.len()-4..]` directly, which
/// can panic when a multi-byte UTF-8 character straddles that byte offset (e.g. an
/// accented character 4-5 bytes from the end). Slicing `name[..name.len()-4]` afterwards
/// is safe *because* the check above already proved the last 4 bytes are the ASCII
/// string ".exe" — an ASCII byte can never be a UTF-8 continuation byte, so the cut
/// point is guaranteed to be a char boundary.
fn strip_exe_suffix(name: &str) -> String {
    let bytes = name.as_bytes();
    if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".exe") {
        name[..name.len() - 4].to_string()
    } else {
        name.to_string()
    }
}

/// Pure decision core of `pty_busy` (spec §4.15): `job_procs` is every pid currently in
/// the pane's Job Object with its resolved image filename (or `None` if the name
/// couldn't be read). The "shell set" excluded from "busy" is `shell_pid` itself **plus**
/// every pid whose image filename matches `shell_image_name` — Git Bash's login
/// `bin\bash.exe` execs into a *different* pid running `usr\bin\bash.exe`, same
/// filename — **minus** `conhost.exe`/`OpenConsole.exe` (the console host, never a user
/// process). Whatever's left is "busy"; `processes` is its unique, `.exe`-stripped names.
pub fn decide_busy(job_procs: &[(u32, Option<String>)], shell_pid: u32, shell_image_name: &str) -> BusyInfo {
    let shell_image_lower = shell_image_name.to_ascii_lowercase();
    let mut names: Vec<String> = Vec::new();
    for (pid, name) in job_procs {
        let Some(name) = name else { continue };
        if in_shell_set(*pid, name, shell_pid, &shell_image_lower) {
            continue;
        }
        let display = strip_exe_suffix(name);
        if !names.contains(&display) {
            names.push(display);
        }
    }
    BusyInfo {
        busy: !names.is_empty(),
        processes: names,
    }
}

/// The "shell set" [`decide_busy`] leaves out: the shell itself, a process with the
/// shell's image name, and the console host. `shell_image_lower` is lowercase already.
fn in_shell_set(pid: u32, name: &str, shell_pid: u32, shell_image_lower: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    pid == shell_pid || lower == shell_image_lower || CONSOLE_HOST_IMAGES.contains(&lower.as_str())
}

/// 0.3.2: at most this many process names in a `pty:leftover` event.
pub const MAX_LEFTOVER_NAMES: usize = 8;

/// Pure (0.3.2 leftover strip): the image names (as reported, e.g. `python.exe`) of every
/// process [`decide_busy`] would count as busy, deduplicated case-insensitively, at most
/// [`MAX_LEFTOVER_NAMES`]. Empty = nothing but the shell is left.
pub fn leftover_names(procs: &[(u32, Option<String>)], shell_pid: u32, shell_image_name: &str) -> Vec<String> {
    let shell_image_lower = shell_image_name.to_ascii_lowercase();
    let mut names: Vec<String> = Vec::new();
    for (pid, name) in procs {
        let Some(name) = name else { continue };
        if in_shell_set(*pid, name, shell_pid, &shell_image_lower)
            || names.iter().any(|n| n.eq_ignore_ascii_case(name))
        {
            continue;
        }
        names.push(name.clone());
        if names.len() == MAX_LEFTOVER_NAMES {
            break;
        }
    }
    names
}

/// Pure (0.3.2, `pty_stop_leftovers`): the pids to terminate — every process outside the
/// shell set (so never the shell itself or the console host), each once. A process whose
/// name is unknown is left alone.
pub fn leftover_kill_targets(procs: &[(u32, Option<String>)], shell_pid: u32, shell_image_name: &str) -> Vec<u32> {
    let shell_image_lower = shell_image_name.to_ascii_lowercase();
    let mut pids: Vec<u32> = Vec::new();
    for (pid, name) in procs {
        let Some(name) = name else { continue };
        if !in_shell_set(*pid, name, shell_pid, &shell_image_lower) && !pids.contains(pid) {
            pids.push(*pid);
        }
    }
    pids
}

/// 0.3.2: one process the `agents` tick saw under a pane's shell. `creation_time` tells a
/// recycled pid apart from the process that was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenProc {
    pub pid: u32,
    pub creation_time: u64,
    pub name: String,
}

/// Upper bound of a pane's remembered descendants (oldest dropped first).
pub const SEEN_DESCENDANTS_CAP: usize = 512;

/// Pure (0.3.2): prunes `seen` of pids that no longer exist (`live` = every pid of this
/// tick's topology), then adds every `observed` descendant with a known creation time
/// that isn't remembered yet, keeping at most [`SEEN_DESCENDANTS_CAP`] (newest win).
pub fn merge_seen_descendants(seen: &mut Vec<SeenProc>, observed: &[ProcSnapshotEntry], live: &HashSet<u32>) {
    seen.retain(|p| live.contains(&p.pid));
    for entry in observed {
        if entry.creation_time == 0
            || seen.iter().any(|p| p.pid == entry.pid && p.creation_time == entry.creation_time)
        {
            continue;
        }
        seen.push(SeenProc {
            pid: entry.pid,
            creation_time: entry.creation_time,
            name: entry.name.clone(),
        });
    }
    if seen.len() > SEEN_DESCENDANTS_CAP {
        let excess = seen.len() - SEEN_DESCENDANTS_CAP;
        seen.drain(..excess);
    }
}

/// Pure (0.3.2): the remembered processes that are still the same process (their pid's
/// current creation time, via `creation_time_of`, matches the remembered one), as
/// `(pid, name)`, minus `exclude` (pids already handled elsewhere: the job's, the walk's).
pub fn surviving_seen(
    seen: &[SeenProc],
    exclude: &HashSet<u32>,
    mut creation_time_of: impl FnMut(u32) -> Option<u64>,
) -> Vec<(u32, Option<String>)> {
    seen.iter()
        .filter(|p| !exclude.contains(&p.pid))
        .filter(|p| creation_time_of(p.pid) == Some(p.creation_time))
        .map(|p| (p.pid, Some(p.name.clone())))
        .collect()
}

// ---------------------------------------------------------------------------------
// BUG-1 fix: whole-system parent-pid tree walk (spec: packaged/MSIX shell children can
// escape our Job Object — the Store pwsh profile's descendants never show up in
// `job_pids`/`pty_processes`/`pty_busy` even though they are very much alive).
// ---------------------------------------------------------------------------------

/// One process in a whole-system snapshot (e.g. from `CreateToolhelp32Snapshot`):
/// pid/parent-pid/image-filename plus a "when was this pid created" timestamp that only
/// needs to be *monotonically comparable* between related processes (real code uses the
/// raw `FILETIME` as a `u64`) — never interpreted as a calendar time. `0` means unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcSnapshotEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub creation_time: u64,
}

/// Pure tree walk (BUG-1 fix, unit-tested): every process in `snapshot` that is a
/// transitive descendant of `root_pid` (`root_pid` itself is never included). This is
/// the "packaged shell" half of the busy/kill fix — the Job Object's own pid list can
/// miss real descendants (e.g. the Store/MSIX pwsh profile breaks its children out of
/// whatever job it's in), but every process on the machine still carries its true
/// parent pid, so walking `ppid` chains from the shell finds them regardless.
///
/// Guards, since `ppid` alone is not trustworthy in isolation:
/// - **pid reuse**: a pid can be recycled after its process exits, so a stale/unrelated
///   process could coincidentally have `ppid == some ancestor's pid`. A claimed child is
///   only accepted if its `creation_time >= ` its claimed parent's (a child cannot have
///   been created before its parent existed). A `0` creation time (couldn't be read) is
///   treated as "unknown, trust the topology" for both sides of the comparison, rather
///   than silently dropping a real descendant just because one timestamp read failed.
/// - **cycles**: a pid is added to `included` at most once and is never re-examined as a
///   potential child afterwards, so a forged or pathological `ppid` cycle can't loop.
pub fn walk_descendants(snapshot: &[ProcSnapshotEntry], root_pid: u32) -> Vec<ProcSnapshotEntry> {
    let root_creation_time = snapshot
        .iter()
        .find(|e| e.pid == root_pid)
        .map(|e| e.creation_time)
        .unwrap_or(0);

    let mut included: HashMap<u32, u64> = HashMap::new();
    included.insert(root_pid, root_creation_time);
    let mut result: Vec<ProcSnapshotEntry> = Vec::new();

    loop {
        let mut added_any = false;
        for entry in snapshot {
            if included.contains_key(&entry.pid) {
                continue;
            }
            let Some(&parent_creation) = included.get(&entry.ppid) else {
                continue;
            };
            let plausible_child = entry.creation_time == 0
                || parent_creation == 0
                || entry.creation_time >= parent_creation;
            if !plausible_child {
                continue;
            }
            included.insert(entry.pid, entry.creation_time);
            result.push(entry.clone());
            added_any = true;
        }
        if !added_any {
            break;
        }
    }

    result
}

/// Cheap whole-system topology (spec §4 finding 3): pid/ppid/image-filename only, via a
/// single `CreateToolhelp32Snapshot` pass — no per-pid `OpenProcess`/`GetProcessTimes`
/// call. [`walk_descendants_lazy`]'s pid-reuse guard only ever needs a creation time for
/// a pid that actually becomes a walk candidate (a tiny fraction of "every process on the
/// machine"), so building the *full* [`ProcSnapshotEntry`] snapshot (which eagerly pays
/// for that lookup on every single process) is no longer what the `agents` tick pays for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcTopologyEntry {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
}

#[cfg(windows)]
pub(crate) fn system_process_topology() -> Vec<ProcTopologyEntry> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                out.push(ProcTopologyEntry {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    name,
                });
                entry = PROCESSENTRY32W {
                    dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                    ..Default::default()
                };
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    out
}

#[cfg(not(windows))]
pub(crate) fn system_process_topology() -> Vec<ProcTopologyEntry> {
    Vec::new()
}

/// Faz 5 §4 finding 3: [`process_creation_time`] with the `Option` collapsed to `0`
/// ("unknown, trust the topology" — the same sentinel [`walk_descendants`]'s own guard
/// already uses) — the on-demand resolver [`walk_descendants_lazy`] calls per candidate
/// pid.
#[cfg(windows)]
pub(crate) fn process_creation_time_or_zero(pid: u32) -> u64 {
    process_creation_time(pid).unwrap_or(0)
}

#[cfg(not(windows))]
pub(crate) fn process_creation_time_or_zero(_pid: u32) -> u64 {
    0
}

/// Same fixed-point descendant walk as [`walk_descendants`] — identical pid-reuse guard,
/// identical iteration order, identical result for the same inputs — except a candidate's
/// creation time is resolved on demand via `creation_time_of` (and memoized in `cache`)
/// only once it actually becomes a candidate (its claimed parent is already `included`),
/// rather than requiring every entry's creation time known up front (spec §4 finding 3:
/// this is what lets the `agents` heuristic tick use [`system_process_topology`] instead
/// of paying for a `GetProcessTimes` call on every process on the machine). `cache` is
/// caller-owned and should be fresh per tick — a pid can be recycled between ticks, so
/// reusing it across ticks would risk serving a stale creation time for a *different*
/// process that happens to reuse the same pid.
pub fn walk_descendants_lazy(
    topology: &[ProcTopologyEntry],
    root_pid: u32,
    cache: &mut HashMap<u32, u64>,
    creation_time_of: &mut dyn FnMut(u32) -> u64,
) -> Vec<ProcSnapshotEntry> {
    let mut resolve = |pid: u32, cache: &mut HashMap<u32, u64>| -> u64 {
        if let Some(&cached) = cache.get(&pid) {
            return cached;
        }
        let value = creation_time_of(pid);
        cache.insert(pid, value);
        value
    };

    let root_creation_time = resolve(root_pid, cache);
    let mut included: HashMap<u32, u64> = HashMap::new();
    included.insert(root_pid, root_creation_time);
    let mut result: Vec<ProcSnapshotEntry> = Vec::new();

    loop {
        let mut added_any = false;
        for entry in topology {
            if included.contains_key(&entry.pid) {
                continue;
            }
            let Some(&parent_creation) = included.get(&entry.ppid) else {
                continue;
            };
            let creation_time = resolve(entry.pid, cache);
            let plausible_child =
                creation_time == 0 || parent_creation == 0 || creation_time >= parent_creation;
            if !plausible_child {
                continue;
            }
            included.insert(entry.pid, creation_time);
            result.push(ProcSnapshotEntry {
                pid: entry.pid,
                ppid: entry.ppid,
                name: entry.name.clone(),
                creation_time,
            });
            added_any = true;
        }
        if !added_any {
            break;
        }
    }

    result
}

/// Snapshots every process on the machine via `CreateToolhelp32Snapshot`
/// (`TH32CS_SNAPPROCESS`), reading each pid's creation time (`GetProcessTimes`) via a
/// best-effort `PROCESS_QUERY_LIMITED_INFORMATION` open — a pid this can't open (already
/// exited, or genuinely inaccessible) is skipped for creation time only (`0`, "unknown"),
/// never dropped from the snapshot, since `walk_descendants` needs the whole topology to
/// find grandchildren even when one link's timestamp is unavailable.
#[cfg(windows)]
pub(crate) fn system_process_snapshot() -> Vec<ProcSnapshotEntry> {
    // Spec §4 finding 3: shares the `CreateToolhelp32Snapshot` pass with
    // `system_process_topology` — this eager variant is kept exactly as it was (every
    // existing caller/test still gets a real creation time for every pid up front); only
    // the `agents` heuristic tick moved off it, onto the topology snapshot +
    // `walk_descendants_lazy`, to stop paying for a `GetProcessTimes` call per process on
    // every tick.
    system_process_topology()
        .into_iter()
        .map(|e| ProcSnapshotEntry {
            creation_time: process_creation_time(e.pid).unwrap_or(0),
            pid: e.pid,
            ppid: e.ppid,
            name: e.name,
        })
        .collect()
}

#[cfg(windows)]
fn process_creation_time(pid: u32) -> Option<u64> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        result.ok()?;
        Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
    }
}

/// Union of a pane's Job Object pid list and a whole-system descendant walk from its
/// shell pid (BUG-1 fix) — the job list alone misses processes that escaped the job
/// (e.g. the Store/MSIX pwsh profile's children); the descendant walk alone would miss
/// nothing the job has *and* the walk somehow didn't see (belt-and-suspenders), and
/// gives us a real image name straight from the snapshot instead of a second
/// `OpenProcess` round-trip for pids already found there.
#[cfg(windows)]
fn pane_process_union(registry: &PtyRegistry, pane_id: &str, shell_pid: u32) -> Vec<(u32, Option<String>)> {
    let mut seen: HashSet<u32> = HashSet::new();
    let mut procs: Vec<(u32, Option<String>)> = Vec::new();

    for (pid, name) in job_pids_with_names(registry, pane_id) {
        if seen.insert(pid) {
            procs.push((pid, name));
        }
    }

    let snapshot = system_process_snapshot();
    for entry in walk_descendants(&snapshot, shell_pid) {
        if seen.insert(entry.pid) {
            procs.push((entry.pid, Some(entry.name)));
        }
    }

    procs
}

/// Terminates every descendant of `pane`'s shell pid (whole-system walk) that isn't
/// already in the pane's Job Object (BUG-1 fix): dropping `pane` right after this call
/// kills everything still *in* the job via `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, but a
/// packaged/MSIX shell's children that escaped the job would otherwise survive pane
/// teardown entirely. Best-effort — a pid that can't be opened for
/// `PROCESS_TERMINATE` (already exited, or genuinely inaccessible) is simply skipped.
#[cfg(windows)]
fn reap_stray_descendants(pane: &PaneHandle) {
    let Some(job) = pane.job.as_ref() else {
        return;
    };
    let mut handled: HashSet<u32> = job_pids_of(job.0).into_iter().collect();
    handled.insert(pane.shell_pid);
    let snapshot = system_process_snapshot();
    for entry in walk_descendants(&snapshot, pane.shell_pid) {
        if handled.insert(entry.pid) {
            terminate_pid(entry.pid);
        }
    }
    // 0.3.2: orphans whose parent died are out of the walk's reach; the tick remembered
    // them (same process = same creation time).
    for (pid, _) in surviving_seen(&pane.seen_descendants, &handled, process_creation_time) {
        terminate_pid(pid);
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    unsafe {
        if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

#[tauri::command(async)]
pub fn pty_busy(registry: State<'_, PtyRegistry>, pane_id: String) -> AppResult<BusyInfo> {
    let Some((shell_pid, shell_image_name)) = registry.shell_info(&pane_id) else {
        // Unknown pane (e.g. already exited/killed) -> nothing running.
        return Ok(BusyInfo {
            busy: false,
            processes: Vec::new(),
        });
    };
    #[cfg(windows)]
    {
        let procs = pane_process_union(&registry, &pane_id, shell_pid);
        Ok(decide_busy(&procs, shell_pid, &shell_image_name))
    }
    #[cfg(not(windows))]
    {
        let _ = (shell_pid, shell_image_name);
        Ok(BusyInfo {
            busy: false,
            processes: Vec::new(),
        })
    }
}

/// 0.3.2 (leftover strip's Stop button): terminates everything still running under the
/// pane's shell — the descendant walk, the Job Object and the remembered orphans — except
/// the shell itself and the console host. The `agents` tick then emits the cleared
/// `pty:leftover`. Unknown pane → no-op.
#[tauri::command(async)]
pub fn pty_stop_leftovers(registry: State<'_, PtyRegistry>, pane_id: String) -> AppResult<()> {
    let Some((shell_pid, shell_image_name)) = registry.shell_info(&pane_id) else {
        return Ok(());
    };
    #[cfg(windows)]
    {
        let mut procs = pane_process_union(&registry, &pane_id, shell_pid);
        let known: HashSet<u32> = procs.iter().map(|(pid, _)| *pid).collect();
        procs.extend(registry.remembered_survivors(&pane_id, &known));
        let targets = leftover_kill_targets(&procs, shell_pid, &shell_image_name);
        log::info!(
            "pty pane={} stop leftovers: {} process(es)",
            crate::agents::short_pane_id(&pane_id),
            targets.len()
        );
        for pid in targets {
            terminate_pid(pid);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (shell_pid, shell_image_name);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------
// Job Object PID/name inspection (D8 — kept for Faz 5, spec §4.19)
// ---------------------------------------------------------------------------------

/// PIDs currently assigned to `pane_id`'s Job Object (D8). Empty (not an error) if the
/// pane is unknown, has no job (non-Windows / job setup failed), or the query fails.
#[cfg(windows)]
pub fn job_pids(registry: &PtyRegistry, pane_id: &str) -> Vec<u32> {
    let panes = registry.panes();
    let Some(pane) = panes.get(pane_id) else {
        return Vec::new();
    };
    let Some(job) = pane.job.as_ref() else {
        return Vec::new();
    };
    job_pids_of(job.0)
}

#[cfg(not(windows))]
pub fn job_pids(_registry: &PtyRegistry, _pane_id: &str) -> Vec<u32> {
    Vec::new()
}

/// [`job_pids`] with each pid resolved to a name the same way [`pane_process_union`]
/// does (`None` if the lookup fails) — spec §4 finding 4: split out so the `agents`
/// heuristic tick can fold this pane's Job Object pids into the descendant list it
/// already walked this tick (see `walk_descendants_lazy`), the same BUG-1 union
/// `pty_busy`/`pty_processes` apply via `pane_process_union`, without a second
/// full-system snapshot.
#[cfg(windows)]
pub(crate) fn job_pids_with_names(registry: &PtyRegistry, pane_id: &str) -> Vec<(u32, Option<String>)> {
    job_pids(registry, pane_id)
        .into_iter()
        .map(|pid| (pid, process_name(pid)))
        .collect()
}

#[cfg(not(windows))]
pub(crate) fn job_pids_with_names(_registry: &PtyRegistry, _pane_id: &str) -> Vec<(u32, Option<String>)> {
    Vec::new()
}

#[cfg(windows)]
fn job_pids_of(job: HANDLE) -> Vec<u32> {
    // JOBOBJECT_BASIC_PROCESS_ID_LIST is a variable-length struct (two u32 header
    // fields followed by a ProcessIdList[N] tail); windows-rs models the tail as a
    // 1-element array, so we over-allocate a raw buffer and index into it manually.
    const MAX_PIDS: usize = 256;
    let header_len = 2 * std::mem::size_of::<u32>();
    let elem_len = std::mem::size_of::<usize>();
    let mut buf = vec![0u8; header_len + elem_len * MAX_PIDS];
    let mut returned: u32 = 0;

    let ok = unsafe {
        QueryInformationJobObject(
            Some(job),
            JobObjectBasicProcessIdList,
            buf.as_mut_ptr() as *mut _,
            buf.len() as u32,
            Some(&mut returned),
        )
    };
    if ok.is_err() {
        return Vec::new();
    }

    // SAFETY: `buf` is large enough for the header and was populated by the kernel
    // above; we only read `count` (kernel-reported, clamped to our buffer) entries.
    unsafe {
        let header = &*(buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST);
        let count = (header.NumberOfProcessIdsInList as usize).min(MAX_PIDS);
        let list_ptr = buf.as_ptr().add(header_len) as *const usize;
        (0..count).map(|i| *list_ptr.add(i) as u32).collect()
    }
}

#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let result =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        result.ok()?;
        let full_path = String::from_utf16_lossy(&buf[..size as usize]);
        full_path.rsplit(['\\', '/']).next().map(str::to_string)
    }
}

/// Faz 5 §1.4/§4 item 11: `node.exe`'s command line, via the NT-level
/// `ProcessCommandLineInformation` query (unlike `ProcessBasicInformation` + reading the
/// PEB, this info class fills a buffer we own directly — no cross-process `PROCESS_VM_READ`
/// needed). Best-effort: `None` on *any* failure (inaccessible pid, unexpected buffer
/// shape, …) — callers skip that pid's heuristic classification rather than erroring
/// (spec: "başarısızsa atla"). Callers are expected to cache this by `(pid,
/// creation_time)` (spec item 11) since it's only ever consulted for `node.exe` pids.
#[cfg(windows)]
pub(crate) fn process_command_line(pid: u32) -> Option<String> {
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows::Win32::Foundation::UNICODE_STRING;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = vec![0u8; 4096];
        let mut return_len: u32 = 0;
        let mut status = NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            buf.as_mut_ptr() as *mut _,
            buf.len() as u32,
            &mut return_len,
        );
        if status.0 < 0 && return_len as usize > buf.len() {
            buf = vec![0u8; return_len as usize];
            status = NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                buf.as_mut_ptr() as *mut _,
                buf.len() as u32,
                &mut return_len,
            );
        }
        let _ = CloseHandle(handle);
        if status.0 < 0 {
            return None;
        }

        // `UNICODE_STRING` header followed (within this same buffer) by the wide
        // command-line text; ntdll points `Buffer` back into our own allocation.
        if buf.len() < std::mem::size_of::<UNICODE_STRING>() {
            return None;
        }
        let header = &*(buf.as_ptr() as *const UNICODE_STRING);
        if header.Buffer.is_null() || header.Length == 0 {
            return None;
        }
        let char_len = (header.Length / 2) as usize;
        let wide = std::slice::from_raw_parts(header.Buffer.0, char_len);
        Some(String::from_utf16_lossy(wide))
    }
}

#[cfg(not(windows))]
pub(crate) fn process_command_line(_pid: u32) -> Option<String> {
    None
}

/// Processes living under `pane_id` (D8 derisk; BUG-1 fix: union of the Job Object's
/// pid list and a whole-system descendant walk from the shell pid, since packaged/MSIX
/// shell children can escape the job entirely — see `pane_process_union`). PID + image
/// name (cmdline is left `None` in the spike — see todo.md Faz 1, "cmdline optional").
#[tauri::command(async)]
pub fn pty_processes(registry: State<'_, PtyRegistry>, pane_id: String) -> AppResult<Vec<ProcessInfo>> {
    #[cfg(windows)]
    {
        let Some((shell_pid, _)) = registry.shell_info(&pane_id) else {
            return Ok(Vec::new());
        };
        Ok(pane_process_union(&registry, &pane_id, shell_pid)
            .into_iter()
            .map(|(pid, name)| ProcessInfo {
                pid,
                name,
                cmdline: None,
            })
            .collect())
    }
    #[cfg(not(windows))]
    {
        let _ = (&registry, &pane_id);
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as StdHashMap;

    // ---- sanitize_spawn_error (spec §9.2: never the raw command line) ----------------

    #[derive(Debug)]
    struct WrappedIoError(std::io::Error);

    impl std::fmt::Display for WrappedIoError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "wrapped: {}", self.0)
        }
    }

    impl std::error::Error for WrappedIoError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[derive(Debug)]
    struct OpaqueError(String);

    impl std::fmt::Display for OpaqueError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // Simulates portable-pty's `bail!("CreateProcessW `{argv}` in cwd `{cwd}`
            // failed: {io_err}")`: the argv/cwd are folded into the message text with no
            // `source()` chain to recover the underlying `io::Error` from.
            write!(f, "{}", self.0)
        }
    }

    impl std::error::Error for OpaqueError {}

    #[test]
    fn sanitize_spawn_error_uses_basename_never_the_full_program_path() {
        let e = OpaqueError("boom".to_string());
        let msg = sanitize_spawn_error(r"C:\Program Files\PowerShell\7\pwsh.exe", &e);
        assert!(msg.contains("pwsh.exe"));
        assert!(!msg.contains(r"C:\Program Files"));
    }

    #[test]
    fn sanitize_spawn_error_recovers_the_root_io_error_through_a_source_chain() {
        let io_err = std::io::Error::from_raw_os_error(2); // "The system cannot find..."
        let wrapped = WrappedIoError(io_err);
        let msg = sanitize_spawn_error("pwsh.exe", &wrapped);
        assert!(msg.contains("pwsh.exe"));
        assert!(msg.contains("os error 2") || msg.to_lowercase().contains("cannot find"));
        // The wrapper's own text ("wrapped: ...") must never appear -- only the root
        // `io::Error`'s message is surfaced.
        assert!(!msg.contains("wrapped:"));
    }

    #[test]
    fn sanitize_spawn_error_recovers_only_the_os_error_code_from_portable_pty_text() {
        // The realistic case: portable-pty's `CreateProcessW` failure message already has
        // the argv/cwd baked in with no `source()` to recover the `io::Error` from -- the
        // critical property is that this NEVER falls back to `e.to_string()` (which would
        // be exactly the unsanitized, argv/cwd-carrying text).
        let e = OpaqueError(r#"CreateProcessW `"C:\secret\agentCommand --token abc123"` in cwd `"C:\Users\alice\secret-project"` failed: The system cannot find the file specified. (os error 2)"#.to_string());
        let msg = sanitize_spawn_error(r"C:\Program Files\PowerShell\7\pwsh.exe", &e);
        assert_eq!(
            msg,
            format!("failed to launch pwsh.exe: {}", std::io::Error::from_raw_os_error(2))
        );
        assert!(!msg.contains("secret"));
        assert!(!msg.contains("alice"));
        assert!(!msg.contains("agentCommand"));
    }

    #[test]
    fn sanitize_spawn_error_says_unknown_without_an_os_error_code() {
        let e = OpaqueError("CreateProcessW `\"x --secret\"` failed: weird".to_string());
        assert_eq!(sanitize_spawn_error("x.exe", &e), "failed to launch x.exe: unknown error");
    }

    #[test]
    fn trailing_os_error_code_parses_only_a_final_suffix() {
        assert_eq!(trailing_os_error_code("boom (os error 2)"), Some(2));
        assert_eq!(trailing_os_error_code("boom (os error 5)
"), Some(5));
        assert_eq!(trailing_os_error_code("(os error 2) then more"), None);
        assert_eq!(trailing_os_error_code("boom (os error x)"), None);
        assert_eq!(trailing_os_error_code("boom (os error )"), None);
    }

    // ---- shell profile detection (spec §1.1, §4.14) ----------------------------

    /// A tiny fake "env + filesystem" for the detection tests: `env` looks up variables
    /// from a map, `exists` checks a fixed set of path strings (compared with the same
    /// casing the tests supply — Windows paths in these tests are all backslash-joined
    /// literals, matching what `Path::join` on Windows produces).
    struct FakeMachine {
        env: StdHashMap<&'static str, &'static str>,
        files: Vec<String>,
    }

    impl FakeMachine {
        fn new() -> Self {
            Self {
                env: StdHashMap::new(),
                files: Vec::new(),
            }
        }
        fn with_env(mut self, key: &'static str, value: &'static str) -> Self {
            self.env.insert(key, value);
            self
        }
        fn with_file(mut self, path: &str) -> Self {
            self.files.push(path.to_string());
            self
        }
        fn env_lookup(&self) -> impl Fn(&str) -> Option<String> + '_ {
            move |k| self.env.get(k).map(|v| v.to_string())
        }
        fn exists(&self) -> impl Fn(&Path) -> bool + '_ {
            move |p| self.files.iter().any(|f| Path::new(f) == p)
        }
    }

    #[test]
    fn detect_pwsh_uses_windows_apps_execution_alias_when_that_is_all_that_exists() {
        let machine = FakeMachine::new()
            .with_env("LOCALAPPDATA", r"C:\Users\test\AppData\Local")
            .with_file(r"C:\Users\test\AppData\Local\Microsoft\WindowsApps\pwsh.exe");
        let profile = detect_pwsh(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(
            profile.program,
            r"C:\Users\test\AppData\Local\Microsoft\WindowsApps\pwsh.exe"
        );
        assert_eq!(profile.id, ShellKind::Pwsh);
        assert_eq!(profile.args, vec!["-NoLogo".to_string()]);
    }

    #[test]
    fn detect_pwsh_prefers_path_over_program_files() {
        let machine = FakeMachine::new()
            .with_env("PATH", r"C:\somewhere;C:\pwsh-on-path")
            .with_env("ProgramFiles", r"C:\Program Files")
            .with_file(r"C:\pwsh-on-path\pwsh.exe")
            .with_file(r"C:\Program Files\PowerShell\7\pwsh.exe");
        let profile = detect_pwsh(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.program, r"C:\pwsh-on-path\pwsh.exe");
    }

    #[test]
    fn detect_pwsh_none_when_nothing_exists() {
        let machine = FakeMachine::new();
        assert!(detect_pwsh(&machine.env_lookup(), &machine.exists()).is_none());
    }

    #[test]
    fn detect_gitbash_finds_bash_via_cmd_git_exe_on_path() {
        // git.exe on PATH at `...\Git\cmd\git.exe` -> bash is `<dir>\..\bin\bash.exe`.
        let machine = FakeMachine::new()
            .with_env("PATH", r"C:\Program Files\Git\cmd")
            .with_file(r"C:\Program Files\Git\cmd\git.exe")
            .with_file(r"C:\Program Files\Git\bin\bash.exe");
        let profile = detect_gitbash(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.program, r"C:\Program Files\Git\bin\bash.exe");
        assert_eq!(profile.id, ShellKind::GitBash);
        assert_eq!(profile.args, vec!["--login".to_string(), "-i".to_string()]);
    }

    #[test]
    fn detect_gitbash_finds_bash_via_mingw64_bin_git_exe_on_path() {
        // git.exe on PATH at `...\Git\mingw64\bin\git.exe` -> bash is
        // `<dir>\..\..\bin\bash.exe`.
        let machine = FakeMachine::new()
            .with_env("PATH", r"C:\Program Files\Git\mingw64\bin")
            .with_file(r"C:\Program Files\Git\mingw64\bin\git.exe")
            .with_file(r"C:\Program Files\Git\bin\bash.exe");
        let profile = detect_gitbash(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.program, r"C:\Program Files\Git\bin\bash.exe");
    }

    #[test]
    fn detect_gitbash_finds_bash_under_localappdata_programs_git() {
        let machine = FakeMachine::new()
            .with_env("LOCALAPPDATA", r"C:\Users\test\AppData\Local")
            .with_file(r"C:\Users\test\AppData\Local\Programs\Git\bin\bash.exe");
        let profile = detect_gitbash(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(
            profile.program,
            r"C:\Users\test\AppData\Local\Programs\Git\bin\bash.exe"
        );
    }

    #[test]
    fn detect_gitbash_none_when_nothing_exists() {
        let machine = FakeMachine::new();
        assert!(detect_gitbash(&machine.env_lookup(), &machine.exists()).is_none());
    }

    #[test]
    fn detect_powershell_requires_the_v1_path_to_exist() {
        let machine = FakeMachine::new().with_env("SystemRoot", r"C:\Windows");
        assert!(detect_powershell(&machine.env_lookup(), &machine.exists()).is_none());

        let machine = machine.with_file(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let profile = detect_powershell(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(
            profile.program,
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        );
    }

    #[test]
    fn detect_cmd_prefers_comspec_then_falls_back_to_system_root() {
        let machine = FakeMachine::new()
            .with_env("ComSpec", r"D:\custom\cmd.exe")
            .with_file(r"D:\custom\cmd.exe");
        let profile = detect_cmd(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.program, r"D:\custom\cmd.exe");

        let machine = FakeMachine::new()
            .with_env("SystemRoot", r"C:\Windows")
            .with_file(r"C:\Windows\System32\cmd.exe");
        let profile = detect_cmd(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.program, r"C:\Windows\System32\cmd.exe");
    }

    #[test]
    fn detect_wsl_requires_wsl_exe_to_exist() {
        let machine = FakeMachine::new().with_env("SystemRoot", r"C:\Windows");
        assert!(detect_wsl(&machine.env_lookup(), &machine.exists()).is_none());

        let machine = machine.with_file(r"C:\Windows\System32\wsl.exe");
        let profile = detect_wsl(&machine.env_lookup(), &machine.exists()).unwrap();
        assert_eq!(profile.id, ShellKind::Wsl);
    }

    #[test]
    fn detect_profiles_orders_pwsh_powershell_cmd_gitbash_wsl() {
        let machine = FakeMachine::new()
            .with_env("SystemRoot", r"C:\Windows")
            .with_env("ProgramFiles", r"C:\Program Files")
            .with_env("LOCALAPPDATA", r"C:\Users\test\AppData\Local")
            .with_file(r"C:\Program Files\PowerShell\7\pwsh.exe")
            .with_file(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
            .with_file(r"C:\Windows\System32\cmd.exe")
            .with_file(r"C:\Program Files\Git\bin\bash.exe")
            .with_file(r"C:\Windows\System32\wsl.exe");
        let profiles = detect_profiles(&machine.env_lookup(), &machine.exists());
        let ids: Vec<ShellKind> = profiles.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec![
                ShellKind::Pwsh,
                ShellKind::Powershell,
                ShellKind::Cmd,
                ShellKind::GitBash,
                ShellKind::Wsl,
            ]
        );
    }

    #[test]
    fn detect_profiles_only_includes_whats_found() {
        let machine = FakeMachine::new();
        assert!(detect_profiles(&machine.env_lookup(), &machine.exists()).is_empty());
    }

    // ---- agent command wrapping (spec §1.2, §4.18) ------------------------------

    fn profile(id: ShellKind, args: &[&str]) -> ShellProfile {
        ShellProfile {
            id,
            name: "test".to_string(),
            program: r"C:\fake\program.exe".to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    const CWD: &str = r"C:\src\app";

    #[test]
    fn wrap_agent_command_none_returns_bare_profile_args() {
        let p = profile(ShellKind::Cmd, &["/Q"]);
        assert_eq!(wrap_agent_command(&p, Path::new(CWD), None), vec!["/Q".to_string()]);
    }

    #[test]
    fn wrap_agent_command_pwsh_without_agent_restores_cwd_after_the_profile() {
        let p = profile(ShellKind::Pwsh, &["-NoLogo"]);
        assert_eq!(
            wrap_agent_command(&p, Path::new(CWD), None),
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                r"Set-Location -LiteralPath 'C:\src\app'".to_string(),
            ]
        );
    }

    #[test]
    fn wrap_agent_command_pwsh_and_powershell() {
        for id in [ShellKind::Pwsh, ShellKind::Powershell] {
            let p = profile(id, &["-NoLogo"]);
            assert_eq!(
                wrap_agent_command(&p, Path::new(CWD), Some("claude")),
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    r"Set-Location -LiteralPath 'C:\src\app'; claude".to_string(),
                ]
            );
        }
    }

    #[test]
    fn pwsh_set_location_doubles_every_single_quote_form() {
        assert_eq!(
            pwsh_set_location(Path::new("C:\\o'neil\\it\u{2019}s [x] $y")),
            "Set-Location -LiteralPath 'C:\\o''neil\\it\u{2019}\u{2019}s [x] $y'"
        );
    }

    #[test]
    fn wrap_agent_command_cmd() {
        let p = profile(ShellKind::Cmd, &[]);
        assert_eq!(
            wrap_agent_command(&p, Path::new(CWD), Some("claude")),
            vec!["/K".to_string(), "claude".to_string()]
        );
    }

    #[test]
    fn wrap_agent_command_gitbash() {
        let p = profile(ShellKind::GitBash, &["--login", "-i"]);
        assert_eq!(
            wrap_agent_command(&p, Path::new(CWD), Some("claude")),
            vec![
                "--login".to_string(),
                "-i".to_string(),
                "-c".to_string(),
                "claude; exec bash --login -i".to_string(),
            ]
        );
    }

    #[test]
    fn wrap_agent_command_wsl() {
        let p = profile(ShellKind::Wsl, &[]);
        assert_eq!(
            wrap_agent_command(&p, Path::new(CWD), Some("claude")),
            vec![
                "--".to_string(),
                "bash".to_string(),
                "-lic".to_string(),
                "claude; exec bash -li".to_string(),
            ]
        );
    }

    #[test]
    fn wrap_agent_command_preserves_spaces_and_quotes_as_a_single_arg() {
        let p = profile(ShellKind::Pwsh, &["-NoLogo"]);
        let args = wrap_agent_command(&p, Path::new(CWD), Some(r#"claude --flag "some value""#));
        assert_eq!(args.last().unwrap(), r#"Set-Location -LiteralPath 'C:\src\app'; claude --flag "some value""#);

        let p = profile(ShellKind::GitBash, &["--login", "-i"]);
        let args = wrap_agent_command(&p, Path::new(CWD), Some("claude --flag 'some value'"));
        assert_eq!(
            args.last().unwrap(),
            "claude --flag 'some value'; exec bash --login -i"
        );
    }

    // ---- env builder (spec §1.2, §4.16, §4.17) ----------------------------------

    #[test]
    fn should_remove_env_key_matches_claudecode_and_prefix_case_insensitively() {
        assert!(should_remove_env_key("CLAUDECODE"));
        assert!(should_remove_env_key("claudecode"));
        assert!(should_remove_env_key("CLAUDE_CODE_CHILD_SESSION"));
        assert!(should_remove_env_key("claude_code_child_session"));
        assert!(!should_remove_env_key("CLAUDE"));
        assert!(!should_remove_env_key("AGENTHUB_PANE_ID"));
    }

    // ---- Review item 17: strip only an EMPTY CC/CXX (the repo's own dev-only
    // `.cargo/config.toml` override), never a real value ----------------------------

    #[test]
    fn should_strip_empty_toolchain_env_matches_empty_cc_and_cxx_case_insensitively() {
        assert!(should_strip_empty_toolchain_env("CC", ""));
        assert!(should_strip_empty_toolchain_env("cc", ""));
        assert!(should_strip_empty_toolchain_env("CXX", ""));
        assert!(should_strip_empty_toolchain_env("cxx", ""));
    }

    #[test]
    fn should_strip_empty_toolchain_env_leaves_a_real_value_untouched() {
        assert!(!should_strip_empty_toolchain_env("CC", "gcc"));
        assert!(!should_strip_empty_toolchain_env("CXX", "g++"));
    }

    #[test]
    fn should_strip_empty_toolchain_env_ignores_unrelated_keys_even_when_empty() {
        assert!(!should_strip_empty_toolchain_env("AGENTHUB_PANE_ID", ""));
        assert!(!should_strip_empty_toolchain_env("PATH", ""));
    }

    #[test]
    fn pane_env_overrides_sets_agenthub_and_terminal_vars() {
        let overrides = pane_env_overrides("pane-1", "ws-1", r"\\.\pipe\agenthub-123", ShellKind::Pwsh, None);
        let map: StdHashMap<&str, &str> = overrides.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(map["AGENTHUB_PANE_ID"], "pane-1");
        assert_eq!(map["AGENTHUB_WORKSPACE_ID"], "ws-1");
        assert_eq!(map["AGENTHUB_ENDPOINT"], r"\\.\pipe\agenthub-123");
        assert_eq!(map["TERM_PROGRAM"], crate::brand::SLUG);
        assert_eq!(map["COLORTERM"], "truecolor");
        assert_eq!(map["TERM"], "xterm-256color");
        assert!(!map.contains_key("WSLENV"));
    }

    #[test]
    fn pane_env_overrides_merges_wslenv_only_for_wsl() {
        let overrides = pane_env_overrides("p", "w", "e", ShellKind::Wsl, Some("FOO:BAR"));
        let map: StdHashMap<&str, &str> = overrides.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(
            map["WSLENV"],
            "FOO:BAR:AGENTHUB_PANE_ID:AGENTHUB_WORKSPACE_ID:AGENTHUB_ENDPOINT"
        );
    }

    #[test]
    fn pane_env_overrides_wsl_with_no_existing_wslenv() {
        let overrides = pane_env_overrides("p", "w", "e", ShellKind::Wsl, None);
        let map: StdHashMap<&str, &str> = overrides.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        assert_eq!(
            map["WSLENV"],
            "AGENTHUB_PANE_ID:AGENTHUB_WORKSPACE_ID:AGENTHUB_ENDPOINT"
        );
    }

    // ---- build_command (spec §4.16, §4.18) --------------------------------------

    #[test]
    fn build_command_argv_and_env_for_pwsh_with_agent() {
        let p = profile(ShellKind::Pwsh, &["-NoLogo"]);
        let dir = tempfile::tempdir().unwrap();
        let cmd = build_command(&p, dir.path(), Some("claude"), "pane-1", "ws-1", "endpoint").unwrap();

        let argv: Vec<String> = cmd.get_argv().iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            argv,
            vec![
                p.program.clone(),
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("{}; claude", pwsh_set_location(dir.path())),
            ]
        );

        let env: StdHashMap<String, String> = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(env.get("AGENTHUB_PANE_ID"), Some(&"pane-1".to_string()));
        assert_eq!(env.get("AGENTHUB_WORKSPACE_ID"), Some(&"ws-1".to_string()));
        assert_eq!(env.get("AGENTHUB_ENDPOINT"), Some(&"endpoint".to_string()));
        assert_eq!(env.get("TERM"), Some(&"xterm-256color".to_string()));
        assert!(!env.keys().any(|k| should_remove_env_key(k)));
    }

    #[test]
    fn build_command_scrubs_claude_code_env_leaked_from_this_very_test_process() {
        // This test binary is very plausibly itself running under Claude Code (this
        // change was authored inside it) — so if `CLAUDECODE`/`CLAUDE_CODE_*` are
        // actually set in the ambient environment right now, this is a real end-to-end
        // check that `build_command` scrubs them, not just a check against a fake map.
        let p = profile(ShellKind::Cmd, &[]);
        let dir = tempfile::tempdir().unwrap();
        let cmd = build_command(&p, dir.path(), None, "pane", "ws", "endpoint").unwrap();
        for (key, _) in cmd.iter_full_env_as_str() {
            assert!(!should_remove_env_key(key), "env key {key} should have been scrubbed");
        }
    }

    #[test]
    fn build_command_rejects_agent_command_starting_with_dash_for_every_profile() {
        for id in [ShellKind::Pwsh, ShellKind::Powershell, ShellKind::Cmd, ShellKind::GitBash, ShellKind::Wsl] {
            let p = profile(id, &[]);
            let dir = tempfile::tempdir().unwrap();
            let err = build_command(&p, dir.path(), Some("-rf"), "pane", "ws", "endpoint").unwrap_err();
            assert_eq!(err.code, crate::error::ErrorCode::InvalidName, "{id:?} should reject a leading '-'");
        }
    }

    #[test]
    fn build_command_rejects_double_quote_only_for_cmd() {
        let p = profile(ShellKind::Cmd, &[]);
        let dir = tempfile::tempdir().unwrap();
        let err = build_command(&p, dir.path(), Some(r#"claude "x""#), "pane", "ws", "endpoint").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::InvalidName);

        let p = profile(ShellKind::Pwsh, &["-NoLogo"]);
        let dir = tempfile::tempdir().unwrap();
        assert!(build_command(&p, dir.path(), Some(r#"claude "x""#), "pane", "ws", "endpoint").is_ok());
    }

    #[test]
    fn build_command_gitbash_and_wsl_argv() {
        let p = profile(ShellKind::GitBash, &["--login", "-i"]);
        let dir = tempfile::tempdir().unwrap();
        let cmd = build_command(&p, dir.path(), Some("claude"), "pane", "ws", "endpoint").unwrap();
        let argv: Vec<String> = cmd.get_argv().iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(
            argv,
            vec![
                p.program.clone(),
                "--login".to_string(),
                "-i".to_string(),
                "-c".to_string(),
                "claude; exec bash --login -i".to_string(),
            ]
        );

        let p = profile(ShellKind::Wsl, &[]);
        let cmd = build_command(&p, dir.path(), Some("claude"), "pane", "ws", "endpoint").unwrap();
        let env: StdHashMap<String, String> = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert!(env.get("WSLENV").unwrap().contains("AGENTHUB_PANE_ID"));
    }

    // ---- pty_busy decision (spec §4.15) ------------------------------------------

    #[test]
    fn decide_busy_false_when_only_shell_and_console_host_remain() {
        let procs = vec![
            (100u32, Some("pwsh.exe".to_string())),
            (101u32, Some("conhost.exe".to_string())),
        ];
        let decision = decide_busy(&procs, 100, "pwsh.exe");
        assert!(!decision.busy);
        assert!(decision.processes.is_empty());
    }

    #[test]
    fn decide_busy_true_with_a_real_subprocess() {
        let procs = vec![
            (100u32, Some("pwsh.exe".to_string())),
            (102u32, Some("node.exe".to_string())),
        ];
        let decision = decide_busy(&procs, 100, "pwsh.exe");
        assert!(decision.busy);
        assert_eq!(decision.processes, vec!["node".to_string()]);
    }

    /// Git Bash's login shell (`bin\bash.exe`, this pane's `shell_pid`) execs into
    /// `usr\bin\bash.exe` — a *different* pid, but the same image filename — which must
    /// also be excluded from "busy", not just the original shell pid (spec §4.15).
    #[test]
    fn decide_busy_excludes_second_bash_process_with_same_image_name() {
        let procs = vec![
            (200u32, Some("bash.exe".to_string())), // the shell_pid itself
            (201u32, Some("bash.exe".to_string())),  // exec'd usr/bin/bash.exe, different pid
            (202u32, Some("claude.exe".to_string())),
        ];
        let decision = decide_busy(&procs, 200, "bash.exe");
        assert!(decision.busy);
        assert_eq!(decision.processes, vec!["claude".to_string()]);
    }

    #[test]
    fn decide_busy_deduplicates_process_names() {
        let procs = vec![
            (100u32, Some("pwsh.exe".to_string())),
            (102u32, Some("node.exe".to_string())),
            (103u32, Some("node.exe".to_string())),
        ];
        let decision = decide_busy(&procs, 100, "pwsh.exe");
        assert_eq!(decision.processes, vec!["node".to_string()]);
    }

    // ---- agent_gone_from (WSL blind-spot fix, review item 1) ----------------------

    #[test]
    fn agent_gone_from_true_with_shell_only() {
        let procs = vec![(100u32, Some("pwsh.exe".to_string()))];
        assert!(agent_gone_from(true, &procs, 100, "pwsh.exe"));
    }

    #[test]
    fn agent_gone_from_false_with_shell_plus_node() {
        let procs = vec![
            (100u32, Some("pwsh.exe".to_string())),
            (102u32, Some("node.exe".to_string())),
        ];
        assert!(!agent_gone_from(true, &procs, 100, "pwsh.exe"));
    }

    #[test]
    fn agent_gone_from_false_for_wsl_shell_with_no_visible_children() {
        // The whole point of the WSL fix: Linux children of `wsl.exe` never show up in a
        // Toolhelp snapshot, so an empty descendant list must NOT be read as "gone" —
        // only the shell itself exiting may end the wait.
        assert!(!agent_gone_from(true, &[], 100, "wsl.exe"));
        // Case-insensitive.
        assert!(!agent_gone_from(true, &[], 100, "WSL.EXE"));
    }

    #[test]
    fn agent_gone_from_true_when_shell_is_dead() {
        assert!(agent_gone_from(false, &[], 100, "wsl.exe"));
        let procs = vec![(102u32, Some("node.exe".to_string()))];
        assert!(agent_gone_from(false, &procs, 100, "pwsh.exe"));
    }

    // ---- strip_exe_suffix (spec §4.15 — non-ASCII image names must not panic) ---

    #[test]
    fn strip_exe_suffix_leaves_non_matching_non_ascii_name_untouched_without_panicking() {
        // "aébcd" has no ".exe" suffix, but its byte length (6) is >= 4 and the
        // multi-byte 'é' straddles the naive `name[name.len()-4..]` cut point — the
        // pre-fix code panicked here with "byte index 2 is not a char boundary".
        assert_eq!(strip_exe_suffix("aébcd"), "aébcd");
    }

    #[test]
    fn strip_exe_suffix_strips_exe_case_insensitively_with_non_ascii_stem() {
        assert_eq!(strip_exe_suffix("çalış.EXE"), "çalış");
        assert_eq!(strip_exe_suffix("çalış.exe"), "çalış");
    }

    #[test]
    fn strip_exe_suffix_ascii_unchanged() {
        assert_eq!(strip_exe_suffix("node.exe"), "node");
        assert_eq!(strip_exe_suffix("node.EXE"), "node");
        assert_eq!(strip_exe_suffix("node"), "node");
        assert_eq!(strip_exe_suffix("exe"), "exe");
    }

    #[test]
    fn decide_busy_excludes_openconsole() {
        let procs = vec![
            (100u32, Some("cmd.exe".to_string())),
            (104u32, Some("OpenConsole.exe".to_string())),
        ];
        let decision = decide_busy(&procs, 100, "cmd.exe");
        assert!(!decision.busy);
    }

    // ---- walk_descendants (BUG-1 fix: packaged/MSIX shell children escape the job) --

    fn snap(pid: u32, ppid: u32, name: &str, creation_time: u64) -> ProcSnapshotEntry {
        ProcSnapshotEntry {
            pid,
            ppid,
            name: name.to_string(),
            creation_time,
        }
    }

    #[test]
    fn walk_descendants_finds_direct_and_grandchild() {
        let snapshot = vec![
            snap(100, 1, "pwsh.exe", 10),
            snap(101, 100, "ping.exe", 20),
            snap(102, 101, "conhost.exe", 25),
            snap(999, 1, "unrelated.exe", 5),
        ];
        let mut found: Vec<u32> = walk_descendants(&snapshot, 100).into_iter().map(|e| e.pid).collect();
        found.sort();
        assert_eq!(found, vec![101, 102]);
    }

    #[test]
    fn walk_descendants_does_not_depend_on_snapshot_ordering() {
        // Same tree as above, but children listed before their parent — the fix-point
        // loop must still find the grandchild.
        let snapshot = vec![
            snap(102, 101, "conhost.exe", 25),
            snap(101, 100, "ping.exe", 20),
            snap(100, 1, "pwsh.exe", 10),
        ];
        let mut found: Vec<u32> = walk_descendants(&snapshot, 100).into_iter().map(|e| e.pid).collect();
        found.sort();
        assert_eq!(found, vec![101, 102]);
    }

    #[test]
    fn walk_descendants_excludes_root_itself() {
        let snapshot = vec![snap(100, 1, "pwsh.exe", 10), snap(101, 100, "ping.exe", 20)];
        let found = walk_descendants(&snapshot, 100);
        assert!(!found.iter().any(|e| e.pid == 100));
    }

    #[test]
    fn walk_descendants_rejects_pid_reuse_child_created_before_parent() {
        // pid 101 claims ppid 100, but its creation_time (5) predates pid 100's (10) —
        // a real child cannot have been created before its parent, so this must be a
        // recycled pid from an unrelated, unrelated-in-time process, not a real child.
        let snapshot = vec![snap(100, 1, "pwsh.exe", 10), snap(101, 100, "stale.exe", 5)];
        let found = walk_descendants(&snapshot, 100);
        assert!(found.is_empty(), "should reject a child older than its claimed parent");
    }

    #[test]
    fn walk_descendants_accepts_child_when_a_timestamp_is_unknown() {
        // creation_time 0 means "couldn't be read" on either side — the walk must still
        // include the child rather than dropping a real descendant over a failed read.
        let snapshot = vec![snap(100, 1, "pwsh.exe", 0), snap(101, 100, "ping.exe", 20)];
        let found = walk_descendants(&snapshot, 100);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, 101);
    }

    #[test]
    fn walk_descendants_does_not_loop_on_a_cycle_disconnected_from_root() {
        // 200 <-> 201 is a (pathological) ppid cycle, but neither is reachable from
        // root 100 — must terminate and must not include either.
        let snapshot = vec![
            snap(100, 1, "pwsh.exe", 10),
            snap(200, 201, "a.exe", 1),
            snap(201, 200, "b.exe", 1),
        ];
        let found = walk_descendants(&snapshot, 100);
        assert!(found.is_empty());
    }

    #[test]
    fn walk_descendants_multiple_children_of_same_parent() {
        let snapshot = vec![
            snap(100, 1, "pwsh.exe", 10),
            snap(101, 100, "ping.exe", 20),
            snap(102, 100, "node.exe", 20),
        ];
        let mut found: Vec<u32> = walk_descendants(&snapshot, 100).into_iter().map(|e| e.pid).collect();
        found.sort();
        assert_eq!(found, vec![101, 102]);
    }

    #[test]
    fn walk_descendants_empty_when_root_has_no_children() {
        let snapshot = vec![snap(100, 1, "pwsh.exe", 10), snap(999, 1, "unrelated.exe", 5)];
        assert!(walk_descendants(&snapshot, 100).is_empty());
    }

    // ---- walk_descendants_lazy (spec §4 finding 3: same walk, lazy creation times) --

    fn topo(pid: u32, ppid: u32, name: &str) -> ProcTopologyEntry {
        ProcTopologyEntry {
            pid,
            ppid,
            name: name.to_string(),
        }
    }

    #[test]
    fn walk_descendants_lazy_matches_walk_descendants_on_the_same_tree() {
        let snapshot = vec![
            snap(100, 1, "pwsh.exe", 10),
            snap(101, 100, "ping.exe", 20),
            snap(102, 101, "conhost.exe", 25),
            snap(999, 1, "unrelated.exe", 5),
        ];
        let topology: Vec<ProcTopologyEntry> = snapshot
            .iter()
            .map(|e| topo(e.pid, e.ppid, &e.name))
            .collect();
        let creation_times: StdHashMap<u32, u64> =
            snapshot.iter().map(|e| (e.pid, e.creation_time)).collect();

        let mut cache = StdHashMap::new();
        let mut found: Vec<u32> = walk_descendants_lazy(&topology, 100, &mut cache, &mut |pid| {
            creation_times.get(&pid).copied().unwrap_or(0)
        })
        .into_iter()
        .map(|e| e.pid)
        .collect();
        found.sort();

        let mut expected: Vec<u32> = walk_descendants(&snapshot, 100).into_iter().map(|e| e.pid).collect();
        expected.sort();
        assert_eq!(found, expected);
    }

    #[test]
    fn walk_descendants_lazy_rejects_pid_reuse_child_created_before_parent() {
        let topology = vec![topo(100, 1, "pwsh.exe"), topo(101, 100, "stale.exe")];
        let creation_times: StdHashMap<u32, u64> = [(100u32, 10u64), (101u32, 5u64)].into_iter().collect();
        let mut cache = StdHashMap::new();
        let found = walk_descendants_lazy(&topology, 100, &mut cache, &mut |pid| {
            creation_times.get(&pid).copied().unwrap_or(0)
        });
        assert!(found.is_empty(), "should reject a child older than its claimed parent");
    }

    #[test]
    fn walk_descendants_lazy_only_queries_creation_time_for_pids_it_actually_reaches() {
        // pid 999 is topologically unrelated to root 100 (ppid 1, same as root, but
        // root's own ppid chain never reaches it) — its creation time must never be
        // queried at all, which is the whole point of this fix (spec §4 finding 3).
        let topology = vec![
            topo(100, 1, "pwsh.exe"),
            topo(101, 100, "ping.exe"),
            topo(999, 1, "unrelated.exe"),
        ];
        let queried: std::cell::RefCell<Vec<u32>> = std::cell::RefCell::new(Vec::new());
        let mut cache = StdHashMap::new();
        let found = walk_descendants_lazy(&topology, 100, &mut cache, &mut |pid| {
            queried.borrow_mut().push(pid);
            match pid {
                100 => 10,
                101 => 20,
                _ => 0,
            }
        });
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, 101);
        assert_eq!(found[0].creation_time, 20);
        assert!(!queried.borrow().contains(&999), "pid 999 is never a walk candidate");
    }

    #[test]
    fn walk_descendants_lazy_memoizes_the_creation_time_resolver_per_pid() {
        let topology = vec![
            topo(100, 1, "pwsh.exe"),
            topo(101, 100, "ping.exe"),
            topo(102, 100, "node.exe"),
        ];
        let calls: std::cell::RefCell<StdHashMap<u32, u32>> = std::cell::RefCell::new(StdHashMap::new());
        let mut cache = StdHashMap::new();
        // Root (100) is queried once up front, then again as a *parent* lookup is never
        // re-resolved (it's read from `included`, not re-queried) — only each pid's own
        // first appearance as a walk candidate should trigger exactly one call.
        let found = walk_descendants_lazy(&topology, 100, &mut cache, &mut |pid| {
            *calls.borrow_mut().entry(pid).or_insert(0) += 1;
            match pid {
                100 => 10,
                101 => 20,
                102 => 20,
                _ => 0,
            }
        });
        assert_eq!(found.len(), 2);
        for (&pid, &count) in calls.borrow().iter() {
            assert_eq!(count, 1, "pid {pid} was resolved more than once in a single walk");
        }
    }

    // ---- spawn cwd validation (spec §1.5, §4) ------------------------------------

    #[test]
    fn resolve_spawn_cwd_rejects_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_spawn_cwd(dir.path(), "does-not-exist").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound);
    }

    #[test]
    fn resolve_spawn_cwd_rejects_a_file_as_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), b"x").unwrap();
        let err = resolve_spawn_cwd(dir.path(), "f.txt").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotADirectory);
    }

    #[test]
    fn resolve_spawn_cwd_accepts_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = resolve_spawn_cwd(dir.path(), "").unwrap();
        assert_eq!(
            std::fs::canonicalize(cwd).unwrap(),
            std::fs::canonicalize(dir.path()).unwrap()
        );
    }
}

/// Serializes the heavier integration tests below (`ctrl_c_tests`,
/// `bug1_msix_pwsh_tests`) against each other. `cargo test`'s default parallel harness
/// runs every test in the same process on separate threads; these tests spawn real
/// console-attached child processes and poll their Job Object / whole-system process
/// state with generous-but-finite timeouts, so letting several of them fight for CPU
/// and race real OS process/console setup at once is a genuine source of flakiness that
/// has nothing to do with the fixes under test (observed directly: every one of these
/// tests is reliable alone, but time out under full-suite parallel load without this).
#[cfg(all(test, windows))]
static HEAVY_INTEGRATION_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(all(test, windows))]
mod job_object_tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::process::Command;

    fn make_job() -> HANDLE {
        unsafe {
            let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).expect("CreateJobObjectW");
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .expect("SetInformationJobObject");
            job
        }
    }

    /// D8 derisk, part 1: spawns a short-lived child (not the test process itself —
    /// killing that would take the whole test binary down), assigns it to a fresh Job
    /// Object, and confirms `job_pids_of` reports it back via
    /// `QueryInformationJobObject(JobObjectBasicProcessIdList)`.
    #[test]
    fn job_pids_of_reports_assigned_process() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 5 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn cmd.exe");
        let pid = child.id();

        unsafe {
            let job = make_job();
            let handle = HANDLE(AsRawHandle::as_raw_handle(&child));
            AssignProcessToJobObject(job, handle).expect("AssignProcessToJobObject");

            let pids = job_pids_of(job);
            assert!(
                pids.contains(&pid),
                "expected job's pid list {pids:?} to contain the child {pid}"
            );

            let _ = CloseHandle(job);
        }

        let _ = child.wait();
    }

    /// D8 derisk, part 2: proves `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` actually kills the
    /// child when the job's last handle closes (what `PtyRegistry::remove` relies on for
    /// `pty_kill` / exit cleanup) — not just that the flag was set without error.
    #[test]
    fn dropping_job_handle_kills_assigned_process() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .expect("spawn cmd.exe");

        unsafe {
            let job = make_job();
            let handle = HANDLE(AsRawHandle::as_raw_handle(&child));
            AssignProcessToJobObject(job, handle).expect("AssignProcessToJobObject");

            // This is the exact mechanism `PaneHandle`'s `Drop` (via `JobHandle`) relies
            // on: closing the job's last handle kills everything still assigned to it.
            drop(JobHandle(job));
        }

        let start = std::time::Instant::now();
        let _status = child.wait().expect("child.wait");
        let elapsed = start.elapsed();
        // `ping -n 30` naturally runs for ~29s; if KILL_ON_JOB_CLOSE actually fired,
        // `wait()` returns almost immediately instead. (Windows exits a job-closed
        // process with code 0 — same as success — so elapsed time, not the exit code,
        // is the signal that proves termination here.)
        assert!(
            elapsed < Duration::from_secs(5),
            "child should have been terminated by KILL_ON_JOB_CLOSE within milliseconds, \
             but wait() took {elapsed:?} (ping -n 30 would take ~29s on its own)"
        );
    }
}

/// Review finding A: `take_pane`/`clear` must release the registry lock *before* the
/// removed `PaneHandle`(s) actually drop (see their doc comments). A `Box<dyn MasterPty>`
/// can't be faked without depending on `anyhow` (its trait methods return
/// `portable_pty`'s internal `anyhow::Error` alias, which isn't re-exported and isn't a
/// dependency of this crate), so these tests open a real (but otherwise idle, never
/// spawned into) ConPTY for `master` and instrument the `writer` instead — an ordinary
/// `std::io::Write` we fully control — to record whether the registry's pane-table lock
/// was already free at the moment the pane's teardown ran.
#[cfg(all(test, windows))]
mod teardown_lock_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct ProbeWriter {
        registry: Arc<PtyRegistry>,
        lock_was_free_on_drop: Arc<AtomicBool>,
    }

    impl Write for ProbeWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Drop for ProbeWriter {
        fn drop(&mut self) {
            // If `take_pane`/`clear` still held the registry lock at this point, this
            // `try_lock` would fail (the bug this test guards against).
            let free = self.registry.panes.try_lock().is_ok();
            self.lock_was_free_on_drop.store(free, Ordering::SeqCst);
        }
    }

    /// Inserts a pane whose `writer` is a `ProbeWriter`, returning the flag it records
    /// into on drop.
    fn insert_probe_pane(registry: &Arc<PtyRegistry>, pane_id: &str) -> Arc<AtomicBool> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        drop(pair.slave);

        let flag = Arc::new(AtomicBool::new(false));
        registry.panes().insert(
            pane_id.to_string(),
            PaneHandle {
                spawned_at: Instant::now(),
                workspace_id: "w-test".to_string(),
                activity: Arc::new(PaneActivity::default()),
                job: None,
                master: pair.master,
                writer: Arc::new(Mutex::new(Box::new(ProbeWriter {
                    registry: registry.clone(),
                    lock_was_free_on_drop: flag.clone(),
                }))),
                shell_pid: 0,
                shell_image_name: "fake.exe".to_string(),
                screen: Arc::new(Mutex::new(PaneScreen::new(24, 80))),
                seen_descendants: Vec::new(),
            },
        );
        flag
    }

    #[test]
    fn take_pane_releases_lock_before_pane_teardown_runs() {
        let registry = Arc::new(PtyRegistry::default());
        let flag = insert_probe_pane(&registry, "pane-a");

        registry.take_pane("pane-a");

        assert!(
            flag.load(Ordering::SeqCst),
            "pane teardown ran while PtyRegistry's lock was still held"
        );
    }

    #[test]
    fn clear_releases_lock_before_any_pane_teardown_runs() {
        let registry = Arc::new(PtyRegistry::default());
        let flag_a = insert_probe_pane(&registry, "pane-a");
        let flag_b = insert_probe_pane(&registry, "pane-b");

        registry.clear();

        assert!(
            flag_a.load(Ordering::SeqCst),
            "pane-a teardown ran while PtyRegistry's lock was still held"
        );
        assert!(
            flag_b.load(Ordering::SeqCst),
            "pane-b teardown ran while PtyRegistry's lock was still held"
        );
    }
}

/// BUG-2 (High): Ctrl+C did not interrupt a foreground child (e.g. `ping -t` under
/// either the cmd or pwsh profile). Root cause: our own process had inherited a
/// per-process "ignore Ctrl+C/Ctrl+Break" flag (`SetConsoleCtrlHandler(NULL, TRUE)`,
/// set by some ancestor process — a background shell/npm/cargo disabling Ctrl+C for
/// children it manages via job control), which Windows documents as inherited by every
/// process this process creates via `CreateProcess`, all the way down the tree. See
/// `clear_inherited_ctrl_c_ignore`'s doc comment for the fix and why it's safe. These
/// tests spawn exactly the way `pty_spawn` does (`build_command` + `native_pty_system` +
/// a real Job Object) so they exercise the actual fix against a real ConPTY, not a mock.
#[cfg(all(test, windows))]
mod ctrl_c_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Spawns `profile` running `ping -t 127.0.0.1` (wrapped the same way `pty_spawn`
    /// wraps an `agent_command`), waits for `ping.exe` to actually appear as a live
    /// descendant of the shell (a whole-system parent-pid walk, not just the pane's Job
    /// Object pid list — a packaged/MSIX shell can legitimately keep its own children
    /// outside the job, which is BUG-1, not BUG-2; this test must stay meaningful
    /// regardless of which shell profile the machine resolves), writes a Ctrl+C byte
    /// (`0x03`) to the pty, then polls for `ping.exe` to disappear within `timeout`.
    /// Returns `true` iff it disappeared in time (i.e. Ctrl+C actually stopped it).
    fn ctrl_c_stops_ping(profile: &ShellProfile, timeout: Duration) -> bool {
        let _guard = HEAVY_INTEGRATION_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let cmd = build_command(profile, dir.path(), Some("ping -t 127.0.0.1"), "pane", "ws", "endpoint")
            .expect("build_command");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let child = pair.slave.spawn_command(cmd).expect("spawn_command");
        drop(pair.slave);
        let shell_pid = child.process_id().expect("process_id");

        let job = spawn_job_for(&*child).expect("spawn_job_for");
        // Shared, not a plain `Box`, because the draining thread below must be able to
        // answer conhost's initial cursor-position query (`ESC[6n`) on this same input
        // pipe — without *some* terminal emulation, cmd/pwsh's own console
        // initialization stalls waiting for that reply and never gets to running the
        // `/K`/`-Command` payload at all (nothing ConPTY/CTRL_C_EVENT-specific; any
        // ConPTY host has to do this, and the frontend's real xterm.js does).
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take_writer")));
        let mut reader = pair.master.try_clone_reader().expect("try_clone_reader");

        // Drain output on a background thread so ping/the shell never block on a full
        // pipe while we poll the job's pid list below, answering the cursor-position
        // query along the way.
        let draining = Arc::new(AtomicBool::new(true));
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        {
            let draining = draining.clone();
            let captured = captured.clone();
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while draining.load(Ordering::Relaxed) {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                                let _ = writer.lock().unwrap().write_all(b"\x1b[1;1R");
                            }
                            captured.lock().unwrap().extend_from_slice(&buf[..n]);
                        }
                    }
                }
            });
        }

        // Whole-system descendant walk rather than the job's own pid list (see this
        // fn's doc comment): a packaged shell can keep real children outside the job
        // (BUG-1), and this test's job is to isolate BUG-2 (Ctrl+C) from that.
        let has_ping = || {
            walk_descendants(&system_process_snapshot(), shell_pid)
                .into_iter()
                .any(|e| e.name.to_ascii_lowercase().contains("ping"))
        };

        let started = Instant::now();
        while !has_ping() {
            if started.elapsed() >= Duration::from_secs(15) {
                let out = String::from_utf8_lossy(&captured.lock().unwrap()).into_owned();
                panic!("ping.exe never showed up as a descendant of pid {shell_pid} within 15s; captured output so far: {out:?}");
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let send_ctrl_c = || {
            let mut writer = writer.lock().unwrap();
            writer.write_all(b"\x03").expect("write ctrl-c byte");
            let _ = writer.flush();
        };
        send_ctrl_c();

        // Polled at a deliberately modest cadence: each check is a whole-system
        // Toolhelp32 snapshot + a `GetProcessTimes` per process, and this loop must not
        // itself become a source of the very CPU contention that makes a real-time
        // check like this flaky under parallel test load. Re-sends the byte every ~2s
        // it's still not stopped: a real user holding down Ctrl+C would do the same,
        // and this absorbs the odd single dropped/early byte (e.g. a byte written while
        // a shell's own console input processing is still spinning up) without
        // weakening what's actually being asserted — the same single byte reliably
        // stops `ping` once, well within `timeout`, is still exactly what's checked.
        let stopped_at = Instant::now();
        let mut stopped = false;
        let mut last_resend = stopped_at;
        while stopped_at.elapsed() < timeout {
            if !has_ping() {
                stopped = true;
                break;
            }
            if last_resend.elapsed() >= Duration::from_secs(2) {
                send_ctrl_c();
                last_resend = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(250));
        }

        if !stopped {
            let out = String::from_utf8_lossy(&captured.lock().unwrap()).into_owned();
            let survivors: Vec<String> = walk_descendants(&system_process_snapshot(), shell_pid)
                .into_iter()
                .map(|e| format!("{}({})", e.name, e.pid))
                .collect();
            eprintln!(
                "ctrl_c_stops_ping: ping still present after {timeout:?}; descendants of \
                 shell pid {shell_pid}: {survivors:?}; captured output: {out:?}"
            );
        }

        draining.store(false, Ordering::Relaxed);
        drop(job); // Kills whatever's left (shell + ping if Ctrl+C didn't work).
        drop(child);
        stopped
    }

    fn cmd_profile() -> ShellProfile {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        ShellProfile {
            id: ShellKind::Cmd,
            name: "Command Prompt".to_string(),
            program: format!(r"{system_root}\System32\cmd.exe"),
            args: Vec::new(),
        }
    }

    #[test]
    fn ctrl_c_interrupts_ping_in_cmd_with_the_fix_applied() {
        clear_inherited_ctrl_c_ignore();
        assert!(
            ctrl_c_stops_ping(&cmd_profile(), Duration::from_secs(20)),
            "Ctrl+C should have stopped ping.exe under cmd.exe /K within 20s"
        );
    }

    #[test]
    fn ctrl_c_interrupts_ping_in_pwsh_with_the_fix_applied() {
        let Some(profile) = cached_profiles().iter().find(|p| p.id == ShellKind::Pwsh).cloned() else {
            eprintln!("skipping ctrl_c_interrupts_ping_in_pwsh_with_the_fix_applied: no pwsh profile detected");
            return;
        };
        clear_inherited_ctrl_c_ignore();
        assert!(
            ctrl_c_stops_ping(&profile, Duration::from_secs(20)),
            "Ctrl+C should have stopped ping.exe under pwsh within 20s"
        );
    }

    /// Without the fix, this reproduces BUG-2 in this environment: the ambient shell
    /// this test binary itself was launched from very plausibly already set the
    /// "ignore Ctrl+C" flag for its own child-process management, and that flag is
    /// inherited straight through into every pane's shell (and its children) unless
    /// something clears it first. This test intentionally does *not* call
    /// `clear_inherited_ctrl_c_ignore` and simply records whether Ctrl+C worked instead
    /// of asserting on it — flipping this file's fix on/off is what proves causation
    /// (see the bug report for the before/after `cargo test` output), and this test
    /// must not leave a false failure in a tree where some earlier test in the same
    /// process already called the (process-wide, sticky) fix.
    #[test]
    fn ctrl_c_reproduction_probe_without_calling_the_fix() {
        let stopped = ctrl_c_stops_ping(&cmd_profile(), Duration::from_secs(20));
        eprintln!(
            "ctrl_c_reproduction_probe_without_calling_the_fix: ping stopped = {stopped} \
             (false here — in a process that hasn't cleared the inherited ignore flag \
             some other way — is exactly BUG-2)"
        );
    }
}

/// BUG-1 (Medium/High): `pty_busy`/`pty_processes` never saw the children of the
/// Store/MSIX pwsh profile (`...\WindowsApps\Microsoft.PowerShell_...\pwsh.exe`, run via
/// the `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` alias) — real, alive, but outside
/// our Job Object. This test drives the exact real alias Kotilo's own `detect_pwsh`
/// would pick on a machine that has the Store package installed, so it self-skips
/// (rather than failing) on a machine without it.
#[cfg(all(test, windows))]
mod bug1_msix_pwsh_tests {
    use super::*;

    fn store_pwsh_profile() -> Option<ShellProfile> {
        let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
        let program = Path::new(&local_app_data)
            .join("Microsoft")
            .join("WindowsApps")
            .join("pwsh.exe");
        if !program.exists() {
            return None;
        }
        Some(ShellProfile {
            id: ShellKind::Pwsh,
            name: "PowerShell 7 (Store)".to_string(),
            program: program.to_string_lossy().into_owned(),
            args: vec!["-NoLogo".to_string()],
        })
    }

    #[test]
    fn pty_busy_and_teardown_see_msix_pwsh_descendants_outside_the_job() {
        let Some(profile) = store_pwsh_profile() else {
            eprintln!(
                "skipping pty_busy_and_teardown_see_msix_pwsh_descendants_outside_the_job: \
                 no Store/MSIX pwsh alias on this machine"
            );
            return;
        };
        let _guard = HEAVY_INTEGRATION_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let cmd = build_command(&profile, dir.path(), Some("ping -t 127.0.0.1"), "pane", "ws", "endpoint")
            .expect("build_command");

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let child = pair.slave.spawn_command(cmd).expect("spawn_command");
        drop(pair.slave);
        let shell_pid = child.process_id().expect("process_id");
        let job = spawn_job_for(&*child);

        // Shared, not a plain `Box`, so the draining thread below can answer conhost's
        // initial cursor-position query (`ESC[6n`) — without *some* terminal emulation,
        // pwsh's own console initialization stalls waiting for that reply and never
        // gets to running the `-Command` payload at all (see `ctrl_c_tests` for the
        // same gotcha, hit and diagnosed there first).
        let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("take_writer")));
        let mut reader = pair.master.try_clone_reader().expect("try_clone_reader");
        {
            let writer = writer.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if buf[..n].windows(4).any(|w| w == b"\x1b[6n") {
                                let _ = writer.lock().unwrap().write_all(b"\x1b[1;1R");
                            }
                        }
                    }
                }
            });
        }

        let registry = Arc::new(PtyRegistry::default());
        registry.panes().insert(
            "pane".to_string(),
            PaneHandle {
                spawned_at: Instant::now(),
                workspace_id: "w-test".to_string(),
                activity: Arc::new(PaneActivity::default()),
                job,
                master: pair.master,
                writer,
                shell_pid,
                shell_image_name: "pwsh.exe".to_string(),
                screen: Arc::new(Mutex::new(PaneScreen::new(24, 80))),
                seen_descendants: Vec::new(),
            },
        );

        // Poll until the real decision path (job pid list ∪ whole-system descendant
        // walk) reports busy with a "ping" process.
        let started = Instant::now();
        let last_busy;
        loop {
            let procs = pane_process_union(&registry, "pane", shell_pid);
            let decision = decide_busy(&procs, shell_pid, "pwsh.exe");
            if decision.busy && decision.processes.iter().any(|p| p.to_ascii_lowercase().contains("ping")) {
                last_busy = decision;
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "pty_busy never saw ping.exe under the Store pwsh profile; last decision: {decision:?}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = &last_busy;

        // Confirm the job's OWN pid list alone (the pre-fix behavior) does NOT see
        // ping on this machine — proves the descendant walk is doing real work here,
        // i.e. this test actually reproduces BUG-1's root cause rather than passing
        // vacuously.
        let job_only_names: Vec<String> = job_pids(&registry, "pane")
            .into_iter()
            .filter_map(process_name)
            .collect();
        assert!(
            !job_only_names.iter().any(|n| n.to_ascii_lowercase().contains("ping")),
            "expected ping.exe to be OUTSIDE the job on this machine (that's BUG-1's root \
             cause) — job pids' names: {job_only_names:?}"
        );

        // Teardown: exercise the same path `pty_kill` uses, and confirm no ping.exe
        // descendant of the shell survives it.
        registry.take_pane("pane");

        let started = Instant::now();
        loop {
            let snapshot = system_process_snapshot();
            let survivors: Vec<String> = walk_descendants(&snapshot, shell_pid)
                .into_iter()
                .filter(|e| e.name.to_ascii_lowercase().contains("ping"))
                .map(|e| e.name)
                .collect();
            if survivors.is_empty() {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "a ping.exe descendant of the Store pwsh shell survived teardown: {survivors:?}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Faz 8 (graceful Claude close): the pure sequencing core, decision wiring, and the
/// exit-wait hard cap -- all unit-tested with an injectable writer/clock/exit-probe, no
/// real process needed. Live-process behavior (does the ctrl-c sequence actually make a
/// real `claude` exit) is the empirical finding this feature is built on, not something
/// re-verified here; these tests only guard the mechanics: what gets written, in what
/// order, how the wait is capped, and which panes take this path at all.
#[cfg(test)]
mod graceful_close_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ---- graceful_close_sequence: pure sequencing/timing -----------------------------

    fn ctrl_c_steps(gap_ms: u64, wait_ms: u64) -> Vec<CloseStep> {
        vec![CloseStep {
            bytes: vec![0x03],
            repeat: 3,
            gap: Duration::from_millis(gap_ms),
            wait: Duration::from_millis(wait_ms),
        }]
    }

    #[test]
    fn writes_ctrl_c_three_times_with_the_gap_between_each() {
        let writes: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sleeps: Arc<Mutex<Vec<Duration>>> = Arc::new(Mutex::new(Vec::new()));
        let w = writes.clone();
        let s = sleeps.clone();

        let exited = graceful_close_sequence(
            move |bytes| w.lock().unwrap().push(bytes.to_vec()),
            move |d| s.lock().unwrap().push(d),
            || true, // exits immediately once probed
            &crate::adapters::claude_default_close(),
            Duration::from_millis(50),
        );

        assert!(exited);
        assert_eq!(*writes.lock().unwrap(), vec![vec![0x03], vec![0x03], vec![0x03]]);
        // Two 400 ms gaps between the three writes; `has_exited` is true on the very
        // first poll, so the exit-wait loop itself contributes no further sleep.
        assert_eq!(*sleeps.lock().unwrap(), vec![Duration::from_millis(400), Duration::from_millis(400)]);
    }

    #[test]
    fn polls_has_exited_at_the_given_interval_until_it_becomes_true() {
        let poll_count = Arc::new(AtomicUsize::new(0));
        let pc = poll_count.clone();

        let exited = graceful_close_sequence(
            |_| {},
            |_| {},
            move || pc.fetch_add(1, Ordering::SeqCst) >= 2, // false, false, true
            &ctrl_c_steps(400, 3000),
            Duration::from_millis(50),
        );

        assert!(exited);
        assert_eq!(poll_count.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn gives_up_once_the_exit_wait_cap_elapses_without_ever_seeing_exit() {
        let total_slept = Arc::new(Mutex::new(Duration::ZERO));
        let ts = total_slept.clone();

        let exited = graceful_close_sequence(
            |_| {},
            move |d| *ts.lock().unwrap() += d,
            || false, // never exits
            &ctrl_c_steps(400, 3000),
            Duration::from_millis(50),
        );

        assert!(!exited);
        // Two 400 ms ctrl-c gaps + exactly the 3000 ms exit-wait cap, no more (the poll
        // loop's last step is clamped to what's left, never overshooting the cap).
        assert_eq!(*total_slept.lock().unwrap(), Duration::from_millis(800 + 3000));
    }

    #[test]
    fn exit_wait_never_sleeps_past_its_cap_even_with_a_poll_interval_that_does_not_divide_it_evenly() {
        let total_slept = Arc::new(Mutex::new(Duration::ZERO));
        let ts = total_slept.clone();

        let exited = graceful_close_sequence(
            |_| {},
            move |d| *ts.lock().unwrap() += d,
            || false,
            &ctrl_c_steps(0, 1000),
            Duration::from_millis(300), // 300 does not evenly divide 1000
        );

        assert!(!exited);
        assert_eq!(*total_slept.lock().unwrap(), Duration::from_millis(1000));
    }

    #[test]
    fn runs_each_step_in_turn_and_stops_once_the_agent_exits() {
        let writes: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let w = writes.clone();
        let w2 = writes.clone();
        let steps = vec![
            CloseStep {
                bytes: b"\x1b".to_vec(),
                repeat: 1,
                gap: Duration::ZERO,
                wait: Duration::from_millis(200),
            },
            CloseStep {
                bytes: b"/exit\r".to_vec(),
                repeat: 1,
                gap: Duration::ZERO,
                wait: Duration::from_millis(200),
            },
            CloseStep {
                bytes: vec![0x04],
                repeat: 2,
                gap: Duration::from_millis(100),
                wait: Duration::from_millis(200),
            },
        ];
        // Exits once "/exit\r" has been written.
        let exited = graceful_close_sequence(
            move |bytes| w.lock().unwrap().push(bytes.to_vec()),
            |_| {},
            move || w2.lock().unwrap().iter().any(|b| b == b"/exit\r"),
            &steps,
            Duration::from_millis(50),
        );
        assert!(exited);
        assert_eq!(*writes.lock().unwrap(), vec![b"\x1b".to_vec(), b"/exit\r".to_vec()]);
    }

    // ---- PaneScreen: the screen-rule parser ------------------------------------------

    #[test]
    fn pane_screen_parses_only_while_enabled_and_follows_resize() {
        let mut screen = PaneScreen::new(4, 20);
        screen.process(b"ignored\r\n");
        assert_eq!(screen.rows(), None);
        screen.set_enabled(true);
        screen.process(b"\x1b[1mhello\x1b[0m\r\nworld");
        let rows = screen.rows().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], "hello");
        assert_eq!(rows[1], "world");
        screen.resize(6, 30);
        assert_eq!(screen.rows().unwrap().len(), 6);
        screen.set_enabled(false);
        assert_eq!(screen.rows(), None);
    }

    // ---- pty_kill decision wiring: Claude vs. everything else ------------------------

    fn insert_probe_pane_with_pid(registry: &PtyRegistry, pane_id: &str, shell_pid: u32) -> Arc<Mutex<Vec<u8>>> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        drop(pair.slave);

        let written: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

        struct RecordingWriter(Arc<Mutex<Vec<u8>>>);
        impl Write for RecordingWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        registry.panes().insert(
            pane_id.to_string(),
            PaneHandle {
                spawned_at: Instant::now(),
                workspace_id: "w-test".to_string(),
                activity: Arc::new(PaneActivity::default()),
                #[cfg(windows)]
                job: None,
                master: pair.master,
                writer: Arc::new(Mutex::new(Box::new(RecordingWriter(written.clone())))),
                shell_pid,
                shell_image_name: "fake.exe".to_string(),
                screen: Arc::new(Mutex::new(PaneScreen::new(24, 80))),
                seen_descendants: Vec::new(),
            },
        );
        written
    }

    /// A pid essentially guaranteed not to belong to a live process on the test machine,
    /// so `pane_process_alive` reads it as already exited (`OpenProcess` fails) --
    /// `graceful_close_sequence`'s exit-wait loop then returns on its very first poll.
    const DEAD_PID: u32 = 0xFFFF_FFF0;

    #[test]
    fn take_pane_no_reap_removes_from_the_map_without_writing_anything() {
        let registry = PtyRegistry::default();
        insert_probe_pane_with_pid(&registry, "pane-a", DEAD_PID);

        let handle = registry.take_pane_no_reap("pane-a");
        assert!(handle.is_some());
        assert!(registry.panes().get("pane-a").is_none());
    }

    #[test]
    fn spawn_graceful_close_thread_writes_ctrl_c_sequence_and_signals_done() {
        let registry = PtyRegistry::default();
        let written = insert_probe_pane_with_pid(&registry, "pane-a", DEAD_PID);

        let pane = registry.take_pane_no_reap("pane-a").expect("pane present");
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = spawn_graceful_close_thread("pane-a".to_string(), pane, crate::adapters::claude_default_close(), Some(tx));

        // The dead pid means `pane_process_alive` is false immediately, so the exit-wait
        // loop resolves on its first poll -- this must complete quickly, well inside a
        // test timeout, and then signal `done` by dropping the sender.
        rx.recv_timeout(Duration::from_secs(5))
            .expect_err("sender is dropped, never sent -- recv must see Disconnected");
        handle.join().expect("graceful close thread panicked");

        assert_eq!(*written.lock().unwrap(), vec![0x03, 0x03, 0x03]);
    }

    #[test]
    fn clear_with_sends_claude_panes_through_graceful_close_and_everything_else_immediately() {
        let registry = PtyRegistry::default();
        let claude_written = insert_probe_pane_with_pid(&registry, "claude-pane", DEAD_PID);
        insert_probe_pane_with_pid(&registry, "shell-pane", DEAD_PID);

        let waiters = registry.clear_with(|pane_id| (pane_id == "claude-pane").then(crate::adapters::claude_default_close));

        // Exactly one graceful-close receiver -- only the Claude-classified pane got one.
        assert_eq!(waiters.len(), 1);
        for rx in waiters {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }

        // Give the graceful thread a moment to finish writing before asserting on it (the
        // receiver above already only unblocks once the thread is mid-teardown, but the
        // write itself happens before that).
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if !claude_written.lock().unwrap().is_empty() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(*claude_written.lock().unwrap(), vec![0x03, 0x03, 0x03]);

        // Both panes are gone from the registry either way.
        assert!(registry.panes().is_empty());
    }

    #[test]
    fn clear_with_never_blocks_the_caller_on_a_claude_panes_graceful_close() {
        let registry = Arc::new(PtyRegistry::default());
        insert_probe_pane_with_pid(&registry, "claude-pane", DEAD_PID);

        let started = Instant::now();
        let waiters = registry.clear_with(|_| Some(crate::adapters::claude_default_close()));
        // `clear_with` itself must return essentially immediately -- the graceful close
        // (its up-to-~3.8s ctrl-c + exit-wait sequence) runs on a detached background
        // thread, not before `clear_with` returns.
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "clear_with blocked the caller for {:?}",
            started.elapsed()
        );
        // Drain so the test process doesn't outlive the background thread's own work.
        for rx in waiters {
            let _ = rx.recv_timeout(Duration::from_secs(5));
        }
    }

    #[test]
    fn track_graceful_close_prunes_finished_receivers_and_take_drains_the_rest() {
        let registry = PtyRegistry::default();

        // A receiver whose sender has already been dropped (that close already finished)
        // -- must be pruned on the next `track_graceful_close` call, not accumulate
        // forever across a long session's worth of closed Claude tabs.
        let (tx_done, rx_done) = std::sync::mpsc::channel::<()>();
        drop(tx_done);
        registry.track_graceful_close(rx_done);

        // A receiver still in flight -- must survive pruning and come back out of
        // `take_pending_graceful_closes`.
        let (tx_pending, rx_pending) = std::sync::mpsc::channel::<()>();
        registry.track_graceful_close(rx_pending);

        let drained = registry.take_pending_graceful_closes();
        assert_eq!(drained.len(), 1, "the already-finished receiver must have been pruned");
        // Draining again returns nothing -- confirms the vec was actually taken, not
        // merely inspected.
        assert!(registry.take_pending_graceful_closes().is_empty());

        drop(tx_pending);
    }

    #[test]
    fn plain_clear_treats_every_pane_as_non_claude() {
        let registry = PtyRegistry::default();
        insert_probe_pane_with_pid(&registry, "pane-a", DEAD_PID);
        registry.clear();
        assert!(registry.panes().is_empty());
    }
}

#[cfg(test)]
mod leftover_tests {
    use super::*;

    fn procs(list: &[(u32, &str)]) -> Vec<(u32, Option<String>)> {
        list.iter().map(|(pid, name)| (*pid, Some(name.to_string()))).collect()
    }

    fn entry(pid: u32, name: &str, creation_time: u64) -> ProcSnapshotEntry {
        ProcSnapshotEntry {
            pid,
            ppid: 1,
            name: name.to_string(),
            creation_time,
        }
    }

    #[test]
    fn leftover_names_skip_the_shell_set_and_dedupe() {
        let list = procs(&[
            (10, "pwsh.exe"),
            (11, "conhost.exe"),
            (12, "python.exe"),
            (13, "PYTHON.EXE"),
            (14, "node.exe"),
            (15, "pwsh.exe"),
            (16, "OpenConsole.exe"),
        ]);
        assert_eq!(leftover_names(&list, 10, "pwsh.exe"), ["python.exe", "node.exe"]);
        assert!(leftover_names(&procs(&[(10, "pwsh.exe"), (11, "conhost.exe")]), 10, "pwsh.exe").is_empty());
        assert!(leftover_names(&[(20, None)], 10, "pwsh.exe").is_empty());
    }

    #[test]
    fn leftover_names_are_capped() {
        let names: Vec<String> = (0..20).map(|i| format!("tool{i}.exe")).collect();
        let list: Vec<(u32, Option<String>)> = names.iter().enumerate().map(|(i, n)| (100 + i as u32, Some(n.clone()))).collect();
        assert_eq!(leftover_names(&list, 1, "cmd.exe").len(), MAX_LEFTOVER_NAMES);
    }

    #[test]
    fn kill_targets_never_include_the_shell_or_console_host() {
        let list = procs(&[(10, "pwsh.exe"), (11, "conhost.exe"), (12, "python.exe"), (12, "python.exe"), (13, "node.exe")]);
        let mut with_unknown = list.clone();
        with_unknown.push((14, None));
        assert_eq!(leftover_kill_targets(&with_unknown, 10, "pwsh.exe"), [12, 13]);
    }

    #[test]
    fn merge_seen_prunes_dead_pids_adds_new_ones_and_skips_unknown_times() {
        let mut seen = vec![SeenProc {
            pid: 5,
            creation_time: 50,
            name: "old.exe".into(),
        }];
        let live: HashSet<u32> = [7, 8, 9].into_iter().collect();
        merge_seen_descendants(&mut seen, &[entry(7, "python.exe", 70), entry(8, "job-only.exe", 0)], &live);
        assert_eq!(seen.iter().map(|p| p.pid).collect::<Vec<_>>(), [7]);
        // Seen again: not duplicated. Recycled pid (new creation time): a separate entry.
        merge_seen_descendants(&mut seen, &[entry(7, "python.exe", 70), entry(9, "node.exe", 90)], &live);
        merge_seen_descendants(&mut seen, &[entry(7, "other.exe", 71)], &live);
        assert_eq!(
            seen.iter().map(|p| (p.pid, p.creation_time)).collect::<Vec<_>>(),
            [(7, 70), (9, 90), (7, 71)]
        );
    }

    #[test]
    fn merge_seen_keeps_the_newest_within_the_cap() {
        let mut seen = Vec::new();
        let observed: Vec<ProcSnapshotEntry> = (1..=600).map(|pid| entry(pid, "x.exe", 1000 + pid as u64)).collect();
        let live: HashSet<u32> = (1..=600).collect();
        merge_seen_descendants(&mut seen, &observed, &live);
        assert_eq!(seen.len(), SEEN_DESCENDANTS_CAP);
        assert_eq!(seen[0].pid, 600 - SEEN_DESCENDANTS_CAP as u32 + 1);
        assert_eq!(seen.last().map(|p| p.pid), Some(600));
    }

    #[test]
    fn surviving_seen_needs_a_matching_creation_time_and_skips_excluded_pids() {
        let seen = vec![
            SeenProc { pid: 1, creation_time: 10, name: "a.exe".into() },
            SeenProc { pid: 2, creation_time: 20, name: "b.exe".into() },
            SeenProc { pid: 3, creation_time: 30, name: "c.exe".into() },
            SeenProc { pid: 4, creation_time: 40, name: "d.exe".into() },
        ];
        let exclude: HashSet<u32> = [3].into_iter().collect();
        // pid 1 alive and the same; pid 2 recycled; pid 4 gone.
        let now = |pid: u32| match pid {
            1 => Some(10),
            2 => Some(25),
            3 => Some(30),
            _ => None,
        };
        assert_eq!(surviving_seen(&seen, &exclude, now), [(1, Some("a.exe".to_string()))]);
    }
}
