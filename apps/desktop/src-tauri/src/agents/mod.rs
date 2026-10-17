//! Faz 5 §1.4: the agent state machine — single source of truth for "what is this pane's
//! agent doing right now". Pure decision functions ([`apply_hook`], [`apply_cancel_fallback`],
//! [`heuristic_output_state`]) are unit-tested in isolation; [`AgentTracker`]
//! is the thin stateful shell that threads them together against real hooks/ticks and
//! decides when the frontend needs a fresh `agents:changed` snapshot.

pub mod heuristic;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::adapters::screen::{self, ScreenEvent, ScreenState, ScreenTrack};
use crate::adapters::{CloseStep, Definitions};
use crate::pty::PtyRegistry;

/// Spec §4 item 7b: how long a pane stays in the "just ended" window after `SessionEnd`
/// before heuristic registration is allowed to create a new record for it again.
const HOOK_ENDED_WINDOW_MS: u64 = 5000;
/// Spec §1.4: cadence of the (comparatively expensive) whole-system process snapshot +
/// heuristic classification/removal pass.
const HEURISTIC_TICK_INTERVAL_MS: u64 = 1500;
/// Faz 6 perf (user decision 2026-09-28): with no agent recognized in any pane the
/// snapshot only looks for a *new* hookless agent, so it runs every 4 s instead —
/// idle CPU with open terminals ~1.5% -> ~0.6% of a core, at the cost of up to 4 s
/// before a freshly started hookless agent appears. Hook-driven Claude is unaffected.
const HEURISTIC_IDLE_TICK_INTERVAL_MS: u64 = 4000;

/// Heuristic snapshot cadence: the slow idle interval only while no agent record exists.
fn heuristic_interval_ms(no_records: bool) -> u64 {
    if no_records {
        HEURISTIC_IDLE_TICK_INTERVAL_MS
    } else {
        HEURISTIC_TICK_INTERVAL_MS
    }
}
/// Spec §4 item 6: "≥ 2 sn sessiz -> idle" (blocked/working cancel fallback).
const CANCEL_FALLBACK_SILENCE_MS: u64 = 2000;
/// Spec §4 item 6: "≥ 1.5 sn kesintisiz çıktı -> working".
const CANCEL_FALLBACK_CONTINUOUS_MS: u64 = 1500;
/// Spec §1.4: hookless heuristic fallback "son 1 sn'de byte geldi -> working".
const HEURISTIC_WORKING_WINDOW_MS: u64 = 1000;
/// Spec §1.4: hookless heuristic fallback "3 sn sessizlik -> idle".
const HEURISTIC_IDLE_SILENCE_MS: u64 = 3000;

/// Faz 7 spec §1.1: log lines carry only the first 8 characters of a pane/agent id, never
/// the whole thing. `pub(crate)` so every module that logs a pane/agent id (`pty`, ...) truncates through this one char-boundary-safe helper instead of a raw byte
/// slice (`&id[..id.len().min(8)]`, which panics if byte 8 lands mid-UTF-8-char — pane ids
/// are UUIDs today so it's ASCII in practice, but agent/session ids elsewhere are not
/// guaranteed to be).
pub(crate) fn short_pane_id(id: &str) -> &str {
    let end = id.char_indices().nth(8).map(|(i, _)| i).unwrap_or(id.len());
    &id[..end]
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------
// Core types (spec §1.4/§1.6)
// ---------------------------------------------------------------------------------

/// Coarse agent identity kept for the current UI; M3 wave 3 moves the UI to
/// [`Agent::adapter_id`]. `Custom` = a user-defined adapter, `Other` = an unknown id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
    Gemini,
    Opencode,
    Copilot,
    Qwen,
    Droid,
    Cursor,
    Custom,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Blocked,
    Working,
    Done,
    Idle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Hook,
    Heuristic,
}

/// The wire type (spec §1.6) *is* the internal record and serializes exactly as the
/// `agents:changed`/`agents_list` contract describes. M2: `sessionId` (the agent's own
/// session id from its last hook, `null` for heuristic records) lets the UI find the pane's
/// hub session when the hook could not carry the pane id (Codex, D-013). M3: `adapterId`
/// is the agent's adapter id (`claude-code`, `codex`, a user adapter's id, ...) from its
/// hooks or its detection definition; `null` only for a hook without an agent id.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub kind: AgentKind,
    pub adapter_id: Option<String>,
    pub state: AgentState,
    pub since_ms: u64,
    pub source: Source,
    pub session_id: Option<String>,
    /// 0.3.2: short labels of the background work (Claude Code `background_tasks`) a
    /// finished turn is still waiting for; non-empty keeps the record Working. Metadata
    /// only, never persisted.
    pub background_tasks: Vec<String>,
    /// The record is `Blocked` on a question (Claude Code's `AskUserQuestion`/`ExitPlanMode`
    /// shown through its permission dialog): answered in the terminal, never with the
    /// permission card's allow/deny keys. Mirrors the hub's WaitingInput for these tools.
    pub question_pending: bool,
}

// ---------------------------------------------------------------------------------
// Hook table (spec §1.4 + §4 items 1, 4, 6, 7, 8) — the primary pure core.
// ---------------------------------------------------------------------------------

pub enum HookOutcome {
    /// `SessionEnd`, or an unknown pane whose hook we otherwise ignore.
    Remove,
    Upsert(Agent),
}

/// Notification `notification_type`s that mean "blocked" (spec §4 item 8 — adds
/// `elicitation_url_dialog` to the original two; `idle_prompt` and anything else is
/// ignored).
const BLOCKED_NOTIFICATION_TYPES: [&str; 3] = [
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
];

/// Tools whose "permission" dialog is really a multiple-choice question (Claude Code's
/// `AskUserQuestion` and plan approval `ExitPlanMode`); same list as the hub's.
fn is_question_tool(tool: Option<&str>) -> bool {
    matches!(tool, Some("AskUserQuestion" | "ExitPlanMode"))
}

/// 0.3.2: at most this many background-task labels per record …
const MAX_BACKGROUND_TASKS: usize = 10;
/// … each at most this many characters.
const MAX_BACKGROUND_LABEL_CHARS: usize = 60;
/// Label of a background task without any of the label fields.
const BACKGROUND_TASK_FALLBACK_LABEL: &str = "background task";

/// 0.3.2: Claude Code's `Stop`/`SubagentStop` `background_tasks` (non-empty = the turn
/// paused waiting for background work) as short labels — per task the first present of
/// `description`, `agent_type`, `name`, `type`. `None` when the field is absent or not an
/// array; an empty array gives `Some(vec![])`.
pub fn background_task_labels(payload: &serde_json::Value) -> Option<Vec<String>> {
    let tasks = payload.get("background_tasks")?.as_array()?;
    Some(
        tasks
            .iter()
            .take(MAX_BACKGROUND_TASKS)
            .map(|task| {
                ["description", "agent_type", "name", "type"]
                    .iter()
                    .find_map(|key| task.get(*key).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty()))
                    .map(|label| label.chars().take(MAX_BACKGROUND_LABEL_CHARS).collect())
                    .unwrap_or_else(|| BACKGROUND_TASK_FALLBACK_LABEL.to_string())
            })
            .collect(),
    )
}

/// The hook-driven half of the state machine (spec §1.4 table, with every Faz 5 §4
/// Revizyon override applied): given the previous record (if any) and one hook message,
/// decides the new record or that it should be removed entirely.
///
/// `seen` is whether the frontend currently reports this pane as visible *and* the
/// window focused (spec §1.4 "görüldü" rule) — only consulted for `Stop`.
///
/// Claude Code hook; see [`apply_agent_hook`] for other agents.
pub fn apply_hook(
    prev: Option<&Agent>,
    pane_id: &str,
    workspace_id: &str,
    event: &str,
    payload: &serde_json::Value,
    ts_ms: u64,
    seen: bool,
) -> HookOutcome {
    apply_agent_hook(prev, AgentKind::Claude, pane_id, workspace_id, event, payload, ts_ms, seen)
}

/// Maps an adapter id (`HookMessage.agent`, a detection match) to the pane's agent kind.
pub fn kind_for_agent(agent: &str) -> AgentKind {
    match agent {
        "claude-code" => AgentKind::Claude,
        "codex" => AgentKind::Codex,
        "gemini" => AgentKind::Gemini,
        "opencode" => AgentKind::Opencode,
        "copilot" => AgentKind::Copilot,
        "qwen" => AgentKind::Qwen,
        "droid" => AgentKind::Droid,
        "cursor" => AgentKind::Cursor,
        _ => AgentKind::Other,
    }
}

/// [`kind_for_agent`], with an id that only a user definition knows mapped to `Custom`.
pub fn kind_for(adapter_id: &str, defs: &Definitions) -> AgentKind {
    match kind_for_agent(adapter_id) {
        AgentKind::Other
            if defs
                .get(adapter_id)
                .is_some_and(|d| d.source == crate::adapters::DefinitionSource::User) =>
        {
            AgentKind::Custom
        }
        kind => kind,
    }
}

