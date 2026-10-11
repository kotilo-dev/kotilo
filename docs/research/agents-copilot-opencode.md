# Agent research: GitHub Copilot CLI and OpenCode

Date: 2026-10-06. Machine: Windows 11, user-level npm installs.
Method: official docs + the locally installed packages (extracted JS / SDK typings / native strings for Copilot; the tagged source tree for OpenCode) + structure-only inspection of local state (keys, event types, table/column names; no values, no prompt/response content, no credential files opened).
Anything not confirmed by a source or the local install is marked **UNVERIFIED**.

| | Copilot CLI | OpenCode |
|---|---|---|
| Version tested | `@github/copilot` **1.0.91** (`copilot --version`) | `@opencode/cli` **2.0.22** (`opencode --version`), source tag `v2.0.22` of `github.com/anomalyco/opencode` |
| Status source | Command hooks (`~/.copilot/hooks/*.json`) | **v2** server plugin (`~/.config/opencode/plugins/`), event stream |
| Permission signal | Yes (`permissionRequest` hook, `notification` `permission_prompt`) | Yes (`permission.asked` / `permission.replied`) |
| Usage on disk | `session-state/<id>/events.jsonl`, **only `session.shutdown` totals** (per-call usage is ephemeral) | SQLite `opencode.db`: `session_v2` totals + `session_message.data` per assistant message |
| Plan limits | Not in custom statusLine / on disk; quota only in TUI footer and the SDK RPC `account.getQuota` | None |

---

## 1. GitHub Copilot CLI

