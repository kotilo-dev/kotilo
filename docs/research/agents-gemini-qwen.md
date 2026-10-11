# Agent research: Gemini CLI and Qwen Code

Researched 2026-10-06 from source on `main` plus the latest release tags. Nothing was installed or run
locally. Anything not confirmed in source or official docs is marked **UNVERIFIED**.

| Agent | Versions checked | npm package | Executable |
|---|---|---|---|
| Gemini CLI | stable `v0.62.0` (2026-09-29), `main` = `0.64.0-nightly` | `@google/gemini-cli` (Node >= 20) | `gemini` |
| Qwen Code | `v0.25.0` (2026-10-05), `main` | `@qwen-code/qwen-code` (Node >= 22) | `qwen` |

Qwen Code started as a Gemini CLI fork. Its hook system is now **Claude Code compatible**, with events such as
`PreToolUse` and `Stop`, and is **not** Gemini compatible. The two adapters share very little hook code.

Source abbreviations used below:
- `G:` = `https://github.com/google-gemini/gemini-cli/blob/main/`
- `Q:` = `https://github.com/QwenLM/qwen-code/blob/main/`

---

## 1. Gemini CLI

### 1.1 Hook config

- **User file:** `~/.gemini/settings.json`, which is `%USERPROFILE%\.gemini\settings.json` on Windows. The
  `GEMINI_CLI_HOME` environment variable overrides the home directory. Other layers: project
  `.gemini/settings.json`, system settings and extensions.
  Sources: `G:docs/hooks/index.md`, `G:packages/core/src/config/storage.ts`, `G:packages/core/src/utils/paths.ts` (`homedir()`).
- **The file may contain comments.** It is parsed with `strip-json-comments` (`G:packages/cli/src/config/settings.ts`).
  A strict JSON merger has two options for a file with comments: treat it as invalid and refuse (AGENTS.md
  rule 4), or support JSONC.