/// M1: [`apply_hook`] for any hooked agent. Codex uses the same event names as Claude
/// Code for everything this table reads, plus `Interrupt` (turn cancelled -> idle). M3:
/// the Agent Integration Protocol v1 event names (`session-start`, `working`,
/// `waiting-permission`, `waiting-input`, `done`, `session-end`, …) map the same way.
#[allow(clippy::too_many_arguments)]
pub fn apply_agent_hook(
    prev: Option<&Agent>,
    kind: AgentKind,
    pane_id: &str,
    workspace_id: &str,
    event: &str,
    payload: &serde_json::Value,
    ts_ms: u64,
    seen: bool,
) -> HookOutcome {
    if event == "SessionEnd" || event == "session-end" {
        return HookOutcome::Remove;
    }

    // Spec §4 item 7a: *any* hook forces source=Hook and the hook's own agent kind, even
    // over a prior heuristic record for the same pane.
    let mut next = match prev {
        Some(agent) => Agent {
            source: Source::Hook,
            kind,
            ..agent.clone()
        },
        None => Agent {
            id: pane_id.to_string(),
            pane_id: pane_id.to_string(),
            workspace_id: workspace_id.to_string(),
            kind,
            adapter_id: None,
            state: AgentState::Idle,
            since_ms: ts_ms,
            source: Source::Hook,
            session_id: None,
            background_tasks: Vec::new(),
            question_pending: false,
        },
    };

    let payload_session_id = payload
        .get("session_id")
        .or_else(|| payload.get("sessionId"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    let tool_name = payload.get("tool_name").and_then(|v| v.as_str());
    let mut new_state = next.state;
    let finished = if seen { AgentState::Idle } else { AgentState::Done };
    // 0.3.2: Working only because a finished turn waits for background work.
    let waiting_on_background = next.state == AgentState::Working && !next.background_tasks.is_empty();

    match event {
        "SessionStart" => {
            let source_field = payload.get("source").and_then(|v| v.as_str()).unwrap_or("");
            if source_field != "compact" {
                // Startup/clear/resume/fork (spec §4 item 7c) — and, deliberately,
                // anything unrecognized too: only `compact` is a no-op.
                new_state = AgentState::Idle;
            }
        }
        "UserPromptSubmit" => {
            new_state = AgentState::Working;
            next.background_tasks.clear();
        }
        "PreToolUse" => {
            new_state = AgentState::Working;
            // The question dialog follows; its permission_prompt Notification has no tool name.
            next.question_pending = is_question_tool(tool_name);
        }
        "PostToolUse" => {
            new_state = AgentState::Working;
        }
        "PermissionRequest" => {
            new_state = AgentState::Blocked;
            if tool_name.is_some() {
                next.question_pending = is_question_tool(tool_name);
            }
        }
        "Notification" => {
            let notification_type = payload
                .get("notification_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if BLOCKED_NOTIFICATION_TYPES.contains(&notification_type) {
                new_state = AgentState::Blocked;
            } else if notification_type == "idle_prompt" && waiting_on_background {
                // 0.3.2: idle at the prompt = no background work left.
                new_state = finished;
            }
            // Anything else (including `idle_prompt` otherwise) is ignored.
        }
        "Stop" => {
            // 0.3.2: a turn paused for background work stays Working until it finishes.
            match background_task_labels(payload).filter(|labels| !labels.is_empty()) {
                Some(labels) => {
                    new_state = AgentState::Working;
                    next.background_tasks = labels;
                }
                None => new_state = finished,
            }
        }
        "SubagentStop" if waiting_on_background => {
            // 0.3.2: the last background task finished → the paused turn is done; with
            // tasks left, only the labels follow.
            match background_task_labels(payload) {
                Some(labels) if labels.is_empty() => new_state = finished,
                Some(labels) => next.background_tasks = labels,
                None => {}
            }
        }
        "done" => {
            new_state = finished;
        }
        "Interrupt" | "session-start" | "waiting-input" | "error" => {
            new_state = AgentState::Idle;
        }
        "working" => {
            new_state = AgentState::Working;
        }
        "waiting-permission" => {
            new_state = AgentState::Blocked;
        }
        _ => {
            // Unknown/uninteresting event (e.g. `SubagentStop` outside background work,
            // spec §4 item 8: "not recorded" — treated the same as any sub-agent tool event, i.e. leaves the
            // pane's own state untouched) — no state change, but the record still gets
            // created/kept and re-stamped as Hook-sourced above.
        }
    }

    if let Some(sid) = payload_session_id {
        next.session_id = Some(sid);
    }

    if matches!(new_state, AgentState::Idle | AgentState::Done) {
        next.background_tasks.clear();
    }
    // Only the question's own dialog events keep the flag; anything else ends the question.
    if !matches!(event, "PreToolUse" | "PermissionRequest" | "Notification") {
        next.question_pending = false;
    }
    if new_state != next.state {
        next.since_ms = ts_ms;
    }
    next.state = new_state;

    HookOutcome::Upsert(next)
}

// ---------------------------------------------------------------------------------
// Blocked/working cancel fallback (spec §4 item 6) — Esc-cancels-mid-turn never
// produces a hook, so this infers the outcome from raw pty activity instead.
// ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelSignal {
    Idle,
    Working,
}

/// Pure (unit-tested): decides whether enough time has passed, since the user's last
/// keystroke in this pane, to call the outcome one way or the other. `since_ms` is the
/// record's own `since_ms` (when it entered `Blocked`/`Working`) — `last_input_ms` must
/// be strictly after it, or there has been no user input since this state began and the
/// fallback stays armed-but-silent (`None`).
pub fn cancel_fallback_signal(
    since_ms: u64,
    last_input_ms: u64,
    last_output_ms: u64,
    output_streak_start_ms: u64,
    now_ms: u64,
) -> Option<CancelSignal> {
    if last_input_ms <= since_ms {
        return None;
    }
    let anchor = last_input_ms;

    let effective_last_output = last_output_ms.max(anchor);
    let silence = now_ms.saturating_sub(effective_last_output);
    if silence >= CANCEL_FALLBACK_SILENCE_MS {
        return Some(CancelSignal::Idle);
    }

    if output_streak_start_ms >= anchor {
        let gap_since_last_chunk = now_ms.saturating_sub(last_output_ms);
        let streak_len = now_ms.saturating_sub(output_streak_start_ms);
        if gap_since_last_chunk < crate::pty::OUTPUT_STREAK_GAP_MS
            && streak_len >= CANCEL_FALLBACK_CONTINUOUS_MS
        {
            return Some(CancelSignal::Working);
        }
    }

    None
}

/// Applies a [`CancelSignal`] to a record — only ever for `Hook`-sourced records
/// currently `Blocked`/`Working` (spec §4 item 6's generalization over the original
/// §1.4 "blocked only" rule); never produces `Done` (mirrors the plain heuristic
/// fallback's "silence is an ambiguous signal for *finished*").
pub fn apply_cancel_fallback(prev: &Agent, signal: CancelSignal, now_ms: u64) -> Option<Agent> {
    if prev.source != Source::Hook {
        return None;
    }
    if !matches!(prev.state, AgentState::Blocked | AgentState::Working) {
        return None;
    }
    // 0.3.2: a turn waiting for background work produces no output of its own; silence
    // after a keystroke says nothing about it (its hooks end it).
    if !prev.background_tasks.is_empty() {
        return None;
    }
    let new_state = match signal {
        CancelSignal::Idle => AgentState::Idle,
        CancelSignal::Working => AgentState::Working,
    };
    if new_state == prev.state {
        return None;
    }
    Some(Agent {
        state: new_state,
        since_ms: now_ms,
        question_pending: false,
        ..prev.clone()
    })
}

// ---------------------------------------------------------------------------------
// Hookless heuristic fallback (spec §1.4: every agent, when no hook has ever
// been seen for the pane) — never produces `Blocked`/`Done`.
// ---------------------------------------------------------------------------------

/// `last_meaningful_output_ms` already has the pty reader thread's echo-suppression
/// baked in (output within 500 ms of the last keystroke doesn't count). Ambiguous ages
/// (between the two thresholds) keep whatever state the record already had, to avoid
/// flapping every tick right at the boundary.
pub fn heuristic_output_state(prev_state: AgentState, last_meaningful_output_ms: u64, now_ms: u64) -> AgentState {
    let age = now_ms.saturating_sub(last_meaningful_output_ms);
    if age < HEURISTIC_WORKING_WINDOW_MS {
        AgentState::Working
    } else if age >= HEURISTIC_IDLE_SILENCE_MS {
        AgentState::Idle
    } else {
        prev_state
    }
}

// ---------------------------------------------------------------------------------
// Screen rules (M3, `adapters::screen`): states hooks can't report, read off the pane's
// terminal screen.
// ---------------------------------------------------------------------------------

/// The agent state a newly raised screen rule stands for. `done` follows `Stop`'s "seen"
/// rule; `waitingInput` is idle (the agent waits for the user, like after `Stop`).
pub fn screen_agent_state(state: ScreenState, seen: bool) -> AgentState {
    match state {
        ScreenState::WaitingPermission => AgentState::Blocked,
        ScreenState::Working => AgentState::Working,
        ScreenState::WaitingInput => AgentState::Idle,
        ScreenState::Done if seen => AgentState::Idle,
        ScreenState::Done => AgentState::Done,
    }
}

/// Which rules may drive a record: all of them for a hookless (heuristic) record; only
/// `waitingPermission` once hooks are live (hooks win, but some agents' hooks never
/// report permission prompts — Cursor).
fn screen_rule_allowed(source: Source, state: ScreenState) -> bool {
    source == Source::Heuristic || state == ScreenState::WaitingPermission
}

/// Applies one screen-rule tick result to a record. Returns whether the record changed.
/// `recent_output` decides where a hook record goes when the permission prompt it was
/// blocked on disappears without a hook (working if output is still flowing, else idle).
pub fn apply_screen_event(agent: &mut Agent, event: ScreenEvent, seen: bool, recent_output: bool, now_ms: u64) -> bool {
    let new_state = match event {
        ScreenEvent::Raised(state) => screen_agent_state(state, seen),
        ScreenEvent::Cleared(ScreenState::WaitingPermission)
            if agent.source == Source::Hook && agent.state == AgentState::Blocked =>
        {
            if recent_output {
                AgentState::Working
            } else {
                AgentState::Idle
            }
        }
        _ => return false,
    };
    if new_state == agent.state {
        return false;
    }
    agent.state = new_state;
    agent.since_ms = now_ms;
    agent.question_pending = false;
    true
}

// ---------------------------------------------------------------------------------
// AgentTracker — the stateful shell (spec §1.4/§1.6). Pure functions above make every
// *decision*; this just holds the map, the ordering/hook-ended bookkeeping, and decides
// when a fresh `agents:changed` snapshot is owed.
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// Leftover processes (0.3.2): after an agent's record goes away while its pane lives on,
// whatever it left running under the shell is reported (`pty:leftover`), never killed.
// ---------------------------------------------------------------------------------

/// How long after the record's removal the first check waits (the agent's own process
/// is usually still exiting).
const LEFTOVER_GRACE_MS: u64 = 2000;

/// One pane being watched for leftovers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeftoverWatch {
    pub since_ms: u64,
    /// The process list last emitted (empty = nothing emitted, or cleared).
    pub emitted: Vec<String>,
}

/// The `pty:leftover` payload; `processes: []` clears the pane's warning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverEvent {
    pub pane_id: String,
    pub processes: Vec<String>,
}

/// Pure (0.3.2): one heuristic tick of a watched pane. `processes` = the non-shell
/// processes under its shell now. Returns whether to keep watching and the list to emit,
/// if any: a new agent record or nothing left ends the watch (emitting the clear only if
/// a warning was shown); a changed list is emitted.
pub fn leftover_step(
    watch: &mut LeftoverWatch,
    has_record: bool,
    processes: Vec<String>,
    now_ms: u64,
) -> (bool, Option<Vec<String>>) {
    let clear = |watch: &LeftoverWatch| (!watch.emitted.is_empty()).then(Vec::new);
    if has_record {
        return (false, clear(watch));
    }
    if now_ms < watch.since_ms.saturating_add(LEFTOVER_GRACE_MS) {
        return (true, None);
    }
    if processes.is_empty() {
        return (false, clear(watch));
    }
    if processes == watch.emitted {
        return (true, None);
    }
    watch.emitted = processes.clone();
    (true, Some(processes))
}

struct TrackedRecord {
    agent: Agent,
    presence_miss_count: u32,
    /// M3: screen-rule hit in force (only for agents whose definition has rules).
    screen: ScreenTrack,
}

impl TrackedRecord {
    fn new(agent: Agent) -> Self {
        Self {
            agent,
            presence_miss_count: 0,
            screen: ScreenTrack::default(),
        }
    }
}

