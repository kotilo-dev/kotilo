//! `agenthub-hook` — the shared agent hook sidecar. Every supported agent's hook config
//! runs `kotilo-hook --agent <id> --event <name>`; the agent spawns one instance per
//! hook firing and feeds it the hook's JSON on stdin. Agent Integration Protocol v1 callers
//! may pass `--json <payload>` (instead of stdin) and `--session <id>`.
//!
//! We hold ourselves to "always exit 0, never write stdout or stderr" so a misbehaving
//! build can never surface as an agent error (some agents inject a hook's stdout into the
//! model's context; Gemini parses stderr when stdout is empty). The one exception is
//! Cursor, which treats empty stdout on a permission hook as invalid JSON and blocks the
//! action: for `--agent cursor`, and for Claude hooks that Cursor runs from
//! `~/.claude/settings.json`, we print a neutral JSON answer ([`cursor_answer`]).
//!
//! One invocation delivers to up to two places:
//! - the hub: the envelope v1 (`schema/hook-envelope.v1.json`) is POSTed to
//!   `127.0.0.1:<port>/v1/events` using `port.json` from the hub data folder, and spooled
//!   to `<data>/spool` when the hub can't be reached;
//! - the desktop app: a [`agenthub_proto::HookMessage`] over its named pipe, only when the
//!   agent runs inside one of our terminals (`AGENTHUB_ENDPOINT` + `AGENTHUB_PANE_ID`).
//!
//! All decision logic lives in [`run_with`], generic over env lookup / stdin / the pipe
//! connect step / the process-chain query, so it is testable without a real pipe or
//! process tree. OS-specific code lives in [`platform`].

pub mod platform;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::value::RawValue;

pub use platform::real_connect;

/// Agent hook stdin is JSON; we never read more than this.
pub const MAX_STDIN_BYTES: u64 = 1024 * 1024;
/// Total budget for the desktop pipe connect + write.
pub const CONNECT_TIMEOUT_MS: u32 = 500;
/// Total budget for the hub POST (connect + write + status line).
pub const HUB_BUDGET_MS: u32 = 300;
/// How many ancestors the envelope's `processChain` lists.
pub const MAX_CHAIN_DEPTH: usize = 8;

pub const ENVELOPE_VERSION: u32 = 1;
/// Overrides the hub data folder (tests, side-by-side runs). Same variable the hub reads.
pub const ENV_DATA_DIR: &str = "AGENTHUB_DATA_DIR";
pub const PORT_FILE_NAME: &str = "port.json";
pub const SPOOL_DIR_NAME: &str = "spool";
pub const TOKEN_HEADER: &str = "X-AgentHub-Token";

/// .NET ticks (100 ns since 0001-01-01) at the Unix epoch; spool file names use .NET
/// ticks so the hub's `SpoolReader` can sort them ordinally.
const DOTNET_TICKS_AT_UNIX_EPOCH: u64 = 621_355_968_000_000_000;

/// Tool events fire constantly and are worthless once replayed late, so they are never
/// spooled (Claude/Codex/Qwen/Droid, Gemini, Copilot, Cursor and OpenCode names).
const NOT_SPOOLED: [&str; 17] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "BeforeTool",
    "AfterTool",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeMCPExecution",
    "afterMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
    "session.tool.called",
    "session.tool.success",
    "session.tool.failed",
];

/// Payload fields that carry conversation text (prompts, assistant replies), for every
/// agent. They are dropped before anything leaves the hook, so no transcript content is
/// ever spooled or sent (AGENTS.md rule 5); `prompt` is replaced by `prompt_length`.
const CONTENT_FIELDS: [&str; 4] = ["prompt", "last_assistant_message", "input-messages", "last-assistant-message"];

/// Per-agent payload fields (dotted paths for nested objects) that carry prompt, response,
/// tool output or file content. Sources: `docs/research/agents-*.md`.
const AGENT_CONTENT_FIELDS: [(&str, &[&str]); 5] = [
    (
        "gemini",
        &[
            "prompt_response",
            "llm_request",
            "llm_response",
            "tool_response",
            "details.newContent",
            "details.originalContent",
            "details.fileDiff",
            "details.prompt",
        ],
    ),
    // `submitted_prompt` is replaced by `has_submitted_prompt` (it marks real user submits).
    // Stop's `crons` carry scheduled prompts and `background_tasks` task descriptions.
    (
        "qwen",
        &["submitted_prompt", "tool_response", "background_tasks", "crons"],
    ),
    ("droid", &["tool_response", "task_result", "custom_instructions"]),
    (
        "copilot",
        &[
            "initialPrompt",
            "transformedPrompt",
            "toolResult",
            "customInstructions",
            "errorContext",
            "error.stack",
        ],
    ),
    // `user_email` is personal data, not content, but must not be stored either.
    (
        "cursor",
        &["text", "content", "attachments", "output", "tool_output", "edits", "agent_message", "user_email"],
    ),
];

/// Agent Integration Protocol: `message` (error text) is metadata and kept, clipped.
pub const MAX_MESSAGE_CHARS: usize = 200;

/// Tool output fields, for every agent: never forwarded (AGENTS.md rule 5).
const TOOL_OUTPUT_FIELDS: [&str; 3] = ["tool_response", "tool_output", "toolResult"];

/// Payload fields holding a tool's arguments (`toolArgs` is Copilot's JSON string form).
const TOOL_INPUT_FIELDS: [&str; 3] = ["tool_input", "toolInput", "toolArgs"];

/// The only tool argument keys that leave the hook: paths, commands, search patterns and
/// short labels the hub maps (permission card, activity timeline). Everything else is
/// dropped: Edit/MultiEdit `old_string`/`new_string`/`edits`, Write `content`,
/// NotebookEdit `new_source`, Task/WebFetch `prompt`, ExitPlanMode `plan`, MCP arguments, …
const TOOL_INPUT_KEPT: [&str; 22] = [
    "file_path",
    "path",
    "notebook_path",
    "absolute_path",
    "filePath",
    "dir_path",
    "directory",
    "paths",
    "command",
    "pattern",
    "glob",
    "url",
    "query",
    "description",
    "subagent_type",
    "todos",
    "cell_id",
    "offset",
    "limit",
    "replace_all",
    "run_in_background",
    "riskLevel",
];

/// Labels written by the model (descriptions, search queries, todo texts) are clipped.
pub const MAX_LABEL_CHARS: usize = 200;
/// Commands, paths and patterns: long enough for any real command line (the hub's limit).
pub const MAX_TOOL_ARG_CHARS: usize = 4000;
/// A todo list longer than this is cut (TodoWrite plans are short).
const MAX_TODOS: usize = 100;

const PATCH_BEGIN: &str = "*** Begin Patch";
const PATCH_FILE_MARKERS: [&str; 4] = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];

/// Adapter id of Cursor CLI (gets a JSON answer on stdout).
pub const CURSOR_AGENT: &str = "cursor";
/// Set by Cursor in every hook's environment (also for the Claude hooks it imports).
pub const ENV_CURSOR_VERSION: &str = "CURSOR_VERSION";
/// Payload field Cursor puts on every hook's stdin JSON.
const CURSOR_VERSION_FIELD: &str = "cursor_version";

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// Image names of the Kotilo desktop app (dev build and bundled product name). Used to
/// find its pipe from the process chain when the agent dropped our environment (Codex runs
/// hooks with an empty environment on Windows).
const DESKTOP_EXE_NAMES: [&str; 2] = agenthub_proto::brand::DESKTOP_EXE_NAMES;

/// Agents whose hooks run outside the pane's process tree (OpenCode's plugin lives in a
/// shared background service): their process chain must not pick a pane, so the desktop
/// pipe is used only with the explicit pane environment.
const OUT_OF_TREE_AGENTS: [&str; 1] = ["opencode"];

/// Removes conversation text from a hook payload (fields shared by every agent and the
/// Agent Integration Protocol); keeps only the prompt's / question's length.
pub fn scrub_payload(payload: serde_json::Value) -> serde_json::Value {
    scrub_payload_for("", payload)
}

/// [`scrub_payload`] plus the given agent's own content fields.
pub fn scrub_payload_for(agent: &str, mut payload: serde_json::Value) -> serde_json::Value {
    let Some(obj) = payload.as_object_mut() else {
        return payload;
    };
    let char_len = |obj: &serde_json::Map<String, serde_json::Value>, key: &str| {
        obj.get(key).and_then(|v| v.as_str()).map(|s| s.chars().count())
    };
    if let Some(len) = char_len(obj, "prompt") {
        obj.insert("prompt_length".to_string(), serde_json::Value::from(len));
    }
    for field in CONTENT_FIELDS {
        obj.remove(field);
    }

    // Protocol `waiting-input {question}`: the question is content.
    if let Some(len) = char_len(obj, "question") {
        obj.insert("question_length".to_string(), serde_json::Value::from(len));
    }
    obj.remove("question");
    // Protocol `error {message}` (and agents' notification texts): metadata, clipped.
    if let Some(serde_json::Value::String(message)) = obj.get_mut("message") {
        if let Some((cut, _)) = message.char_indices().nth(MAX_MESSAGE_CHARS) {
            message.truncate(cut);
        }
    }

    if agent == "qwen" && obj.contains_key("submitted_prompt") {
        obj.insert("has_submitted_prompt".to_string(), serde_json::Value::Bool(true));
    }
    // Qwen's PostToolUseFailure `error` is the tool's error text (StopFailure's is a kind).
    if agent == "qwen"
        && obj.get("hook_event_name").and_then(|v| v.as_str()) == Some("PostToolUseFailure")
    {
        obj.remove("error");
    }
    let fields = AGENT_CONTENT_FIELDS
        .iter()
        .find(|(id, _)| *id == agent)
        .map(|(_, fields)| *fields)
        .unwrap_or_default();
    for path in fields {
        remove_path(obj, path);
    }
    scrub_tool_fields(obj);
    payload
}

/// Every agent: drops tool output and keeps only metadata keys of the tool's arguments
/// ([`TOOL_INPUT_KEPT`]). Copilot's `toolArgs` JSON string is scrubbed and re-encoded
/// (dropped when it is not a JSON object).
fn scrub_tool_fields(obj: &mut serde_json::Map<String, serde_json::Value>) {
    for field in TOOL_OUTPUT_FIELDS {
        obj.remove(field);
    }
    for field in TOOL_INPUT_FIELDS {
        let keep = match obj.get_mut(field) {
            None => continue,
            Some(serde_json::Value::Object(args)) => {
                scrub_tool_input(args);
                true
            }
            Some(serde_json::Value::String(text)) => match serde_json::from_str::<serde_json::Value>(text) {
                Ok(serde_json::Value::Object(mut args)) => {
                    scrub_tool_input(&mut args);
                    *text = serde_json::Value::Object(args).to_string();
                    true
                }
                _ => false,
            },
            Some(_) => false,
        };
        if !keep {
            obj.remove(field);
        }
    }
}