- **Shape**
  (`G:docs/hooks/reference.md`, `G:packages/cli/src/config/settingsSchema.ts` `HookDefinitionArray`):

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "*",
        "hooks": [
          { "name": "agenthub-hook", "type": "command", "command": "<see 1.3>", "timeout": 5000 }
        ]
      }
    ]
  }
}
```

  - Only `type: "command"` is supported.
  - `timeout` is in **milliseconds**. The default is 60000.
  - Optional fields: `name`, `description`, and `sequential` (on the definition). A per-hook `env` object is
    spread into the hook's environment (`hookRunner.ts`), but it is not in the schema.
  - **Matcher, tool events:** regex against the tool name. **Matcher, lifecycle events:** exact match against
    the trigger or source. `""`, `"*"` or an omitted matcher matches everything (`G:packages/core/src/hooks/hookPlanner.ts`).
  - `/hooks disable <name>` and the `hooksConfig.disabled` list key on `name`.
- **Enablement:**
  - `hooksConfig.enabled` defaults to `true`; hooks have been on by default since v0.26.0.
  - `hooksConfig.disabled` is a list of hook names.
  - `hooksConfig.notifications` defaults to `true` and shows a UI indicator while a hook runs.
- **Folder trust gate (important).**
  - `HookRegistry.processHooksFromConfig()` loads the **merged** settings hooks only when
    `config.isTrustedFolder()` returns true. This includes the user-level hooks. If the folder is not trusted,
    it logs "Project hooks disabled because the folder is not trusted." Source: `G:packages/core/src/hooks/hookRegistry.ts`
    in both `main` and `v0.62.0`.
  - `security.folderTrust.enabled` defaults to **true** in `settingsSchema.ts` (`main` and `v0.62.0`).
    `docs/cli/trusted-folders.md` still says "disabled by default", so the docs are stale.
  - Trust decisions are stored in `~/.gemini/trustedFolders.json`.
  - `GEMINI_CLI_TRUST_WORKSPACE=true` or `--skip-trust` forces trust (`G:packages/core/src/utils/trust.ts`).
  - Consequence: in a folder the user has not trusted yet, **our hooks do not fire**. The interactive TUI asks
    for trust at startup. The UI should show "hooks inactive: folder not trusted" rather than reporting a broken install.
- **Project hooks** are also fingerprinted (`trustedHooks.ts`) and warn when their command changes. This does
  not affect user hooks.

### 1.2 Events and stdin payload

The events are defined by the `HookEventName` enum in `G:packages/core/src/hooks/types.ts`:
`BeforeTool, AfterTool, BeforeAgent, AfterAgent, Notification, SessionStart, SessionEnd, PreCompress, BeforeModel, AfterModel, BeforeToolSelection`.

Every payload has these common fields (`hookEventHandler.ts` `createBaseInput`):
`session_id`, `transcript_path` (path of the chat `.jsonl`, or `""`), `cwd`, `hook_event_name`, `timestamp` (ISO).

| Event | Extra fields | Meaning for us |
|---|---|---|
| `SessionStart` | `source`: `startup`, `resume` or `clear` | Session start |
| `SessionEnd` | `reason`: `exit`, `clear`, `logout`, `prompt_input_exit` or `other` | Session end. Fired from the registered cleanup on graceful exit (`AppContainer.tsx`, `gemini.tsx`) |
| `BeforeAgent` | `prompt` (**content**) | Prompt submitted → Working. Fires once per user prompt (`client.ts`) |
| `AfterAgent` | `prompt`, `prompt_response` (**content**), `stop_hook_active` | Turn done → Done or WaitingInput. Fires only on the outermost call with no pending tool calls (`client.ts` `fireAfterAgentHookSafe`) |
| `BeforeTool` | `tool_name`, `tool_input`, `mcp_context?`, `original_request_name?` | Tool use. Fires **before** the policy check and confirmation (`scheduler/scheduler.ts` `_processToolCall`) |
| `AfterTool` | `+ tool_response` | Tool finished, so any pending permission was resolved |
| `Notification` | `notification_type` (only `"ToolPermission"` exists), `message`, `details` | **WaitingPermission**. Fired from `scheduler/confirmation.ts` when a confirmation is required |
| `PreCompress` | `trigger`: `auto` or `manual` | optional |
| `BeforeModel`, `AfterModel`, `BeforeToolSelection` | `llm_request` / `llm_response` (full transcript) | **Do not register.** Heavy and full of content |

`Notification.details` (`hookSystem.ts` `toSerializableDetails`) always has `type` and `title`. The other fields
depend on `type`:

| `type` | Fields | Notes |
|---|---|---|
| `exec` | `command`, `rootCommand` | |
| `edit` | `fileName`, `filePath`, `fileDiff`, `originalContent`, `newContent`, `isModifying` | **The content fields hold file content and must not be persisted** |
| `mcp` | `serverName`, `toolName`, `toolDisplayName` | |
| `info` | `prompt`, `urls` | |

`message` is one of these strings: `"Tool <title> requires execution|editing|MCP|information"`.

Gaps in the event coverage:
- There is no idle or "waiting input" notification. `AfterAgent` is the turn-done signal.
- There is no explicit error event. Error behaviour is **UNVERIFIED**: when a turn is cancelled (Esc) or fails
  with an API error, `AfterAgent` probably does not fire.
- There is no "permission answered" event. The next `AfterTool` means allowed. After a deny ("No, suggest
  changes"), the next signal is the user's next `BeforeAgent`, so a fallback is needed, for example terminal
  activity or a timeout. **UNVERIFIED** whether anything fires on deny.

### 1.3 Execution on Windows

- The hook command runs through **PowerShell, never cmd** (`G:packages/core/src/utils/shell-utils.ts` `getShellConfiguration`):
  - If `%ComSpec%` is `pwsh.exe` or `powershell.exe`, it runs `<ComSpec> -NoProfile -NonInteractive -Command <cmd>`.
  - Otherwise it runs `pwsh.exe -NoProfile -Command <cmd>` when pwsh is on PATH.
  - Otherwise it runs `powershell.exe -NoProfile -NonInteractive -Command <cmd>`.
  - On macOS and Linux it runs `bash -c <cmd>`.
  - The process is started with `spawn(..., {shell:false, cwd: input.cwd})`.
- `hookRunner.ts` appends `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` on PowerShell.
- **Quoting.** In PowerShell a double-quoted path followed by arguments is a parse error. The Windows command
  must use the call operator, ideally with single quotes, because PS 5.1 strips embedded double quotes
  (issue #25859):
  `& 'C:\Users\<u>\AppData\Local\agenthub\agenthub-hook.exe' gemini`.
  An unquoted path with no spaces also works, but the `&` form is safer. The macOS form is
  `'/path/agenthub-hook' gemini`. The command string is therefore platform-specific and belongs in the platform layer.
- **Latency.** Every hook pays PowerShell startup time, roughly 0.2–0.7 s (**UNVERIFIED** numbers). Hooks are
  awaited; matching hooks run in parallel by default. Register few events and set a short `timeout`, for
  example 5000 ms.
- **Environment.** The hook gets the parent environment plus:
  - `GEMINI_PROJECT_DIR`, `GEMINI_CWD` (both equal `cwd`)
  - `GEMINI_SESSION_ID`
  - `GEMINI_PLANS_DIR`
  - `CLAUDE_PROJECT_DIR` (a compatibility alias)

  If `security.environmentVariableRedaction` is enabled, or under GitHub Actions, variables whose names match
  `/TOKEN|SECRET|PASSWORD|KEY|AUTH|CRED|PRIVATE|CERT/i` are dropped (`G:packages/core/src/services/environmentSanitization.ts`).
  **Our `AGENTHUB_*` variable names must avoid these substrings.**
- **Exit codes and stdout:**
  - `0` with empty stdout is a success with no output (`stdout.trim() || stderr.trim()` is empty).
  - `2` blocks the action and uses stderr as the reason.
  - Any other code is a non-fatal warning.
  - Stdout must be JSON or empty. Our hook writes nothing and exits 0, which is correct.
  - **stderr is also parsed** when stdout is empty, so our hook should keep stderr empty too.
- **Timeout** kills the hook with `taskkill /pid <pid> /f /t`.

### 1.4 Permission prompt keys

Source: `G:packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx` and `hooks/useSelectionList.ts`.

- **Numbering.** The prompt is a numbered radio list with `showNumbers` on by default. Pressing a digit selects
  and confirms immediately when the list has fewer than 10 items (`NUMBER_INPUT_TIMEOUT_MS` = 1000).
- **Option order.** The options are built per confirmation type:
  1. `1` is always "Allow once".
  2. "Allow for this session" (`ProceedAlways`) comes next, but **only in a trusted folder**. For `exec` it also
     requires no untrusted flags and no modified build files. For `edit` it requires that the file is not a build file.
  3. Then come "Allow … for all future sessions", only if `security.enablePermanentToolApproval` is set, and
     "Modify with external editor" (edit only, when IDE diffing is off).
  4. The **last** option is "No, suggest changes (esc)" (`Cancel`).
- **Key recommendation:**
  - Allow once: `1`.
  - Deny: `Esc`. This is robust because the list length varies.
  - Allow always: `2`, sent **only** after confirming that option 2 exists. The hub cannot know the option list
    from the hook payload, so offer "Always" only for trusted folders, or fall back to "answer in terminal".
- **MCP prompts** have a different option 2/3 ("Allow tool for this session", "Allow all server tools for this
  session"), but 2 still means session-scope allow for that tool.

### 1.5 Usage data on disk

- **Path:** `~/.gemini/tmp/<project-slug>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 chars of sessionId>.jsonl`.
  Subagent transcripts go to `chats/<parentSessionId>/<id>.jsonl`.
  Sources: `G:packages/core/src/services/chatRecordingService.ts` `initialize()`, `G:packages/core/src/config/storage.ts`.
- **Project slug.** The slug **replaced the sha256 hash directory**. `Storage.initialize()` migrates old
  `tmp/<sha256>` directories to the slug (`performMigration`).
  - `ProjectRegistry` (`G:packages/core/src/config/projectRegistry.ts`) maps project paths to slugs in
    `~/.gemini/projects.json`: `{ "projects": { "<normalized path>": "<slug>" } }`.
  - Normalisation is `path.resolve(p)` plus `.toLowerCase()` on win32.
  - The slug is the lowercased basename with `[^a-z0-9]` replaced by `-` and runs of `-` collapsed. Collisions
    get `-1`, `-2`, ….
  - Each slug directory holds a `.project_root` marker file whose content is the owning project path.
  - **To map a directory to a project, read `tmp/<slug>/.project_root` or `projects.json`. Do not recompute a hash.**
  - Older installs (before the registry) used `~/.gemini/tmp/<sha256(projectRoot)>/chats/session-*.json`, a
    single JSON document, not JSONL. The version that introduced the registry is **UNVERIFIED**.
- **Format: append-only JSONL** (`chatRecordingTypes.ts`). Line types:
  1. **Metadata header** (first line):
     `{sessionId, projectHash, startTime, lastUpdated, kind: "main"|"subagent", directories?}`.
     `projectHash` is `sha256(projectRoot)` of the raw, un-normalised path (`G:packages/core/src/utils/paths.ts` `getProjectHash`).
  2. **Message record** `{id, timestamp, type, content, displayContent?}` where `type` is `user`, `gemini`,
     `info`, `error` or `warning`. A `gemini` record adds:
     - `model`
     - `tokens` (see below)
     - `toolCalls[] {id, name, args, result, status, timestamp, displayName, description, …}`
     - `thoughts[]`
  3. `{"$set": {...}}` metadata updates, such as `lastUpdated`, `summary` or `memoryScratchpad`.
  4. `{"$patch": {...}}` message patches.
  5. `{"$rewindTo": "<messageId>"}`.
- **The same message `id` can appear more than once.** `recordMessageTokens` re-appends the last `gemini`
  message after attaching `tokens`. **The parser must dedupe by `id`, last write wins, and honour `$rewindTo`
  for history.** For cost purposes, do not drop rewound messages, because the tokens were still spent.
- **`tokens` fields:**
  - `input` = `promptTokenCount`
  - `output` = `candidatesTokenCount`
  - `cached` = `cachedContentTokenCount`
  - `thoughts` = `thoughtsTokenCount`
  - `tool` = `toolUsePromptTokenCount`
  - `total` = `totalTokenCount`

  There is one record per API response. Under Gemini API semantics `input` includes `cached`, and `thoughts` is
  separate from `output`. Billable output is therefore `output + thoughts`, and fresh input is `input - cached`.
  Source: Gemini API `UsageMetadata` docs (https://ai.google.dev/api/generate-content#UsageMetadata); the
  "input includes cached" semantics were not re-fetched and are **UNVERIFIED**.
- **Session id.** The chat `sessionId` equals the hook `session_id`, because `Config.promptId = sessionId`
  (`G:packages/core/src/config/config.ts`). The hook `transcript_path` is the exact file path.

### 1.6 Plan limits

- Nothing is persisted locally.
- The CLI fetches quota in memory from the Code Assist API (`retrieveUserQuota` in
  `G:packages/core/src/code_assist/server.ts`) and shows it in the UI.
- There is no statusLine or command hook that exposes it. Report it as "unknown".

### 1.7 Headless run (AI provider)

```
gemini -p "<prompt>" -o text -m <model> --skip-trust --approval-mode default
```

Sources: `G:packages/cli/src/config/config.ts`, `G:docs/cli/headless.md`.

- `-p` / `--prompt` forces headless mode. A positional prompt now defaults to **interactive** mode in a TTY.
- `-o` / `--output-format` accepts `text`, `json` or `stream-json`. `-m` / `--model` selects the model.
- **Run it with `cwd` set to an empty scratch directory.** In headless mode an untrusted folder throws
  `FatalUntrustedWorkspaceError` (`G:packages/cli/src/utils/userStartupWarnings.ts`). `--skip-trust` avoids
  that by setting `GEMINI_CLI_TRUST_WORKSPACE=true` in-process.
- In headless mode, policy decisions of `ASK_USER` become **DENY**, and `ask_user` is excluded. Mutating
  tools are denied in `default` mode; read-only tools may still run.
- `--approval-mode plan` (read-only) is stricter. The code may refuse a non-default mode in an untrusted
  folder (`config.ts` around L2805), which is **UNVERIFIED** with `--skip-trust`.
- There is no flag that removes all tools. `-e none` to disable extensions is **UNVERIFIED**.
- **Side effect:** with `--skip-trust` the user's hooks fire for this run, including **our own hook**. The
  hub should set an env marker, for example `AGENTHUB_HEADLESS=1`, that our hook ignores. The run also writes a
  chat file under `tmp/<slug-of-scratch-dir>/`, which the usage reader should attribute to "AI provider" or skip.
- Exit codes: `0` success, `1` error, `42` input error, `53` turn limit.

### 1.8 Detection and closing

- **Detection.** A global npm install puts `gemini.cmd`, `gemini.ps1` and `gemini` in `%APPDATA%\npm`.
  Detect `gemini.cmd` or `gemini` on PATH. Other installers (Homebrew on macOS; winget or scoop on Windows) are **UNVERIFIED**.
- **Graceful close** (`G:packages/cli/src/ui/AppContainer.tsx`, `G:docs/reference/keyboard-shortcuts.md`):
  - Ctrl+C cancels the running request. A second Ctrl+C inside the warning window runs `/quit`.
  - Ctrl+D with an empty input does the same.
  - `/quit` (alias `/exit`) followed by Enter is the simplest option.
  - Each of these runs the cleanup, which fires `SessionEnd`.

### 1.9 Example hook payloads (synthetic, schema-accurate)

```json
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"SessionStart","timestamp":"2026-10-06T09:15:02.114Z","source":"startup"}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"BeforeAgent","timestamp":"2026-10-06T09:15:20.500Z","prompt":"<redacted prompt>"}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"BeforeTool","timestamp":"2026-10-06T09:15:24.010Z","tool_name":"run_shell_command","tool_input":{"command":"npm test","description":"Run tests"}}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"Notification","timestamp":"2026-10-06T09:15:24.090Z","notification_type":"ToolPermission","message":"Tool Shell requires execution","details":{"type":"exec","title":"Confirm Shell Command","command":"npm test","rootCommand":"npm"}}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"AfterTool","timestamp":"2026-10-06T09:15:31.700Z","tool_name":"run_shell_command","tool_input":{"command":"npm test"},"tool_response":{"llmContent":"<redacted>","returnDisplay":"<redacted>"}}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"AfterAgent","timestamp":"2026-10-06T09:15:40.020Z","prompt":"<redacted>","prompt_response":"<redacted>","stop_hook_active":false}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"PreCompress","timestamp":"2026-10-06T09:40:00.000Z","trigger":"auto"}
{"session_id":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","transcript_path":"C:\\Users\\dev\\.gemini\\tmp\\shop-api\\chats\\session-2026-10-06T09-15-7b0c2f9e.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"SessionEnd","timestamp":"2026-10-06T09:41:12.300Z","reason":"exit"}
```

The `tool_response` shape is **UNVERIFIED**; treat it as opaque.

### 1.10 Example chat file (synthetic, from `chatRecordingTypes.ts`)

```jsonl
{"sessionId":"7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10","projectHash":"5f2c…(sha256 of C:\\work\\shop-api)","startTime":"2026-10-06T09:15:02.000Z","lastUpdated":"2026-10-06T09:15:02.000Z","kind":"main"}
{"id":"m-u1","timestamp":"2026-10-06T09:15:20.400Z","type":"user","content":[{"text":"<redacted>"}]}
{"$set":{"lastUpdated":"2026-10-06T09:15:20.401Z"}}
{"id":"m-g1","timestamp":"2026-10-06T09:15:23.900Z","type":"gemini","content":"","toolCalls":[{"id":"call-1","name":"run_shell_command","args":{"command":"npm test"},"status":"success","timestamp":"2026-10-06T09:15:31.600Z","displayName":"Shell"}],"thoughts":[],"model":"gemini-2.5-pro"}
{"id":"m-g1","timestamp":"2026-10-06T09:15:23.900Z","type":"gemini","content":"","toolCalls":[{"id":"call-1","name":"run_shell_command","args":{"command":"npm test"},"status":"success","timestamp":"2026-10-06T09:15:31.600Z","displayName":"Shell"}],"thoughts":[],"model":"gemini-2.5-pro","tokens":{"input":18234,"output":120,"cached":12000,"thoughts":310,"tool":0,"total":18664}}
{"id":"m-g2","timestamp":"2026-10-06T09:15:39.800Z","type":"gemini","content":"<redacted>","thoughts":[],"model":"gemini-2.5-pro","tokens":{"input":19102,"output":450,"cached":18000,"thoughts":95,"tool":0,"total":19647}}
{"$set":{"lastUpdated":"2026-10-06T09:15:39.801Z"}}
```

The duplicate `m-g1` line is intentional: it reproduces how a message is re-appended once its tokens arrive.

---

## 2. Qwen Code

### 2.1 Hook config

- **User file:** `~/.qwen/settings.json`. `QWEN_HOME` overrides the `~/.qwen` directory
  (`Q:packages/core/src/config/storage.ts`). Other layers: project `.qwen/settings.json`, which loads only in a
  trusted folder, plus System and SystemDefaults settings.
- **User hooks load regardless of folder trust** (`Q:docs/users/features/hooks.md` "Troubleshooting").
  `security.folderTrust.enabled` defaults to `false` (`Q:packages/cli/src/config/settingsSchema.ts`).
- The file is parsed with `strip-json-comments` after a BOM strip, so it is JSONC.
- **Shape:** Claude Code style (`Q:docs/users/features/hooks.md`):

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "<see 2.3>", "name": "agenthub-hook", "timeout": 5 } ] }
    ]
  }
}
```

