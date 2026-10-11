# Agent research: Factory Droid CLI and Cursor CLI

Researched 2026-10-06 for the M-phase adapters (`PRD.md` §5.4). Neither CLI is installed on the
dev machine; everything below comes from official docs, changelogs, installer scripts (downloaded
and read, not executed) and public bug reports / third-party parsers. **UNVERIFIED** marks
anything not confirmed by an official source or that needs a live check on Windows.

| | Factory Droid | Cursor CLI |
|---|---|---|
| Version researched | CLI **0.234.0** (Windows installer, 2026-10-06); changelog top entry 0.233.0 (2026-10-03) | **2026.10.01-e373342** (Windows installer, 2026-10-06); changelog top entry 2026-08-26 |
| Native Windows | **Yes**: `irm https://app.factory.ai/cli/windows \| iex` → `%USERPROFILE%\bin\droid.exe` | **Yes**: `irm 'https://cursor.com/install?win32=true' \| iex` → `%LOCALAPPDATA%\cursor-agent\` |
| Hook config (user) | `%USERPROFILE%\.factory\hooks.json` (or the `hooks` key in `settings.json`) | `%USERPROFILE%\.cursor\hooks.json` |
| Hook shell on Windows | `cmd.exe /d /s /c <command>` | docs say cmd.exe; bug reports show PowerShell wrapper or bash (see risks) |
| WaitingPermission signal | **Yes**: `Notification` with `notification_type: "permission_prompt"` | **No** hook for it (only screen heuristics) |
| Done / waiting for input | `Stop`, `Notification idle_prompt` | `stop` (interactive only; not in `-p`) |
| Token usage on disk | **Yes**: `sessions/<project>/<id>.settings.json` → `tokenUsage` (cumulative) | **No**: transcripts have no tokens and no model |
| Plan limits locally | None | None |
| Headless AI provider | `droid exec -o text [-m model] "prompt"` (default autonomy = read-only) | `agent -p --output-format text --mode ask --trust [--model m] "prompt"` |

---

## 1. Factory Droid CLI

### 1.1 Install, detection, close

- Install methods (official quickstart / CLI reference):
  - Windows: `irm https://app.factory.ai/cli/windows | iex`. The installer script downloads
    `https://downloads.factory.ai/factory-cli/releases/<ver>/windows/<arch>/droid.exe`, verifies
    the SHA-256, copies it to **`%USERPROFILE%\bin\droid.exe`** and adds that folder to the user PATH.
    It stops running `droid` processes before replacing the file.
  - npm: `npm install -g droid`. The npm package wraps a platform binary (`@factory/cli-<platform>`,
    per tokenx's facts doc) and has auto-update disabled.
  - macOS/Linux: `curl -fsSL https://app.factory.ai/cli | sh` or `brew install --cask droid`.
- Detection: look for `droid.exe` on PATH, in `%USERPROFILE%\bin\`, or under the npm global bin
  (`droid.cmd`). Read the version with `droid --version` (the flag is **UNVERIFIED** because the CLI reference does not list it).
- Data dir: `%USERPROFILE%\.factory\` (settings doc: Windows `%USERPROFILE%\.factory\settings.json`).
- Graceful close: `/quit` (aliases `exit`), or press **Ctrl+C twice quickly** (one press cancels the current operation).
  Recommended sequence: Esc (dismiss an overlay) → Ctrl+C (cancel the turn) → type `/quit` + Enter →
  fall back to a second Ctrl+C.

### 1.2 Hooks

**Files** (`docs.factory.com/harness/hooks`): user `~/.factory/hooks.json`, project `.factory/hooks.json`,
org-managed, plugin `hooks/hooks.json`. Legacy `.factory/hooks/hooks.json` still loads and is migrated
on the next save. **"If `hooks.json` is absent, Droid also reads hook declarations from the `hooks`
key in the matching `settings.json`."**

> Merger consequence: if the user has no `hooks.json` but has a `hooks` key in `settings.json`,
> creating `hooks.json` would silently disable the user's settings.json hooks. In that case write
> into `settings.json` → `hooks` (or ask the user). If `hooks.json` exists, write there.

**Shape** (standalone file is keyed directly by event; inside `settings.json` it is wrapped in `"hooks"`):

```json
{
  "SessionStart": [
    { "hooks": [ { "type": "command", "command": "C:/Users/u/AppData/Local/agent-hub/agenthub-hook.exe --agent droid --event SessionStart", "timeout": 10 } ] }
  ],
  "PreToolUse": [
    { "matcher": "*", "hooks": [ { "type": "command", "command": "…agenthub-hook.exe --agent droid --event PreToolUse" } ] }
  ]
}
```

Fields: `matcher` (optional; empty, `*` or omitted = all; case-sensitive regex; tool names
`Execute, Read, Edit, Create, ApplyPatch, LS, Glob, Grep, Task, FetchUrl, WebSearch`, `mcp__<srv>__<tool>`),
`commandRegex` (optional, Execute only), `hooks[]` with `type: "command"` (only type), `command`,
`timeout` (seconds, default 60). No version field.

**Events** and agent-hub state mapping:

| Event | Key payload fields | Suggested state |
|---|---|---|
| `SessionStart` | `source` = `startup`/`resume`/`clear`/`compact` (+ optional prior session ids, field names **UNVERIFIED**) | session open → Idle |
| `UserPromptSubmit` | `prompt`, `has_images` | Working (never store `prompt`) |
| `PreToolUse` | `tool_name`, `tool_input` | Working (tool activity) |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | Working |
| `Notification` | `message`, `notification_type`: `permission_prompt` / `idle_prompt` / `auth_success` / `elicitation_dialog` | `permission_prompt` → **WaitingPermission**; `idle_prompt` / `elicitation_dialog` → **WaitingInput** |
| `Stop` | `stop_hook_active`, `tool_execution_count`, `elapsed_time` | Done |
| `SubagentStop` | `task_name`, `task_result`, `task_error`, `stop_hook_active` | (subagent) no top-level change |
| `PreCompact` | `trigger` (`manual`/`auto`), `custom_instructions`, `message_count`, `estimated_tokens` | unchanged |
| `SessionEnd` | `reason` (`clear`/`logout`/`prompt_input_exit`/`other`), `session_duration_ms`, `message_count` | Closed |

Notes:
- "Cancellation emits the informational `Notification` hook instead of `Stop`". The changelog says
  "`idle_prompt` Notification hook now fires on cancelled turns", so after a user cancel expect
  `Notification idle_prompt` and **no** `Stop`.
- Errors: there is no dedicated error event. A failed turn surfaces only as `Stop`/`idle_prompt` (**UNVERIFIED**).
- Common stdin fields on every event: `session_id`, `transcript_path`, `cwd`,
  `permission_mode` (`off`/`spec`/`auto-low`/`auto-medium`/`auto-high`), `hook_event_name`,
  optional `message_id`. The payload has **no model field**; read it from the session settings file (§1.4).
- String, boolean and number fields are also exported as environment variables (exact names **UNVERIFIED**).
  `FACTORY_PROJECT_DIR` is set. `DROID_PLUGIN_ROOT` is set for plugin hooks only.
- **Output semantics:** exit 0 means success. For `UserPromptSubmit`/`SessionStart`, stdout is added to context; for other events
  stdout is shown in transcript views. Exit 2 blocks (PreToolUse / UserPromptSubmit) or feeds stderr back.
  Any other exit code is a non-blocking error. **Empty stdout + exit 0 is a no-op for every event**, so our sidecar's
  "no stdout, exit 0" contract is safe for Droid.
- **Windows execution:** Droid's Windows build runs hook commands with cmd.exe. Evidence from
  entireio/cli PR #2349 (binary inspection): 0.109.1 `spawn("cmd.exe",["/c",H])`, 0.178.0
  `shell:"cmd.exe"`, 0.215.1 `spawn(%ComSpec%,["/d","/s","/c",H],{windowsVerbatimArguments:true})`.
  postman-plugin PR #67 (Droid 0.231.0) confirms cmd.exe and that a `"shell"` override is ignored.
  So the command must be cmd-compatible: a quoted absolute exe path plus plain args, with no `>/dev/null`, `&`, `||` or `$VAR`.
  Changelog: "Windows hooks – preserved command quoting", "Plugin hooks now run on Windows when their
  command path contains spaces".
- Enable/trust: no trust prompt is documented. `hooksDisabled: true` in settings disables all hooks.
  An org setting `allowManagedHooksOnly` ignores user hooks. "Droid snapshots hooks at startup and warns when hooks
  are modified externally". An install therefore takes effect from the **next** session, and the user may see a
  warning in `/hooks`.
- Hooks in `droid exec`: whether they fire is **UNVERIFIED** (probably yes). The hub should ignore or tag sessions it
  started itself for the AI provider (for example with an env marker).

### 1.3 Permission prompt keys

Droid uses a TUI menu, selected with the arrow keys + **Enter**, and **Esc** dismisses/rejects (the changelog fix
"approval prompt no longer stays wedged … so Enter and Esc respond again"). Documented options:
approve/reject, and an "always allow" option that **raises the session Autonomy Level** to the level
the prompt requires (sandbox prompts persist the path/domain instead). `Alt+E` toggles approval details.
The exact option labels, their order and any numeric shortcuts are **UNVERIFIED**. Capture them from a live session
before wiring Allow once / Always / Deny buttons; until then use the "answer in terminal" fallback.

### 1.4 Usage / tokens on disk

Sources: tokenx `docs/facts/droid.md` (verified against Droid 0.174.0, 2026-07-18), Maestro
`factory-droid-session-storage.ts` (verified 2026-01-16), ccusage/tokscale/openusage parsers.

```
%USERPROFILE%\.factory\sessions\<project-key>\<session-id>.jsonl          # event log
%USERPROFILE%\.factory\sessions\<project-key>\<session-id>.settings.json  # metadata + cumulative tokens
```

- `<project-key>` is the cwd with `/` and `\` replaced by `-` (`/Users/me/proj` → `-Users-me-proj`).
  **The Windows form (drive colon handling) is UNVERIFIED.** Do not compute it. Use the hook's
  `transcript_path` (the `.jsonl`) and its sibling `<id>.settings.json`, or scan `sessions/*/<id>.*`.
  (The hooks doc example shows `…/.factory/projects/…/session.jsonl` for `transcript_path`, but all
  parsers use `sessions/`. Trust the payload value.)
- `settings.json`: `model` (e.g. `"claude-sonnet-4-5-20250929"` or `"custom:glm-5.1"`), `reasoningEffort`,
  `autonomyMode`, `assistantActiveTimeMs`, `providerLock`, `providerLockTimestamp` (RFC 3339),
  `apiProviderLock`, and `tokenUsage { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
  thinkingTokens }`. The file is **rewritten after each turn with running totals**, so cost must be computed from
  deltas against the last seen totals (agent-beacon PR #733). Changelog: "Session token usage is now
  counted only on successful turns". `custom:` models are BYOK. `providerLock` is a wire-protocol
  label, not the model vendor.
- `.jsonl` records: the first line is `{"type":"session_start","id":…,"cwd":…,"title":…}`, followed by
  `{"type":"message","id":…,"parentId"?:…,"timestamp":…,"message":{"role":"user"|"assistant","content":[…]}}`
  and others (e.g. `compaction_state`). There are **no per-message token fields**. Never persist `content`.
- Plan limits: none locally. Credits and caps are server-side (Factory web / Analytics API), so show "unknown".

### 1.5 Headless (AI provider)

```
droid exec -o text [-m <model-id>] --cwd <empty temp dir> "<prompt>"
```
- With no `--auto`, the default autonomy is **read-only** ("file reads, git diffs, environment inspection"). Never
  pass `--auto` or `--skip-permissions-unsafe`. To restrict further: `--disabled-tools <ids>` or
  `--restrict-tools <ids>` (whether an empty list is accepted is **UNVERIFIED**; `droid exec --list-tools` shows the ids).
- `-o json` → `{"type":"result","subtype":"success","is_error":false,"duration_ms":…,"num_turns":1,"result":"…","session_id":"…"}`.
  Exit code 0 on success.
- Auth: the docs show `FACTORY_API_KEY`. Whether an interactive login alone is enough for `exec` is **UNVERIFIED**.
  We must not read or set the key (hard rule 3). If exec fails unauthenticated, report "configure Droid login".
- Note that `-r` means `--reasoning-effort` in exec but `--resume` in interactive mode.

---

## 2. Cursor CLI (`agent` / `cursor-agent`)

### 2.1 Install, detection, close

- Windows native installer (script read 2026-10-06, version `2026.10.01-e373342`): it downloads
  `https://downloads.cursor.com/lab/<ver>/windows/<arch>/agent-cli-package.zip` and extracts it to
  `%LOCALAPPDATA%\cursor-agent\versions\<ver>\`. It then copies the `cursor-agent*` files to `%LOCALAPPDATA%\cursor-agent\`
  and creates the aliases **`agent.exe` / `agent.cmd` / `agent.ps1`** next to `cursor-agent.*`, and adds that folder
  to the user PATH. Installing **deletes the whole `%LOCALAPPDATA%\cursor-agent` directory first**.
- macOS/Linux/WSL: `curl https://cursor.com/install -fsS | bash` → `~/.local/bin/agent` (+ `cursor-agent`).
- Detection: `agent.exe` / `cursor-agent.exe` (or `.cmd`) in `%LOCALAPPDATA%\cursor-agent\` or on PATH.
  `agent --version`. **Name clash:** `agent` is generic, so prefer `cursor-agent` for detection and
  verify with `--version` output or the install path.
- Auto-updates by default (`agent update` updates manually).
- Graceful close: **Ctrl+D twice** (docs: "requires a double-press"). Whether `/quit`/`/exit` or Ctrl+C work is
  **UNVERIFIED**.

### 2.2 Hooks

**Files** (`cursor.com/docs/hooks`): enterprise `C:\ProgramData\Cursor\hooks.json`, team (dashboard),
project `<root>/.cursor/hooks.json`, user `~/.cursor/hooks.json` (relative paths resolve from `~/.cursor/`).
All sources run and their responses merge (deny > ask > allow). Config changes are hot-reloaded. The docs and the CLI changelog
(2026-01) state that the CLI uses the same files.

**Shape:**
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [ { "command": "C:/…/agenthub-hook.exe --agent cursor --event sessionStart", "timeout": 5 } ],
    "stop":         [ { "command": "C:/…/agenthub-hook.exe --agent cursor --event stop", "timeout": 5 } ]
  }
}
```
`version` (required, `1`). Per entry: `command` (required), `type` (`command`|`prompt`), `timeout` (s),
`matcher` (regex), `loop_limit` (stop/subagentStop), `failClosed` (default false).

**Events (agent):** `sessionStart, sessionEnd, preToolUse, postToolUse, postToolUseFailure,
subagentStart, subagentStop, beforeShellExecution, afterShellExecution, beforeMCPExecution,
afterMCPExecution, beforeReadFile, afterFileEdit, beforeSubmitPrompt, preCompact, stop,
afterAgentResponse, afterAgentThought`. Tab events: `beforeTabFileRead, afterTabFileEdit`. App: `workspaceOpen`.

**Common stdin fields:** `conversation_id, generation_id, model, model_id?, model_params[],
hook_event_name, cursor_version, workspace_roots[], user_email, transcript_path`. Per event:
- `sessionStart`: `session_id, is_background_agent, composer_mode?`
- `sessionEnd`: `session_id, reason` (`completed|aborted|error|window_close|user_close`), `duration_ms, final_status, error_message?`
- `beforeSubmitPrompt`: `prompt, attachments` (output `continue`)
- `preToolUse`: `tool_name, tool_input, tool_use_id, cwd, agent_message`
- `postToolUse`: `tool_name, tool_input, tool_output, tool_use_id, duration`; `postToolUseFailure`: `+error_message, failure_type, is_interrupt`
- `beforeShellExecution`: `command, cwd, sandbox`; `afterShellExecution`: `command, output, duration, sandbox`
- `afterFileEdit`: `file_path, edits[]`; `beforeReadFile`: `file_path, content, attachments`
- `stop`: `status` (`completed|aborted|error`), `loop_count`
- `preCompact`: `trigger, context_usage_percent, context_tokens, context_window_size, …`

Env passed to hooks: `CURSOR_PROJECT_DIR, CURSOR_VERSION, CURSOR_USER_EMAIL, CURSOR_TRANSCRIPT_PATH,
CURSOR_CODE_REMOTE, CLAUDE_PROJECT_DIR` (alias). Do **not** store `user_email` (personal data).

**What actually fires in the CLI (not the IDE)** comes from forum threads 148316 (2026-05) and 169059 (2026-08-21, CLI
2026.08.11, macOS):
- Interactive local CLI: `sessionStart`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`,
  `postToolUse`, `stop`, `sessionEnd`, `beforeReadFile`, `afterAgentThought`. `beforeSubmitPrompt` and
  `afterAgentResponse` were reported **missing** (staff: "hook parity … on the roadmap", no ETA).
- `-p` headless: `beforeSubmitPrompt`, `afterAgentResponse` and `stop` are **not** fired.
- One report (loongsuite-pilot #452, v2026.09.23) claims no user hooks fire from the CLI at all. This is
  **UNVERIFIED/contradicted** by staff replies but needs a live Windows check.
- In the CLI, `generation_id` is inconsistent. Use **`conversation_id`** as the session key (staff advice).

**State mapping (best available):** `sessionStart` → Idle. The first `beforeSubmitPrompt` (if it fires) or the first
`postToolUse`/`afterShellExecution`/`afterFileEdit` → Working. `stop` → Done (`status: error` →
Error). `sessionEnd` → Closed. Pure-text turns may never show Working if `beforeSubmitPrompt` does not
fire. **There is no WaitingPermission/WaitingInput hook** (Claude's `Notification`/`PermissionRequest`
are explicitly "not supported" in the mapping), so the PRD's "Kısmi" (partial) rating stands. WaitingPermission needs a screen
heuristic on the `(y)/(n)` approval prompt.

**Output contract and empty stdout (IMPORTANT):**
- Exit 0 means "use the JSON output". For **permission hooks** (`preToolUse`, `beforeShellExecution`,
  `beforeMCPExecution`, `beforeReadFile`, `subagentStart`), *"invalid JSON or a response that does not match
  the hook's schema blocks the action"*. Several integrations hit exactly this: an empty stdout with exit 0
  produced "Hook returned invalid JSON" and **blocked every tool call** (stablyai/orca #15462 on Windows,
  agentguard #62 2026-10-05, agent-presence #89 2026-10-06). The earlier fail-open-on-malformed behaviour
  (forum 152669, Feb 2026) was "addressed" by May 2026, so assume **fail-closed**.
- Exit 2 → deny. Other non-zero exit codes → fail-open (unless `failClosed: true`).
- Printing `{"permission":"allow"}` would **auto-approve** and bypass the user's prompt. That is not acceptable.
  `{"permission":"ask"}` would force a prompt even for allowlisted commands. So **agent-hub must not register any
  permission hook for Cursor.**
- For non-permission events, whether empty stdout is harmless is **UNVERIFIED**. orca's fix emits `{}`
  for them. `beforeSubmitPrompt` expects `continue`, so empty or `{}` might block the prompt (**UNVERIFIED**).
- Recommendation: register only `sessionStart, sessionEnd, postToolUse, afterShellExecution,
  afterFileEdit, stop` (and optionally `beforeSubmitPrompt`). Add a Cursor mode to the sidecar that prints
  `{}` (or `{"continue":true}` for `beforeSubmitPrompt`) and still exits 0. This is a deliberate exception to
  the "never write stdout" rule and needs a `docs/DECISIONS.md` entry.

**Windows execution problems (all open as of the last post):**
- Docs: "Commands execute in a shell (bash on Unix, cmd.exe on Windows)". Reports show a **PowerShell
  wrapper** (orca) and **bash eval when `MSYSTEM` is set** (forum 168129, lezli01 blog, CLI 2026.08.11).
  Keep the command shell-neutral: an unquoted forward-slash absolute path to the exe without spaces, plus plain args.
  If the path has spaces, PowerShell needs `&`, bash needs quotes, and cmd needs quotes, so install the sidecar to a path without spaces.
- **UTF-8 BOM prefixed to the stdin JSON** on Windows (forum 168407, staff-confirmed). The sidecar must
  strip `\uFEFF` before parsing.
- On Windows headless, hooks reportedly **block for the full `timeout`** instead of returning on process exit
  (forum 169942, CLI 2026.08.25–09.02). Keep `timeout` small (e.g. 5) for our observational hooks.
- Hooks double-firing on the Windows CLI were reported (forum 157184). The hub must dedupe.

**Third-party import, a cross-adapter risk (affects our existing Claude adapter):** Cursor loads
Claude Code hooks from `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json` when
"Include Third-Party Plugins, Skills, and Other Configs" is on. **That setting is on by default; in the CLI it is hardcoded on**
with no opt-out (forum 166558). `PreToolUse` is mapped to `preToolUse`, which is a permission hook. Our Claude
merger installs `PreToolUse` with a silent sidecar, so on a machine with Cursor, **Cursor may block
every tool call** (agent-presence #89 describes exactly this; whether empty output is treated as invalid there is
**UNVERIFIED**). Cursor also sends its own payloads to our sidecar under `--agent claude`, which creates ghost
Claude sessions. Mitigation: the sidecar detects Cursor (stdin has `cursor_version`, or env `CURSOR_VERSION`
is set). In that case, for `PreToolUse`/`UserPromptSubmit` it prints a neutral response. `{}`
must be checked live; an "allow" response is not acceptable. Otherwise drop the event or re-tag it as cursor. Verify this live before shipping.

### 2.3 Permission prompt keys

Docs (`cursor.com/docs/cli/using`): "Before running terminal commands, CLI will ask you to approve
(**y**) or reject (**n**) execution." The prompt also offers an allowlist/"auto-run" option (Run Modes
docs mention "Add to allowlist"). Its key is **UNVERIFIED**. Shift+Tab rotates modes (Agent/Plan/Ask),
not approvals. Mode-switch approvals use a pager with a 15 s countdown (changelog 2026-07-20).
Permissions config: `~/.cursor/cli-config.json` and `<project>/.cursor/cli.json`, with `permissions.allow`/`deny` arrays
of `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`.

### 2.4 Usage / tokens on disk

- Transcripts: `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` (subagents in
  `subagents/`). Claude-compatible JSONL (changelog Feb 2026) with roles, text and tool calls, and **no model and
  no token counters** (meq PR #2, multiple parsers). Metadata: `~/.cursor/chats/<workspace-hash>/<session-id>/store.db` (SQLite).
  The Windows slug format is **UNVERIFIED**.
- Tokens exist only in the `stream-json` stdout of `-p` runs and in the Admin API (`/teams/filtered-usage-events`).
  The TUI `/usage` (2026-07-13) shows account meters fetched from the server. **The PRD's "no data" holds:** show "no data".
- Plan limits: none locally. `/usage` is server-side, so show "unknown".

### 2.5 Headless (AI provider)

```
agent -p --output-format text --mode ask --trust [--model <id>] "<prompt>"
```
- `-p/--print` is non-interactive. `--output-format text` returns "only the final assistant message".
  `--mode ask` is read-only Q&A. Without `--force`, "changes are only proposed, not applied". `--trust` skips
  the workspace-trust prompt (headless only). `--model` selects the model.
- `--output-format json` returns `{"type":"result","subtype":"success","is_error":false,"duration_ms":…,"duration_api_ms":…,"result":"…","session_id":"…","request_id":…}`.
- Auth: an existing `agent login` session or `CURSOR_API_KEY`. We neither read nor set the key. Run it in an empty temp
  dir as cwd (`--workspace <dir>`). Hooks (sessionStart etc.) will fire for these runs, so tag them or ignore them.

---

## 3. Fixtures (synthetic, from the documented schemas)

### 3.1 Droid hook payloads

```json
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"C:\\Users\\dev\\.factory\\sessions\\-C-Users-dev-src-demo\\7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6.jsonl","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"SessionStart","source":"startup"}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"C:\\Users\\dev\\.factory\\sessions\\-C-Users-dev-src-demo\\7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6.jsonl","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"UserPromptSubmit","prompt":"<redacted>","has_images":false}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"PreToolUse","message_id":"msg_01","tool_name":"Execute","tool_input":{"command":"npm test","riskLevel":"low"}}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"Notification","message":"Droid needs your permission to use Execute","notification_type":"permission_prompt"}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"PostToolUse","tool_name":"Execute","tool_input":{"command":"npm test"},"tool_response":{"exitCode":0,"output":"<redacted>"}}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"Stop","stop_hook_active":false,"tool_execution_count":3,"elapsed_time":41250}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"Notification","message":"Droid is waiting for your input","notification_type":"idle_prompt"}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"SubagentStop","task_name":"explorer","task_result":"<redacted>","task_error":null,"stop_hook_active":false}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"PreCompact","trigger":"auto","custom_instructions":"","message_count":84,"estimated_tokens":181000}
{"session_id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","transcript_path":"…same…","cwd":"C:\\Users\\dev\\src\\demo","permission_mode":"off","hook_event_name":"SessionEnd","reason":"prompt_input_exit","session_duration_ms":612000,"message_count":12}
```
(The `tool_input`/`tool_response` inner shapes, the `message` wording, the `elapsed_time` unit and the Windows
project-key format are **UNVERIFIED**.)

### 3.2 Droid session files

`<id>.settings.json`:
```json
{"model":"claude-sonnet-4-5-20250929","reasoningEffort":"medium","autonomyMode":"normal","assistantActiveTimeMs":38200,"providerLock":"anthropic","providerLockTimestamp":"2026-10-05T09:12:44.120Z","tokenUsage":{"inputTokens":48210,"outputTokens":3120,"cacheCreationTokens":12000,"cacheReadTokens":96400,"thinkingTokens":850}}
```
`<id>.jsonl`:
```json
{"type":"session_start","id":"7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6","title":"Fix failing tests","cwd":"C:\\Users\\dev\\src\\demo"}
{"type":"message","id":"m1","timestamp":"2026-10-05T09:12:44.000Z","message":{"role":"user","content":[{"type":"text","text":"<redacted>"}]}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-10-05T09:12:51.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Execute","input":{"command":"npm test"}}]}}
```

### 3.3 Cursor hook payloads

```json
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"c0ffee00-1111-4222-8333-444455556666","model":"gpt-5","hook_event_name":"sessionStart","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"session_id":"c0ffee00-1111-4222-8333-444455556666","is_background_agent":false,"composer_mode":"agent"}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"beforeSubmitPrompt","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"prompt":"<redacted>","attachments":[]}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"afterShellExecution","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"command":"npm test","output":"<redacted>","duration":5120,"sandbox":false}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"postToolUse","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"tool_name":"Shell","tool_input":{"command":"npm test"},"tool_output":"{\"exitCode\":0}","tool_use_id":"tool_01","duration":5130}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"afterFileEdit","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"file_path":"C:/Users/dev/src/demo/src/app.ts","edits":[{"old_string":"<redacted>","new_string":"<redacted>"}]}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"stop","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"status":"completed","loop_count":0}
{"conversation_id":"c0ffee00-1111-4222-8333-444455556666","generation_id":"g-01","model":"gpt-5","hook_event_name":"sessionEnd","cursor_version":"2026.10.01-e373342","workspace_roots":["C:/Users/dev/src/demo"],"user_email":null,"transcript_path":null,"session_id":"c0ffee00-1111-4222-8333-444455556666","reason":"user_close","duration_ms":402000,"is_background_agent":false,"final_status":"completed"}
```
Add one variant with a leading UTF-8 BOM (`EF BB BF`) to test the Windows stdin quirk. The path style in
`workspace_roots` on Windows is **UNVERIFIED**. Test both `C:\…` and `C:/…`.

### 3.4 Cursor transcript line (no usage, for a "no data" test)
```json
{"role":"assistant","message":{"content":[{"type":"text","text":"<redacted>"}]}}
```

---

## 4. Open risks

1. **Cursor imports our Claude hooks** (`PreToolUse` → permission hook) from `~/.claude/settings.json` with
   no CLI opt-out. Our silent sidecar may block all Cursor tool calls and creates ghost Claude sessions.
   This affects users today, not only the future Cursor adapter. It needs a live check and a sidecar fix (detect `cursor_version`).
2. The Cursor permission-hook fail-closed rule means our Cursor adapter can never observe the pre-approval moment, so no WaitingPermission.
3. Cursor CLI hook coverage is incomplete (`beforeSubmitPrompt`/`afterAgentResponse` are missing; `stop` is missing in `-p`), and it has
   Windows bugs: BOM, shell mismatch, full-timeout waits, double fire. One report says no user hooks fire at all.
4. Droid's `hooks.json` vs `settings.json` precedence: creating `hooks.json` can hide existing settings.json hooks.
5. Droid on Windows uses cmd.exe for hooks, so the command must be cmd-safe. Hooks snapshot at startup, so changes apply from the next session.
6. Droid's Windows `sessions/<project-key>` encoding is unverified. Rely on `transcript_path`.
7. Permission-prompt key sequences for both CLIs need a live capture (manual test).

## 5. Sources

Droid:
- https://docs.factory.com/harness/hooks (= /reference/hooks-reference)
- https://docs.factory.com/droid-cli/quickstart , /droid-cli/cli-reference , /droid-cli/settings
- https://docs.factory.com/droid-exec/overview , /autonomy-and-safety/auto-run , /autonomy-and-safety/permission-rules
- https://docs.factory.com/changelog/release-notes (CLI v0.233.0, 2026-10-03)
- https://app.factory.ai/cli/windows (installer script, v0.234.0)
- https://github.com/entireio/cli/pull/2349 (cmd.exe hook execution by version)
- https://github.com/postmanlabs/postman-plugin/pull/67 (Droid 0.231.0, cmd.exe, `DROID_PLUGIN_ROOT` on Windows)
- https://github.com/juya-ai-lab/tokenx/blob/main/docs/facts/droid.md (session layout, settings fields)
- https://github.com/RunMaestro/Maestro/blob/main/src/main/storage/factory-droid-session-storage.ts
- https://github.com/kingsword09/droid-acp/blob/main/src/factory-sessions.ts
- https://github.com/ccusage/ccusage/tree/main/rust/adapters/droid , https://openusage.sh/docs/providers/droid/
- https://github.com/Asymptote-Labs/agent-beacon/pull/733 (cumulative totals → deltas)

Cursor:
- https://cursor.com/docs/hooks (= /docs/agent/hooks) , https://cursor.com/docs/reference/third-party-hooks
- https://cursor.com/docs/cli/installation , /cli/using , /cli/headless , /cli/reference/parameters ,
  /cli/reference/permissions , /cli/reference/output-format , /cli/changelog
- https://cursor.com/install?win32=true (installer script, 2026.10.01-e373342)
- Forum: 148316 (CLI hook coverage), 169059 (CLI missing hooks, conversation_id), 168326, 168129 (Claude
  import + bash eval), 168407 (BOM), 169942 (Windows timeout wait), 157184 (double fire), 166558 (no
  opt-out), 152669 (malformed JSON behaviour)
- https://github.com/stablyai/orca/issues/15462 , https://github.com/SumonMSelim/agentguard/issues/62 ,
  https://github.com/PerfectPan/agent-presence/issues/89 , https://github.com/alibaba/loongsuite-pilot/issues/452
- https://github.com/Brandeling/meq/pull/2 (transcripts have no tokens/model)