#[derive(Default)]
struct TrackerState {
    records: HashMap<String, TrackedRecord>,
    /// Spec §4 item 7b: pane id -> the `now_ms` at which its post-`SessionEnd` window
    /// closes (heuristic registration is suppressed for that pane until then, or until
    /// the process match is lost, whichever comes first).
    hook_ended_until: HashMap<String, u64>,
    /// Spec §4 item 5: last-applied `tsMs` per pane, so a hook that raced its way to a
    /// later arrival than a newer one is dropped rather than clobbering it.
    last_applied_ts_ms: HashMap<String, u64>,
    visible_pane_id: Option<String>,
    window_focused: bool,
    /// Spec §4 item 11: `(pid, creation_time) -> cmdline` cache for `node.exe` pids.
    /// 0.3.2: pruned to the pids of each heuristic tick's topology.
    cmdline_cache: HashMap<(u32, u64), Option<String>>,
    last_heuristic_tick_ms: u64,
    /// 0.3.2: panes whose record went away while the pane lives on (see [`leftover_step`]).
    leftover_watch: HashMap<String, LeftoverWatch>,
    /// 0.3.2: `pty:leftover` payloads not emitted yet (drained by `run_loop`).
    leftover_events: Vec<LeftoverEvent>,
}

impl TrackerState {
    /// Starts watching a pane for leftovers (its record was just removed).
    fn watch_leftovers(&mut self, pane_id: &str, now_ms: u64) {
        self.leftover_watch.entry(pane_id.to_string()).or_insert(LeftoverWatch {
            since_ms: now_ms,
            emitted: Vec::new(),
        });
    }

    /// Ends a pane's watch because an agent record appeared on it.
    fn end_leftover_watch_for_record(&mut self, pane_id: &str) {
        if let Some(mut watch) = self.leftover_watch.remove(pane_id) {
            if let (_, Some(processes)) = leftover_step(&mut watch, true, Vec::new(), 0) {
                self.leftover_events.push(LeftoverEvent {
                    pane_id: pane_id.to_string(),
                    processes,
                });
            }
        }
    }
}

fn is_seen(visible_pane_id: &Option<String>, window_focused: bool, pane_id: &str) -> bool {
    window_focused && visible_pane_id.as_deref() == Some(pane_id)
}

/// Spec §4 finding 4 (pure, unit-tested): extends `descendants` (this tick's already
/// lazily-walked list) with any pid the pane's Job Object has that the walk didn't reach
/// — the same BUG-1 union `pty_busy`/`pty_processes` apply via `pty::pane_process_union`,
/// reused here for both `classify_descendants`'s input and the presence check's
/// `decide_busy` input. A job-only pid gets `ppid: 0`/`creation_time: 0` — both already
/// "unknown" to every consumer here: `classify_descendants` never reads `ppid`, and a `0`
/// creation time is simply the least-specific `cmdline_cache` key, the same sentinel
/// `walk_descendants`'s own pid-reuse guard already treats as "trust the topology".
fn union_with_job_pids(
    descendants: &[crate::pty::ProcSnapshotEntry],
    job_pairs: &[(u32, Option<String>)],
) -> Vec<crate::pty::ProcSnapshotEntry> {
    let mut seen: HashSet<u32> = descendants.iter().map(|e| e.pid).collect();
    let mut union: Vec<crate::pty::ProcSnapshotEntry> = descendants.to_vec();
    for (pid, name) in job_pairs {
        if !seen.insert(*pid) {
            continue;
        }
        let Some(name) = name else { continue };
        union.push(crate::pty::ProcSnapshotEntry {
            pid: *pid,
            ppid: 0,
            name: name.clone(),
            creation_time: 0,
        });
    }
    union
}

#[derive(Default)]
pub struct AgentTracker {
    state: Mutex<TrackerState>,
    dirty: AtomicBool,
    /// M3: the loaded adapter definitions (detection, graceful close, screen rules).
    /// Swapped whole on reload; readers clone the `Arc`.
    definitions: RwLock<Arc<Definitions>>,
}