- **Hook types:** `command`, `http`, `function` and `prompt`.
- **Command-hook fields:**
  - `type`, `command`
  - `name` (required if the hook should be individually toggleable)
  - `description`
  - `timeout`: **seconds**, default 60. For backward compatibility a value of 1000 or more is read as milliseconds.
  - `async`
  - `env`
  - `shell`: `"bash"` or `"powershell"`
  - `statusMessage`
- **Definition fields:** `matcher` and `sequential`.
- **Matcher semantics:** `""`, `"*"` and `".*"` match all. Otherwise the matcher is an exact match, a
  `|`-separated list, or an unanchored regex.
- **Enablement:**
  - Hooks are on by default.
  - The top-level `"disableAllHooks": true` setting turns them all off.
  - `--safe-mode` (or `QWEN_CODE_SAFE_MODE`) and `--bare` (or `QWEN_CODE_SIMPLE`) also disable all hooks,
    **including user hooks**.
- **Reloading.** Hooks are read at session start and are reloaded only when the interactive `/hooks` menu is
  opened. An install takes effect for **new** sessions.

### 2.2 Events and stdin payload

The events are listed in `Q:docs/users/features/hooks.md` "Hook Events" and the `HookEventName` enum in
`Q:packages/core/src/hooks/types.ts`:
`PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, SessionDelete, MessageDisplay, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, Notification, PermissionRequest, PermissionDenied, TodoCreated, TodoCompleted, InstructionsLoaded`.