/// Keeps [`TOOL_INPUT_KEPT`] keys only, clipped; an `apply_patch` body in any argument is
/// replaced by the file paths it names (`paths`); todos keep `content` (clipped), `status`, `id`.
fn scrub_tool_input(args: &mut serde_json::Map<String, serde_json::Value>) {
    let patch_paths = args
        .values()
        .filter_map(|v| v.as_str())
        .find(|s| s.contains(PATCH_BEGIN))
        .map(patch_file_paths);
    args.retain(|key, value| {
        if !TOOL_INPUT_KEPT.contains(&key.as_str()) {
            return false;
        }
        if let serde_json::Value::String(text) = value {
            if text.contains(PATCH_BEGIN) {
                return false;
            }
            let max = if matches!(key.as_str(), "description" | "query") { MAX_LABEL_CHARS } else { MAX_TOOL_ARG_CHARS };
            clip_chars(text, max);
        }
        true
    });
    if let Some(paths) = patch_paths {
        args.insert(
            "paths".to_string(),
            serde_json::Value::Array(paths.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    if let Some(todos) = args.get_mut("todos") {
        match todos {
            serde_json::Value::Array(items) => {
                items.truncate(MAX_TODOS);
                for item in items.iter_mut() {
                    *item = scrub_todo(item);
                }
            }
            _ => {
                args.remove("todos");
            }
        }
    }
}

/// `{content, status, id}` of one TodoWrite item; `content` clipped to [`MAX_LABEL_CHARS`].
fn scrub_todo(item: &serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for key in ["content", "status", "id"] {
        if let Some(serde_json::Value::String(text)) = item.get(key) {
            let mut text = text.clone();
            clip_chars(&mut text, MAX_LABEL_CHARS);
            out.insert(key.to_string(), serde_json::Value::String(text));
        }
    }
    serde_json::Value::Object(out)
}

/// The file paths an `apply_patch` body names (`*** Add/Update/Delete File: <path>`,
/// `*** Move to: <path>`), in order, without duplicates; at most 50.
pub fn patch_file_paths(patch: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in patch.lines() {
        let line = line.trim_end_matches('\r');
        let Some(path) = PATCH_FILE_MARKERS.iter().find_map(|m| line.strip_prefix(m)) else {
            continue;
        };
        let mut path = path.trim().to_string();
        clip_chars(&mut path, MAX_TOOL_ARG_CHARS);
        if !path.is_empty() && !paths.contains(&path) && paths.len() < 50 {
            paths.push(path);
        }
    }
    paths
}

fn clip_chars(text: &mut String, max: usize) {
    if let Some((cut, _)) = text.char_indices().nth(max) {
        text.truncate(cut);
    }
}

/// Removes a dotted path (`details.newContent`) from a JSON object, if present.
fn remove_path(obj: &mut serde_json::Map<String, serde_json::Value>, path: &str) {
    match path.split_once('.') {
        None => {
            obj.remove(path);
        }
        Some((head, rest)) => {
            if let Some(inner) = obj.get_mut(head).and_then(|v| v.as_object_mut()) {
                remove_path(inner, rest);
            }
        }
    }
}

/// `^[a-z0-9][a-z0-9-]{0,63}$` — adapter ids as used in `--agent`.
pub fn is_valid_agent_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let ok = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    matches!(bytes.first(), Some(b) if ok(b))
        && bytes.len() <= 64
        && bytes.iter().all(|b| ok(b) || *b == b'-')
}

/// The neutral stdout answer Cursor needs: `{}` ("no decision"; empty stdout would be
/// invalid JSON, which blocks permission hooks), except for prompt-submit hooks, which
/// expect `continue` (`beforeSubmitPrompt`, and Claude's `UserPromptSubmit` that Cursor
/// maps onto it). `{"continue":true}` is also a valid no-op answer in Claude's format.
pub fn cursor_answer(event: Option<&str>) -> &'static str {
    match event {
        Some("beforeSubmitPrompt" | "UserPromptSubmit") => r#"{"continue":true}"#,
        _ => "{}",
    }
}

/// Strips a leading UTF-8 BOM (Cursor on Windows prefixes one to the stdin JSON).
pub fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes)
}

/// Parses the hook payload: a JSON object, else `{}` (the hub rejects a `null` payload).
pub fn parse_payload(bytes: &[u8]) -> serde_json::Value {
    match serde_json::from_slice::<serde_json::Value>(strip_bom(bytes)) {
        Ok(value @ serde_json::Value::Object(_)) => value,
        _ => serde_json::Value::Object(serde_json::Map::new()),
    }
}

/// The desktop app's pipe, found from the nearest Kotilo ancestor in the process chain.
pub fn pipe_from_chain(chain: &[ProcessRef]) -> Option<String> {
    chain
        .iter()
        .find(|p| DESKTOP_EXE_NAMES.iter().any(|n| p.name.eq_ignore_ascii_case(n)))
        .map(|p| format!(r"\\.\pipe\{}-{}", agenthub_proto::brand::EXE_PREFIX, p.pid))
}

/// The actual pipe connect+write step: given the pipe path and the encoded message, does
/// the real (or, in tests, fake) I/O and reports diagnostics through the given logger.
pub type ConnectFn<'a> = dyn Fn(&str, &[u8], &dyn Fn(&str)) + 'a;

/// Returns the ancestors of the given pid, nearest first, at most the given depth.
pub type ChainFn<'a> = dyn Fn(u32, usize) -> Vec<ProcessRef> + 'a;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProcessRef {
    pub pid: u32,
    pub name: String,
}

/// The value after `flag` in argv (arg 0 is the program name). Pure.
pub fn parse_flag(args: &[String], flag: &str) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == flag {
            return iter.next().cloned();
        }
    }
    None
}

/// `--event <name>`.
pub fn parse_event(args: &[String]) -> Option<String> {
    parse_flag(args, "--event")
}

/// `--agent <id>`, defaulting to [`agenthub_proto::DEFAULT_AGENT`].
pub fn parse_agent(args: &[String]) -> String {
    parse_flag(args, "--agent")
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| agenthub_proto::DEFAULT_AGENT.to_string())
}

/// Wall-clock instant at 100 ns resolution, taken once per invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
    unix_100ns: u64,
}

impl Stamp {
    pub fn now() -> Self {
        let unix_100ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| (d.as_nanos() / 100).min(u64::MAX as u128) as u64)
            .unwrap_or(0);
        Self { unix_100ns }
    }

    pub fn from_unix_ms(ms: u64) -> Self {
        Self {
            unix_100ns: ms.saturating_mul(10_000),
        }
    }

    pub fn ts_ms(&self) -> u64 {
        self.unix_100ns / 10_000
    }

    pub fn dotnet_ticks(&self) -> u64 {
        self.unix_100ns.saturating_add(DOTNET_TICKS_AT_UNIX_EPOCH)
    }

    /// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC).
    pub fn iso(&self) -> String {
        let ms = self.ts_ms();
        let secs = ms / 1000;
        let (year, month, day) = civil_from_days((secs / 86_400) as i64);
        let sod = secs % 86_400;
        format!(
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
            sod / 3600,
            (sod / 60) % 60,
            sod % 60,
            ms % 1000
        )
    }
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 -> proleptic Gregorian
/// `(year, month, day)`. Public-domain algorithm,
/// <http://howardhinnant.github.io/date_algorithms.html#civil_from_days>.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn debug_enabled(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env(agenthub_proto::ENV_DEBUG).as_deref() == Some("1")
}

fn non_empty(env: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    env(key).filter(|v| !v.is_empty())
}

/// The hub data folder: `AGENTHUB_DATA_DIR`, else the platform default. `None` when
/// neither can be resolved (then the hub is not contacted and nothing is spooled).
pub fn data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    non_empty(env, ENV_DATA_DIR)
        .map(PathBuf::from)
        .or_else(|| platform::default_data_dir(env))
}

/// Walks `parents` (`pid -> (parent pid, image name)`) upward from `self_pid`, nearest
/// ancestor first. Stops at pid 0, an unknown parent, a cycle (pid reuse) or `max_depth`.
pub fn chain_from_parents(
    parents: &HashMap<u32, (u32, String)>,
    self_pid: u32,
    max_depth: usize,
) -> Vec<ProcessRef> {
    let mut chain = Vec::new();
    let mut seen = HashSet::from([self_pid]);
    let mut current = self_pid;
    while chain.len() < max_depth {
        let Some(&(parent, _)) = parents.get(&current) else {
            break;
        };
        if parent == 0 || !seen.insert(parent) {
            break;
        }
        let Some((_, name)) = parents.get(&parent) else {
            break;
        };
        chain.push(ProcessRef {
            pid: parent,
            name: name.clone(),
        });
        current = parent;
    }
    chain
}

/// Hook envelope v1 (`schema/hook-envelope.v1.json`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<'a> {
    pub v: u32,
    pub agent: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<&'a str>,
    pub ts_ms: u64,
    pub received_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<&'a str>,
    pub hook_pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_pid: Option<u32>,
    pub process_chain: &'a [ProcessRef],
    /// The agent's payload object (stdin or `--json`), scrubbed; `{}` when empty or not a
    /// JSON object. `run` never sends `null`.
    pub payload: Option<&'a RawValue>,
}

impl Envelope<'_> {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
}

/// The stdin bytes as a raw JSON value, untouched, if they are valid JSON.
pub fn raw_payload(stdin: &[u8]) -> Option<Box<RawValue>> {
    let text = std::str::from_utf8(stdin).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    RawValue::from_string(text.to_string()).ok()
}

/// `port.json` → `(port, token)`. `None` if missing, unreadable or invalid.
pub fn read_port_file(dir: &Path) -> Option<(u16, String)> {
    let bytes = std::fs::read(dir.join(PORT_FILE_NAME)).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let port = u16::try_from(value.get("port")?.as_u64()?).ok().filter(|p| *p > 0)?;
    let token = value.get("token")?.as_str()?;
    // The token goes into a header line: refuse anything that could break out of it.
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return None;
    }
    Some((port, token.to_string()))
}

/// POSTs `body` to the hub's `/v1/events` on loopback. `Ok` only for a 2xx status line
/// received within `budget`.
pub fn post_event(port: u16, token: &str, body: &[u8], budget: Duration) -> Result<(), String> {
    let deadline = Instant::now() + budget;
    let remaining = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| "hub budget exhausted".to_string())
    };

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, remaining()?).map_err(|e| format!("connect: {e}"))?;
    stream.set_write_timeout(Some(remaining()?)).map_err(|e| e.to_string())?;
    let head = format!(
        "POST /v1/events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{TOKEN_HEADER}: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        .map_err(|e| format!("write: {e}"))?;

    let mut response = Vec::with_capacity(64);
    let mut buf = [0u8; 64];
    while !response.windows(2).any(|w| w == b"\r\n") && response.len() < 512 {
        stream.set_read_timeout(Some(remaining()?)).map_err(|e| e.to_string())?;
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(buf.get(..n).unwrap_or_default()),
            Err(e) => return Err(format!("read: {e}")),
        }
    }
    if is_success_status_line(&response) {
        Ok(())
    } else {
        Err(format!(
            "hub answered {:?}",
            String::from_utf8_lossy(response.get(..response.len().min(32)).unwrap_or_default())
        ))
    }
}