### 1.1 Detection
- npm package `@github/copilot`. npm shims are `%APPDATA%\npm\copilot.cmd` / `copilot.ps1` / `copilot` (sh). The shim runs `node …\@github\copilot\npm-loader.js`, which starts the platform binary `node_modules\@github\copilot-win32-x64\copilot.exe` (also `-win32-arm64`). The runtime extracts itself to `%LOCALAPPDATA%\copilot\pkg\win32-x64\<version>\` (`app.js`, `copilot-sdk\`, `prebuilds\…\runtime.node`). Verified locally.
- Config/state root: `%USERPROFILE%\.copilot` (override: `COPILOT_HOME`, per `copilot help environment`). Local contents: `config.json`, `session-state\`, `logs\process-*.log`, `installed-plugins\`, `ide\`, `open-sessions-state.json`. No `hooks\` directory until something creates it.
- Version: `copilot --version` prints `GitHub Copilot CLI 1.0.91.`

### 1.2 Hooks
Source: [CLI hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference), [hooks tutorial](https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks), and `copilot help config` (local).

**Locations.** The CLI loads hooks in this order: policy → user → project → plugins.
- Policy: `C:\ProgramData\GitHub\Copilot\policy.d\*.json`
- **User: `%USERPROFILE%\.copilot\hooks\*.json`** (or `$COPILOT_HOME\hooks\`). This is verified in `app.js`: `userHooksDir: join(resolveCopilotHome(...), "hooks")`.
- User settings `hooks` field. The docs say `~/.copilot/settings.json`, but local `copilot help config` says the `hooks` field in the global `config.json` acts as user-level hooks. Both files exist in the code (`settings.json` is used for `disabledHooks`). Which file is authoritative is **UNVERIFIED**, so avoid it.
- Repo: `.github/hooks/*.json`, `.github/copilot/settings(.local).json`
- **Recommendation:** install our own file, `~/.copilot/hooks/agenthub.json`. It needs no merge into user files, and uninstall deletes only our file. Keep the backup-first rule anyway.

**File shape** (`version: 1`; keys are event names; camelCase is the native form):
```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "type": "command",
        "powershell": "& 'C:\\…\\agenthub-hook.exe' copilot sessionStart",
        "bash": "'/…/agenthub-hook' copilot sessionStart",
        "timeoutSec": 10 }
    ]
  }
}
```
Fields: `type` (default `"command"`), `bash`, `powershell`, `command` (cross-platform fallback; explicit platform fields win), `exec` + `args` (CLI only; runs an executable directly with no shell; documented, but **UNVERIFIED** in 1.0.91 because I found no clear string in the binary), `cwd`, `env`, `timeoutSec` (default 30, alias `timeout`), `matcher` (regex `^(?:P)$` on `toolName` / `notification_type` / `trigger`). HTTP hooks exist, but loopback URLs need `COPILOT_HOOK_ALLOW_LOCALHOST=1` (env name verified in `app.js` / `runtime.node`). Use command hooks.

**Windows execution.** On Windows the `powershell` field is used, and the `bash` field is ignored. The docs say "PowerShell 7.0 or later must be installed". The native runtime contains both `pwsh.exe` and `powershell.exe` (fallback order **UNVERIFIED**). There is a `powershellFlags` config, default `["-NoProfile","-NoLogo"]` (applies to the shell tool; whether hooks use it too is **UNVERIFIED**). Stdin is JSON; the doc example reads it with `[Console]::In.ReadToEnd() | ConvertFrom-Json`. Quote the exe path with the PowerShell call operator `& '…'`. Env passed to hooks: whatever is in the `env` field plus the inherited process env. `COPILOT_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` strings exist in the runtime, but whether they are set for hooks is **UNVERIFIED**. Exit codes: 0 means stdout is parsed as JSON. 2 means deny for `preToolUse` / `permissionRequest`. Any other non-zero is fail-open, **except `preToolUse`, which is fail-closed** (the tool is denied). A timeout is always fail-open. → Our hook must print nothing (or `{}`) and exit 0 quickly, especially on `preToolUse`. Better still, do not subscribe to `preToolUse` at all and use `postToolUse` / `permissionRequest` instead.

**The event name is not in the camelCase payload.** Only `notification` carries `hook_event_name`. Pass the event name as an argv token, as shown above.

**Events → hub state** (camelCase payload fields; every event has `sessionId`, `timestamp` (ms), `cwd`):

| Event | Extra fields | Hub meaning |
|---|---|---|
| `sessionStart` | `source` (`startup`/`resume`/`new`), `initialPrompt?` | SessionStart / Idle |
| `sessionEnd` | `reason` (`complete`/`error`/`abort`/`timeout`/`user_exit`) | SessionEnd |
| `userPromptSubmitted` | `prompt` (do not store) | Working |
| `userPromptTransformed` | `prompt`, `transformedPrompt` | ignore |
| `preToolUse` | `toolName`, `toolArgs` (**JSON string**, per the tutorial) | Working (fail-closed; avoid) |
| `postToolUse` | `toolName`, `toolArgs`, `toolResult{resultType,textResultForLlm}` | Working (tool done) |
| `postToolUseFailure` | `toolName`, `toolArgs`, `error` | Working |
| `permissionRequest` | `toolName`, `toolInput` (may hold `requestSandboxBypass`) | **WaitingPermission** |
| `notification` | `hook_event_name:"Notification"`, `message`, `title?`, `notification_type` ∈ `shell_completed`, `shell_detached_completed`, `agent_completed`, `agent_idle`, `permission_prompt`, `elicitation_dialog` | `permission_prompt` → WaitingPermission; `elicitation_dialog` → WaitingInput; `agent_idle` / `agent_completed` → Done |
| `agentStop` | `transcriptPath`, `stopReason:"end_turn"`, `stop_hook_active` | **Done (turn end)** |
| `subagentStart` / `subagentStop` | `transcriptPath`, `agentName`, … | ignore / timeline |
| `errorOccurred` | `error{message,name,stack?}`, `errorContext`, `recoverable` | Error |
| `preCompact` | `transcriptPath`, `trigger`, `customInstructions` | ignore |

PascalCase aliases (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, `Notification`, …) send snake_case Claude-style payloads (`session_id`, `tool_name`, `tool_input`, `transcript_path`). Use camelCase for one consistent shape. Tool names: `bash`, `powershell`, `view`, `create`, `edit`, `glob`, `grep`, `web_fetch`, `task`, `ask_user`, plus MCP tools. Model is **not** in hook payloads; take it from `events.jsonl` (`session.start.data.selectedModel`, `session.model_change.data.newModel`) or statusLine. `transcriptPath` presumably points to `session-state/<id>/events.jsonl` (**UNVERIFIED**).

### 1.3 Permission prompt keys (TUI)
Source: the extracted `app.js` (select component + digit-buffer hook `u1`) and the [allowing-tools doc](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools).
- Options are a vertical numbered list. Typical shell prompt: `1. Yes`; `2. Yes, and approve <cmd> for the rest of the running session` (or `Yes, and don't ask again … <location>`); last item: `No, and tell Copilot what to do differently (Esc)`.
- Keys: a **digit `1`–`9`** commits that item immediately (with fewer than 10 items); ↑/↓, `k`/`j` and Ctrl+P/N move the selection; **Enter** confirms; **Esc** (or Ctrl+G) rejects. Choosing the last item with a digit only highlights it so a reason can be typed.
- **Allow once = `1`**, **Always (session) = `2` only when that option is present** (it is missing for some requests, e.g. `managedApprovalRequired`, and sandbox-bypass prompts use different labels), **Deny = `Esc`**. Because the option count varies, prefer `1` / `Esc` and offer "Always" only when the hook payload allows it. "Always = 2" is **UNVERIFIED per prompt type**.

### 1.4 Usage data on disk
Source: `copilot-sdk/generated/session-events.d.ts` (shipped with 1.0.91) + structure of one local `events.jsonl`.
- Path: `~/.copilot/session-state/<sessionId>/events.jsonl` (+ `workspace.yaml` with keys `id, cwd, client_name, user_named, summary_count, fork_count, created_at, updated_at`; + `checkpoints/`, `files/`, `research/`).
- Every line is `{type, data, id, timestamp (ISO), parentId, agentId?, ephemeral?}`. About 150 event types exist (`session.start`, `session.resume`, `session.model_change`, `user.message`, `assistant.turn_start`, `assistant.message`, `assistant.turn_end`, `tool.execution_start/complete`, `permission.requested/completed`, `session.error`, `session.shutdown`, …).
- **Important: `assistant.usage` (per-call `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `model`, `cost`, `duration`, `copilotUsage.totalNanoAiu`, quota info) is `ephemeral: true` and NOT written to disk.** Neither are `session.idle`, `session.usage_info`, `model.call_finished` or `user_input.requested`.
- Persisted token data:
  - `session.shutdown.data`: `modelMetrics{<model>: {requests{count,cost}, usage{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens?}, totalNanoAiu?}}`, `agentMetrics{main|<id>: …}`, `currentModel`, `currentTokens`, `systemTokens`, `conversationTokens`, `toolDefinitionsTokens`, `totalApiDurationMs`, `totalNanoAiu`, `sessionStartTime` (ms), `shutdownType`, `codeChanges{linesAdded,linesRemoved,filesModified[]}`. The local file also has `totalPremiumRequests` (not in the typings; legacy billing).
  - `assistant.message.data.outputTokens?` + `model?` (output only).
  - `session.usage_checkpoint.data.totalNanoAiu` (AI credits only).
- → Cost per session is only available **after a clean shutdown** (`/exit`). A killed process has no totals, so show "partial / no data". A live alternative is the statusLine payload (§1.5) or `--usage-output-file` in headless runs.
- Project mapping: `session.start.data.context` (and `session.resume`, `session.context_changed`) = `{cwd, gitRoot?, branch?, repository?, headCommit?, …}`; `workspace.yaml` `cwd`. Session id = directory name = `session.start.data.sessionId`. Producer/version: `data.producer`, `data.copilotVersion`.

### 1.5 Plan limits
- Custom `statusLine` (`config.json` → `statusLine: {type:"command", command, padding?, refreshInterval?}`; on Windows a plain command runs via **`cmd.exe`**). Its stdin JSON (key list extracted from `app.js`): `cwd, session_id, session_name, transcript_path, model{id,display_name,auto_tier,pending_auto_tier}, workspace{current_dir}, username, remote{…}, version, cost{total_api_duration_ms, total_lines_added, total_lines_removed, total_duration_ms, total_premium_requests}, context_window{total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens, context_window_size, used_percentage, remaining_percentage, remaining_tokens, last_call_input_tokens, last_call_output_tokens, current_context_tokens, displayed_context_limit, current_context_used_percentage, current_usage{…}}, ai_used{total_nano_aiu, formatted}, allow_all_enabled`.
  - **No quota/entitlement fields.** It gives session usage only (premium requests / AI credits used, tokens, context %). This is the "partial" source.
- Plan quota (`entitlementRequests`, `usedRequests`, `remainingPercentage`, `overage`, reset date, keyed `chat` / `completions` / `premium_interactions`) exists only in memory: the TUI footer, `/usage`, and the experimental SDK/ACP RPC `account.getQuota`. It is not on disk → "unknown" unless we later drive the CLI via `--acp` (**UNVERIFIED** whether ACP exposes that RPC).
- Installing a statusLine would mean writing `config.json` (a user file). It needs a backup-first JSON merge and must chain any existing user `statusLine`, the same as for Claude.

### 1.6 Headless run (AI provider)
From `copilot --help` (local):
```
copilot -p "<prompt>" -s --model <model> --no-ask-user --no-custom-instructions \
        --disable-builtin-mcps --no-auto-update --log-level none \
        --deny-tool shell --deny-tool write --available-tools <none…>
```
- `-p/--prompt` is non-interactive and exits when done. `-s/--silent` prints the agent response only. `--output-format json` gives JSONL. `--model` (or env `COPILOT_MODEL`; `auto` allowed). The model list comes from `copilot help config`.
- No tools: `--available-tools` ("only these tools will be available") and `--excluded-tools` exist. Whether an empty `--available-tools` list means "no tools" is **UNVERIFIED**. Without `--allow-all-tools`, a `-p` run cannot prompt, so any non-read-only tool request is denied. Read-only tools (`view`, `glob`, `grep`) may still run. Do **not** pass `--allow-all*`/`--yolo`.
- `--usage-output-file <file>` writes final usage stats as JSON (fields **UNVERIFIED**).
- Each `-p` run consumes premium requests / AI credits and creates a session under `session-state` (**UNVERIFIED**; the usage reader should skip sessions we started).

### 1.7 Graceful close
`/exit` + Enter (documented in `copilot help commands`). Alternatively **Ctrl+C twice** (the UI hint "ctrl+c again to exit"; the first Ctrl+C cancels the running operation). `/exit` produces `session.shutdown` with usage totals, so prefer it.

---

## 2. OpenCode

### 2.1 Detection, and the v1 → v2 break
- **Installed here: v2**, npm package **`@opencode/cli`** (repo `github.com/anomalyco/opencode`, formerly `sst/opencode`). Shims: `%APPDATA%\npm\opencode.cmd` and **`opencode2.cmd`**, both running `node_modules\@opencode\cli\bin\opencode.exe` (a native binary; platform packages `@opencode/cli-windows-x64[-baseline]`, `-windows-arm64`). The legacy v1 package is `opencode-ai` (**detect both**; v1 behaviour is not re-verified here).
- v2 architecture: the TUI talks to a **shared background service** (`opencode service start|stop|status`; `--standalone` runs a private server instead). `~/.config/opencode/service.json` holds the service password (**a credential: never read it**).
- Paths (XDG on all OSes, from `packages/util/src/global-roots.ts`): config `%USERPROFILE%\.config\opencode` (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`), data `%USERPROFILE%\.local\share\opencode` (`XDG_DATA_HOME`), cache `~/.cache/opencode`, logs `…\share\opencode\log\`.
- DB file (`packages/cli/src/database-path.ts`): `<data>\opencode.db` for channels latest/dev/beta/next/prod, else `opencode-<channel>.db`. It is overridden by `OPENCODE_DB`.

### 2.2 Plugin mechanism (v2)
Source: `packages/core/src/plugin/source-directory.ts`, `plugin/module.ts`, `config/plugin/source.ts`, `config/discovery.ts`, `packages/plugin/src/promise/*.ts`, `plugin/src/host.ts`.
- **Auto-discovery:** files `*.ts` / `*.js` (or sub-directories) in `plugin/` or `plugins/` under each config directory. That covers global `~/.config/opencode/plugins/` and project `.opencode/plugins/`. That the global dir is scanned is inferred from discovery (the global config dir is a config root; same as the v1 docs [opencode.ai/docs/plugins](https://opencode.ai/docs/plugins)). Alternatively, list them in `opencode.json(c)` under `"plugins"` (v2) or `"plugin"` (v1, migrated). Configured local plugins must be **directories**; a file path is rejected with a warning.
- A directory plugin resolves entry points `server` / `index` (server side), `tui`, and `rpc` (`Host.resolve`).
- **Module format changed in v2:** the module must `export default { id, setup(ctx) }` (Promise API) or `{ id, effect }` (Effect API). Otherwise it fails with "Plugin must export a default definition with an id and an effect or setup function." **The v1 style (`export const P = async (ctx) => ({ event: async ({event}) => … })`) does not load in v2.** The v1 docs page still shows the old style.
- Minimal v2 server plugin (shape from `promise/plugin.ts`; `ctx.event.subscribe()` returns `AsyncIterable` over the server SSE `/api/event`; the exact runtime behaviour of the loop is **UNVERIFIED**):
```js
// ~/.config/opencode/plugins/agenthub.js
export default {
  id: "agenthub",
  setup(ctx) {
    const ac = new AbortController()
    ;(async () => {
      for await (const e of ctx.event.subscribe({ signal: ac.signal })) {
        if (!WANTED.has(e.type)) continue
        fetch("http://127.0.0.1:<port>/…", { method: "POST", body: JSON.stringify(slim(e)) }).catch(() => {})
      }
    })()
    return () => ac.abort()
  },
}
```
  The server runtime is Bun (compiled exe), so global `fetch`, `node:child_process` and `Bun.spawn` are available (**UNVERIFIED** for the compiled binary; `ctx.shell` also exists). Spawning `agenthub-hook` with JSON on stdin keeps the protocol identical to the other adapters.
- **Tab mapping risk:** in service mode the plugin runs inside the shared background server, **not** in the terminal's process. Env vars set on our PTY do not reach it. Mitigations: (a) launch with `opencode --session ses_<ourId>`. `--session` "creates if it does not exist", and the ID must start with `ses`, so we know the mapping up front. (b) Launch with `--standalone` (private server; env inheritance **UNVERIFIED**). (c) Use a `tui` entry point, which runs in the TUI process (TUI plugin API `context.data.on(type, fn)`, as used by the built-in `tui/src/feature-plugins/system/notifications.ts`).
- Event envelope: `{id, created (ms), type, location?{directory, workspaceID?}, durable?{aggregateID,seq,version}, metadata?, data}`. Relevant types (from `packages/client/src/promise/generated/types.ts`) and the mapping used by OpenCode's own notifications plugin:

| Event | `data` | Hub meaning |
|---|---|---|
| `session.created` | `sessionID, projectID, location{directory}, parentID?, slug, title?, agent?, model?{id,providerID,variant?}, version` | SessionStart |
| `session.execution.started` | `sessionID` | Working |
| `session.status` | `sessionID, status{type: idle\|busy\|retry}` | Working / Idle |
| `permission.asked` | `id, sessionID, action, resources[], save?[], message?, source?{type:"tool",messageID,id}` | **WaitingPermission** |
| `permission.replied` | `sessionID, requestID, reply: once\|always\|reject` | back to Working |
| `form.created` / `form.replied` / `form.cancelled` | `form{id,sessionID,title,…}` | **WaitingInput** (question tool) |
| `session.execution.succeeded` / `session.execution.interrupted{reason}` | `sessionID` | **Done** |
| `session.idle` | `sessionID` | Done / Idle |
| `session.execution.failed` | `sessionID, error{message,…}` | Error |
| `session.tool.called` / `.success` / `.failed` | tool info | timeline |
| `session.usage.updated` | `sessionID, cost (USD), tokens{input,output,reasoning,cache{read,write}}` | live usage (session totals) |
| `session.step.ended` | `sessionID, assistantMessageID, finish, cost, tokens, files?` | per-step usage |
| `session.deleted` | | SessionEnd |

  Sub-agent sessions have `parentID`; ignore them for top-level state, the same as the built-in plugin does.

### 2.3 Permission prompt keys (TUI)
Source: `packages/tui/src/routes/session/permission.tsx`, `util/permission.ts`, `config/keybind.ts`.
- Options are a horizontal row: **`Allow once` | `Always allow` | `Reject`**. "Always allow" appears only when `request.save` is non-empty, i.e. when `permission.asked.data.save?.length > 0`. The first option (`once`) is preselected.
- Keys: **Enter** = select the current option (→ **once** by default); **Right / `l`** = next, **Left / `h`** = previous; **Esc** = Reject (`app.exit`, i.e. Ctrl+C, also rejects while a prompt is open). Inside a sub-agent session, Reject opens a "rejection reason" box (Enter confirms, Esc cancels).
- Key sequences: once = `Enter`; always = `Right`, `Enter` (only if `save` is non-empty); deny = `Esc`. Keybinds are user-configurable (`Keymap`), so the defaults are assumed.

### 2.4 Usage data (opencode.db, v2 schema)
Schema read from a temporary scratch copy of the local DB with Node 24 `node:sqlite` (copy deleted afterwards; schema only, no rows read) and cross-checked with `packages/core/src/session/sql.ts`. **The DB also contains `account`, `control_account` (access/refresh tokens) and `credential` tables. The reader must never select from them; use explicit column lists and open the DB read-only.**
- `project(id, worktree, vcs, name, …, time_created, time_updated)` → project path (`worktree`).
- `session_v2(id 'ses_…', project_id, parent_id, slug, directory, path, title, version, agent, model JSON {id,providerID,variant?}, cost REAL USD, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, time_idle, idle_outcome, time_archived, …)`. These are **running per-session totals** (incremented by `SessionProjector.applyUsage`). Paths are stored with **forward slashes on Windows** (`C:/…`). Times are epoch ms.
- `session_message(id 'msg_…', session_id, type, seq, time_created, time_updated, data JSON)`. For `type='assistant'`, `data` = `{agent, model{id,providerID,variant?}, content[…], finish?, cost?, tokens?{input,output,reasoning,cache{read,write}}, error?, time{created,streamed?,completed?}}`. `type='compaction'` also carries `cost` / `tokens`. **`content` holds transcript text**, so read only `json_extract(data,'$.tokens…')`, `$.cost`, `$.model` and `$.time`.
- `event(id, aggregate_id, seq, created, type, data)` is the durable event log (includes `session.step.ended` with cost/tokens). Other tables: `permission` (saved "always" rules), `session_inbox`, `session_pending`, `kv`, `workspace`, `worktree`, `project_directory`, `migration`.
- OpenCode computes `cost` itself (USD) from models.dev pricing. Use it directly, with our price table as a fallback.
- Local DB currently has 0 sessions, so no row-level fixture could be built from this machine; a fixture must come from a test run.
- v1 DB layout (`opencode-ai` ≤1.x: `session` / `message` / `part` tables) differs. A migration exists (`core/src/database/v1-migration.bun.ts`, target `opencode-next.db`). The v1 layout is not covered here (**UNVERIFIED**).

### 2.5 Plan limits
None exposed locally → "unknown".

### 2.6 Headless run (AI provider)
From `opencode run --help` (local) and `packages/cli/src/run/noninteractive.ts`:
```
opencode run --standalone -m <provider>/<model>[#variant] "<prompt>"
```
- `--format default` prints the text parts; `--format json` gives events. `--model/-m provider/model#variant`. Without `--auto`, any permission request is **auto-rejected** ("This non-interactive run cannot ask the user for permission…").
- To deny all tools, set env `OPENCODE_CONFIG_CONTENT='{"permission":"deny"}'`. The legacy string form is migrated to rule `{action:"*",resource:"*",effect:"deny"}` (`config/normalize.ts`). It is unclear whether the env reaches the shared service unless `--standalone` is used (**UNVERIFIED**). The tools are still described to the model (they are only denied).
- Do not pass `--auto`. A run creates a session in the DB, so the usage reader should be able to exclude it (e.g. a fixed `--title`).

### 2.7 Graceful close
`/exit` (aliases `/quit`, `/q`) + Enter, or the `app.exit` keybind **`ctrl+c` / `ctrl+d` / `<leader>q`** (`tui/src/config/keybind.ts`). While a permission prompt is open, Ctrl+C rejects the permission instead of exiting. Whether Ctrl+C with text in the input clears the input first is **UNVERIFIED**. The background service keeps running after the TUI exits (service mode).

---

## 3. Open risks
1. **Copilot usage only at shutdown.** Per-call usage is ephemeral. Killed sessions have no token totals; live numbers need the statusLine payload, which means writing `config.json`.
2. **Copilot plan quota is not reachable** through files or the custom statusLine. PRD §5.4 "Kısmi (statusLine)" is only session usage, not the limit.
3. **Copilot `preToolUse` is fail-closed.** A crashing hook blocks tools, so do not register it. Confirm `exec`/`args` support and the pwsh vs powershell.exe choice with a live manual test (user-run).
4. **OpenCode v2 broke the v1 plugin format**, so the PRD's v1 assumption needs a v2 `export default {id, setup}` plugin. Supporting v1 (`opencode-ai`) means a second plugin file and a different DB layout.
5. **OpenCode shared background service:** the plugin is not in the terminal's process, so map sessions via `--session ses_<id>` or `--standalone`. Plugin hot-reload and the lifetime of the `ctx.event.subscribe` loop need a live test.
6. **OpenCode DB holds OAuth tokens and credentials** (`account`, `control_account`, `credential`) next to usage tables. The reader must use explicit column SELECTs on `session_v2` / `session_message` / `project` only, opened read-only (WAL).
7. The Copilot settings-file ambiguity (`config.json` vs `settings.json` for the `hooks` field) is avoided by using `~/.copilot/hooks/agenthub.json`.

## 4. Sources
- Copilot hooks reference: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
- Copilot hooks tutorial: https://docs.github.com/en/copilot/tutorials/copilot-cli-hooks
- Copilot allowing tools: https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools
- Copilot CLI docs root: https://docs.github.com/copilot/how-tos/copilot-cli
- Local Copilot 1.0.91: `copilot --help`, `copilot help config|commands|billing|limits|environment`; `%LOCALAPPDATA%\copilot\pkg\win32-x64\1.0.91\copilot-sdk\generated\session-events.d.ts` and `rpc.d.ts`; `app.js` (statusLine payload, permission select, hooks dir); `prebuilds\win32-x64\runtime.node` strings.
- OpenCode source, tag v2.0.22: https://github.com/anomalyco/opencode/tree/v2.0.22. Files: `packages/core/src/plugin/{source-directory,module}.ts`, `packages/core/src/config/{discovery,normalize}.ts`, `packages/core/src/config/plugin/source.ts`, `packages/plugin/src/{host.ts,promise/plugin.ts}`, `packages/client/src/promise/generated/types.ts`, `packages/tui/src/routes/session/permission.tsx`, `packages/tui/src/util/permission.ts`, `packages/tui/src/config/keybind.ts`, `packages/tui/src/feature-plugins/system/notifications.ts`, `packages/tui/src/app.tsx`, `packages/core/src/session/{sql,projector}.ts`, `packages/core/src/database/path.ts`, `packages/schema/src/{session-message,token-usage,model,session-id}.ts`, `packages/util/src/global-roots.ts`, `packages/cli/src/{database-path.ts,run/noninteractive.ts}`
- OpenCode plugin docs (v1-style examples): https://opencode.ai/docs/plugins
- Local OpenCode 2.0.22: `opencode --help`, `opencode run --help`, `opencode service --help`, `opencode plugin --help`; DB schema via `node:sqlite` (schema only).