impl AgentTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TrackerState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn definitions(&self) -> Arc<Definitions> {
        self.definitions.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Replaces the definitions (startup, `agents_definitions_reload`). Existing records
    /// keep their kind; screen-rule bookkeeping restarts with the new rules.
    pub fn set_definitions(&self, defs: Definitions) {
        *self.definitions.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(defs);
        for record in self.lock().records.values_mut() {
            record.screen = ScreenTrack::default();
        }
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Consumes the "something changed since the last snapshot" flag (spec §1.4: the
    /// emit-coalescing poller reads this at its own cadence rather than emitting once
    /// per individual change).
    pub fn take_dirty(&self) -> bool {
        self.dirty.swap(false, Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> Vec<Agent> {
        self.lock().records.values().map(|r| r.agent.clone()).collect()
    }

    /// 0.3.2: the `pty:leftover` payloads queued since the last call.
    pub fn take_leftover_events(&self) -> Vec<LeftoverEvent> {
        std::mem::take(&mut self.lock().leftover_events)
    }

    /// Spec §1.3/§1.4: applies one decoded [`agenthub_proto::HookMessage`]. Returns
    /// whether the visible agent list actually changed. `known_pane` is whether the
    /// `PtyRegistry` currently has this pane open — spec §4 finding 2: a hook message
    /// for a pane it doesn't (any more) know about (queued right before `pane_died`, or
    /// an escaped/never-tracked process) must never create a ghost record that then
    /// lives forever, so it's dropped outright, before ever touching the tracker's own
    /// state.
    pub fn on_hook(&self, msg: &agenthub_proto::HookMessage, known_pane: bool) -> bool {
        if !known_pane {
            return false;
        }

        let mut state = self.lock();

        let last_ts = state
            .last_applied_ts_ms
            .get(&msg.pane_id)
            .copied()
            .unwrap_or(0);
        if msg.ts_ms < last_ts {
            return false; // spec §4 item 5: strictly-older tsMs is dropped.
        }
        state
            .last_applied_ts_ms
            .insert(msg.pane_id.clone(), msg.ts_ms);
        state.hook_ended_until.remove(&msg.pane_id);

        let seen = is_seen(&state.visible_pane_id, state.window_focused, &msg.pane_id);
        let prev = state.records.get(&msg.pane_id).map(|r| r.agent.clone());
        let defs = self.definitions();
        let outcome = apply_agent_hook(
            prev.as_ref(),
            kind_for(&msg.agent, &defs),
            &msg.pane_id,
            &msg.workspace_id,
            &msg.event,
            &msg.payload,
            msg.ts_ms,
            seen,
        );
        // M3: the hook's own adapter id wins over a detection guess.
        let outcome = match outcome {
            HookOutcome::Upsert(mut agent) if !msg.agent.is_empty() => {
                agent.adapter_id = Some(msg.agent.clone());
                HookOutcome::Upsert(agent)
            }
            other => other,
        };

        let changed = match outcome {
            HookOutcome::Remove => {
                let removed = state.records.remove(&msg.pane_id).is_some();
                if removed {
                    state
                        .hook_ended_until
                        .insert(msg.pane_id.clone(), msg.ts_ms + HOOK_ENDED_WINDOW_MS);
                    state.watch_leftovers(&msg.pane_id, now_ms());
                    // Faz 7 spec §1.2: hook-driven transitions are logged at `info` —
                    // short pane id, event, and the outcome (here: the record is gone).
                    log::info!("agent pane={} hook={} -> removed", short_pane_id(&msg.pane_id), msg.event);
                }
                removed
            }
            HookOutcome::Upsert(agent) => {
                let changed = prev.as_ref() != Some(&agent);
                if changed {
                    let prev_state = prev
                        .as_ref()
                        .map(|a| format!("{:?}", a.state))
                        .unwrap_or_else(|| "none".to_string());
                    log::info!(
                        "agent pane={} hook={} kind={:?} state={}->{:?} source=hook",
                        short_pane_id(&msg.pane_id),
                        msg.event,
                        agent.kind,
                        prev_state,
                        agent.state
                    );
                }
                state.end_leftover_watch_for_record(&msg.pane_id);
                let screen = state
                    .records
                    .remove(&msg.pane_id)
                    .map(|r| r.screen)
                    .unwrap_or_default();
                state.records.insert(
                    msg.pane_id.clone(),
                    TrackedRecord {
                        screen,
                        ..TrackedRecord::new(agent)
                    },
                );
                changed
            }
        };

        drop(state);
        if changed {
            self.mark_dirty();
        }
        changed
    }

    /// Spec §1.6: `done -> idle` when the frontend reports this pane as newly visible
    /// *and* the window focused. No-op for an unknown pane or a pane not currently done.
    pub fn set_focus(&self, visible_pane_id: Option<String>, window_focused: bool) -> bool {
        let now = now_ms();
        let mut state = self.lock();
        state.visible_pane_id = visible_pane_id.clone();
        state.window_focused = window_focused;

        let mut changed = false;
        if window_focused {
            if let Some(pid) = visible_pane_id {
                if let Some(record) = state.records.get_mut(&pid) {
                    if record.agent.state == AgentState::Done {
                        record.agent.state = AgentState::Idle;
                        record.agent.since_ms = now;
                        changed = true;
                    }
                }
            }
        }
        drop(state);
        if changed {
            self.mark_dirty();
        }
        changed
    }

    /// Spec §1.6: `agent_ack` — `done -> idle` unconditionally; no-op for an unknown
    /// pane or one not currently done.
    pub fn ack(&self, pane_id: &str) -> bool {
        let now = now_ms();
        let mut state = self.lock();
        let changed = match state.records.get_mut(pane_id) {
            Some(record) if record.agent.state == AgentState::Done => {
                record.agent.state = AgentState::Idle;
                record.agent.since_ms = now;
                true
            }
            _ => false,
        };
        drop(state);
        if changed {
            self.mark_dirty();
        }
        changed
    }

    /// Faz 8 / M3 (graceful close): the key sequence that lets this pane's agent exit
    /// cleanly — its definition's `gracefulClose`, or the Faz 8 Claude sequence for
    /// Claude Code — regardless of `source` (hook or heuristic). `pty_kill`, the
    /// page-reload hook, and app exit all use this as the sole "graceful close instead of
    /// an immediate kill" decision. `None` for an unknown pane or an agent without one.
    pub fn close_plan(&self, pane_id: &str) -> Option<Vec<CloseStep>> {
        let (adapter_id, kind) = {
            let state = self.lock();
            let agent = &state.records.get(pane_id)?.agent;
            (agent.adapter_id.clone(), agent.kind)
        };
        self.definitions().close_plan(adapter_id.as_deref(), kind)
    }

    /// Spec §1.4: pane death (or `pty_kill`) removes the record outright, regardless of
    /// source.
    pub fn pane_died(&self, pane_id: &str) -> bool {
        let mut state = self.lock();
        let removed = state.records.remove(pane_id).is_some();
        state.hook_ended_until.remove(pane_id);
        state.last_applied_ts_ms.remove(pane_id);
        state.leftover_watch.remove(pane_id);
        drop(state);
        if removed {
            self.mark_dirty();
        }
        removed
    }

    /// Faz 7 spec §9.4: `Reload` kills every running pane, so nothing should be left
    /// tracked afterwards either — purges every record and every piece of pane-keyed
    /// bookkeeping outright, regardless of source/state. Returns whether anything was
    /// actually cleared (an empty tracker returns `false`, same convention as every other
    /// mutator here).
    pub fn clear_all(&self) -> bool {
        let mut state = self.lock();
        let had_anything = !state.records.is_empty();
        state.records.clear();
        state.hook_ended_until.clear();
        state.last_applied_ts_ms.clear();
        state.leftover_watch.clear();
        drop(state);
        if had_anything {
            self.mark_dirty();
        }
        had_anything
    }

    /// Spec §1.4: the periodic tick — heuristic registration/removal (gated to
    /// `HEURISTIC_TICK_INTERVAL_MS`) and the cancel fallback / hookless output heuristic
    /// (every call — cheap, atomics only). Returns whether anything changed.
    pub fn tick(&self, pty: &PtyRegistry) -> bool {
        let now = now_ms();

        // Spec §4 finding 3: peek the gating timestamps under a short-lived lock only —
        // the (possibly expensive) whole-system process walk below must never run
        // while the tracker lock is held, or every other tracker call (`on_hook`,
        // `ack`, `set_focus`, `pane_died`) would queue up behind it on a tokio worker.
        let do_heuristic = {
            let state = self.lock();
            now.saturating_sub(state.last_heuristic_tick_ms) >= heuristic_interval_ms(state.records.is_empty())
        };

        let panes = pty.pane_summaries();
        // Spec §4 finding 3: topology-only snapshot (pid/ppid/name, no per-pid
        // `GetProcessTimes`) — `walk_descendants_lazy` resolves a creation time only
        // for a pid it actually reaches, memoized in `creation_time_cache` for the
        // whole tick. Faz 6 perf check: skipped with no pane open — nothing would read
        // it, yet it cost ~25 ms every 1.5 s (~1.7% of a core while idle). The cheap
        // ghost-record purge below still runs.
        let topology = if do_heuristic && !panes.is_empty() {
            Some(crate::pty::system_process_topology())
        } else {
            None
        };
        let mut creation_time_cache: HashMap<u32, u64> = HashMap::new();
        let live_pids: HashSet<u32> = topology.iter().flatten().map(|e| e.pid).collect();
        let defs = self.definitions();

        let mut state = self.lock();
        let mut changed = false;

        // Spec §4 finding 2: purge bookkeeping for any pane id that isn't live any
        // more — a hook message queued right before `pane_died`, or a process that
        // escaped tracking entirely, must never leave a record (or its hook-ended/
        // last-applied-ts bookkeeping) that lives forever.
        let live: HashSet<&str> = panes.iter().map(|p| p.pane_id.as_str()).collect();
        let ghosts: Vec<String> = state
            .records
            .keys()
            .filter(|id| !live.contains(id.as_str()))
            .cloned()
            .collect();
        for id in ghosts {
            state.records.remove(&id);
            changed = true;
        }
        state.hook_ended_until.retain(|id, _| live.contains(id.as_str()));
        state.last_applied_ts_ms.retain(|id, _| live.contains(id.as_str()));
        state.leftover_watch.retain(|id, _| live.contains(id.as_str()));

        for pane in &panes {
            if do_heuristic {
                if let Some(topo) = &topology {
                    changed |= self.heuristic_tick_one(
                        &mut state,
                        pty,
                        pane,
                        topo,
                        &live_pids,
                        &mut creation_time_cache,
                        &defs,
                        now,
                    );
                }
            }
            changed |= self.screen_tick_one(&mut state, pty, pane, &defs, now);
            changed |= self.activity_tick_one(&mut state, pty, pane, now);
        }

        if do_heuristic {
            state.last_heuristic_tick_ms = now;
        }
        if topology.is_some() {
            // 0.3.2: the cache only ever needs this tick's processes.
            state.cmdline_cache.retain(|(pid, _), _| live_pids.contains(pid));
        }

        drop(state);
        if changed {
            self.mark_dirty();
        }
        changed
    }

    /// One pane's heuristic registration/removal pass (spec §1.4/§4 items 4, 7b, 11;
    /// finding 4: presence + classification now see `union_with_job_pids`'s BUG-1 union
    /// rather than the descendant walk alone). M3: matched against the loaded definitions'
    /// `detect` lists.
    #[allow(clippy::too_many_arguments)]
    fn heuristic_tick_one(
        &self,
        state: &mut TrackerState,
        pty: &PtyRegistry,
        pane: &crate::pty::PaneSummary,
        topology: &[crate::pty::ProcTopologyEntry],
        live_pids: &HashSet<u32>,
        creation_time_cache: &mut HashMap<u32, u64>,
        defs: &Definitions,
        now: u64,
    ) -> bool {
        let descendants = crate::pty::walk_descendants_lazy(
            topology,
            pane.shell_pid,
            creation_time_cache,
            &mut crate::pty::process_creation_time_or_zero,
        );
        // 0.3.2: remembered for pane teardown / `pty_stop_leftovers` (orphans).
        pty.remember_descendants(&pane.pane_id, &descendants, live_pids);
        // Spec §4 finding 4: presence + classification must see the same BUG-1 union
        // `pty_busy` does (`pty::pane_process_union`) — the descendant walk alone can
        // miss a Job-assigned pid it doesn't reach (e.g. a packaged/MSIX shell profile).
        let job_pairs = crate::pty::job_pids_with_names(pty, &pane.pane_id);
        let union = union_with_job_pids(&descendants, &job_pairs);

        let matched = heuristic::classify_descendants(
            &union,
            &mut state.cmdline_cache,
            &crate::pty::process_command_line,
            defs,
        );

        if let Some(&until) = state.hook_ended_until.get(&pane.pane_id) {
            if now >= until || matched.is_none() {
                state.hook_ended_until.remove(&pane.pane_id);
            }
        }

        let changed = match state.records.get(&pane.pane_id) {
            None => {
                let suppressed = state.hook_ended_until.contains_key(&pane.pane_id);
                if let (false, Some(adapter_id)) = (suppressed, matched) {
                    let kind = kind_for(&adapter_id, defs);
                    // Faz 7 spec §1.2: heuristic-sourced transitions are `debug` (hook
                    // transitions are the `info`-level ones, logged in `on_hook`).
                    log::debug!(
                        "agent pane={} heuristic registered adapter={adapter_id} source=heuristic",
                        short_pane_id(&pane.pane_id),
                    );
                    state.records.insert(
                        pane.pane_id.clone(),
                        TrackedRecord::new(Agent {
                            id: pane.pane_id.clone(),
                            pane_id: pane.pane_id.clone(),
                            workspace_id: pane.workspace_id.clone(),
                            kind,
                            adapter_id: Some(adapter_id),
                            state: AgentState::Idle,
                            since_ms: now,
                            source: Source::Heuristic,
                            session_id: None,
                            background_tasks: Vec::new(),
                            question_pending: false,
                        }),
                    );
                    true
                } else {
                    false
                }
            }
            Some(record) => {
                let shell_image_name = pty
                    .shell_info(&pane.pane_id)
                    .map(|(_, name)| name)
                    .unwrap_or_default();
                let pairs: Vec<(u32, Option<String>)> = union
                    .iter()
                    .map(|e| (e.pid, Some(e.name.clone())))
                    .collect();
                let busy = crate::pty::decide_busy(&pairs, pane.shell_pid, &shell_image_name).busy;
                let (remove, new_miss) = heuristic::presence_tick(
                    record.agent.source,
                    matched.is_some(),
                    busy,
                    record.presence_miss_count,
                );
                if remove {
                    log::debug!(
                        "agent pane={} heuristic removed (kind={:?})",
                        short_pane_id(&pane.pane_id),
                        record.agent.kind
                    );
                    state.records.remove(&pane.pane_id);
                    state.watch_leftovers(&pane.pane_id, now);
                    true
                } else {
                    if let Some(record) = state.records.get_mut(&pane.pane_id) {
                        record.presence_miss_count = new_miss;
                    }
                    false
                }
            }
        };

        if state.leftover_watch.contains_key(&pane.pane_id) {
            self.leftover_tick_one(state, pty, pane, &union, now);
        }
        changed
    }

    /// 0.3.2: one watched pane's leftover check (see [`leftover_step`]): the non-shell
    /// processes of this tick's descendant/job union plus remembered orphans still alive.
    fn leftover_tick_one(
        &self,
        state: &mut TrackerState,
        pty: &PtyRegistry,
        pane: &crate::pty::PaneSummary,
        union: &[crate::pty::ProcSnapshotEntry],
        now: u64,
    ) {
        let has_record = state.records.contains_key(&pane.pane_id);
        let processes = if has_record {
            Vec::new()
        } else {
            let shell_image_name = pty
                .shell_info(&pane.pane_id)
                .map(|(_, name)| name)
                .unwrap_or_default();
            let mut pairs: Vec<(u32, Option<String>)> =
                union.iter().map(|e| (e.pid, Some(e.name.clone()))).collect();
            let known: HashSet<u32> = pairs.iter().map(|(pid, _)| *pid).collect();
            pairs.extend(pty.remembered_survivors(&pane.pane_id, &known));
            let mut names = crate::pty::leftover_names(&pairs, pane.shell_pid, &shell_image_name);
            names.sort_by_key(|n| n.to_ascii_lowercase());
            names
        };
        let Some(watch) = state.leftover_watch.get_mut(&pane.pane_id) else {
            return;
        };
        let (keep, emit) = leftover_step(watch, has_record, processes, now);
        if !keep {
            state.leftover_watch.remove(&pane.pane_id);
        }
        if let Some(processes) = emit {
            log::info!(
                "agent pane={} leftover processes: {}",
                short_pane_id(&pane.pane_id),
                processes.len()
            );
            state.leftover_events.push(LeftoverEvent {
                pane_id: pane.pane_id.clone(),
                processes,
            });
        }
    }

    /// M3: one pane's screen-rule pass, every tick. The pane's `vt100` screen only runs
    /// while its agent's definition has `screenRules`; everything else turns it off.
    fn screen_tick_one(
        &self,
        state: &mut TrackerState,
        pty: &PtyRegistry,
        pane: &crate::pty::PaneSummary,
        defs: &Definitions,
        now: u64,
    ) -> bool {
        let seen = is_seen(&state.visible_pane_id, state.window_focused, &pane.pane_id);
        let record = state.records.get_mut(&pane.pane_id);
        let rules = record
            .as_ref()
            .and_then(|r| r.agent.adapter_id.as_deref())
            .and_then(|id| defs.get(id))
            .map(|d| d.rules.as_slice())
            .filter(|r| !r.is_empty());
        let (Some(record), Some(rules)) = (record, rules) else {
            pty.set_screen_enabled(&pane.pane_id, false);
            return false;
        };
        pty.set_screen_enabled(&pane.pane_id, true);
        let (Some(rows), Some(activity)) = (pty.screen_rows(&pane.pane_id), pty.activity_snapshot(&pane.pane_id)) else {
            return false;
        };

        let source = record.agent.source;
        if record
            .screen
            .hit
            .as_ref()
            .is_some_and(|h| !screen_rule_allowed(source, h.state))
        {
            // Hooks went live while a hookless-only rule was in force: hooks own it now.
            record.screen = ScreenTrack::default();
        }
        let current = screen::first_match(rules, &rows, |r| screen_rule_allowed(source, r.state));
        let event = screen::step(
            &mut record.screen,
            rules,
            current,
            activity.last_input_ms,
            activity.last_meaningful_output_ms,
            now,
        );
        if event != ScreenEvent::None {
            log::debug!("agent pane={} screen {event:?}", short_pane_id(&pane.pane_id));
        }
        let recent_output = now.saturating_sub(activity.last_meaningful_output_ms) < HEURISTIC_WORKING_WINDOW_MS;
        apply_screen_event(&mut record.agent, event, seen, recent_output, now)
    }

    /// One pane's cancel-fallback / hookless-heuristic pass (spec §1.4),
    /// every tick — cheap (atomics only).
    fn activity_tick_one(
        &self,
        state: &mut TrackerState,
        pty: &PtyRegistry,
        pane: &crate::pty::PaneSummary,
        now: u64,
    ) -> bool {
        let Some(record) = state.records.get_mut(&pane.pane_id) else {
            return false;
        };

        if record.agent.source == Source::Hook
            && matches!(record.agent.state, AgentState::Blocked | AgentState::Working)
        {
            let Some(activity) = pty.activity_snapshot(&pane.pane_id) else {
                return false;
            };
            let Some(signal) = cancel_fallback_signal(
                record.agent.since_ms,
                activity.last_input_ms,
                activity.last_output_ms,
                activity.output_streak_start_ms,
                now,
            ) else {
                return false;
            };
            if let Some(updated) = apply_cancel_fallback(&record.agent, signal, now) {
                record.agent = updated;
                return true;
            }
            return false;
        }

        // M3: while a screen rule is in force it owns a hookless record's state.
        if record.agent.source == Source::Heuristic && record.screen.hit.is_none() {
            let Some(activity) = pty.activity_snapshot(&pane.pane_id) else {
                return false;
            };
            let new_state =
                heuristic_output_state(record.agent.state, activity.last_meaningful_output_ms, now);
            if new_state != record.agent.state {
                record.agent.state = new_state;
                record.agent.since_ms = now;
                return true;
            }
        }

        false
    }
}

/// Spec §1.4: the periodic tick/emit loop, spawned once for the app's whole lifetime.
/// A 150 ms cadence is cheap (`tick`'s own internal gating limits the expensive
/// heuristic work to its own, much slower cadence — see
/// `HEURISTIC_TICK_INTERVAL_MS`) and keeps `agents:changed`
/// emits comfortably under the spec's "~10/s" coalescing cap even under a burst of
/// hook-driven changes, since every change within one 150 ms window collapses into a
/// single emit.
pub async fn run_loop(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if app.try_state::<AgentTracker>().is_none()
            || app.try_state::<PtyRegistry>().is_none()
        {
            continue;
        }

        // Spec §4 finding 3: `tick`'s heuristic pass does blocking Win32 syscalls
        // (`OpenProcess`/`GetProcessTimes`/`NtQueryInformationProcess`) — running it
        // directly on this async task would block a tokio worker thread for the
        // duration. `AgentTracker`/`PtyRegistry` are Tauri-managed
        // state reachable from a cloned `AppHandle`, so a dedicated blocking task can
        // borrow them for one tick without holding anything (let alone a std `Mutex`
        // guard) across an `.await`.
        let app_for_tick = app.clone();
        let (dirty, leftovers) = tauri::async_runtime::spawn_blocking(move || {
            let tracker = app_for_tick.state::<AgentTracker>();
            let pty = app_for_tick.state::<PtyRegistry>();
            tracker.tick(&pty);
            (tracker.take_dirty(), tracker.take_leftover_events())
        })
        .await
        .unwrap_or_default();

        for event in leftovers {
            let _ = app.emit("pty:leftover", event);
        }

        if dirty {
            if let Some(tracker) = app.try_state::<AgentTracker>() {
                let _ = app.emit("agents:changed", tracker.snapshot());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -- Faz 7 §1.1/§9.2 logging helpers ---------------------------------------------

    #[test]
    fn short_pane_id_truncates_to_8_chars() {
        assert_eq!(short_pane_id("0123456789abcdef"), "01234567");
    }

    #[test]
    fn short_pane_id_leaves_a_short_id_untouched() {
        assert_eq!(short_pane_id("abc"), "abc");
    }

    fn agent(state: AgentState, since_ms: u64, source: Source, kind: AgentKind) -> Agent {
        Agent {
            id: "p1".into(),
            pane_id: "p1".into(),
            workspace_id: "w1".into(),
            kind,
            adapter_id: None,
            state,
            since_ms,
            source,
            session_id: None,
            background_tasks: Vec::new(),
            question_pending: false,
        }
    }

    fn hook_agent(state: AgentState, since_ms: u64) -> Agent {
        agent(state, since_ms, Source::Hook, AgentKind::Claude)
    }

    fn upsert(outcome: HookOutcome) -> Agent {
        match outcome {
            HookOutcome::Upsert(a) => a,
            HookOutcome::Remove => panic!("expected Upsert, got Remove"),
        }
    }

    // -- apply_hook: table -------------------------------------------------------

    #[test]
    fn session_start_on_no_record_creates_idle_claude_hook() {
        let out = apply_hook(None, "p1", "w1", "SessionStart", &json!({}), 100, false);
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Idle);
        assert_eq!(a.kind, AgentKind::Claude);
        assert_eq!(a.source, Source::Hook);
        assert_eq!(a.since_ms, 100);
    }

    #[test]
    fn session_start_with_startup_source_resets_existing_record_to_idle() {
        let prev = hook_agent(AgentState::Working, 50);
        let out = apply_hook(
            Some(&prev),
            "p1",
            "w1",
            "SessionStart",
            &json!({"source": "startup", "session_id": "s2"}),
            200,
            false,
        );
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Idle);
        assert_eq!(a.since_ms, 200);
        assert_eq!(a.session_id, Some("s2".to_string()));
    }

    #[test]
    fn session_start_with_clear_resume_fork_all_reset_to_idle() {
        for source in ["clear", "resume", "fork"] {
            let prev = hook_agent(AgentState::Blocked, 10);
            let out = apply_hook(
                Some(&prev),
                "p1",
                "w1",
                "SessionStart",
                &json!({"source": source}),
                20,
                false,
            );
            assert_eq!(upsert(out).state, AgentState::Idle, "source={source}");
        }
    }

    #[test]
    fn session_start_with_compact_source_is_a_no_op() {
        let prev = hook_agent(AgentState::Working, 50);
        let out = apply_hook(
            Some(&prev),
            "p1",
            "w1",
            "SessionStart",
            &json!({"source": "compact"}),
            200,
            false,
        );
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.since_ms, 50, "since_ms must not bump on a no-op");
    }

    #[test]
    fn user_prompt_submit_and_tool_events_set_working() {
        for event in ["UserPromptSubmit", "PreToolUse", "PostToolUse"] {
            let prev = hook_agent(AgentState::Idle, 10);
            let out = apply_hook(Some(&prev), "p1", "w1", event, &json!({}), 20, false);
            assert_eq!(upsert(out).state, AgentState::Working, "event={event}");
        }
    }

    #[test]
    fn permission_request_sets_blocked() {
        let prev = hook_agent(AgentState::Working, 10);
        let out = apply_hook(Some(&prev), "p1", "w1", "PermissionRequest", &json!({}), 20, false);
        assert_eq!(upsert(out).state, AgentState::Blocked);
    }

    #[test]
    fn question_tools_mark_the_blocked_record_as_a_question() {
        for tool in ["AskUserQuestion", "ExitPlanMode"] {
            let prev = hook_agent(AgentState::Working, 10);
            let pre = upsert(apply_hook(Some(&prev), "p1", "w1", "PreToolUse", &json!({"tool_name": tool}), 20, false));
            assert!(pre.question_pending, "{tool}");
            let req = upsert(apply_hook(Some(&pre), "p1", "w1", "PermissionRequest", &json!({"tool_name": tool}), 30, false));
            let notif = upsert(apply_hook(
                Some(&req),
                "p1",
                "w1",
                "Notification",
                &json!({"notification_type": "permission_prompt", "message": format!("Claude needs your permission to use {tool}")}),
                40,
                false,
            ));
            assert_eq!((notif.state, notif.question_pending), (AgentState::Blocked, true), "{tool}");
            let answered = upsert(apply_hook(Some(&notif), "p1", "w1", "PostToolUse", &json!({"tool_name": tool}), 50, false));
            assert_eq!((answered.state, answered.question_pending), (AgentState::Working, false), "{tool}");
        }
    }

    #[test]
    fn a_real_permission_request_is_not_a_question() {
        let prev = hook_agent(AgentState::Working, 10);
        let pre = upsert(apply_hook(Some(&prev), "p1", "w1", "PreToolUse", &json!({"tool_name": "Bash"}), 20, false));
        let req = upsert(apply_hook(Some(&pre), "p1", "w1", "PermissionRequest", &json!({"tool_name": "Bash"}), 30, false));
        assert_eq!((req.state, req.question_pending), (AgentState::Blocked, false));
        let notif = upsert(apply_hook(Some(&req), "p1", "w1", "Notification", &json!({"notification_type": "permission_prompt"}), 40, false));
        assert!(!notif.question_pending);
    }

    #[test]
    fn cancel_fallback_ends_a_pending_question() {
        let mut prev = hook_agent(AgentState::Blocked, 10);
        prev.question_pending = true;
        let next = apply_cancel_fallback(&prev, CancelSignal::Idle, 99).expect("changes");
        assert!(!next.question_pending);
    }

    #[test]
    fn notification_blocked_types_set_blocked() {
        for nt in ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"] {
            let prev = hook_agent(AgentState::Working, 10);
            let out = apply_hook(
                Some(&prev),
                "p1",
                "w1",
                "Notification",
                &json!({"notification_type": nt}),
                20,
                false,
            );
            assert_eq!(upsert(out).state, AgentState::Blocked, "notification_type={nt}");
        }
    }

    #[test]
    fn notification_idle_prompt_is_ignored() {
        let prev = hook_agent(AgentState::Working, 10);
        let out = apply_hook(
            Some(&prev),
            "p1",
            "w1",
            "Notification",
            &json!({"notification_type": "idle_prompt"}),
            20,
            false,
        );
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.since_ms, 10);
    }

    #[test]
    fn stop_goes_idle_when_seen_and_done_when_not_seen() {
        let prev = hook_agent(AgentState::Working, 10);
        let seen = apply_hook(Some(&prev), "p1", "w1", "Stop", &json!({}), 20, true);
        assert_eq!(upsert(seen).state, AgentState::Idle);

        let not_seen = apply_hook(Some(&prev), "p1", "w1", "Stop", &json!({}), 20, false);
        assert_eq!(upsert(not_seen).state, AgentState::Done);
    }

    // -- 0.3.2: background tasks ---------------------------------------------------------

    /// Claude Code `Stop` input while two background agents still run (docs: hooks,
    /// `background_tasks`); unknown fields stay unread.
    fn stop_with_background() -> serde_json::Value {
        json!({
            "session_id": "s1",
            "hook_event_name": "Stop",
            "stop_hook_active": false,
            "background_tasks": [
                {"id": "t1", "type": "agent", "agent_type": "backend-expert", "status": "running"},
                {"id": "t2", "type": "bash", "description": "  npm run build -- --watch and a very long tail that goes past sixty chars  "},
                {"id": "t3"}
            ]
        })
    }

    #[test]
    fn background_task_labels_take_the_first_present_field_and_cap() {
        let labels = background_task_labels(&stop_with_background()).unwrap();
        assert_eq!(labels[0], "backend-expert");
        assert!(labels[1].starts_with("npm run build -- --watch"));
        assert_eq!(labels[1].chars().count(), MAX_BACKGROUND_LABEL_CHARS);
        assert_eq!(labels[2], BACKGROUND_TASK_FALLBACK_LABEL);
        assert_eq!(background_task_labels(&json!({"background_tasks": []})), Some(vec![]));
        assert_eq!(background_task_labels(&json!({})), None);
        let many: Vec<serde_json::Value> = (0..30).map(|i| json!({"name": format!("t{i}")})).collect();
        assert_eq!(
            background_task_labels(&json!({"background_tasks": many})).unwrap().len(),
            MAX_BACKGROUND_TASKS
        );
    }

    #[test]
    fn stop_with_background_tasks_stays_working_with_labels() {
        let prev = hook_agent(AgentState::Working, 10);
        let a = upsert(apply_hook(Some(&prev), "p1", "w1", "Stop", &stop_with_background(), 20, false));
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.since_ms, 10);
        assert_eq!(a.background_tasks.len(), 3);
        let wire = serde_json::to_value(&a).unwrap();
        assert_eq!(wire["backgroundTasks"][0], "backend-expert");
    }