Every payload has these common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
`timestamp` and `permission_mode` (`default`, `plan`, `auto_edit`, `auto` or `yolo`). Depending on the event it
also has `agent_id` (inside a subagent), `prompt_id`, `source_type` and `source_id` (ACP only). New optional
fields can be added at any time, so **the parser must ignore unknown fields**.

| Event | Extra fields | Meaning for us |
|---|---|---|
| `SessionStart` | `source` (`startup`, `resume`, `clear` or `compact`), `model`, `agent_type?` | Session start, and gives the model |
| `SessionEnd` | `reason` (`clear`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled` or `other`) | Session end |
| `UserPromptSubmit` | `prompt`, `submitted_prompt?` (**content**) | Working. Also fires on tool-result continuations; only events that carry `submitted_prompt` are real user submissions |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `tool_call_id?` | Tool use. Fires at execution, **after** approval (`coreToolScheduler.ts` around L5537, versus permission around L4139) |
| `PostToolUse` | `+ tool_response`, `duration_ms?` | Tool done |
| `PostToolUseFailure` | (as `PostToolUse`, per docs) | Tool error |
| `PermissionRequest` | `tool_name`, `tool_input`, `permission_suggestions?` | Fires before the dialog and is **awaited**. Its output can decide the request, so **our hook must print nothing** |
| `Notification` | `message`, `title?`, `notification_type` (`permission_prompt`, `idle_prompt` or `auth_success`) | `permission_prompt` means **WaitingPermission** (fired when the dialog is shown). `idle_prompt` means **WaitingInput/Done** |
| `Stop` | `stop_hook_active`, `last_assistant_message` (**content**), `context_usage?`, `context_limit?`, `input_tokens?`, `background_tasks`, `crons` | Turn done. **Its `context_usage` ratio feeds the context % display** |
| `StopFailure` | `error` (`rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `loop_detected` or `unknown`), `error_details?` | **Error** (fire-and-forget). API errors fire it in the TUI, not with `-p` |
| `PermissionDenied` | `tool_name`, `tool_input`, `reason` | AUTO-mode classifier denial only |
| `MessageDisplay` | (streaming) | **Do not register.** It fires repeatedly |