/// `HTTP/1.x 2xx ...`.
fn is_success_status_line(response: &[u8]) -> bool {
    response.starts_with(b"HTTP/1.") && response.get(8) == Some(&b' ') && response.get(9) == Some(&b'2')
}

pub fn should_spool(event: Option<&str>) -> bool {
    !event.is_some_and(|e| NOT_SPOOLED.contains(&e))
}

/// `<ticks D19>-<pid>`: zero-padded .NET ticks first, so ordinal order is chronological.
pub fn spool_file_stem(stamp: Stamp, pid: u32) -> String {
    format!("{:019}-{pid}", stamp.dotnet_ticks())
}

/// Writes `body` to `<data>/spool/<stem>.json` via a `.tmp` file + rename, so the hub
/// never reads a half-written file.
pub fn spool(data_dir: &Path, stamp: Stamp, pid: u32, body: &[u8]) -> std::io::Result<PathBuf> {
    let dir = data_dir.join(SPOOL_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    let stem = spool_file_stem(stamp, pid);
    let temp = dir.join(format!("{stem}.tmp"));
    let target = dir.join(format!("{stem}.json"));
    std::fs::write(&temp, body)?;
    std::fs::rename(&temp, &target)?;
    Ok(target)
}

/// Writes the (Cursor-only) stdout answer; called at most once per invocation.
pub type EmitFn<'a> = dyn Fn(&str) + 'a;

/// Writes `text` to the real stdout and flushes; errors are ignored (always exit 0).
pub fn emit_stdout(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes()).and_then(|_| out.flush());
}

/// Entry point used by the binary: real process-chain query, answers on the real stdout.
pub fn run<R: Read>(
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    stdin: &mut R,
    connect: &ConnectFn<'_>,
) {
    run_with(args, env, stdin, connect, &platform::process_chain, &emit_stdout);
}