    #[test]
    fn stop_with_empty_or_absent_background_tasks_finishes_and_clears() {
        let mut prev = hook_agent(AgentState::Working, 10);
        prev.background_tasks = vec!["x".into()];
        for payload in [json!({"background_tasks": []}), json!({})] {
            let a = upsert(apply_hook(Some(&prev), "p1", "w1", "Stop", &payload, 20, false));
            assert_eq!(a.state, AgentState::Done);
            assert!(a.background_tasks.is_empty());
        }
    }

    #[test]
    fn subagent_stop_finishes_a_turn_waiting_on_background_work() {
        let paused = upsert(apply_hook(Some(&hook_agent(AgentState::Working, 10)), "p1", "w1", "Stop", &stop_with_background(), 20, true));
        // One task left: labels follow, still Working.
        let one_left = json!({"background_tasks": [{"agent_type": "frontend-expert"}]});
        let a = upsert(apply_hook(Some(&paused), "p1", "w1", "SubagentStop", &one_left, 30, true));
        assert_eq!((a.state, a.background_tasks.clone()), (AgentState::Working, vec!["frontend-expert".to_string()]));
        // Absent field: nothing changes.
        let b = upsert(apply_hook(Some(&a), "p1", "w1", "SubagentStop", &json!({}), 35, true));
        assert_eq!(b.background_tasks, a.background_tasks);
        // Empty: finished (seen → Idle).
        let c = upsert(apply_hook(Some(&b), "p1", "w1", "SubagentStop", &json!({"background_tasks": []}), 40, true));
        assert_eq!(c.state, AgentState::Idle);
        assert!(c.background_tasks.is_empty());
        assert_eq!(c.since_ms, 40);
    }