Notes on the notification signals:
- `idle_prompt` is fired by `Q:packages/cli/src/ui/hooks/useAttentionNotifications.ts` every time the UI enters
  the Idle state. It fires once per idle period, probably including at startup.
- `idle_prompt` also fires after a denied permission, because the turn ends. This clears WaitingPermission. The
  deny path is **UNVERIFIED** at runtime.
- `permission_prompt` is fired from `Q:packages/core/src/core/coreToolScheduler.ts`. `PermissionRequest` comes
  first and carries the tool name and input.

### 2.3 Execution on Windows

- **Default shell** (`Q:packages/core/src/utils/shell-utils.ts` `getShellConfiguration`):
  - Default: **`cmd.exe /d /s /c <cmd>`**, taken from `%ComSpec%`.
  - If `%ComSpec%` is PowerShell: `<ComSpec> -NoProfile -Command`.
  - If the environment looks like Git Bash or MSYS (`MSYSTEM=MINGW*` or `MSYS*`, or `TERM` contains `msys` or
    `cygwin`): **Git bash -c**.
  - A per-hook `"shell": "powershell"` forces `powershell -Command`, which is Windows PowerShell 5.1.
- **Quoting pitfall.** The process is started with `spawn(exe, [...prefix, command], {shell:false})` and **no
  `windowsVerbatimArguments`** (`Q:packages/core/src/hooks/hookRunner.ts`). libuv escapes the inner `"`
  characters as `\"`, which cmd does not understand. Use an **unquoted command whose path has no spaces**:
  `C:\Users\<u>\AppData\Local\agenthub\agenthub-hook.exe qwen`. The same lesson already applied to Codex (see
  commit 3d02699). That form also works in Git Bash.
  - If the install path can contain spaces, use the 8.3 short path or add `"shell":"powershell"` with
    `& '<path>' qwen`. **UNVERIFIED**; test on a live install.