/// The full decision core, generic over every side effect except the hub POST/spool
/// (which go to the data folder `env` resolves — tests point it at a temp dir).
///
/// Never panics: no `unwrap`/`expect`/indexing that could fail on any input.
pub fn run_with<R: Read>(
    args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    stdin: &mut R,
    connect: &ConnectFn<'_>,
    chain: &ChainFn<'_>,
    emit: &EmitFn<'_>,
) {
    // Stamped before reading stdin (which can be slow), so the time reflects when the
    // hook fired.
    let stamp = Stamp::now();
    let log = |line: &str| {
        if debug_enabled(env) {
            eprintln!("[{}] {line}", agenthub_proto::brand::HOOK_MARKER);
        }
    };

    let agent = parse_agent(args);
    if !is_valid_agent_id(&agent) {
        return;
    }
    let flag_event = parse_event(args);
    // Cursor's answer goes out first, before any I/O that could hit the watchdog.
    if agent == CURSOR_AGENT {
        emit(cursor_answer(flag_event.as_deref()));
    }
    let is_claude = agent == agenthub_proto::DEFAULT_AGENT;
    // Cursor runs the Claude hooks from ~/.claude/settings.json too: those events are not
    // Claude's. Answer neutrally and drop them.
    if is_claude && non_empty(env, ENV_CURSOR_VERSION).is_some() {
        emit(cursor_answer(flag_event.as_deref()));
        return;
    }
    // The hub's own headless AI runs.
    if env(agenthub_proto::ENV_INTERNAL).as_deref() == Some("1") {
        return;
    }

    let pane_id = non_empty(env, agenthub_proto::ENV_PANE_ID);
    let workspace_id = non_empty(env, agenthub_proto::ENV_WORKSPACE_ID);
    let hook_pid = std::process::id();
    let process_chain = chain(hook_pid, MAX_CHAIN_DEPTH);
    // Our pane env normally names the pipe; agents that drop the environment (Codex)
    // still run inside the pane's process tree, so the app is found from the chain and
    // resolves the pane itself from the chain pids.
    let pipe = match non_empty(env, agenthub_proto::ENV_ENDPOINT).zip(pane_id.clone()) {
        Some(found) => Some(found),
        None if OUT_OF_TREE_AGENTS.contains(&agent.as_str()) => None,
        None => pipe_from_chain(&process_chain).map(|endpoint| (endpoint, String::new())),
    };
    let data = data_dir(env);
    if pipe.is_none() && data.is_none() {
        // Nowhere to deliver: exit without ever touching stdin.
        return;
    }

    // `--json` replaces stdin entirely (a protocol caller may never close its stdin).
    let mut parsed = match parse_flag(args, "--json") {
        Some(json) => parse_payload(json.as_bytes()),
        None => {
            let mut buf = Vec::new();
            let _ = stdin.take(MAX_STDIN_BYTES).read_to_end(&mut buf);
            parse_payload(&buf)
        }
    };
    if is_claude && parsed.get(CURSOR_VERSION_FIELD).is_some() {
        emit(cursor_answer(flag_event.as_deref()));
        return;
    }
    if let (Some(session), Some(obj)) = (
        parse_flag(args, "--session").filter(|s| !s.is_empty()),
        parsed.as_object_mut(),
    ) {
        obj.entry("sessionId").or_insert(serde_json::Value::String(session));
    }
    let event = flag_event.or_else(|| {
        parsed
            .get("hook_event_name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    let payload = scrub_payload_for(&agent, parsed);

    if let Some((endpoint, pane)) = pipe {
        let msg = agenthub_proto::HookMessage::new(
            pane,
            workspace_id.clone().unwrap_or_default(),
            event.clone().unwrap_or_default(),
            stamp.ts_ms(),
            payload.clone(),
        )
        .with_agent(agent.clone())
        .with_chain(process_chain.iter().map(|p| p.pid).collect());
        connect(&endpoint, &agenthub_proto::encode(&msg), &log);
    }

    let Some(data) = data else {
        return;
    };
    let raw = serde_json::value::to_raw_value(&payload).ok();
    let envelope = Envelope {
        v: ENVELOPE_VERSION,
        agent: &agent,
        event: event.as_deref(),
        ts_ms: stamp.ts_ms(),
        received_at: stamp.iso(),
        pane_id: pane_id.as_deref(),
        workspace_id: workspace_id.as_deref(),
        hook_pid,
        parent_pid: process_chain.first().map(|p| p.pid),
        process_chain: &process_chain,
        payload: raw.as_deref(),
    };
    let body = envelope.to_bytes();

    let posted = match read_port_file(&data) {
        Some((port, token)) => post_event(port, &token, &body, Duration::from_millis(HUB_BUDGET_MS as u64))
            .map_err(|e| log(&format!("hub post failed: {e}")))
            .is_ok(),
        None => {
            log("no usable port.json");
            false
        }
    };
    if !posted && should_spool(event.as_deref()) {
        if let Err(e) = spool(&data, stamp, hook_pid, &body) {
            log(&format!("spool failed: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::Cursor;
    use std::net::TcpListener;

    fn env_map(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    fn args(event: &str) -> Vec<String> {
        vec![
            "agenthub-hook".to_string(),
            "--event".to_string(),
            event.to_string(),
        ]
    }

    fn agent_args(agent: &str, event: &str) -> Vec<String> {
        let mut a = args(event);
        a.push("--agent".to_string());
        a.push(agent.to_string());
        a
    }

    fn fake_chain(_pid: u32, _depth: usize) -> Vec<ProcessRef> {
        vec![
            ProcessRef { pid: 200, name: "bash.exe".into() },
            ProcessRef { pid: 100, name: "codex.exe".into() },
        ]
    }

    fn no_pipe(_: &str, _: &[u8], _: &dyn Fn(&str)) {}

    fn no_emit(text: &str) {
        panic!("unexpected stdout {text:?}");
    }

    fn spooled(dir: &Path) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(dir.join(SPOOL_DIR_NAME)) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries.map(|e| e.unwrap().path()).collect();
        files.sort();
        files
    }

    // -- args ------------------------------------------------------------------------

    #[test]
    fn parse_event_finds_the_flag() {
        assert_eq!(parse_event(&args("Stop")), Some("Stop".to_string()));
    }

    #[test]
    fn parse_event_missing_flag_returns_none() {
        assert_eq!(parse_event(&["agenthub-hook".to_string()]), None);
    }

    #[test]
    fn parse_event_flag_with_no_value_returns_none() {
        let a = vec!["agenthub-hook".to_string(), "--event".to_string()];
        assert_eq!(parse_event(&a), None);
    }

    #[test]
    fn parse_agent_reads_the_flag_and_defaults_to_claude_code() {
        assert_eq!(parse_agent(&agent_args("codex", "Stop")), "codex");
        assert_eq!(parse_agent(&args("Stop")), "claude-code");
        let empty = vec!["x".to_string(), "--agent".to_string(), String::new()];
        assert_eq!(parse_agent(&empty), "claude-code");
    }

    // -- time --------------------------------------------------------------------------

    #[test]
    fn stamp_formats_iso_utc_with_milliseconds() {
        // 2026-10-04T10:00:00.123Z
        let s = Stamp::from_unix_ms(1_791_108_000_123);
        assert_eq!(s.iso(), "2026-10-04T10:00:00.123Z");
        assert_eq!(Stamp::from_unix_ms(0).iso(), "1970-01-01T00:00:00.000Z");
        assert_eq!(Stamp::from_unix_ms(951_782_400_000).iso(), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn stamp_dotnet_ticks_match_the_dotnet_epoch_offset() {
        assert_eq!(Stamp::from_unix_ms(0).dotnet_ticks(), 621_355_968_000_000_000);
        // DateTime(2026,10,4,10,0,0,123,Utc).Ticks
        assert_eq!(Stamp::from_unix_ms(1_791_108_000_123).dotnet_ticks(), 639_267_048_001_230_000);
    }

    #[test]
    fn spool_file_stem_is_zero_padded_ticks_then_pid() {
        let stem = spool_file_stem(Stamp::from_unix_ms(0), 42);
        assert_eq!(stem, "0621355968000000000-42");
        let a = spool_file_stem(Stamp::from_unix_ms(1), 9);
        let b = spool_file_stem(Stamp::from_unix_ms(2), 10);
        assert!(a < b, "ordinal order must be chronological");
    }

    // -- process chain ---------------------------------------------------------------

    #[test]
    fn chain_from_parents_walks_nearest_first_and_stops_at_unknown_or_zero() {
        let parents = HashMap::from([
            (10, (20, "agenthub-hook.exe".to_string())),
            (20, (30, "bash.exe".to_string())),
            (30, (40, "claude.exe".to_string())),
            (40, (0, "explorer.exe".to_string())),
        ]);
        let chain = chain_from_parents(&parents, 10, 8);
        let pids: Vec<u32> = chain.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![20, 30, 40]);
        assert_eq!(chain[1].name, "claude.exe");
        assert_eq!(chain_from_parents(&parents, 10, 2).len(), 2);
        assert!(chain_from_parents(&parents, 99, 8).is_empty());
    }

    #[test]
    fn chain_from_parents_stops_on_a_cycle() {
        let parents = HashMap::from([(1, (2, "a".to_string())), (2, (1, "b".to_string()))]);
        assert_eq!(chain_from_parents(&parents, 1, 8).len(), 1);
    }

    #[test]
    fn real_process_chain_does_not_panic() {
        let chain = platform::process_chain(std::process::id(), MAX_CHAIN_DEPTH);
        assert!(chain.len() <= MAX_CHAIN_DEPTH);
    }

    // -- payload / port file ---------------------------------------------------------

    #[test]
    fn raw_payload_keeps_bytes_untouched_and_rejects_invalid() {
        let raw = raw_payload(b"  {\"b\":1, \"a\":2.50}\n").unwrap();
        assert_eq!(raw.get(), "{\"b\":1, \"a\":2.50}");
        assert!(raw_payload(b"").is_none());
        assert!(raw_payload(b"not json").is_none());
    }

    #[test]
    fn read_port_file_parses_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_port_file(dir.path()).is_none());
        std::fs::write(dir.path().join(PORT_FILE_NAME), r#"{"v":1,"port":4567,"token":"abc","pid":1}"#).unwrap();
        assert_eq!(read_port_file(dir.path()), Some((4567, "abc".to_string())));
        std::fs::write(dir.path().join(PORT_FILE_NAME), r#"{"v":1,"port":0,"token":"abc"}"#).unwrap();
        assert!(read_port_file(dir.path()).is_none());
        std::fs::write(dir.path().join(PORT_FILE_NAME), "{\"v\":1,\"port\":1,\"token\":\"a\\r\\nX: y\"}").unwrap();
        assert!(read_port_file(dir.path()).is_none(), "header injection must be refused");
    }

    #[test]
    fn should_spool_skips_only_tool_events() {
        assert!(!should_spool(Some("PreToolUse")));
        assert!(!should_spool(Some("PostToolUse")));
        assert!(!should_spool(Some("PostToolUseFailure")));
        assert!(should_spool(Some("Stop")));
        assert!(should_spool(None));
    }

    // -- hub delivery ------------------------------------------------------------------

    /// Accepts one connection, captures the request and answers with `status`.
    fn fake_hub(status: &'static str) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let len: usize = text
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse().ok())
                        .unwrap_or(0);
                    if request.len() >= split + 4 + len {
                        break;
                    }
                }
            }
            let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
            String::from_utf8_lossy(&request).to_string()
        });
        (port, handle)
    }

    fn write_port_file(dir: &Path, port: u16) {
        std::fs::write(
            dir.join(PORT_FILE_NAME),
            format!(r#"{{"v":1,"port":{port},"token":"secret-token","pid":1}}"#),
        )
        .unwrap();
    }

    fn body_of(request: &str) -> serde_json::Value {
        let body = &request[request.find("\r\n\r\n").unwrap() + 4..];
        serde_json::from_str(body).unwrap()
    }

    #[test]
    fn run_posts_the_envelope_to_the_hub_with_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let (port, server) = fake_hub("202 Accepted");
        write_port_file(dir.path(), port);
        let data = dir.path().to_string_lossy().to_string();
        let env = env_map(&[(ENV_DATA_DIR, &data), ("AGENTHUB_PANE_ID", "pane-1")]);
        let mut stdin = Cursor::new(br#"{"session_id":"s1","hook_event_name":"Stop"}"#.to_vec());

        run_with(&agent_args("codex", "Stop"), &env, &mut stdin, &no_pipe, &fake_chain, &no_emit);

        let request = server.join().unwrap();
        assert!(request.starts_with("POST /v1/events HTTP/1.1\r\n"));
        assert!(request.contains("X-AgentHub-Token: secret-token\r\n"));
        assert!(request.contains("Content-Type: application/json\r\n"));
        let body = body_of(&request);
        assert_eq!(body["v"], 1);
        assert_eq!(body["agent"], "codex");
        assert_eq!(body["event"], "Stop");
        assert_eq!(body["paneId"], "pane-1");
        assert!(body.get("workspaceId").is_none(), "unknown fields are omitted");
        assert_eq!(body["parentPid"], 200);
        assert_eq!(body["processChain"][1]["name"], "codex.exe");
        assert_eq!(body["payload"]["session_id"], "s1");
        assert!(spooled(dir.path()).is_empty(), "a delivered event is not spooled");
    }

    #[test]
    fn run_spools_when_the_hub_rejects_the_event() {
        let dir = tempfile::tempdir().unwrap();
        let (port, server) = fake_hub("401 Unauthorized");
        write_port_file(dir.path(), port);
        let data = dir.path().to_string_lossy().to_string();
        let env = env_map(&[(ENV_DATA_DIR, &data)]);
        let mut stdin = Cursor::new(br#"{"session_id":"s1"}"#.to_vec());

        run_with(&args("SessionStart"), &env, &mut stdin, &no_pipe, &fake_chain, &no_emit);
        server.join().unwrap();

        let files = spooled(dir.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].extension().unwrap(), "json");
        let body: serde_json::Value = serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap();
        assert_eq!(body["agent"], "claude-code");
        assert_eq!(body["event"], "SessionStart");
    }

    #[test]
    fn run_spools_when_no_hub_is_running_but_not_tool_events() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_string_lossy().to_string();
        let env = env_map(&[(ENV_DATA_DIR, &data)]);

        run_with(&args("PreToolUse"), &env, &mut Cursor::new(b"{}".to_vec()), &no_pipe, &fake_chain, &no_emit);
        assert!(spooled(dir.path()).is_empty());

        run_with(&args("Stop"), &env, &mut Cursor::new(b"{}".to_vec()), &no_pipe, &fake_chain, &no_emit);
        assert_eq!(spooled(dir.path()).len(), 1);
    }

    #[test]
    fn run_takes_the_event_from_the_payload_when_no_flag_is_given() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_string_lossy().to_string();
        let env = env_map(&[(ENV_DATA_DIR, &data)]);
        let mut stdin = Cursor::new(br#"{"hook_event_name":"Notification"}"#.to_vec());
        run_with(&["agenthub-hook".to_string()], &env, &mut stdin, &no_pipe, &fake_chain, &no_emit);
        let files = spooled(dir.path());
        let body: serde_json::Value = serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap();
        assert_eq!(body["event"], "Notification");
    }

    #[test]
    fn scrub_payload_drops_conversation_text_and_keeps_prompt_length() {
        let out = scrub_payload(serde_json::json!({
            "session_id": "s",
            "prompt": "héllo",
            "last_assistant_message": "secret",
            "input-messages": ["x"],
            "last-assistant-message": "y",
            "tool_input": { "command": "npm test" },
        }));
        assert_eq!(out["prompt_length"], 5);
        for gone in ["prompt", "last_assistant_message", "input-messages", "last-assistant-message"] {
            assert!(out.get(gone).is_none(), "{gone} must be removed");
        }
        assert_eq!(out["session_id"], "s");
        assert_eq!(out["tool_input"]["command"], "npm test");
        assert_eq!(scrub_payload(serde_json::Value::Null), serde_json::Value::Null);
    }

    #[test]
    fn spooled_envelope_never_contains_prompt_or_reply_text() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_string_lossy().to_string();
        let env = env_map(&[(ENV_DATA_DIR, &data)]);
        let mut stdin =
            Cursor::new(br#"{"session_id":"s","prompt":"top secret","last_assistant_message":"also secret"}"#.to_vec());
        let args: Vec<String> = ["agenthub-hook", "--agent", "codex", "--event", "Stop"].iter().map(|s| s.to_string()).collect();
        run_with(&args, &env, &mut stdin, &no_pipe, &fake_chain, &no_emit);
        let text = std::fs::read_to_string(&spooled(dir.path())[0]).unwrap();
        assert!(!text.contains("secret"));
        assert!(text.contains("\"prompt_length\":10"));
    }

    #[test]
    fn pipe_from_chain_finds_the_desktop_app() {
        let chain = vec![
            ProcessRef { pid: 5, name: "pwsh.exe".into() },
            ProcessRef { pid: 6, name: "codex.exe".into() },
            // Matched case-insensitively.
            ProcessRef { pid: 7, name: agenthub_proto::brand::DESKTOP_EXE_NAMES[1].to_uppercase() },
        ];
        let expected = format!(r"\\.\pipe\{}-7", agenthub_proto::brand::EXE_PREFIX);
        assert_eq!(pipe_from_chain(&chain), Some(expected));
        assert_eq!(pipe_from_chain(&chain[..2]), None);
    }

    #[test]
    fn run_sends_an_empty_object_for_invalid_or_non_object_stdin() {
        for stdin in [&b"not json"[..], b"", b"null", b"[1]", b"\"x\""] {
            let dir = tempfile::tempdir().unwrap();
            let data = dir.path().to_string_lossy().to_string();
            let env = env_map(&[(ENV_DATA_DIR, &data)]);
            run_with(&args("Stop"), &env, &mut Cursor::new(stdin.to_vec()), &no_pipe, &fake_chain, &no_emit);
            assert_eq!(spooled_body(dir.path())["payload"], serde_json::json!({}), "{stdin:?}");
        }
    }

    #[test]
    fn post_event_fails_fast_when_nothing_listens() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let start = Instant::now();
        assert!(post_event(port, "t", b"{}", Duration::from_millis(HUB_BUDGET_MS as u64)).is_err());
        assert!(start.elapsed() < Duration::from_millis(HUB_BUDGET_MS as u64 + 200));
    }

    #[test]
    fn success_status_line_requires_2xx() {
        assert!(is_success_status_line(b"HTTP/1.1 202 Accepted\r\n"));
        assert!(!is_success_status_line(b"HTTP/1.1 401 Unauthorized\r\n"));
        assert!(!is_success_status_line(b"garbage"));
    }

    // -- envelope vs schema ------------------------------------------------------------

    #[test]
    fn envelope_matches_the_v1_schema_structurally() {
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../../../schema/hook-envelope.v1.json")).unwrap();
        let chain = fake_chain(1, 8);
        let raw = raw_payload(br#"{"session_id":"s"}"#);
        let full = Envelope {
            v: ENVELOPE_VERSION,
            agent: "codex",
            event: Some("Stop"),
            ts_ms: 1,
            received_at: Stamp::from_unix_ms(1).iso(),
            pane_id: Some("p"),
            workspace_id: Some("w"),
            hook_pid: 5,
            parent_pid: Some(200),
            process_chain: &chain,
            payload: raw.as_deref(),
        };
        let minimal = Envelope {
            v: ENVELOPE_VERSION,
            agent: "claude-code",
            event: None,
            ts_ms: 1,
            received_at: Stamp::from_unix_ms(1).iso(),
            pane_id: None,
            workspace_id: None,
            hook_pid: 5,
            parent_pid: None,
            process_chain: &[],
            payload: None,
        };
        for envelope in [&full, &minimal] {
            let value: serde_json::Value = serde_json::from_slice(&envelope.to_bytes()).unwrap();
            let obj = value.as_object().unwrap();
            for key in schema["required"].as_array().unwrap() {
                assert!(obj.contains_key(key.as_str().unwrap()), "missing required {key}");
            }
            let props = schema["properties"].as_object().unwrap();
            for (key, v) in obj {
                let spec = props.get(key).unwrap_or_else(|| panic!("{key} not in schema"));
                let types: Vec<&str> = match &spec["type"] {
                    serde_json::Value::String(t) => vec![t.as_str()],
                    serde_json::Value::Array(ts) => ts.iter().filter_map(|t| t.as_str()).collect(),
                    _ => panic!("{key}: no type"),
                };
                let actual = match v {
                    serde_json::Value::Null => "null",
                    serde_json::Value::Bool(_) => "boolean",
                    serde_json::Value::Number(n) if n.is_u64() || n.is_i64() => "integer",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Object(_) => "object",
                };
                assert!(types.contains(&actual), "{key}: {actual} not in {types:?}");
            }
        }
    }

    // -- desktop pipe ------------------------------------------------------------------

    /// A `Read` that panics if ever read from — proves `run` never touches stdin when
    /// there is nowhere to deliver.
    struct PanicOnRead;
    impl Read for PanicOnRead {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            panic!("stdin must not be read when there is no destination");
        }
    }

    #[test]
    fn run_without_any_destination_never_reads_stdin_or_connects() {
        let env = env_map(&[]);
        let connected = RefCell::new(false);
        let connect = |_: &str, _: &[u8], _: &dyn Fn(&str)| {
            *connected.borrow_mut() = true;
        };
        run_with(&args("Stop"), &env, &mut PanicOnRead, &connect, &fake_chain, &no_emit);
        assert!(!*connected.borrow());
    }

    #[test]
    fn run_without_pane_id_never_reads_stdin_or_connects() {
        let env = env_map(&[("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1")]);
        let connected = RefCell::new(false);
        let connect = |_: &str, _: &[u8], _: &dyn Fn(&str)| {
            *connected.borrow_mut() = true;
        };
        run_with(&args("Stop"), &env, &mut PanicOnRead, &connect, &fake_chain, &no_emit);
        assert!(!*connected.borrow());
    }

    #[test]
    fn run_with_pipe_env_sends_the_message_with_agent() {
        let env = env_map(&[
            ("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1"),
            ("AGENTHUB_PANE_ID", "pane-1"),
            ("AGENTHUB_WORKSPACE_ID", "ws-1"),
        ]);
        let mut stdin = Cursor::new(br#"{"session_id":"abc"}"#.to_vec());
        let captured: RefCell<Option<(String, Vec<u8>)>> = RefCell::new(None);
        let connect = |endpoint: &str, bytes: &[u8], _: &dyn Fn(&str)| {
            *captured.borrow_mut() = Some((endpoint.to_string(), bytes.to_vec()));
        };
        run_with(&agent_args("codex", "Stop"), &env, &mut stdin, &connect, &fake_chain, &no_emit);

        let (endpoint, bytes) = captured.into_inner().expect("connect must be called");
        assert_eq!(endpoint, r"\\.\pipe\agenthub-1");
        let msg = agenthub_proto::decode(&bytes).unwrap();
        assert_eq!(msg.agent, "codex");
        assert_eq!(msg.pane_id, "pane-1");
        assert_eq!(msg.workspace_id, "ws-1");
        assert_eq!(msg.event, "Stop");
        assert_eq!(msg.payload, serde_json::json!({"session_id": "abc"}));
        assert!(msg.ts_ms > 0);
    }

    #[test]
    fn run_pipe_missing_workspace_id_defaults_to_empty_string() {
        let env = env_map(&[
            ("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1"),
            ("AGENTHUB_PANE_ID", "pane-1"),
        ]);
        let captured: RefCell<Option<Vec<u8>>> = RefCell::new(None);
        let connect = |_: &str, bytes: &[u8], _: &dyn Fn(&str)| {
            *captured.borrow_mut() = Some(bytes.to_vec());
        };
        run_with(&args("SessionEnd"), &env, &mut Cursor::new(Vec::new()), &connect, &fake_chain, &no_emit);
        let msg = agenthub_proto::decode(&captured.into_inner().unwrap()).unwrap();
        assert_eq!(msg.workspace_id, "");
        assert_eq!(msg.agent, "claude-code");
        assert_eq!(msg.payload, serde_json::json!({}));
    }

    /// Reports far more than `MAX_STDIN_BYTES` available, so the cap is what stops it.
    struct Infinite;
    impl Read for Infinite {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            buf.fill(b'a');
            Ok(buf.len())
        }
    }

    #[test]
    fn run_caps_stdin_read_at_one_mebibyte() {
        let env = env_map(&[
            ("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1"),
            ("AGENTHUB_PANE_ID", "pane-1"),
        ]);
        let captured: RefCell<Option<Vec<u8>>> = RefCell::new(None);
        let connect = |_: &str, bytes: &[u8], _: &dyn Fn(&str)| {
            *captured.borrow_mut() = Some(bytes.to_vec());
        };
        run_with(&args("Stop"), &env, &mut Infinite, &connect, &fake_chain, &no_emit);
        assert!(captured.into_inner().unwrap().len() < MAX_STDIN_BYTES as usize);
    }

    /// Sleeps before returning its payload — proves the stamp is taken before stdin.
    struct SlowRead {
        data: Cursor<Vec<u8>>,
        slept: bool,
        sleep_for: Duration,
    }
    impl Read for SlowRead {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.slept {
                self.slept = true;
                std::thread::sleep(self.sleep_for);
            }
            self.data.read(buf)
        }
    }

    #[test]
    fn run_stamps_ts_ms_before_reading_stdin_not_after() {
        let env = env_map(&[
            ("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1"),
            ("AGENTHUB_PANE_ID", "pane-1"),
        ]);
        let sleep_for = Duration::from_millis(60);
        let mut stdin = SlowRead {
            data: Cursor::new(b"{}".to_vec()),
            slept: false,
            sleep_for,
        };
        let captured: RefCell<Option<Vec<u8>>> = RefCell::new(None);
        let connect = |_: &str, bytes: &[u8], _: &dyn Fn(&str)| {
            *captured.borrow_mut() = Some(bytes.to_vec());
        };

        let before = Stamp::now().ts_ms();
        run_with(&args("Stop"), &env, &mut stdin, &connect, &fake_chain, &no_emit);
        let after = Stamp::now().ts_ms();

        let msg = agenthub_proto::decode(&captured.into_inner().unwrap()).unwrap();
        assert!(msg.ts_ms >= before);
        assert!(after.saturating_sub(msg.ts_ms) >= sleep_for.as_millis() as u64 / 2);
    }

    #[test]
    fn debug_enabled_requires_exact_value_1() {
        assert!(debug_enabled(&env_map(&[("AGENTHUB_DEBUG", "1")])));
        assert!(!debug_enabled(&env_map(&[("AGENTHUB_DEBUG", "true")])));
        assert!(!debug_enabled(&env_map(&[])));
    }

    // -- M3: protocol transport, agent ids, internal runs, Cursor ---------------------

    fn argv(parts: &[&str]) -> Vec<String> {
        std::iter::once("agenthub-hook").chain(parts.iter().copied()).map(str::to_string).collect()
    }

    fn spooled_body(dir: &Path) -> serde_json::Value {
        let files = spooled(dir);
        assert_eq!(files.len(), 1, "exactly one spooled envelope expected");
        serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap()
    }

    /// Runs with a temp data dir (no hub → spool) and returns (dir, stdout answers).
    fn run_spooling(
        argv: &[String],
        extra_env: &[(&str, &str)],
        mut stdin: &mut dyn Read,
    ) -> (tempfile::TempDir, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_string_lossy().to_string();
        let mut pairs = vec![(ENV_DATA_DIR, data.as_str())];
        pairs.extend_from_slice(extra_env);
        let env = env_map(&pairs);
        let out = RefCell::new(Vec::new());
        let emit = |t: &str| out.borrow_mut().push(t.to_string());
        run_with(argv, &env, &mut stdin, &no_pipe, &fake_chain, &emit);
        (dir, out.into_inner())
    }

    #[test]
    fn agent_id_validation() {
        for ok in ["claude-code", "codex", "a", "0", "my-agent-2", &"a".repeat(64)] {
            assert!(is_valid_agent_id(ok), "{ok}");
        }
        for bad in ["", "-a", "Claude", "a_b", "a b", "a.b", "../x", "ä", &"a".repeat(65)] {
            assert!(!is_valid_agent_id(bad), "{bad}");
        }
    }

    #[test]
    fn invalid_agent_id_exits_silently_without_reading_stdin() {
        let (dir, out) = run_spooling(&argv(&["--agent", "Bad_Id", "--event", "done"]), &[], &mut PanicOnRead);
        assert!(spooled(dir.path()).is_empty());
        assert!(out.is_empty());
    }

    #[test]
    fn json_flag_replaces_stdin_and_protocol_event_passes_through() {
        let a = argv(&["--agent", "my-agent", "--event", "session-start", "--json", r#"{"sessionId":"s1","cwd":"C:\\w"}"#]);
        let (dir, out) = run_spooling(&a, &[], &mut PanicOnRead);
        let body = spooled_body(dir.path());
        assert_eq!(body["agent"], "my-agent");
        assert_eq!(body["event"], "session-start");
        assert_eq!(body["payload"], serde_json::json!({"sessionId": "s1", "cwd": "C:\\w"}));
        assert!(out.is_empty(), "no stdout for non-Cursor agents");
    }

    #[test]
    fn invalid_json_flag_becomes_an_empty_object_and_still_sends() {
        for bad in ["{oops", "null", "[]", ""] {
            let (dir, _) = run_spooling(&argv(&["--agent", "x", "--event", "done", "--json", bad]), &[], &mut PanicOnRead);
            assert_eq!(spooled_body(dir.path())["payload"], serde_json::json!({}), "{bad}");
        }
    }

    #[test]
    fn session_flag_sets_session_id_only_when_absent() {
        let (dir, _) = run_spooling(&argv(&["--agent", "x", "--event", "working", "--session", "s9"]), &[], &mut Cursor::new(Vec::new()));
        assert_eq!(spooled_body(dir.path())["payload"], serde_json::json!({"sessionId": "s9"}));

        let a = argv(&["--agent", "x", "--event", "working", "--session", "s9", "--json", r#"{"sessionId":"own"}"#]);
        let (dir, _) = run_spooling(&a, &[], &mut PanicOnRead);
        assert_eq!(spooled_body(dir.path())["payload"]["sessionId"], "own");
    }

    #[test]
    fn protocol_payload_drops_question_and_clips_message() {
        let long = "é".repeat(250);
        let out = scrub_payload_for(
            "my-agent",
            serde_json::json!({"sessionId": "s", "question": "Which file?", "message": long, "kind": "api"}),
        );
        assert!(out.get("question").is_none());
        assert_eq!(out["question_length"], 11);
        assert_eq!(out["message"].as_str().unwrap().chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(out["kind"], "api");
        let short = scrub_payload_for("x", serde_json::json!({"message": "rate limited"}));
        assert_eq!(short["message"], "rate limited");
    }

    #[test]
    fn protocol_usage_payload_is_kept_intact() {
        let usage = serde_json::json!({"sessionId": "s", "model": "m", "inputTokens": 10, "outputTokens": 2, "cachedTokens": 1, "costUsd": 0.01});
        assert_eq!(scrub_payload_for("my-agent", usage.clone()), usage);
    }

    #[test]
    fn internal_runs_are_dropped_without_reading_stdin() {
        let (dir, out) = run_spooling(&args("Stop"), &[("AGENTHUB_INTERNAL", "1")], &mut PanicOnRead);
        assert!(spooled(dir.path()).is_empty());
        assert!(out.is_empty());
        let (dir, _) = run_spooling(&args("Stop"), &[("AGENTHUB_INTERNAL", "0")], &mut Cursor::new(b"{}".to_vec()));
        assert_eq!(spooled(dir.path()).len(), 1, "only the exact value 1 marks an internal run");
    }

    #[test]
    fn bom_is_stripped_for_every_agent() {
        let mut stdin = b"\xEF\xBB\xBF".to_vec();
        stdin.extend_from_slice(br#"{"session_id":"s1"}"#);
        let (dir, _) = run_spooling(&agent_args("codex", "Stop"), &[], &mut Cursor::new(stdin));
        assert_eq!(spooled_body(dir.path())["payload"]["session_id"], "s1");
        assert_eq!(strip_bom(b"{}"), b"{}");
    }

    #[test]
    fn cursor_agent_prints_a_neutral_answer_and_still_delivers() {
        let mut stdin = b"\xEF\xBB\xBF".to_vec();
        stdin.extend_from_slice(br#"{"conversation_id":"c1","hook_event_name":"stop","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":"me@example.com","status":"completed","loop_count":0}"#);
        let (dir, out) = run_spooling(&agent_args("cursor", "stop"), &[("CURSOR_VERSION", "2026.10.01")], &mut Cursor::new(stdin));
        assert_eq!(out, vec!["{}".to_string()]);
        let body = spooled_body(dir.path());
        assert_eq!(body["agent"], "cursor");
        assert_eq!(body["payload"]["conversation_id"], "c1");
        assert_eq!(body["payload"]["status"], "completed");
        assert!(body["payload"].get("user_email").is_none());
    }

    #[test]
    fn cursor_prompt_submit_answers_continue() {
        assert_eq!(cursor_answer(Some("beforeSubmitPrompt")), r#"{"continue":true}"#);
        assert_eq!(cursor_answer(Some("UserPromptSubmit")), r#"{"continue":true}"#);
        assert_eq!(cursor_answer(Some("preToolUse")), "{}");
        assert_eq!(cursor_answer(Some("PreToolUse")), "{}");
        assert_eq!(cursor_answer(None), "{}");
    }

    #[test]
    fn cursor_answers_even_for_internal_runs_and_without_a_destination() {
        let (dir, out) = run_spooling(&agent_args("cursor", "sessionStart"), &[("AGENTHUB_INTERNAL", "1")], &mut PanicOnRead);
        assert_eq!(out, vec!["{}".to_string()]);
        assert!(spooled(dir.path()).is_empty());

        let out = RefCell::new(Vec::new());
        let emit = |t: &str| out.borrow_mut().push(t.to_string());
        run_with(&agent_args("cursor", "stop"), &env_map(&[]), &mut PanicOnRead, &no_pipe, &fake_chain, &emit);
        assert_eq!(out.into_inner(), vec!["{}".to_string()]);
    }

    #[test]
    fn claude_hook_run_by_cursor_env_is_answered_neutrally_and_dropped() {
        let (dir, out) = run_spooling(&args("PreToolUse"), &[("CURSOR_VERSION", "2026.10.01-e373342")], &mut PanicOnRead);
        assert_eq!(out, vec!["{}".to_string()]);
        assert!(spooled(dir.path()).is_empty());

        let (dir, out) = run_spooling(&args("UserPromptSubmit"), &[("CURSOR_VERSION", "x")], &mut PanicOnRead);
        assert_eq!(out, vec![r#"{"continue":true}"#.to_string()]);
        assert!(spooled(dir.path()).is_empty());
    }

    #[test]
    fn claude_hook_run_by_cursor_payload_is_answered_neutrally_and_dropped() {
        let mut stdin = b"\xEF\xBB\xBF".to_vec();
        stdin.extend_from_slice(br#"{"conversation_id":"c1","hook_event_name":"preToolUse","cursor_version":"2026.10.01-e373342","tool_name":"Shell","tool_input":{"command":"npm test"}}"#);
        let (dir, out) = run_spooling(&args("Stop"), &[], &mut Cursor::new(stdin));
        assert_eq!(out, vec!["{}".to_string()]);
        assert!(spooled(dir.path()).is_empty());

        // The same payload marker on another agent is not a Claude/Cursor clash.
        let (dir, out) = run_spooling(&agent_args("codex", "Stop"), &[], &mut Cursor::new(br#"{"cursor_version":"1"}"#.to_vec()));
        assert!(out.is_empty());
        assert_eq!(spooled(dir.path()).len(), 1);
    }

    #[test]
    fn copilot_camel_case_session_id_is_forwarded_untouched() {
        let stdin = br#"{"sessionId":"0b5c-1","timestamp":1791108000123,"cwd":"C:\\work\\demo","source":"new","initialPrompt":"secret plan"}"#;
        let (dir, _) = run_spooling(&agent_args("copilot", "sessionStart"), &[], &mut Cursor::new(stdin.to_vec()));
        let body = spooled_body(dir.path());
        assert_eq!(body["payload"]["sessionId"], "0b5c-1");
        assert!(body["payload"].get("session_id").is_none(), "no renaming in the sidecar");
        assert!(body["payload"].get("initialPrompt").is_none());
        assert!(!body.to_string().contains("secret"));
    }

    #[test]
    fn copilot_tool_events_are_not_spooled() {
        let (dir, _) = run_spooling(&agent_args("copilot", "postToolUse"), &[], &mut Cursor::new(b"{}".to_vec()));
        assert!(spooled(dir.path()).is_empty());
    }

    // -- per-agent content scrubbing (payloads from docs/research/agents-*.md) ---------

    fn scrub(agent: &str, json: &str) -> serde_json::Value {
        scrub_payload_for(agent, serde_json::from_str(json).unwrap())
    }

    fn assert_no_secret(v: &serde_json::Value) {
        assert!(!v.to_string().contains("SECRET"), "content leaked: {v}");
    }

    #[test]
    fn gemini_payloads_are_scrubbed() {
        let before_agent = scrub("gemini", r#"{"session_id":"7b0c","transcript_path":"C:\\t.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"BeforeAgent","timestamp":"2026-10-06T09:15:20.500Z","prompt":"SECRET prompt"}"#);
        assert_no_secret(&before_agent);
        assert_eq!(before_agent["prompt_length"], 13);
        assert_eq!(before_agent["session_id"], "7b0c");

        let after_agent = scrub("gemini", r#"{"session_id":"7b0c","hook_event_name":"AfterAgent","prompt":"SECRET","prompt_response":"SECRET reply","stop_hook_active":false}"#);
        assert_no_secret(&after_agent);
        assert_eq!(after_agent["stop_hook_active"], false);

        let after_tool = scrub("gemini", r#"{"session_id":"7b0c","hook_event_name":"AfterTool","tool_name":"run_shell_command","tool_input":{"command":"npm test"},"tool_response":{"llmContent":"SECRET","returnDisplay":"SECRET"}}"#);
        assert_no_secret(&after_tool);
        assert_eq!(after_tool["tool_input"]["command"], "npm test");

        let edit = scrub("gemini", r#"{"session_id":"7b0c","hook_event_name":"Notification","notification_type":"ToolPermission","message":"Tool Edit requires editing","details":{"type":"edit","title":"Confirm Edit","fileName":"app.ts","filePath":"C:\\work\\app.ts","fileDiff":"SECRET diff","originalContent":"SECRET old","newContent":"SECRET new","isModifying":false}}"#);
        assert_no_secret(&edit);
        assert_eq!(edit["details"]["filePath"], "C:\\work\\app.ts");
        assert_eq!(edit["details"]["type"], "edit");
        assert_eq!(edit["message"], "Tool Edit requires editing");

        let exec = scrub("gemini", r#"{"hook_event_name":"Notification","details":{"type":"exec","title":"Confirm Shell Command","command":"npm test","rootCommand":"npm"}}"#);
        assert_eq!(exec["details"]["command"], "npm test");
        let info = scrub("gemini", r#"{"hook_event_name":"Notification","details":{"type":"info","title":"t","prompt":"SECRET","urls":["https://x"]}}"#);
        assert_no_secret(&info);

        let model = scrub("gemini", r#"{"hook_event_name":"AfterModel","llm_request":{"contents":"SECRET"},"llm_response":{"text":"SECRET"}}"#);
        assert_no_secret(&model);
    }

    #[test]
    fn qwen_payloads_are_scrubbed() {
        let submit = scrub("qwen", r#"{"session_id":"1f6b","cwd":"C:\\work\\shop-api","hook_event_name":"UserPromptSubmit","permission_mode":"default","prompt_id":"p-1","prompt":"SECRET","submitted_prompt":"SECRET"}"#);
        assert_no_secret(&submit);
        assert_eq!(submit["has_submitted_prompt"], true);
        assert_eq!(submit["prompt_length"], 6);
        let continuation = scrub("qwen", r#"{"hook_event_name":"UserPromptSubmit","prompt":"SECRET"}"#);
        assert!(continuation.get("has_submitted_prompt").is_none());

        let post = scrub("qwen", r#"{"session_id":"1f6b","hook_event_name":"PostToolUse","tool_name":"run_shell_command","tool_input":{"command":"npm test"},"tool_response":{"output":"SECRET"},"tool_use_id":"toolu_01","duration_ms":6800}"#);
        assert_no_secret(&post);
        assert_eq!(post["duration_ms"], 6800);

        let stop = scrub("qwen", r#"{"session_id":"1f6b","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"SECRET","context_usage":0.142,"context_limit":131072,"input_tokens":18612,"background_tasks":[],"crons":[]}"#);
        assert_no_secret(&stop);
        assert_eq!(stop["context_usage"], 0.142);
        assert_eq!(stop["input_tokens"], 18612);

        let failure = scrub("qwen", r#"{"session_id":"1f6b","hook_event_name":"PostToolUseFailure","tool_name":"read_file","error":"SECRET tool error","is_interrupt":false}"#);
        assert_no_secret(&failure);
        assert_eq!(failure["is_interrupt"], false);
        let stop_failure = scrub("qwen", r#"{"session_id":"1f6b","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429","last_assistant_message":"SECRET"}"#);
        assert_no_secret(&stop_failure);
        assert_eq!(stop_failure["error"], "rate_limit", "StopFailure's error is a kind, not text");
    }

    /// Every content field in the adapters' hook fixtures (`adapters/<id>/fixtures/hooks.jsonl`,
    /// marked `SECRET`) is removed, and the fields the hub maps survive.
    #[test]
    fn gemini_and_qwen_fixture_payloads_are_scrubbed() {
        let fixtures = [
            ("gemini", include_str!("../../../adapters/gemini/fixtures/hooks.jsonl")),
            ("qwen", include_str!("../../../adapters/qwen/fixtures/hooks.jsonl")),
        ];
        for (agent, lines) in fixtures {
            for line in lines.lines().filter(|l| !l.trim().is_empty()) {
                let raw: serde_json::Value = serde_json::from_str(line).unwrap();
                let scrubbed = scrub_payload_for(agent, raw.clone());
                assert_no_secret(&scrubbed);
                for key in ["session_id", "cwd", "hook_event_name", "tool_name", "notification_type", "source", "model"] {
                    assert_eq!(scrubbed.get(key), raw.get(key), "{agent}: {key} must survive");
                }
            }
        }
    }

    #[test]
    fn droid_payloads_are_scrubbed() {
        let submit = scrub("droid", r#"{"session_id":"7f3c","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"UserPromptSubmit","prompt":"SECRET","has_images":false}"#);
        assert_no_secret(&submit);
        assert_eq!(submit["has_images"], false);

        let post = scrub("droid", r#"{"session_id":"7f3c","hook_event_name":"PostToolUse","tool_name":"Execute","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0,"output":"SECRET"}}"#);
        assert_no_secret(&post);
        assert_eq!(post["tool_input"]["command"], "npm test");

        let sub = scrub("droid", r#"{"session_id":"7f3c","hook_event_name":"SubagentStop","task_name":"explorer","task_result":"SECRET","task_error":null,"stop_hook_active":false}"#);
        assert_no_secret(&sub);
        assert_eq!(sub["task_name"], "explorer");

        let compact = scrub("droid", r#"{"session_id":"7f3c","hook_event_name":"PreCompact","trigger":"auto","custom_instructions":"SECRET","message_count":84,"estimated_tokens":181000}"#);
        assert_no_secret(&compact);
        assert_eq!(compact["estimated_tokens"], 181000);

        let notif = scrub("droid", r#"{"session_id":"7f3c","hook_event_name":"Notification","message":"Droid needs your permission to use Execute","notification_type":"permission_prompt"}"#);
        assert_eq!(notif["notification_type"], "permission_prompt");
        assert_eq!(notif["message"], "Droid needs your permission to use Execute");
    }

    #[test]
    fn copilot_payloads_are_scrubbed() {
        let submit = scrub("copilot", r#"{"sessionId":"s","timestamp":1,"cwd":"C:\\w","prompt":"SECRET"}"#);
        assert_no_secret(&submit);
        assert_eq!(submit["prompt_length"], 6);
        let transformed = scrub("copilot", r#"{"sessionId":"s","prompt":"SECRET","transformedPrompt":"SECRET"}"#);
        assert_no_secret(&transformed);

        let post = scrub("copilot", r#"{"sessionId":"s","timestamp":1,"cwd":"C:\\w","toolName":"bash","toolArgs":"{\"command\":\"npm test\"}","toolResult":{"resultType":"success","textResultForLlm":"SECRET"}}"#);
        assert_no_secret(&post);
        assert_eq!(post["toolName"], "bash");
        assert_eq!(post["toolArgs"], "{\"command\":\"npm test\"}");

        let compact = scrub("copilot", r#"{"sessionId":"s","transcriptPath":"C:\\e.jsonl","trigger":"manual","customInstructions":"SECRET"}"#);
        assert_no_secret(&compact);

        let notif = scrub("copilot", r#"{"sessionId":"s","hook_event_name":"Notification","message":"Copilot needs permission","notification_type":"permission_prompt"}"#);
        assert_eq!(notif["notification_type"], "permission_prompt");
        let perm = scrub("copilot", r#"{"sessionId":"s","toolName":"powershell","toolInput":{"command":"npm test"}}"#);
        assert_eq!(perm["toolInput"]["command"], "npm test");

        let error = scrub("copilot", r#"{"sessionId":"s","error":{"message":"Rate limit exceeded","name":"RateLimitError","stack":"SECRET"},"errorContext":"SECRET","recoverable":false}"#);
        assert_no_secret(&error);
        assert_eq!(error["error"]["message"], "Rate limit exceeded");
        assert_eq!(error["error"]["name"], "RateLimitError");
    }

    #[test]
    fn opencode_never_finds_a_pane_from_its_process_chain() {
        // The plugin runs in OpenCode's background service; a desktop app in its ancestry is not the session's pane.
        let chain = |_: u32, _: usize| {
            vec![
                ProcessRef { pid: 6, name: "opencode.exe".into() },
                ProcessRef { pid: 7, name: agenthub_proto::brand::DESKTOP_EXE_NAMES[1].into() },
            ]
        };
        let connected = RefCell::new(false);
        let connect = |_: &str, _: &[u8], _: &dyn Fn(&str)| {
            *connected.borrow_mut() = true;
        };
        let json = argv(&["agenthub-hook", "--agent", "opencode", "--event", "session.idle", "--json", r#"{"sessionId":"ses_1"}"#]);
        run_with(&json, &env_map(&[]), &mut PanicOnRead, &connect, &chain, &no_emit);
        assert!(!*connected.borrow());

        let pane = env_map(&[("AGENTHUB_ENDPOINT", r"\\.\pipe\agenthub-1"), ("AGENTHUB_PANE_ID", "pane-1")]);
        run_with(&json, &pane, &mut PanicOnRead, &connect, &chain, &no_emit);
        assert!(*connected.borrow(), "an explicit pane environment still reaches the desktop app");
    }

    #[test]
    fn cursor_payloads_are_scrubbed() {
        let common = r#""conversation_id":"c0ff","generation_id":"g-01","model":"gpt-5","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":"SECRET@example.com","transcript_path":null"#;
        let cases = [
            r#""hook_event_name":"beforeSubmitPrompt","prompt":"SECRET","attachments":[{"type":"file","filePath":"SECRET"}]"#,
            r#""hook_event_name":"afterShellExecution","command":"npm test","output":"SECRET","duration":5120,"sandbox":false"#,
            r#""hook_event_name":"postToolUse","tool_name":"Shell","tool_input":{"command":"npm test"},"tool_output":"SECRET","tool_use_id":"tool_01","duration":5130"#,
            r#""hook_event_name":"afterFileEdit","file_path":"C:/Users/dev/src/demo/src/app.ts","edits":[{"old_string":"SECRET","new_string":"SECRET"}]"#,
            r#""hook_event_name":"beforeReadFile","file_path":"C:/x.ts","content":"SECRET","attachments":[]"#,
            r#""hook_event_name":"afterAgentResponse","text":"SECRET""#,
            r#""hook_event_name":"afterAgentThought","text":"SECRET""#,
            r#""hook_event_name":"preToolUse","tool_name":"Shell","tool_input":{"command":"ls"},"tool_use_id":"t","cwd":"C:/w","agent_message":"SECRET""#,
        ];
        for case in cases {
            let out = scrub("cursor", &format!("{{{common},{case}}}"));
            assert_no_secret(&out);
            assert_eq!(out["conversation_id"], "c0ff");
            assert_eq!(out["model"], "gpt-5");
            assert_eq!(out["cursor_version"], "2026.10.01-e373342");
        }
        let shell = scrub("cursor", &format!("{{{common},{}}}", cases[1]));
        assert_eq!(shell["command"], "npm test");
        let edit = scrub("cursor", &format!("{{{common},{}}}", cases[3]));
        assert_eq!(edit["file_path"], "C:/Users/dev/src/demo/src/app.ts");
        let end = scrub("cursor", &format!("{{{common},\"hook_event_name\":\"sessionEnd\",\"session_id\":\"c0ff\",\"reason\":\"user_close\",\"duration_ms\":402000,\"final_status\":\"completed\"}}"));
        assert_eq!(end["reason"], "user_close");
    }

    #[test]
    fn agent_specific_fields_are_kept_for_other_agents() {
        let v = serde_json::json!({"content": "kept", "text": "kept"});
        assert_eq!(scrub_payload_for("claude-code", v.clone()), v);
        assert_eq!(scrub_payload_for("codex", v.clone()), v);
    }

    // -- tool arguments and output (every agent, M4) ------------------------------------

    fn claude_tool(event: &str, tool: &str, input: &str, response: &str) -> serde_json::Value {
        scrub(
            "claude-code",
            &format!(
                r#"{{"session_id":"abc","transcript_path":"C:\\t.jsonl","cwd":"C:\\work\\app","permission_mode":"default","hook_event_name":"{event}","tool_name":"{tool}","tool_input":{input},"tool_response":{response},"tool_use_id":"toolu_01"}}"#
            ),
        )
    }

    #[test]
    fn claude_edit_tools_keep_only_the_path() {
        let edit = claude_tool(
            "PostToolUse",
            "Edit",
            r#"{"file_path":"C:\\work\\app\\src\\a.ts","old_string":"SECRET old","new_string":"SECRET new","replace_all":false}"#,
            r#"{"filePath":"C:\\work\\app\\src\\a.ts","oldString":"SECRET","newString":"SECRET","originalFile":"SECRET","structuredPatch":[{"lines":["SECRET"]}],"userModified":false}"#,
        );
        assert_no_secret(&edit);
        assert_eq!(edit["tool_input"], serde_json::json!({"file_path":"C:\\work\\app\\src\\a.ts","replace_all":false}));
        assert_eq!(edit["tool_use_id"], "toolu_01");
        assert!(edit.get("tool_response").is_none());

        let multi = claude_tool(
            "PreToolUse",
            "MultiEdit",
            r#"{"file_path":"C:\\work\\app\\b.ts","edits":[{"old_string":"SECRET","new_string":"SECRET"},{"old_string":"SECRET","new_string":"SECRET","replace_all":true}]}"#,
            "null",
        );
        assert_no_secret(&multi);
        assert_eq!(multi["tool_input"], serde_json::json!({"file_path":"C:\\work\\app\\b.ts"}));

        let write = claude_tool("PostToolUse", "Write", r#"{"file_path":"C:\\work\\app\\c.md","content":"SECRET body"}"#, r#"{"type":"create","filePath":"C:\\work\\app\\c.md","content":"SECRET"}"#);
        assert_no_secret(&write);
        assert_eq!(write["tool_input"]["file_path"], "C:\\work\\app\\c.md");

        let notebook = claude_tool("PreToolUse", "NotebookEdit", r#"{"notebook_path":"C:\\work\\n.ipynb","cell_id":"c1","new_source":"SECRET","cell_type":"code","edit_mode":"replace"}"#, "null");
        assert_no_secret(&notebook);
        assert_eq!(notebook["tool_input"], serde_json::json!({"notebook_path":"C:\\work\\n.ipynb","cell_id":"c1"}));
    }

    #[test]
    fn claude_shell_search_and_task_tools_keep_their_metadata() {
        let bash = claude_tool("PostToolUse", "Bash", r#"{"command":"npm test","description":"Run the tests","timeout":120000}"#, r#"{"stdout":"SECRET","stderr":"SECRET","interrupted":false}"#);
        assert_no_secret(&bash);
        assert_eq!(bash["tool_input"], serde_json::json!({"command":"npm test","description":"Run the tests"}));

        let grep = claude_tool("PreToolUse", "Grep", r#"{"pattern":"TODO","path":"src","glob":"*.ts","output_mode":"content"}"#, "null");
        assert_eq!(grep["tool_input"], serde_json::json!({"pattern":"TODO","path":"src","glob":"*.ts"}));

        let read = claude_tool("PostToolUse", "Read", r#"{"file_path":"C:\\work\\app\\a.ts","offset":10,"limit":50}"#, r#"{"type":"text","file":{"content":"SECRET"}}"#);
        assert_no_secret(&read);
        assert_eq!(read["tool_input"]["offset"], 10);

        let task = claude_tool("PreToolUse", "Task", r#"{"description":"Find callers","prompt":"SECRET instructions","subagent_type":"Explore"}"#, "null");
        assert_no_secret(&task);
        assert_eq!(task["tool_input"], serde_json::json!({"description":"Find callers","subagent_type":"Explore"}));

        let fetch = claude_tool("PreToolUse", "WebFetch", r#"{"url":"https://example.com","prompt":"SECRET"}"#, "null");
        assert_no_secret(&fetch);
        assert_eq!(fetch["tool_input"]["url"], "https://example.com");

        let plan = claude_tool("PreToolUse", "ExitPlanMode", r#"{"plan":"SECRET plan"}"#, "null");
        assert_no_secret(&plan);
        let mcp = claude_tool("PreToolUse", "mcp__slack__post", r#"{"channel":"x","text":"SECRET"}"#, "null");
        assert_no_secret(&mcp);
        assert_eq!(mcp["tool_input"], serde_json::json!({}));

        let long = "x".repeat(MAX_TOOL_ARG_CHARS + 10);
        let clipped = claude_tool("PreToolUse", "Bash", &format!(r#"{{"command":"{long}","description":"{long}"}}"#), "null");
        assert_eq!(clipped["tool_input"]["command"].as_str().unwrap().len(), MAX_TOOL_ARG_CHARS);
        assert_eq!(clipped["tool_input"]["description"].as_str().unwrap().len(), MAX_LABEL_CHARS);
    }

    #[test]
    fn claude_todo_write_keeps_the_plan_clipped() {
        let long = "y".repeat(300);
        let todo = claude_tool(
            "PreToolUse",
            "TodoWrite",
            &format!(r#"{{"todos":[{{"content":"Add tests","status":"completed","activeForm":"Adding tests","priority":"high"}},{{"content":"{long}","status":"in_progress","id":"2"}}]}}"#),
            r#"{"oldTodos":[{"content":"SECRET"}],"newTodos":[]}"#,
        );
        assert_no_secret(&todo);
        let todos = todo["tool_input"]["todos"].as_array().unwrap();
        assert_eq!(todos[0], serde_json::json!({"content":"Add tests","status":"completed"}));
        assert_eq!(todos[1]["content"].as_str().unwrap().len(), MAX_LABEL_CHARS);
        assert_eq!(todos[1]["id"], "2");
    }

    #[test]
    fn codex_apply_patch_keeps_only_the_file_paths() {
        let patch = r"*** Begin Patch\n*** Update File: src/app.ts\n@@\n-SECRET old\n+SECRET new\n*** Add File: docs/new.md\n+SECRET\n*** Update File: src/app.ts\n*** Move to: src/main.ts\n*** Delete File: old.txt\n*** End Patch";
        let out = scrub(
            "codex",
            &format!(r#"{{"session_id":"c1","cwd":"C:\\work\\app","hook_event_name":"PreToolUse","model":"gpt-5-codex","tool_name":"apply_patch","tool_input":{{"command":"{patch}"}},"tool_use_id":"call_1"}}"#),
        );
        assert_no_secret(&out);
        assert_eq!(out["tool_input"], serde_json::json!({"paths":["src/app.ts","docs/new.md","src/main.ts","old.txt"]}));

        let post = scrub("codex", &format!(r#"{{"session_id":"c1","hook_event_name":"PostToolUse","tool_name":"apply_patch","tool_input":{{"input":"{patch}"}},"tool_response":"SECRET"}}"#));
        assert_no_secret(&post);
        assert_eq!(post["tool_input"]["paths"][0], "src/app.ts");

        let bash = scrub("codex", r#"{"session_id":"c1","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"SECRET"}"#);
        assert_no_secret(&bash);
        assert_eq!(bash["tool_input"]["command"], "cargo test");
    }

    #[test]
    fn other_agents_tool_arguments_are_scrubbed() {
        let qwen = scrub("qwen", r#"{"session_id":"q","hook_event_name":"PreToolUse","tool_name":"write_file","tool_input":{"file_path":"C:\\w\\a.ts","content":"SECRET"},"tool_use_id":"t1"}"#);
        assert_no_secret(&qwen);
        assert_eq!(qwen["tool_input"]["file_path"], "C:\\w\\a.ts");
        let qwen_read = scrub("qwen", r#"{"session_id":"q","hook_event_name":"PreToolUse","tool_name":"read_file","tool_input":{"absolute_path":"C:\\w\\b.ts"}}"#);
        assert_eq!(qwen_read["tool_input"]["absolute_path"], "C:\\w\\b.ts");

        let gemini = scrub("gemini", r#"{"session_id":"g","hook_event_name":"BeforeTool","tool_name":"replace","tool_input":{"file_path":"C:\\w\\a.ts","old_string":"SECRET","new_string":"SECRET","instruction":"SECRET"}}"#);
        assert_no_secret(&gemini);
        assert_eq!(gemini["tool_input"], serde_json::json!({"file_path":"C:\\w\\a.ts"}));

        let droid = scrub("droid", r#"{"session_id":"d","hook_event_name":"PreToolUse","tool_name":"Create","tool_input":{"file_path":"C:\\w\\n.ts","content":"SECRET"}}"#);
        assert_no_secret(&droid);
        assert_eq!(droid["tool_input"]["file_path"], "C:\\w\\n.ts");

        let copilot = scrub("copilot", r#"{"sessionId":"s","toolName":"edit","toolArgs":"{\"path\":\"C:\\\\w\\\\a.ts\",\"old_str\":\"SECRET\",\"new_str\":\"SECRET\"}","toolResult":{"resultType":"success"}}"#);
        assert_no_secret(&copilot);
        let args: serde_json::Value = serde_json::from_str(copilot["toolArgs"].as_str().unwrap()).unwrap();
        assert_eq!(args, serde_json::json!({"path":"C:\\w\\a.ts"}));
        let bad = scrub("copilot", r#"{"sessionId":"s","toolName":"x","toolArgs":"SECRET not json"}"#);
        assert_no_secret(&bad);
        let create = scrub("copilot", r#"{"sessionId":"s","toolName":"create","toolInput":{"path":"C:\\w\\n.md","file_text":"SECRET"}}"#);
        assert_no_secret(&create);
        assert_eq!(create["toolInput"]["path"], "C:\\w\\n.md");

        let cursor = scrub("cursor", r#"{"conversation_id":"c","hook_event_name":"postToolUse","tool_name":"Write","tool_input":{"file_path":"C:/w/a.ts","contents":"SECRET"},"tool_output":"SECRET"}"#);
        assert_no_secret(&cursor);
        assert_eq!(cursor["tool_input"]["file_path"], "C:/w/a.ts");
    }

    #[test]
    fn patch_file_paths_ignores_body_lines_and_duplicates() {
        assert!(patch_file_paths("no patch here").is_empty());
        assert_eq!(
            patch_file_paths("*** Begin Patch\r\n*** Update File: a.rs\r\n+*** Add File: fake\r\n*** Update File: a.rs\r\n*** End Patch"),
            vec!["a.rs".to_string()]
        );
    }

    #[test]
    fn spooled_permission_request_holds_no_edit_content() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_map(&[(ENV_DATA_DIR, dir.path().to_str().unwrap())]);
        let stdin = r#"{"session_id":"abc","hook_event_name":"PermissionRequest","tool_name":"Write","tool_input":{"file_path":"C:\\w\\a.ts","content":"SECRET"}}"#;
        run_with(&args("PermissionRequest"), &env, &mut Cursor::new(stdin.as_bytes().to_vec()), &no_pipe, &fake_chain, &no_emit);
        let files = spooled(dir.path());
        assert_eq!(files.len(), 1);
        let body = std::fs::read_to_string(&files[0]).unwrap();
        assert!(!body.contains("SECRET"), "{body}");
        assert!(body.contains("a.ts"));
    }

    #[test]
    fn remove_path_ignores_missing_and_non_object_parents() {
        let mut obj = serde_json::json!({"details": "str", "a": {"b": {"c": 1, "d": 2}}});
        let map = obj.as_object_mut().unwrap();
        remove_path(map, "details.newContent");
        remove_path(map, "missing.x");
        remove_path(map, "a.b.c");
        assert_eq!(obj, serde_json::json!({"details": "str", "a": {"b": {"d": 2}}}));
    }
}