    #[test]
    fn subagent_stop_outside_background_work_changes_nothing() {
        let prev = hook_agent(AgentState::Working, 10);
        let a = upsert(apply_hook(Some(&prev), "p1", "w1", "SubagentStop", &json!({"background_tasks": []}), 20, false));
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.since_ms, 10);
    }

    #[test]
    fn idle_prompt_ends_background_waiting_and_prompt_submit_clears_labels() {
        let paused = upsert(apply_hook(Some(&hook_agent(AgentState::Working, 10)), "p1", "w1", "Stop", &stop_with_background(), 20, false));
        let idle = json!({"notification_type": "idle_prompt"});
        let a = upsert(apply_hook(Some(&paused), "p1", "w1", "Notification", &idle, 30, false));
        assert_eq!(a.state, AgentState::Done);
        assert!(a.background_tasks.is_empty());
        // Without background work idle_prompt is still ignored.
        let plain = hook_agent(AgentState::Working, 10);
        assert_eq!(upsert(apply_hook(Some(&plain), "p1", "w1", "Notification", &idle, 30, false)).state, AgentState::Working);

        let b = upsert(apply_hook(Some(&paused), "p1", "w1", "UserPromptSubmit", &json!({}), 40, false));
        assert_eq!(b.state, AgentState::Working);
        assert!(b.background_tasks.is_empty());
        // Tool events of background agents keep the labels.
        let c = upsert(apply_hook(Some(&paused), "p1", "w1", "PreToolUse", &json!({}), 40, false));
        assert_eq!(c.background_tasks.len(), 3);
    }

    #[test]
    fn cancel_fallback_leaves_background_waiting_alone() {
        let mut prev = hook_agent(AgentState::Working, 10);
        prev.background_tasks = vec!["x".into()];
        assert!(apply_cancel_fallback(&prev, CancelSignal::Idle, 100).is_none());
    }

    // -- 0.3.2: leftover processes ---------------------------------------------------------

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn leftover_step_waits_out_the_grace_then_emits_changes_and_clears() {
        let mut watch = LeftoverWatch {
            since_ms: 1000,
            emitted: Vec::new(),
        };
        assert_eq!(leftover_step(&mut watch, false, names(&["claude.exe"]), 1500), (true, None));
        let at = 1000 + LEFTOVER_GRACE_MS;
        assert_eq!(leftover_step(&mut watch, false, names(&["python.exe"]), at), (true, Some(names(&["python.exe"]))));
        assert_eq!(leftover_step(&mut watch, false, names(&["python.exe"]), at + 1), (true, None));
        assert_eq!(
            leftover_step(&mut watch, false, names(&["node.exe", "python.exe"]), at + 2),
            (true, Some(names(&["node.exe", "python.exe"])))
        );
        assert_eq!(leftover_step(&mut watch, false, Vec::new(), at + 3), (false, Some(Vec::new())));
    }

    #[test]
    fn leftover_step_ends_quietly_when_nothing_was_shown() {
        let mut watch = LeftoverWatch {
            since_ms: 0,
            emitted: Vec::new(),
        };
        assert_eq!(leftover_step(&mut watch, false, Vec::new(), 10_000), (false, None));
        assert_eq!(leftover_step(&mut watch, true, names(&["x.exe"]), 10_000), (false, None));
        let mut shown = LeftoverWatch {
            since_ms: 0,
            emitted: names(&["x.exe"]),
        };
        assert_eq!(leftover_step(&mut shown, true, Vec::new(), 10_000), (false, Some(Vec::new())));
    }

    #[test]
    fn leftover_event_serializes_for_the_ui() {
        let wire = serde_json::to_value(LeftoverEvent {
            pane_id: "p1".into(),
            processes: names(&["python.exe"]),
        })
        .unwrap();
        assert_eq!(wire, json!({"paneId": "p1", "processes": ["python.exe"]}));
    }

    #[test]
    fn tracker_session_end_starts_a_leftover_watch_and_a_new_record_clears_it() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "UserPromptSubmit", 100, json!({})), true);
        tracker.on_hook(&hook_msg("p1", "SessionEnd", 200, json!({})), true);
        assert!(tracker.lock().leftover_watch.contains_key("p1"));
        // A warning was shown; then a new session starts on the pane.
        tracker.lock().leftover_watch.get_mut("p1").unwrap().emitted = names(&["python.exe"]);
        tracker.on_hook(&hook_msg("p1", "SessionStart", 300, json!({})), true);
        assert!(!tracker.lock().leftover_watch.contains_key("p1"));
        assert_eq!(
            tracker.take_leftover_events(),
            [LeftoverEvent {
                pane_id: "p1".into(),
                processes: Vec::new()
            }]
        );
        assert!(tracker.take_leftover_events().is_empty());
        // pane_died drops a watch without an event.
        tracker.on_hook(&hook_msg("p1", "SessionEnd", 400, json!({})), true);
        tracker.pane_died("p1");
        assert!(tracker.lock().leftover_watch.is_empty());
        assert!(tracker.take_leftover_events().is_empty());
    }

    #[test]
    fn session_end_removes_the_record_regardless_of_state() {
        let prev = hook_agent(AgentState::Blocked, 10);
        let out = apply_hook(Some(&prev), "p1", "w1", "SessionEnd", &json!({}), 20, false);
        assert!(matches!(out, HookOutcome::Remove));
    }

    #[test]
    fn missing_record_plus_non_session_start_hook_creates_one() {
        let out = apply_hook(None, "p1", "w1", "PreToolUse", &json!({}), 20, false);
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.kind, AgentKind::Claude);
        assert_eq!(a.source, Source::Hook);
    }

    #[test]
    fn any_hook_forces_source_hook_and_kind_claude_over_a_prior_heuristic_record() {
        let prev = agent(AgentState::Idle, 10, Source::Heuristic, AgentKind::Codex);
        let out = apply_hook(Some(&prev), "p1", "w1", "PreToolUse", &json!({}), 20, false);
        let a = upsert(out);
        assert_eq!(a.source, Source::Hook);
        assert_eq!(a.kind, AgentKind::Claude);
        assert_eq!(a.state, AgentState::Working);
    }

    #[test]
    fn since_ms_only_updates_when_state_actually_changes() {
        let prev = hook_agent(AgentState::Working, 100);
        let out = apply_hook(Some(&prev), "p1", "w1", "PostToolUse", &json!({}), 500, false);
        assert_eq!(upsert(out).since_ms, 100, "no state change -> since_ms unchanged");
    }

    #[test]
    fn unknown_event_is_a_no_op_but_still_marks_source_hook() {
        let prev = agent(AgentState::Idle, 10, Source::Heuristic, AgentKind::Other);
        let out = apply_hook(Some(&prev), "p1", "w1", "SubagentStop", &json!({}), 20, false);
        let a = upsert(out);
        assert_eq!(a.state, AgentState::Idle);
        assert_eq!(a.since_ms, 10);
        assert_eq!(a.source, Source::Hook);
    }

    #[test]
    fn kind_for_agent_maps_hub_adapter_ids() {
        assert_eq!(kind_for_agent("claude-code"), AgentKind::Claude);
        assert_eq!(kind_for_agent("codex"), AgentKind::Codex);
        assert_eq!(kind_for_agent("something-else"), AgentKind::Other);
    }

    #[test]
    fn codex_hooks_drive_a_codex_record() {
        let out = apply_agent_hook(None, AgentKind::Codex, "p1", "w1", "UserPromptSubmit", &json!({}), 10, false);
        let a = upsert(out);
        assert_eq!(a.kind, AgentKind::Codex);
        assert_eq!(a.source, Source::Hook);
        assert_eq!(a.state, AgentState::Working);

        let blocked = upsert(apply_agent_hook(Some(&a), AgentKind::Codex, "p1", "w1", "PermissionRequest", &json!({}), 20, false));
        assert_eq!(blocked.state, AgentState::Blocked);

        let done = upsert(apply_agent_hook(Some(&a), AgentKind::Codex, "p1", "w1", "Stop", &json!({}), 30, false));
        assert_eq!(done.state, AgentState::Done);
    }

    #[test]
    fn interrupt_returns_a_working_agent_to_idle() {
        let prev = agent(AgentState::Working, 10, Source::Hook, AgentKind::Codex);
        let a = upsert(apply_agent_hook(Some(&prev), AgentKind::Codex, "p1", "w1", "Interrupt", &json!({}), 20, false));
        assert_eq!(a.state, AgentState::Idle);
        assert_eq!(a.since_ms, 20);
    }

    #[test]
    fn session_id_is_captured_from_payload() {
        let out = apply_hook(
            None,
            "p1",
            "w1",
            "UserPromptSubmit",
            &json!({"session_id": "abc"}),
            20,
            false,
        );
        assert_eq!(upsert(out).session_id, Some("abc".to_string()));
    }

    // -- cancel_fallback_signal / apply_cancel_fallback --------------------------

    #[test]
    fn cancel_fallback_none_without_input_since_state_began() {
        assert_eq!(cancel_fallback_signal(100, 100, 0, 0, 5000), None);
        assert_eq!(cancel_fallback_signal(100, 50, 0, 0, 5000), None);
    }

    #[test]
    fn cancel_fallback_idle_after_two_seconds_silence_since_input() {
        // since_ms=100, input at 200, no output at all, now=2200 -> silence since input
        // is 2000ms.
        assert_eq!(
            cancel_fallback_signal(100, 200, 0, 0, 2200),
            Some(CancelSignal::Idle)
        );
    }

    #[test]
    fn cancel_fallback_none_before_silence_threshold() {
        assert_eq!(cancel_fallback_signal(100, 200, 0, 0, 2199), None);
    }

    #[test]
    fn cancel_fallback_working_after_continuous_output_since_input() {
        // Streak started right at the input (approved immediately), still flowing now.
        assert_eq!(
            cancel_fallback_signal(100, 200, 1700, 200, 1700),
            Some(CancelSignal::Working)
        );
    }

    #[test]
    fn cancel_fallback_none_when_streak_started_before_input() {
        // The "continuous output" was already happening before the user typed (e.g.
        // residual output from the blocked tool call) — not evidence of approval.
        assert_eq!(cancel_fallback_signal(100, 200, 1700, 50, 1700), None);
    }

    #[test]
    fn apply_cancel_fallback_only_for_hook_blocked_or_working() {
        let heuristic = agent(AgentState::Working, 10, Source::Heuristic, AgentKind::Claude);
        assert!(apply_cancel_fallback(&heuristic, CancelSignal::Idle, 100).is_none());

        let done = hook_agent(AgentState::Done, 10);
        assert!(apply_cancel_fallback(&done, CancelSignal::Idle, 100).is_none());
    }

    #[test]
    fn apply_cancel_fallback_transitions_and_never_produces_done() {
        let blocked = hook_agent(AgentState::Blocked, 10);
        let idled = apply_cancel_fallback(&blocked, CancelSignal::Idle, 5000).unwrap();
        assert_eq!(idled.state, AgentState::Idle);
        assert_eq!(idled.since_ms, 5000);

        let working = hook_agent(AgentState::Working, 10);
        let approved = apply_cancel_fallback(&working, CancelSignal::Working, 5000);
        assert!(approved.is_none(), "working -> working is not a change");
    }

    #[test]
    fn heuristic_interval_is_slow_only_while_no_agent_is_tracked() {
        assert_eq!(heuristic_interval_ms(true), 4000);
        assert_eq!(heuristic_interval_ms(false), 1500);
    }

    // -- heuristic_output_state ------------------------------------------------------

    #[test]
    fn heuristic_output_state_recent_output_is_working() {
        assert_eq!(
            heuristic_output_state(AgentState::Idle, 900, 1000),
            AgentState::Working
        );
    }

    #[test]
    fn heuristic_output_state_long_silence_is_idle() {
        assert_eq!(
            heuristic_output_state(AgentState::Working, 0, 3000),
            AgentState::Idle
        );
    }

    #[test]
    fn heuristic_output_state_ambiguous_age_keeps_previous_state() {
        assert_eq!(
            heuristic_output_state(AgentState::Working, 0, 2000),
            AgentState::Working
        );
        assert_eq!(
            heuristic_output_state(AgentState::Idle, 0, 2000),
            AgentState::Idle
        );
    }

    // -- AgentTracker: on_hook / ack / set_focus / pane_died -------------------------

    fn hook_msg(pane_id: &str, event: &str, ts_ms: u64, payload: serde_json::Value) -> agenthub_proto::HookMessage {
        agenthub_proto::HookMessage::new(pane_id, "w1", event, ts_ms, payload)
    }

    #[test]
    fn agent_serializes_session_id_for_the_ui() {
        let out = apply_hook(None, "p1", "w1", "SessionStart", &json!({"session_id": "s-1"}), 1, false);
        let wire = serde_json::to_value(upsert(out)).unwrap();
        assert_eq!(wire["sessionId"], "s-1");
        let none = serde_json::to_value(agent(AgentState::Idle, 1, Source::Heuristic, AgentKind::Codex)).unwrap();
        assert!(none["sessionId"].is_null());
    }

    #[test]
    fn tracker_on_hook_applies_and_reports_changed() {
        let tracker = AgentTracker::new();
        let changed = tracker.on_hook(&hook_msg("p1", "UserPromptSubmit", 100, json!({})), true);
        assert!(changed);
        assert!(tracker.take_dirty());
        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].state, AgentState::Working);
    }

    #[test]
    fn tracker_on_hook_drops_stale_ts_ms() {
        let tracker = AgentTracker::new();
        assert!(tracker.on_hook(&hook_msg("p1", "PreToolUse", 200, json!({})), true));
        assert!(tracker.take_dirty());
        // An older message for the same pane must be dropped (no state change).
        let changed = tracker.on_hook(&hook_msg("p1", "PermissionRequest", 100, json!({})), true);
        assert!(!changed);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Working);
    }

    #[test]
    fn tracker_on_hook_equal_ts_ms_is_accepted() {
        let tracker = AgentTracker::new();
        assert!(tracker.on_hook(&hook_msg("p1", "PreToolUse", 200, json!({})), true));
        let changed = tracker.on_hook(&hook_msg("p1", "PermissionRequest", 200, json!({})), true);
        assert!(changed);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Blocked);
    }

    #[test]
    fn tracker_session_end_removes_record() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "PreToolUse", 100, json!({})), true);
        let changed = tracker.on_hook(&hook_msg("p1", "SessionEnd", 200, json!({})), true);
        assert!(changed);
        assert!(tracker.snapshot().is_empty());
    }

    #[test]
    fn tracker_ack_moves_done_to_idle_and_is_noop_otherwise() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "Stop", 100, json!({})), true);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Done);
        assert!(tracker.ack("p1"));
        assert_eq!(tracker.snapshot()[0].state, AgentState::Idle);
        assert!(!tracker.ack("p1"));
        assert!(!tracker.ack("unknown-pane"));
    }

    #[test]
    fn tracker_set_focus_moves_done_to_idle_for_the_newly_visible_pane() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "Stop", 100, json!({})), true);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Done);
        let changed = tracker.set_focus(Some("p1".to_string()), true);
        assert!(changed);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Idle);
    }

    #[test]
    fn tracker_set_focus_without_window_focus_does_not_ack() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "Stop", 100, json!({})), true);
        let changed = tracker.set_focus(Some("p1".to_string()), false);
        assert!(!changed);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Done);
    }

    #[test]
    fn tracker_stop_uses_current_focus_state_for_seen_rule() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "UserPromptSubmit", 50, json!({})), true);
        tracker.set_focus(Some("p1".to_string()), true);
        tracker.on_hook(&hook_msg("p1", "Stop", 100, json!({})), true);
        assert_eq!(tracker.snapshot()[0].state, AgentState::Idle);
    }

    #[test]
    fn tracker_pane_died_removes_record() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "PreToolUse", 100, json!({})), true);
        assert!(tracker.pane_died("p1"));
        assert!(tracker.snapshot().is_empty());
        assert!(!tracker.pane_died("p1"));
    }

    /// Faz 8 / M3 (graceful close): Claude Code keeps its Ctrl+C sequence regardless of
    /// hook/heuristic source; another agent gets its definition's `gracefulClose`; an
    /// agent without one and an unknown pane get none (immediate kill).
    #[test]
    fn tracker_close_plan_follows_the_pane_agents_definition() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "PreToolUse", 100, json!({})), true);
        assert_eq!(tracker.close_plan("p1"), Some(crate::adapters::claude_default_close()));

        let mut gemini = crate::adapters::tests::def("gemini");
        gemini.graceful_close = vec![crate::adapters::CloseStepDef {
            keys: "/quit\r".into(),
            repeat: None,
            gap_ms: None,
            wait_ms: Some(500),
        }];
        tracker.set_definitions(Definitions::from_builtin(vec![gemini, crate::adapters::tests::def("codex")]));
        {
            let mut state = tracker.lock();
            for (pane, id, kind) in [("p2", "codex", AgentKind::Codex), ("p3", "gemini", AgentKind::Gemini)] {
                let mut a = agent(AgentState::Idle, 100, Source::Heuristic, kind);
                a.pane_id = pane.into();
                a.adapter_id = Some(id.into());
                state.records.insert(pane.to_string(), TrackedRecord::new(a));
            }
        }
        assert_eq!(tracker.close_plan("p2"), None);
        let plan = tracker.close_plan("p3").unwrap();
        assert_eq!(plan[0].bytes, b"/quit\r".to_vec());
        assert_eq!(plan[0].wait, std::time::Duration::from_millis(500));
        assert_eq!(tracker.close_plan("no-such-pane"), None);
    }

    #[test]
    fn hook_sets_adapter_id_and_kind_from_the_message_agent() {
        let tracker = AgentTracker::new();
        let mut msg = hook_msg("p1", "working", 100, json!({"sessionId": "s1"}));
        msg.agent = "my-agent".into();
        tracker.on_hook(&msg, true);
        let a = &tracker.snapshot()[0];
        assert_eq!(a.adapter_id.as_deref(), Some("my-agent"));
        assert_eq!(a.kind, AgentKind::Other);
        assert_eq!(a.state, AgentState::Working);
        assert_eq!(a.session_id.as_deref(), Some("s1"));

        let mut user = Definitions::default();
        user.items.push(
            crate::adapters::validate(crate::adapters::tests::def("my-agent"), crate::adapters::DefinitionSource::User)
                .unwrap(),
        );
        tracker.set_definitions(user);
        let mut msg = hook_msg("p1", "waiting-permission", 200, json!({}));
        msg.agent = "my-agent".into();
        tracker.on_hook(&msg, true);
        let a = &tracker.snapshot()[0];
        assert_eq!(a.kind, AgentKind::Custom);
        assert_eq!(a.state, AgentState::Blocked);
        assert!(serde_json::to_value(a).unwrap()["adapterId"] == "my-agent");
    }

    #[test]
    fn protocol_events_map_like_their_claude_counterparts() {
        let cases = [
            ("session-start", AgentState::Idle),
            ("working", AgentState::Working),
            ("waiting-permission", AgentState::Blocked),
            ("waiting-input", AgentState::Idle),
            ("done", AgentState::Done),
            ("error", AgentState::Idle),
        ];
        for (event, expected) in cases {
            let start = if expected == AgentState::Working { AgentState::Idle } else { AgentState::Working };
            let prev = agent(start, 10, Source::Hook, AgentKind::Custom);
            let out = upsert(apply_agent_hook(Some(&prev), AgentKind::Custom, "p1", "w1", event, &json!({}), 20, false));
            assert_eq!(out.state, expected, "event={event}");
        }
        let prev = agent(AgentState::Working, 10, Source::Hook, AgentKind::Custom);
        assert!(matches!(
            apply_agent_hook(Some(&prev), AgentKind::Custom, "p1", "w1", "session-end", &json!({}), 20, false),
            HookOutcome::Remove
        ));
    }

    #[test]
    fn kind_for_maps_new_agents_and_user_definitions() {
        assert_eq!(kind_for_agent("cursor"), AgentKind::Cursor);
        assert_eq!(kind_for_agent("droid"), AgentKind::Droid);
        assert_eq!(kind_for_agent("qwen"), AgentKind::Qwen);
        assert_eq!(kind_for_agent("copilot"), AgentKind::Copilot);
        assert_eq!(kind_for("mine", &Definitions::default()), AgentKind::Other);
        assert_eq!(serde_json::to_value(AgentKind::Custom).unwrap(), "custom");
    }

    // -- M3 screen rules ------------------------------------------------------------------

    #[test]
    fn screen_agent_state_maps_rule_states() {
        assert_eq!(screen_agent_state(ScreenState::WaitingPermission, true), AgentState::Blocked);
        assert_eq!(screen_agent_state(ScreenState::Working, false), AgentState::Working);
        assert_eq!(screen_agent_state(ScreenState::WaitingInput, false), AgentState::Idle);
        assert_eq!(screen_agent_state(ScreenState::Done, false), AgentState::Done);
        assert_eq!(screen_agent_state(ScreenState::Done, true), AgentState::Idle);
    }

    #[test]
    fn hook_records_only_take_permission_rules() {
        assert!(screen_rule_allowed(Source::Hook, ScreenState::WaitingPermission));
        assert!(!screen_rule_allowed(Source::Hook, ScreenState::Working));
        assert!(screen_rule_allowed(Source::Heuristic, ScreenState::Done));
    }

    #[test]
    fn apply_screen_event_raises_and_releases_a_hook_records_permission_block() {
        let mut a = hook_agent(AgentState::Working, 10);
        assert!(apply_screen_event(&mut a, ScreenEvent::Raised(ScreenState::WaitingPermission), false, true, 50));
        assert_eq!((a.state, a.since_ms), (AgentState::Blocked, 50));
        assert!(apply_screen_event(&mut a, ScreenEvent::Cleared(ScreenState::WaitingPermission), false, true, 60));
        assert_eq!(a.state, AgentState::Working);

        let mut b = hook_agent(AgentState::Blocked, 10);
        assert!(apply_screen_event(&mut b, ScreenEvent::Cleared(ScreenState::WaitingPermission), false, false, 60));
        assert_eq!(b.state, AgentState::Idle);

        // A heuristic record's cleared hit is left to the output heuristic.
        let mut c = agent(AgentState::Blocked, 10, Source::Heuristic, AgentKind::Cursor);
        assert!(!apply_screen_event(&mut c, ScreenEvent::Cleared(ScreenState::WaitingPermission), false, false, 60));
        assert!(!apply_screen_event(&mut c, ScreenEvent::None, false, false, 60));
    }

    /// End to end without a real PTY: bytes through a `vt100` pane screen, rules from a
    /// definition, the tracker's state mapping.
    #[test]
    fn screen_bytes_drive_rules_end_to_end() {
        use crate::adapters::screen::{ClearOn, ScreenRule};
        let mut cursor = crate::adapters::tests::def("cursor");
        cursor.screen_rules = vec![
            ScreenRule {
                id: "permission".into(),
                state: ScreenState::WaitingPermission,
                pattern: r"Run this command\?[\s\S]*\(y\)".into(),
                lines: Some(4),
                clear_on: None,
            },
            ScreenRule {
                id: "working".into(),
                state: ScreenState::Working,
                pattern: "ctrl\\+c to stop".into(),
                lines: None,
                clear_on: Some(ClearOn::Input),
            },
        ];
        let defs = Definitions::from_builtin(vec![cursor]);
        let rules = &defs.get("cursor").unwrap().rules;

        let mut screen = crate::pty::PaneScreen::new(10, 60);
        screen.set_enabled(true);
        let mut track = ScreenTrack::default();
        let mut a = agent(AgentState::Idle, 0, Source::Heuristic, AgentKind::Cursor);
        let tick = |screen: &crate::pty::PaneScreen, a: &mut Agent, track: &mut ScreenTrack, input: u64, now: u64| {
            let rows = screen.rows().unwrap();
            let m = screen::first_match(rules, &rows, |r| screen_rule_allowed(a.source, r.state));
            let ev = screen::step(track, rules, m, input, 0, now);
            apply_screen_event(a, ev, false, false, now);
        };

        screen.process(b"\x1b[2J\x1b[H  Generating... (ctrl+c to stop)\r\n");
        tick(&screen, &mut a, &mut track, 0, 100);
        assert_eq!(a.state, AgentState::Working);

        // The TUI redraws: a permission box at the bottom, split over several lines.
        screen.process(b"\x1b[2J\x1b[H\x1b[6;1H\x1b[1mRun this command?\x1b[0m\r\n  npm test\r\n  \x1b[32m(y)\x1b[0m allow  (n) deny");
        tick(&screen, &mut a, &mut track, 0, 200);
        assert_eq!(a.state, AgentState::Blocked);

        // Answered: the box disappears; the hookless record waits for the output heuristic.
        screen.process(b"\x1b[2J\x1b[H$ ");
        tick(&screen, &mut a, &mut track, 250, 300);
        assert!(track.hit.is_none());
    }

    /// Faz 7 spec §9.4: `Reload` clears every tracked record, regardless of source/state.
    #[test]
    fn tracker_clear_all_removes_every_record_and_is_idempotent() {
        let tracker = AgentTracker::new();
        tracker.on_hook(&hook_msg("p1", "PreToolUse", 100, json!({})), true);
        tracker.on_hook(&hook_msg("p2", "PreToolUse", 100, json!({})), true);
        assert_eq!(tracker.snapshot().len(), 2);

        assert!(tracker.clear_all());
        assert!(tracker.snapshot().is_empty());
        assert!(!tracker.clear_all(), "clearing an already-empty tracker reports no change");
    }

    // -- Spec §4 finding 2: unknown-pane hook messages / ghost record purge ---------

    #[test]
    fn on_hook_for_an_unknown_pane_is_dropped_and_creates_no_record() {
        let tracker = AgentTracker::new();
        let changed = tracker.on_hook(
            &hook_msg("ghost", "PreToolUse", 100, json!({})),
            false,
        );
        assert!(!changed);
        assert!(!tracker.take_dirty());
        assert!(tracker.snapshot().is_empty());
    }

    #[test]
    fn tick_purges_records_and_bookkeeping_for_panes_that_are_no_longer_live() {
        let tracker = AgentTracker::new();
        let registry = PtyRegistry::default(); // no live panes at all
        tracker.on_hook(&hook_msg("p1", "PreToolUse", 100, json!({})), true);
        assert_eq!(tracker.snapshot().len(), 1);

        // "p1" isn't a live pane per `registry.pane_summaries()` -> ghost, purged.
        let changed = tracker.tick(&registry);
        assert!(changed);
        assert!(tracker.snapshot().is_empty());

        // The purge must also have cleared `last_applied_ts_ms` for "p1" — a fresh hook
        // with an *older* tsMs than the original one is accepted rather than dropped as
        // stale, proving no leftover bookkeeping survived.
        let accepted = tracker.on_hook(&hook_msg("p1", "PreToolUse", 1, json!({})), true);
        assert!(accepted);
    }

    // -- Spec §4 finding 4: presence/classification union with job pids -------------

    #[test]
    fn union_with_job_pids_adds_job_only_pids_with_unknown_ppid_and_creation_time() {
        let descendants = vec![crate::pty::ProcSnapshotEntry {
            pid: 10,
            ppid: 1,
            name: "pwsh.exe".to_string(),
            creation_time: 5,
        }];
        let job_pairs = vec![(10, Some("pwsh.exe".to_string())), (99, Some("claude.exe".to_string()))];
        let union = union_with_job_pids(&descendants, &job_pairs);
        assert_eq!(union.len(), 2, "pid 10 already in descendants, not duplicated");
        let extra = union.iter().find(|e| e.pid == 99).expect("job-only pid 99 present");
        assert_eq!(extra.name, "claude.exe");
        assert_eq!(extra.ppid, 0);
        assert_eq!(extra.creation_time, 0);
    }

    #[test]
    fn union_with_job_pids_skips_job_pids_with_no_resolvable_name() {
        let descendants: Vec<crate::pty::ProcSnapshotEntry> = Vec::new();
        let job_pairs = vec![(99, None)];
        let union = union_with_job_pids(&descendants, &job_pairs);
        assert!(union.is_empty());
    }

}