- **Environment.** The hook gets the parent environment minus Qwen's internal daemon secrets
  (`sanitize-child-env.ts`), plus:
  - `QWEN_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` and `GEMINI_PROJECT_DIR` (all equal to `cwd`)
  - variables from `getShellContextEnvVars()`
  - the hook's `env`
- **Exit codes and stdout:**
  - `0` with a JSON object on stdout controls behaviour.
  - Plain stdout is **injected into model context** on `SessionStart`, `UserPromptSubmit` and
    `UserPromptExpansion`, and shown as a system message on other events.
  - `2` is a blocking error that sends stderr to the model.
  - Any other code is a non-blocking error.
  - Our hook writes nothing and exits 0, which is correct and **essential** here.
- **Execution modes.** Hooks run in parallel by default. `async: true` makes a hook non-blocking; this is
  optional for us, but its output is discarded and slots are limited to 10.

### 2.4 Permission prompt keys

Source: `Q:packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx`.

- **Numbering.** As in Gemini, the list is numbered and digits select immediately (`useSelectionList.ts`).
- **Options:**
  1. `1` is "Yes, allow once".
  2. In a trusted folder, unless `hideAlwaysAllow` is set:
     - for `edit`: `2` "Yes, allow always";
     - for `exec`: `2` "Always allow in this project" and `3` "Always allow for this user".
  3. "Modify with external editor" appears for edits.
  4. The last option is "No, suggest changes (esc)".
- **Deny keys:** `Esc` **or Ctrl+C** cancels (`key.name === 'escape' || ctrl+c`).
- **Key recommendation:** once is `1`, always is `2` (project scope; same caveat as Gemini), and deny is `Esc`.

### 2.5 Usage data on disk

- **Path:** `~/.qwen/projects/<sanitizeCwd(projectRoot)>/chats/<sessionId>.jsonl`. `QWEN_RUNTIME_DIR` overrides
  the base directory. Sources: `Q:packages/core/src/services/chatRecordingService.ts` `ensureConversationFile`,
  `storage.ts` `getProjectDir`.
- **Directory name.** `sanitizeCwd` (`Q:packages/core/src/utils/paths.ts`) lowercases the path on win32 and
  then replaces `[^a-zA-Z0-9]` with `-`. For example `C:\work\shop-api` becomes `c--work-shop-api`.
  - The mapping is lossy, but every record also carries `cwd`. **Use the record's `cwd` for project mapping.**
  - The separate `~/.qwen/tmp/<sha256(lower(path))>/` directory holds temp data, not chats.
- **Format: append-only JSONL.** Each line is a `ChatRecord`:
  - Common fields: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `type`, `subtype?`, `cwd`, `version` (CLI
    version), `gitBranch?`, `promptId?`, `provenance?`.
  - `type` is one of `user`, `assistant`, `tool_result` or `system`.
  - Assistant records add `message` (Gemini `Content`, which is content), `model`, `contextWindowSize?` and
    **`usageMetadata`**.
- **`usageMetadata` fields** (GenAI shape): `promptTokenCount`, `candidatesTokenCount`,
  `cachedContentTokenCount`, `thoughtsTokenCount`, `totalTokenCount`.
  - There is one assistant record per API response, written by `recordAssistantTurn` from `Q:packages/core/src/core/llm-chat.ts`.
  - How OpenAI-compatible provider usage is mapped into these fields is **UNVERIFIED**.
- `system` records with `subtype: "ui_telemetry"` hold replayed UI events, including API responses with token
  counts. **Do not sum both sources.** Use only `assistant.usageMetadata`.
- The file is never rewritten. Rewinds are `system`/`rewind` records plus `parentUuid` branching.
- **Cost.** Qwen Code is multi-provider: Qwen OAuth, DashScope, OpenAI-compatible endpoints, Anthropic and
  Gemini. The price must be looked up by `model`; show "unknown price" for unknown models. The status of the
  Qwen OAuth free tier is **UNVERIFIED**.
- Where subagent transcripts are written is **UNVERIFIED**.

### 2.6 Plan limits

- Nothing is persisted locally.
- The status line JSON (`Q:docs/users/features/status-line.md`) exposes only `context_window.*` and session
  token totals; it has no `rate_limits`.
- Report limits as "unknown".

### 2.7 Headless run (AI provider)

```
qwen -p "<prompt>" -o text -m <model> --approval-mode plan --safe-mode --chat-recording false --max-tool-calls 0
```

Sources: `Q:packages/cli/src/config/top-level-options.ts`, `Q:docs/users/features/headless.md`.

- **Prompt flag.** `-p` is marked deprecated in the options file but is still documented and works. A
  positional prompt also means one-shot mode.
- **Model and output:** `-o` / `--output-format` accepts `text`, `json` or `stream-json`. `-m` / `--model` selects the model.
- **`--safe-mode`** disables hooks, including ours, plus extensions, MCP servers, skills, context files and
  permission rules. That is ideal for an isolated AI call.
- `--chat-recording false` avoids writing a chat file, so headless runs are not counted as usage.
- `--approval-mode plan` is read-only.
- `--max-tool-calls 0` aborts the run with exit code 55 on the first tool call. That is "tools off" at the cost
  of a failed run if the model tries a tool. `--exclude-tools` is also available. Exit-code-55 handling and
  `--exclude-tools` behaviour are **UNVERIFIED**.
- Exit codes: `53` turn cap, `55` budget, `130` SIGINT.

### 2.8 Detection and closing

- **Detection.** A global npm install creates `qwen.cmd`, `qwen.ps1` and `qwen` in `%APPDATA%\npm`. Other
  installers are **UNVERIFIED**.
- **Graceful close** (`Q:packages/cli/src/ui/AppContainer.tsx`, `quitCommand.ts`):
  - Ctrl+C twice, or Ctrl+D twice.
  - `/quit` or `/exit`. The bare words `exit`, `quit` and `:q` also map to `/quit`.

### 2.9 Example hook payloads (synthetic, schema-accurate)

```json
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"SessionStart","timestamp":"2026-10-06T10:00:01.000Z","permission_mode":"default","source":"startup","model":"qwen3-coder-plus"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"UserPromptSubmit","timestamp":"2026-10-06T10:00:10.000Z","permission_mode":"default","prompt_id":"p-1","prompt":"<redacted>","submitted_prompt":"<redacted>"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"PermissionRequest","timestamp":"2026-10-06T10:00:14.000Z","permission_mode":"default","prompt_id":"p-1","tool_name":"run_shell_command","tool_input":{"command":"npm test","is_background":false}}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"Notification","timestamp":"2026-10-06T10:00:14.050Z","permission_mode":"default","message":"Qwen Code needs your permission to use run_shell_command","title":"Permission needed","notification_type":"permission_prompt"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"PreToolUse","timestamp":"2026-10-06T10:00:18.000Z","permission_mode":"default","prompt_id":"p-1","tool_name":"run_shell_command","tool_input":{"command":"npm test"},"tool_use_id":"toolu_01","tool_call_id":"call_abc"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"PostToolUse","timestamp":"2026-10-06T10:00:25.000Z","permission_mode":"default","prompt_id":"p-1","tool_name":"run_shell_command","tool_input":{"command":"npm test"},"tool_response":{"output":"<redacted>"},"tool_use_id":"toolu_01","duration_ms":6800}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"Stop","timestamp":"2026-10-06T10:00:31.000Z","permission_mode":"default","prompt_id":"p-1","stop_hook_active":false,"last_assistant_message":"<redacted>","context_usage":0.142,"context_limit":131072,"input_tokens":18612,"background_tasks":[],"crons":[]}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"Notification","timestamp":"2026-10-06T10:00:31.200Z","permission_mode":"default","message":"Qwen Code is waiting for your input","title":"Waiting for input","notification_type":"idle_prompt"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"StopFailure","timestamp":"2026-10-06T10:05:00.000Z","permission_mode":"default","error":"rate_limit","error_details":"429 Too Many Requests"}
{"session_id":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","transcript_path":"C:\\Users\\dev\\.qwen\\projects\\c--work-shop-api\\chats\\1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11.jsonl","cwd":"C:\\work\\shop-api","hook_event_name":"SessionEnd","timestamp":"2026-10-06T10:10:00.000Z","permission_mode":"default","reason":"prompt_input_exit"}
```

Some details in these payloads are **UNVERIFIED**:
- the exact `tool_input` and `tool_response` contents;
- whether `prompt_id` and `permission_mode` appear on `Notification` and `SessionEnd`.

### 2.10 Example chat file (synthetic, from `ChatRecord`)

```jsonl
{"uuid":"r1","parentUuid":null,"sessionId":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","timestamp":"2026-10-06T10:00:10.000Z","type":"user","provenance":"real_user","cwd":"C:\\work\\shop-api","version":"0.25.0","gitBranch":"main","promptId":"p-1","message":{"role":"user","parts":[{"text":"<redacted>"}]}}
{"uuid":"r2","parentUuid":"r1","sessionId":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","timestamp":"2026-10-06T10:00:13.900Z","type":"assistant","provenance":"assistant_output","cwd":"C:\\work\\shop-api","version":"0.25.0","gitBranch":"main","promptId":"p-1","model":"qwen3-coder-plus","contextWindowSize":131072,"message":{"role":"model","parts":[{"functionCall":{"id":"call_abc","name":"run_shell_command","args":{"command":"npm test"}}}]},"usageMetadata":{"promptTokenCount":17020,"candidatesTokenCount":64,"cachedContentTokenCount":15000,"thoughtsTokenCount":0,"totalTokenCount":17084}}
{"uuid":"r3","parentUuid":"r2","sessionId":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","timestamp":"2026-10-06T10:00:25.100Z","type":"tool_result","cwd":"C:\\work\\shop-api","version":"0.25.0","promptId":"p-1","message":{"role":"user","parts":[{"functionResponse":{"id":"call_abc","name":"run_shell_command","response":{"output":"<redacted>"}}}]},"toolCallResult":{"callId":"call_abc","status":"success"}}
{"uuid":"r4","parentUuid":"r3","sessionId":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","timestamp":"2026-10-06T10:00:30.900Z","type":"assistant","provenance":"assistant_output","cwd":"C:\\work\\shop-api","version":"0.25.0","promptId":"p-1","model":"qwen3-coder-plus","contextWindowSize":131072,"message":{"role":"model","parts":[{"text":"<redacted>"}]},"usageMetadata":{"promptTokenCount":18540,"candidatesTokenCount":72,"cachedContentTokenCount":17000,"totalTokenCount":18612}}
{"uuid":"r5","parentUuid":"r4","sessionId":"1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11","timestamp":"2026-10-06T10:00:31.000Z","type":"system","subtype":"ui_telemetry","cwd":"C:\\work\\shop-api","version":"0.25.0","systemPayload":{"uiEvent":{"event.name":"qwen-code.api_response","input_token_count":18540,"output_token_count":72}}}
```

The `provenance` value on `tool_result` and the `ui_telemetry` payload fields are **UNVERIFIED**; the parser
must skip `system` records.

---

## 3. Recommended state mapping

| Hub state | Gemini CLI | Qwen Code |
|---|---|---|
| Session start | `SessionStart` | `SessionStart` (also gives `model`) |
| Working | `BeforeAgent`, `BeforeTool`, `AfterTool` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` |
| WaitingPermission | `Notification` with `notification_type=ToolPermission` | `Notification` with `notification_type=permission_prompt` (`PermissionRequest` for the card details) |
| Done / WaitingInput | `AfterAgent` | `Stop`, then `Notification idle_prompt` |
| Error | none; **UNVERIFIED** | `StopFailure` |
| Session end | `SessionEnd` | `SessionEnd` |

Both agents fire all of these synchronously except Qwen's `StopFailure`. Our hook must return quickly and keep
stdout and stderr empty.

## 4. Open risks

1. **Gemini hooks run only in trusted folders**, and folder trust is on by default. Install succeeds, but
   untrusted folders produce no events.
2. **Gemini on Windows runs every hook through PowerShell.** It needs the `& '<path>'` command form, which
   differs from the macOS form, and each event pays PowerShell startup latency.
3. **Qwen on Windows runs hooks through cmd.exe without verbatim arguments.** The command must be unquoted with
   no spaces in the path. Under Git Bash environment variables it switches to bash.
4. **"Always allow" option numbers depend on trust and settings** in both agents. Only `1` and `Esc` are stable.
5. **Gemini has no deny or error signal**, so a stale-WaitingPermission fallback is needed.
6. **Gemini chat files re-append messages**, so the parser must dedupe by `id`. The project directory is now a
   slug, not a hash, and older installs keep `.json` files under `tmp/<sha256>`.
7. **Headless runs can trigger our own hook.** This applies to Gemini with `--skip-trust`. Mark headless runs
   with an env flag; for Qwen, use `--safe-mode`.
8. **Payloads contain prompt, response and file content** (`prompt`, `prompt_response`,
   `details.newContent`, `last_assistant_message`). The hook must drop them before forwarding (AGENTS.md rule 5).
9. **Qwen cost needs a per-provider price table**, and how OpenAI-compatible usage maps into `usageMetadata` is
   **UNVERIFIED**.
10. **Nothing was verified live.** Both CLIs need a manual test on Windows before an adapter is called "supported".
