# Decisions

Non-obvious decisions, newest last. Format: context, decision, consequence.

## D-001 Snapshot imports, no git history (M0)

**Context:** AgentDeck and CCC (0.8.0), two earlier private projects of the author, are the two sources. AgentDeck's history contains a proprietary integration; renaming `Ccc.*` → `Hub.*` touches nearly every hub file anyway.
**Decision:** Both are imported as plain snapshots. The source repos stay private and read-only as the historical reference.
**Consequence:** `git blame` starts at the import commit. Code comments still cite source-phase tags ("Faz 5 §1.4", "spec §4 item 7") – those specs live in the archived repos.

## D-002 Proprietary integration removed, screen-rule engine dropped for now (M0)

**Context:** AgentDeck's vt100 screen-rule engine (the per-pane `vt100::Parser` in `pty`) and its session-recovery feature (`rusqlite`) existed only for a proprietary local LLM integration. Hard rule 1 forbids proprietary code in this repo.
**Decision:** Removed all of that integration's code, UI, strings, docs and tests, plus the then-unused `vt100` and `rusqlite` dependencies, `Agent.issue`, the `"error"` notification kind and the `busy`/`unsupported` error codes. The default agent commands are now `claude`, `codex`.
**Consequence:** Hookless agents use only the process-tree + output-activity heuristic. A generic, data-driven screen-rule engine (`adapter.json` → `screenRules`) is re-introduced with custom agents in M3, written fresh.

## D-003 Desktop layout and identity (M0)

**Decision:** Rust workspace at the repo root with members `apps/desktop/src-tauri` (crate `agenthub`, lib `agenthub_lib`), `crates/proto` (`agenthub-proto`) and `crates/hook` (`agenthub-hook`, formerly `notify-cli`/`agentdeck-notify`). Tauri `productName` `agent-hub`, identifier `dev.agenthub.app`. Data dirs `%APPDATA%\agent-hub` (state, settings) and `%LOCALAPPDATA%\agent-hub` (`bin`, `logs`, `diagnostics`). Env vars `AGENTHUB_*`. In-app help Markdown lives in `apps/desktop/docs/` (bundled via `?raw` imports).
**Consequence:** Working name only (PRD §12); the final brand renames these in M5. The About contact address is a placeholder until then. AgentDeck installs and their `~/.claude/settings.json` entries (`agentdeck-notify`) are not recognized; no migration.

## D-004 Hook sidecar keeps the named-pipe transport until M1 (M0)

**Context:** ARCHITECTURE §2.3 wants `agenthub-hook` to POST to the hub with a spool fallback. AgentDeck's sidecar talks to the desktop app over `\\.\pipe\agenthub-<pid>`.
**Decision:** M0 only renames it. Porting CCC's `Ccc.Hook` spool and `ProcessChain` logic to Rust and switching to HTTP is M1.
**Consequence:** Until M1 the desktop app tracks Claude Code itself (as AgentDeck did); the hub's ingest is reachable but nothing in-repo feeds it.

## D-005 Hub is a headless ASP.NET Core service (M0)

**Decision:** `Ccc.Core` → `Hub.Core`, `Ccc.Infrastructure` → `Hub.Infrastructure`, new `Hub.Contracts` (dependency-free: token header name, `port.json` record) and `Hub.Service` (`agenthub-hub.exe`, replaces `Ccc.App/Hosting`). WinUI and Windows-desktop services (tray, toast, text injection, terminal locator, NAudio recorder, sounds, startup registration) are not ported – they become Rust platform-layer work. `Ccc.Hook`, `Ccc.StatusLine` and the Whisper native runtimes are deferred (M1/M2).
**Consequence:** Hub.Core/Infrastructure stay `net10.0` with no OS checks. Daily-summary scheduling and localized summary labels need a client (M2). The hub can install Claude Code's statusLine entry, but the `agenthub-statusline.exe` it points at is not built yet.

## D-006 Hub API: random loopback port + per-start token (M0)

**Decision:** Kestrel binds `127.0.0.1` on a random port and writes `port.json` (`{v, port, token, pid}`, atomic write) to `%LOCALAPPDATA%\agent-hub\hub`. Every route requires the `X-AgentHub-Token` header (constant-time compare); requests with an `Origin` header get 403. Routes from CCC are kept; `POST /v1/events` is added and `/v1/hook` stays as an alias. A named mutex allows one hub per user session.
**Consequence:** Replaces CCC's fixed 47821–47830 port probing and `port.txt`. Hub data is `hub.db`, env vars `AGENTHUB_*`; existing CCC data is not migrated (separate import tool if wanted). Hook/statusLine entries are recognized as ours by `agenthub-hook.exe` / `agenthub-statusline.exe`.

## D-007 Desktop platform layer not yet extracted (M0)

**Context:** Hard rule 7 keeps `#[cfg(...)]` in platform-layer files only. The imported AgentDeck code has `#[cfg(windows)]` inline in `pty`, `lib.rs`, `ipc_server`, `commands/*` and the hook sidecar.
**Decision:** M0 imports it as is so behavior and tests stay identical. Extracting a `platform` module behind traits (PTY job/process tree, pipes/IPC, WebView2 settings, folder picker) is scheduled before the macOS work, starting with the code M1 touches (hook transport, hub supervisor).
**Consequence:** Until then the Rust crates only build on Windows; CI runs on `windows-latest` only.

## D-008 The hub owns every agent hook installation (M1)

**Context:** In M0 both the desktop app (AgentDeck's `hooks` module) and the hub (CCC's merger) wrote `~/.claude/settings.json`, in different shapes, and both treated any `agenthub-hook` entry as their own.
**Decision:** The hub is the only writer. Each adapter has an `IHookInstaller` (backup first; invalid files are reported as `invalidConfig` and left untouched; only entries whose command contains `agenthub-hook` count as ours). The desktop app's `hooks_*` commands call the hub API, and its own writer is removed. Hook commands are `"<hub bin>\agenthub-hook.exe" --agent <id> --event <Event>`, one per event; the hook binary lives in `%LOCALAPPDATA%\agent-hub\hub\bin`.
**Consequence:** Hook install needs a running hub (the UI says so when it isn't). Older bare-exe Claude entries show as `outdated`, and Install repairs them.

## D-009 Hook delivery: desktop pipe and hub, independently (M1)

**Decision:** `agenthub-hook` sends envelope v1 to the hub (HTTP, ≤ 300 ms, spool on failure) and, when it runs inside an agent-hub terminal, also sends the old `HookMessage` (now with `agent`) to the desktop app's named pipe. Neither path depends on the other.
**Consequence:** Live pane state in the desktop app keeps working while the UI still reads it from the pipe. M2 moves the UI to the hub stream, and then the pipe can go.

## D-010 Codex hook trust is reported, never written (M1)

**Context:** Codex runs a user-level hook only when `config.toml` has a matching `[hooks.state."…"] trusted_hash`, and the user approves hooks in `/hooks`. agent-hub could compute that hash itself.
**Decision:** It doesn't; computing the hash would bypass the agent's own security review. The installer writes `$CODEX_HOME/hooks.json`, and `needsApproval` reports whether our entries lack trust entries. The UI (M2) tells the user to approve them in Codex `/hooks`.
**Consequence:** The Codex integration is not live until the user approves it once. The `needsApproval` check is a tolerant read-only scan of `config.toml`; if it misreads a key format, the only effect is a false "needs approval".

## D-011 Codex usage without shipped prices; agent column without key change (M1)

**Decision:** Each Codex rollout `token_count` line becomes one usage entry (from `last_token_usage`; cached input stored as cache read). Cost stays empty unless the user adds the model to `pricing.json`, because no OpenAI prices are verified. Plan limits come from the latest `rate_limits` and are mapped by window length (300 min → 5 h, 10080 → weekly). They are stored apart from Claude's. Migration 008 adds `agent` (and `pane_id`) as plain columns; `session_id` stays the primary key, since agent session ids are UUIDs and a key change would mean rebuilding SQLite tables. The in-memory tracker is keyed by agent + session id.
**Consequence:** Codex costs show "—" by default. The fixtures were built from the documented schema of openai/codex 0.160.0, not captured from a real run, and should be re-checked against real files.

## D-012 Hub supervisor and parent watch (M1)

**Decision:** The desktop app starts `agenthub-hub` hidden with `--parent-pid <app pid>` and `AGENTHUB_TOOLS_DIR=<app folder>`. It restarts the hub on exit with backoff (1 s doubling to 30 s, reset after a 60 s run). Exit code 2 (another hub holds the mutex) means wait and retry every 30 s. The hub shuts down gracefully once the parent process is gone, so the app never kills it. The exe is looked up in this order: `AGENTHUB_HUB_EXE`, next to the app exe, and in debug builds the repo's `hub/Hub.Service/bin/<config>/net10.0`.
**Consequence:** Bundling the self-contained hub as a Tauri sidecar is M5 packaging work. New platform-specific desktop code lives in `src-tauri/src/platform` (D-007).

## D-013 Codex on Windows: empty hook environment, no quotes, content scrubbed in the hook (M1, verified live)

**Context:** A live test with codex-cli 0.160.0 on Windows showed three things. (1) Codex starts hooks with a completely empty environment, so `LOCALAPPDATA`, `AGENTHUB_PANE_ID` and `AGENTHUB_ENDPOINT` are all missing. (2) Its `cmd /C "<command>"` wrapper does not run commands that contain quotes; the same exe path written without quotes runs every time. (3) Stop payloads carry `last_assistant_message` and UserPromptSubmit carries `prompt`, so spooled envelopes held conversation text on disk.
**Decision:** (1) `agenthub-hook` falls back to the known-folder API for `%LOCALAPPDATA%`. When there is no pane environment, it finds the desktop app's pipe from its process chain (`agenthub.exe` / `agent-hub.exe`) and sends the chain pids; the app maps the nearest pane shell pid to the pane. (2) The Codex installer writes the exe path unquoted. A directory with spaces is replaced by its 8.3 short form (`Hub.Infrastructure/Platform/CommandLinePaths`); the file name stays long because it carries the ownership marker. (3) The hook removes `prompt`, `last_assistant_message` and the legacy notify text fields before sending or spooling anything, and keeps only `prompt_length`.
**Consequence:** Payloads are no longer forwarded byte for byte. If 8.3 names are disabled and the path has spaces, the Codex hook can't run; `CodexHooksMerger.CommandRunsOnWindows` reports this so it can be surfaced as a health issue. The live test used `--dangerously-bypass-hook-trust` for the test run only; the product never does.

## D-014 Desktop ↔ hub: Rust-side proxy and one stream (M2)

**Decision:** The webview never sees the hub token. It calls `hub_request(method, path, body)` and `hub_export(path, dest)`. Rust accepts only `/v1/...` paths without `..`, `//`, backslashes or whitespace, and only GET/POST/PUT/DELETE. A single WebSocket to `/v1/stream` (tungstenite, re-reads `port.json` on every reconnect) is relayed as `hub:status` and `hub:event` Tauri events into `stores/hubStore.ts`. The hub coalesces each frame type to at most one per 100 ms per client.
**Consequence:** Every screen reads live data from one store. A hub restart (new port and token) is picked up within the retry backoff (1–5 s).

## D-015 Pending permission details stay in memory (M2)

**Decision:** While a session waits for permission, the hub keeps `{tool, command, path, risk, since}` from `tool_input` (command cut at 4000 characters) and serves it on `/v1/sessions` and the stream. It is never written to SQLite or logs and is cleared on any other state. `risk` comes from a heuristic classifier in Hub.Core: deletesFiles, writesDatabase, network, installsPackages, gitPush, other.
**Consequence:** The permission card can show the exact command, but the command is not available after a hub restart.

## D-016 Permission keys, verified (M2)

**Decision:** Codex uses `y` to allow once, `p` to always allow the command prefix (only when offered) and `Esc` to deny, per the defaults in `codex-rs/tui/src/keymap.rs` (0.160.0). Claude Code was checked live in our own PTY (v2.1.289, `--permission-mode default`): `1` = Yes and runs immediately, `2` = the "Yes, and always allow …" option (its text varies), `Esc` = cancel. The prompt lists 3–4 options, so only 1, 2 and Esc are used. Both are recorded in `adapters/*/adapter.json`.
**Consequence:** A user who changed Codex's keymap, or a future prompt layout, needs the "Answer in terminal" fallback, which the card always offers.

## D-017 UI foundation choices (M2)

**Decision:**
- **Tokens:** DESIGN_SYSTEM tokens are CSS variables exposed to Tailwind 4 via `@theme inline`. Components use no raw hex. The light theme uses the same token names under `[data-theme="light"]`.
- **Theme:** `"system"` follows the OS preference via a resolved-theme store that Monaco, highlight.js and xterm read.
- **Fonts:** Geist and Geist Mono are bundled from the `geist` npm package (OFL). Geist Mono is the default terminal font.
- **Language:** EN/TR dictionaries share one typed shape. The language preference lives in the `ui` slice of `state.json`.
- **Routes:** the nav rail routes use Alt+1…9 (M4 added Mission control after Overview, so Settings is Alt+9), because Ctrl+1…9 already switch workspaces and Ctrl+Alt is AltGr on Turkish keyboards.

**Consequence:** The in-app help Markdown is still English only.

## D-018 Browser e2e with Tauri IPC mocks and a fake hub (M2)

**Decision:** `vite --mode e2e` loads `src/e2e/setup.ts` before the app. It uses `@tauri-apps/api/mocks` (`mockIPC` with event mocking, `mockWindows`) and answers every desktop command and hub route from typed fixtures (`src/e2e/fixtures.ts`, checked against `hubTypes.ts`). Playwright (`npm --prefix apps/desktop run e2e`) opens every route in dark/light × EN/TR plus a workspace with two agent panes, fails on uncaught page errors, and writes screenshots to `apps/desktop/test-results/screens/`.
**Consequence:** UI changes can be looked at without the user's desktop. Real PTY output, the real hub and the native window are not covered there.

## D-019 Notifications: hub decides, desktop shows (M2)

**Decision:** While the stream is connected, the hub's rule engine is the only source of agent notifications (quiet hours and DND are applied in the hub). The desktop shows the toast, and suppresses it when the agent's pane is visible in a focused window. When the stream is disconnected, the desktop falls back to its old pane-state decision, so there are never two toasts for one event.
**Consequence:** The toast body uses the hub's language setting; the title is rebuilt in the UI language.

## D-020 Live dictation: desktop captures and inserts, hub transcribes (M2b)

**Context:** CCC did everything in one WinUI process. Here the hub is a headless service and the desktop app owns the windows; ARCHITECTURE §10.1 recommended keeping Whisper.net in the hub for v1.
**Decision:** The desktop (Rust) owns the global hotkeys (`RegisterHotKey` on a dedicated thread, hold/tap detected by polling the key), the microphone (cpal, default input device, mono at the device rate, resampled to 16 kHz before sending), the overlay (a second Tauri window shown with `SW_SHOWNOACTIVATE` and `WS_EX_NOACTIVATE`, so it never takes the focus) and text insertion (`SendInput` paste/typing, full clipboard save/restore). Sound cues play natively (`PlaySound`), not in the overlay webview, because WebView2's autoplay policy can block audio in a window that never gets a user gesture. The hub owns transcription, transcript cleanup, AI cleanup, the file output and history (`POST /v1/dictation/transcribe` etc.). The controller is a platform-free state machine tested with fakes. The OS parts (hotkeys, microphone, insertion) have no automated tests because of AGENTS rule 6; they are on the manual test list.
**Consequence:** Dictation works only while the desktop app runs. Audio crosses the loopback once, as an in-memory request body (≤ 30 min × 64 KB/s); it is never written to disk. A macOS port needs new platform files for hotkeys, insertion and the overlay; the recorder (cpal) and the controller carry over.

## D-021 Adapter definitions are read at runtime (M3)

**Context:** Until M2 `adapter.json` was only a test fixture; agent data was copied by hand into C# (`AdapterRegistry.Default`), Rust (`AgentKind`, detection lists, Claude-only graceful close) and TypeScript.
**Decision:** Both processes load the definitions: built-in ones from the bundled `adapters/` folder (debug: the repo's `adapters/`; the desktop passes the resolved folder to the hub as `AGENTHUB_ADAPTERS_DIR`) and user ones from `%APPDATA%\agent-hub\adapters\<id>\adapter.json` (hub override `AGENTHUB_USER_ADAPTERS_DIR`). The folder name must equal the id; a built-in id wins and a user file with the same id is reported as an error. Invalid files are listed with their error and never stop the app; a broken built-in file keeps its code adapter working. The hub validates against the schema with a small built-in validator; reload is on demand (`POST /v1/adapters/reload`, `agents_definitions_reload`), there is no file watcher. Every user definition (and a built-in one without code) gets a `GenericAdapter` and no hook installer. Desktop detection (`detect`), graceful close (`gracefulClose`; claude-code keeps the old Ctrl+C sequence) and screen rules come from the definitions.
**Consequence:** A new agent needs no Rust change. The bundle currently includes the adapter fixtures too (to be excluded before packaging, M5). Gemini and OpenCode lost their hard-coded detection until their definitions land (M3 wave 2).

## D-022 Agent Integration Protocol v1 semantics (M3)

**Decision:** Transport is `agenthub-hook --agent <id> --event <event> [--session <id>] [--json <payload>]` or `POST /v1/events` with the envelope; envelopes with `v` other than 1 are rejected and a null or missing payload reads as `{}`. Payload keys are camelCase. A missing session id falls back to `pane:<paneId>`; without a pane the event is rejected. `done` maps to Idle (like Stop), `error` to Error, `waiting-input` to WaitingInput; a known `risk` value passes through, otherwise the classifier decides. `waiting-input` question text is dropped by the sidecar (`question_length` only). Each `usage` event becomes one usage row keyed `<agent>:<session>:<event ms>` and never creates a session; `inputTokens` excludes `cachedTokens` (stored as cache reads), and a reported `costUsd` survives repricing (migration 009 `cost_reported`). Spec: `docs/agent-protocol.md`, `schema/agent-protocol.v1.json`.
**Consequence:** Custom agents get the permission card, notifications and usage without code. Screen-rule regexes may not use lookaround or backreferences, because the desktop uses Rust's `regex`.

## D-023 One hook merger, per-shell command forms, usage sources (M3)

**Context:** Research (`docs/research/agents-*.md`) showed each agent runs hook commands differently on Windows: cmd with a broken quote handling (Codex, Qwen), cmd (Droid), PowerShell (Gemini, Copilot), PowerShell or bash (Cursor).
**Decision:** Each agent's hook config is data on one backup-first `JsonHooksMerger` (shapes: Claude-style matcher groups, Codex groups, Cursor flat commands, Copilot own file; JSONC where the agent allows comments). The command line per shell is built in the platform layer (`Platform/HookCommandLine.cs`). Usage comes from per-agent `IUsageSource`s (file sources with watchers, or DB polling), and plan limits are stored per agent (`plan-limits.json` for Claude, `plan-limits-<agent>.json` for the rest). Claude and Codex behave as before.
**Consequence:** A hook-based adapter is mostly configuration plus a mapping class and fixtures.

## D-024 Hook sidecar: protocol transport, per-agent scrubbing, internal runs (M3)

**Decision:** `--json` replaces stdin (a protocol caller may never close stdin); any non-object payload becomes `{}`, also on the desktop pipe. `--agent` must match `^[a-z0-9][a-z0-9-]{0,63}$`, otherwise the hook exits silently. The sidecar keeps a scrub list per adapter id (prompt and response text, tool results, file content in Gemini `details`, Cursor `user_email`); `prompt` becomes `prompt_length`, `message` is clipped to 200 characters. `tool_input`/`toolArgs` are kept as before. `AGENTHUB_INTERNAL=1` (set by the hub's own AI runs) drops the event. A UTF-8 BOM is stripped. Tool events of the new agents are not spooled.
**Consequence:** A new built-in agent needs its content fields added to the sidecar; user adapters get the common and protocol scrubbing only.

## D-025 Cursor: the one exception to "the hook never writes stdout" (M3)

**Context:** Cursor treats empty stdout on its permission hooks as a block, and it also runs the Claude Code hooks from `~/.claude/settings.json` (its `PreToolUse` becomes a permission hook), so agent-hub's Claude integration could block every Cursor tool call.
**Decision:** For `--agent cursor`, and for `claude-code` hooks fired by Cursor (detected by `CURSOR_VERSION` in the environment or `cursor_version` in the payload), the hook writes `{}` (prompt-submit events: `{"continue":true}`) before any network I/O. It never answers allow or ask. Claude hooks fired by Cursor are neither sent nor spooled. The Cursor adapter registers only observational events; its waiting-permission state comes from a screen rule.
**Consequence:** Whether `{}` is neutral for Claude-format `PreToolUse` inside Cursor is unverified until a live check (manual test list).

## D-026 AI providers per feature; keys in the OS vault (M3)

**Context:** The hub's AI jobs (assistant, daily summary, dictation cleanup) only ran `claude -p`.
**Decision:** Each feature picks a provider: `cli:<adapter id>` (the user's installed CLI with tools off or read-only, never auto-approve, `AGENTHUB_INTERNAL=1`, an empty scratch folder below the buddy folder so these runs stay out of sessions) or `openai:<name>` (`/chat/completions`; base URL, model, optional key). The key lives in Windows Credential Manager (`agent-hub/ai/<name>`, platform layer), never in settings or logs; the API only says `hasKey`. npm `.cmd` shims are resolved and started directly, never through cmd.exe with the prompt on the command line. Pre-M3 model aliases (`"haiku"`) migrate to `cli:claude-code`. CLI flag sets are verified against the installed `--help` (claude-code, codex, copilot, opencode); gemini, qwen, droid and cursor are marked `verified: false`.
**Consequence:** "Fully local" is shown only when every enabled feature uses a loopback endpoint. Answer formats of the CLIs and the Credential Manager code need a live check; tests use an in-memory secret store only.

## D-027 Copilot CLI adapter (M3)

**Decision:** agent-hub writes its own hook file `$COPILOT_HOME/hooks/agenthub.json` (version 1, PowerShell `& '…'` plus a bash form, `timeoutSec` 10) with 8 camelCase events and never `preToolUse`, because Copilot blocks the tool when that hook fails. The event name comes from `--event` (payloads don't carry it). `notification` `agent_idle` means done; `agent_completed` is ignored because sub-agents fire it. Usage comes only from `session.shutdown` totals in `session-state/<id>/events.jsonl` (growth after a resume), stored as reported with no USD cost, since Copilot bills premium requests. No plan limits.
**Consequence:** a session killed without `/exit` has no usage. The hook shell (pwsh vs powershell.exe) and neutrality of empty output on `permissionRequest` are on the manual test list.

## D-028 OpenCode v2 adapter (M3)

**Decision:** Only OpenCode v2 (`@opencode/cli`) is supported. The hub installs a server plugin (`~/.config/opencode/plugins/agenthub.js`, embedded in the hub, rendered with the hook exe path) that forwards OpenCode's own event names one at a time through `agenthub-hook --agent opencode --json …`, so spooling, scrubbing and the desktop pipe are reused. The plugin runs in OpenCode's shared background service, so the sidecar never maps it to a pane by process chain and the adapter drops the chain. Usage is the growth per session from `opencode.db` `session_v2` (read-only connection, named columns only, plus `project.worktree`), with the reported `cost`; sessions titled `agent-hub-ai` (the hub's own AI runs) are skipped.
**Consequence:** OpenCode sessions show state and usage but are not linked to a terminal tab yet (follow-up: the v2 `tui` plugin entry or launching with `--session`). Detection can't tell v1 from v2 (both run `opencode.exe`).

## D-029 Gemini CLI and Qwen Code adapters (M3)

**Decision:** Gemini hooks live in `settings.json` (JSONC, ms timeouts, PowerShell `& '…'`), Qwen hooks in `settings.json` (JSONC, seconds, unquoted cmd with the 8.3 path). Model events (full transcript) and Qwen's awaited `PermissionRequest` are never registered. Gemini's `Notification` `ToolPermission` is the permission request; any later turn or tool event ends WaitingPermission, because Gemini reports no deny. A Qwen `UserPromptSubmit` is a new turn only with `has_submitted_prompt`; Stop's `context_usage` is the agent-reported context reading. `HookStatus.hint` (`folderTrust`, `hooksDisabled`) explains installed but silent hooks. Usage comes from the chat recordings (Gemini deduped by message id, Qwen only `assistant.usageMetadata`); cached tokens are split off input, thoughts count as output. No prices are shipped.
**Consequence:** after a Gemini deny the card stays until the next prompt. Gemini's personal Google sign-in has been shut down by Google (2026-10), so a live check needs an API key. Both adapters are "unverified live" until the manual tests.

## D-030 Factory Droid and Cursor CLI adapters (M3)

**Decision:** Droid reads `hooks.json` and falls back to `settings.json` → `hooks` only when `hooks.json` is absent, so agent-hub writes `hooks.json` only if it exists or `settings.json` has no hooks, and otherwise merges into `settings.json`; status and install follow the file Droid reads, stale entries in the other file are removed. A `permission_prompt` notification carries the tool/command of that session's last `PreToolUse` (memory only). Droid usage is the difference between successive running totals in `<id>.settings.json` (a decrease is a reset; thinking tokens are not added to output). Droid gets no permission keys until a live capture. Cursor registers only observational events; repeated events within 2 s with the same payload map to Other; its waiting-permission state comes only from a screen rule; keys y/n per its docs; usage "no data".
**Consequence:** the Cursor prompt regex, Droid key labels and Cursor's Windows hook behaviour (one report says CLI hooks don't fire) need the manual checks. Droid model ids that match the Anthropic price table get an API-equivalent cost, not Factory credits.

## D-031 The UI reads adapter definitions (M3)

**Decision:** The desktop's loaded definitions (`agents_definitions`) are the UI's source for agent names, avatars, permission keys and the launch menu; the hand-kept TS copies are gone. Built-in avatars stay design tokens whose values equal `adapter.json` (test-enforced, DESIGN_SYSTEM §2.4 updated: Copilot is `P`, Cursor `U`, so every built-in letter is unique); user avatars render their own hex inline. The permission card sends the definition's keys with `pane_send_keys`; without a complete key pair (Droid) it offers only "Answer in terminal". When a definition has a `waitingPermission` screen rule, the desktop's `blocked` state overrides the hub's state and the card shows no command details (Cursor). The launch menu lists installed definitions ("installed" = an exact `detect.executables` match in a `PATH` folder), then the user's own commands.
**Consequence:** Adding a built-in agent needs no UI code beyond its avatar tokens and strings.

## D-032 Custom agents are written by the desktop (M3)

**Decision:** The "Add custom agent" wizard validates in the UI (JS RegExp plus the hub's no-lookaround/backreference rule); Rust re-validates with the loader plus the schema checks the hub runs, refuses built-in ids, writes `%APPDATA%\agent-hub\adapters\<id>\adapter.json` atomically (overwrite only when asked; the id is fixed when editing) and reloads; then the hub reloads (`POST /v1/adapters/reload`).
**Consequence:** Users can also hand-edit the file; invalid files show as error cards with the validator message.

## D-033 Settings → AI: endpoints save at once, keys never reach a store (M3)

**Decision:** OpenAI-compatible endpoints are saved immediately (on top of the last saved settings, mirrored into the draft), because the vault accepts keys only for saved endpoints; feature choices go through the normal save bar. The API key lives only in the form's local state until `PUT /v1/ai/providers/{name}/key` and is cleared right after, whatever the outcome. Endpoint names are fixed after creation (a rename would drop the key); deleting an endpoint moves its features to the first installed agent CLI. The "Fully local" badge is computed from the draft with the hub's rule. The old model fields (`dailySummaryModel`, dictation `aiModel`, buddy model) are gone from the UI types.
**Consequence:** "Load models" works only for saved endpoints. The assistant has no UI yet, so its card only shows the provider choice.

## D-034 Replayed spool events never notify; live AI provider check (M3)

**Context:** The first live run of M3 showed that the hub, on start, replayed spooled hook events within a second and raised "completed", "waiting for input" and "waiting reminder" notifications for intermediate states minutes old (behaviour inherited from M0). The same run tested every installed agent CLI as an AI provider.
**Decision:** Spooled envelopes are enqueued as replayed: they update sessions and transitions but don't feed the rule engine, and no poll runs after them; the next clock tick judges only the final state (a session that really waits past the reminder delay still gets its one reminder). Live provider results (2026-10-06): claude-code, codex and copilot answer correctly with the D-026 flags; gemini maps to `notLoggedIn` (no sign-in); qwen without a configured auth type now maps to `notLoggedIn` too; opencode's free "Console" provider refuses headless `opencode run` ("can only be used from within OpenCode"), so OpenCode works as an AI provider only with another configured provider.
**Consequence:** No toast storm after the hub was down. The OpenCode limitation is noted in the help and the manual test list.

## D-035 Tool arguments leave the hook as an allowlist (M4)

**Context:** The M4 scan found that claude-code and codex payloads still carried `tool_response` and Edit/Write content (and spooled PermissionRequests kept it on disk), and that `AGENTHUB_DEBUG=1` wrote whole payloads to the desktop's `hooks.log` – both against rule 5.
**Decision:** For every agent the sidecar drops tool output (`tool_response`, `tool_output`, `toolResult`) and reduces `tool_input` / `toolInput` / Copilot `toolArgs` to metadata keys (paths, `command`, `pattern`, `glob`, `url`, `query`, `description`, `subagent_type`, `todos`, a few numeric options), clipped (descriptions/queries 200, others 4000 characters). Codex `apply_patch` bodies become `paths: [...]`. TodoWrite `todos` keep `{content ≤ 200, status, id}`, at most 100. `hooks.log` writes only agent, event, session, pane and payload size.
**Consequence:** A new tool's path key must be added to the allowlist before the hub sees it; MCP arguments never reach the hub or the desktop.

## D-036 Activity timeline in hub memory (M4, extends D-015)

**Decision:** `ActivityTracker` keeps the last 200 tool entries per session (`{kind, tool, target, paths, startedAt, durationMs, status}`) plus turn markers and the latest TodoWrite plan, fed on the pipeline consumer. Pre/Post pair by `tool_use_id`, else by tool name oldest first; Post-only agents add finished entries; a permission prompt with no Post before the turn ends is "denied". `GET /v1/sessions/{agent}/{id}/activity` serves the ring; the stream sends per-session deltas (`activity`, ≤ 1 per 100 ms) and nothing on connect. Timelines are dropped 10 min after the session ends, after 12 h idle, or beyond 256 sessions. Never SQLite or logs.
**Consequence:** A hub restart loses the timeline (user decision 2026-10-08). OpenCode's plugin v2 forwards `session.tool.called/.success/.failed` (names and shapes read from the 2.0.22 binary, not checked live); users must reinstall the plugin.

## D-037 Changed files and HEAD content via the git CLI (M4)

**Decision:** The desktop runs read-only git (`GIT_OPTIONAL_LOCKS=0`, fsmonitor off, `diff.relative=false`, `core.quotepath=off`, 5 s timeout, hidden window): `git_changes` = `diff --numstat -z -M HEAD` + `status --porcelain=v2 -z`, workspace-relative via `rev-parse --show-prefix`; `git_show_head` = `cat-file` (no filters/textconv), ≤ 2 MB, decoded and LF-normalised like `fs_read_text`. Missing git, no repo or no HEAD are normal results. No libgit2 (no new license, same choice as the hub's `GitRunner`).
**Consequence:** One refresh starts four git processes, so the UI debounces; huge untracked trees are capped (5000 entries, 500 line counts). Renames on disk show as D + ? until staged.

## D-038 Composer dictation (M4)

**Decision:** `dictation_start_composer(paneId)` / `dictation_stop_composer()` reuse the dictation controller with a composer target: same overlay, microphone, hub transcription and cleanup, but the text comes back only as one `dictation:composer` event (text or error) – no OS insertion, no clipboard. History records `outputs: []`. Start always toggles; another running dictation answers `failed`/`busy`.
**Consequence:** Works even when the global dictation hotkey is disabled; the hotkey also stops a composer recording.

## D-039 Design tokens only, named type scale (M4)

**Decision:** The AgentDeck `--color-*` aliases are gone; components use `@theme` token classes. Modal backdrops share `--scrim`. Font sizes come from a named scale (`text-label` 11 … `text-display` 26, DESIGN_SYSTEM §3) with an 11 px minimum. Components render strings through `useStrings()` (plain `strings` only in callbacks, module code and the error boundary). `designRules.test.ts` enforces no text below 11 px, no `--color-*`, no hard-coded backdrops.
**Consequence:** Light-theme backdrops became a tinted dim; 10 px labels became 11 px. 13.5/14.5/18/22 px and Tailwind `text-xs`/`text-sm` remain in imported components.

## D-040 Mission control preview from xterm buffers (M4)

**Decision:** Mission control (`/mission`, Alt+3, right after Overview) shows per tile the last 5 non-blank lines of the pane's in-memory xterm buffer (at most 120 rows read, soft-wrapped rows joined), polled about once a second only while the page is mounted and the window is visible. The text lives in component state only, is never logged or stored, and is not an ARIA live region. Sessions outside the app show metadata only (pending permission, the agent's notification, current tool). Filters: Needs you = waiting permission/input or error, Working, Done = Idle (the hub has no "done"); Stale only under All. Overview keeps its stats and links to Mission control.
**Consequence:** Later route shortcuts moved by one (Settings is Alt+9). No preview for external sessions.

## D-041 Timeline rail and diff tabs (M4)

**Decision:** The timeline is a fixed-width rail outside the resizable column group (visibility and width in the `layout` slice of `state.json`). It follows the focused pane (the split half that last had focus). The client fetches a session's activity once and then merges `activity` deltas by id (cap 200, never back to "running", the frame's plan wins during a fetch, only opened sessions, at most 16 kept, refetch only on a real reconnect). "Touched by the agent" = targets of edit/write entries; Bash-made changes count under "Other changes". Changed files refresh on `fs:changed`/`fs:rescan` (800 ms debounce) and by hand. Diffs are read-only viewer tabs (`diff: true`, HEAD via `git_show_head` vs working copy via `fs_read_text`), never persisted.
**Consequence:** Commits or checkouts outside the app show up only after the next file event or a manual refresh. No toggle shortcut yet (Ctrl+Alt is AltGr on Turkish keyboards); palette command `view.toggleTimeline`.

## D-042 Composer send and saved prompts (M4)

**Decision:** The composer handles keys only on its own elements (no window listeners, never auto-focused; Escape returns focus to the terminal). Send strips Escape and other control characters (except tab/newline), turns newlines into CR, wraps the text in bracketed paste only when the program enabled DECSET 2004 (otherwise the multi-line paste warning applies), writes it with `ptyWrite` and sends Enter as a separate write after 40 ms. Pasted images go to `<workspace>/.agent-hub/attachments/` (created on demand) and are appended as `@path`; a one-time hint suggests adding `.agent-hub/` to `.gitignore` – we never edit it. Saved prompts are user-authored text in desktop `settings.json` (`composer.savedPrompts`) – an explicit, user-approved rule-5 exception – normalized on save (title 80, text 20 000 chars, 200 prompts, unique ids) and replaced by `savedPromptCount` in the diagnostics zip.
**Consequence:** The 40 ms Enter delay and paste behaviour need a manual check against live Claude Code / Codex TUIs.

## D-043 Split pane (M4)

**Decision:** At most two panes per workspace terminal panel: the left half is the active tab, the right half `splitTabId`, persisted as `splitIndex` in the frontend-owned `terminals` slice of `state.json`. Split via tab menu, dragging a tab onto the right half, or the header split button. Closing either half's tab returns to a single pane; splitting never closes or duplicates a terminal. The focused half is session state only. The permission card is capped to the pane height and scrolls in narrow halves.
**Consequence:** The header split button exists on agent panes only; plain shell tabs split via the tab menu or drag.

## D-044 Brand switch: one `brand.json`, protocol names stay (M5)

**Context:** The product name is still a working name and will change at the end of M5. Identity values were spelled in ~40 places across Rust, C#, TypeScript and the Tauri config, and some of them (hook marker, data folders, credential targets) are on users' disks.
**Decision:** `brand.json` at the repo root is the single source (`name, slug, identifier, publisher, exePrefix, website, supportEmail, updateEndpoint, legacy{slugs, hookMarkers, credentialPrefixes}`). Readers: `crates/proto/build.rs` generates `agenthub_proto::brand` (app + hook sidecar); Hub.Core embeds the file (`Brand.Current`), `hub/Directory.Build.props` reads `Company`/`Product`/the hub's `AssemblyName` from it; the UI imports it in `src/app/constants.ts` (strings interpolate `APP_NAME`); `index.html` gets the title from a Vite plugin. `tauri.conf.json` is *checked*, not generated: `src-tauri/build.rs` fails the build when `productName`, `identifier`, the window title or the sidecar name differ from `brand.json` (one config file for `cargo`, `tauri dev` and `tauri build`; a rename edits both files). Derived values: data folders `%APPDATA%`/`%LOCALAPPDATA%\<slug>`, exes `<exePrefix>-hub/-hook/-statusline`, hook marker `<exePrefix>-hook`, pipe `\.\pipe\<exePrefix>-<pid>`, mutex `Local\<slug>.hub`, credentials `<slug>/ai/<name>` (user `<slug>`), log `<exePrefix>.log`, `TERM_PROGRAM=<slug>`, workspace folder `.<slug>/attachments`, export names `<slug>-cost-…`. Kept fixed as protocol/internal names: `AGENTHUB_*` env vars, `X-AgentHub-Token`, crate/package/solution names, the cargo binary `agenthub-hook` (copied as `<exePrefix>-hook-<triple>.exe`), Copilot's `hooks/agenthub.json` and OpenCode's `plugins/agenthub.js` + plugin id (a renamed file would leave the old one behind and the agent would run both). A Rust guard test (`crates/proto/tests/brand_guard.rs`) fails on `agent-hub`, `agenthub-hook` or `dev.agenthub.app` in product code outside comments, tests, docs, `schema/` (published ids) and a three-file allowlist.
**Migration (active only when `legacy` lists are non-empty):** the desktop app moves `%APPDATA%\<legacy>` and `%LOCALAPPDATA%\<legacy>\{logs,diagnostics}` before its logger starts; the hub moves `%LOCALAPPDATA%\<legacy>\hub` itself after taking its mutex, and exits 2 (supervisor retries) while a legacy hub still holds `Local\<legacy>.hub`; never merges into an existing folder. Hook entries containing any current or legacy marker are ours (uninstall removes, install/repair rewrites them; legacy status line exes are derived from `<legacy marker minus -hook>`). AI keys are read from legacy credential prefixes when missing, re-saved under the new prefix and removed from the old one.
**Consequence:** Renaming = edit `brand.json` + `tauri.conf.json` (build check), add the old values to `legacy`, replace icons. Not migrated: Tauri's own identifier folders (window state, WebView2 storage). The desktop app's cargo binary stays `agenthub.exe` while the hook's process-chain lookup matches `<exePrefix>.exe` and `<name>.exe`, so a renamed build must ship with Tauri `mainBinaryName` (or the bundled `<name>.exe`). Tests that spell today's paths (hook exe fixtures) still pass with today's brand but must be updated when the values change.

## D-045 Licensing: Polar keys, hub-computed update window, Pro gate (M5)

**Superseded by D-047** (no paid tier; the licensing code is removed).

**Context:** One-time Pro purchase with one year of updates, Supporter with lifetime updates, no own server (PRD §7). Polar is the Merchant of Record (supports Turkish individual sellers, built-in license keys with a public, unauthenticated customer-portal API). Polar's `validate` answers 404 for expired keys and `activate` refuses them, so a Polar expiry would lock users out of their already-paid builds on a new machine.
**Decision:** The hub owns licensing. `POST /v1/license {key}` = Polar `activate` (label `device-<16 hex of a salted SHA-256 of the machine name>`) + `validate`; `DELETE` deactivates (best effort) and deletes `license.json`; `GET` → `{tier, state, licensee, updatesUntil, buildDate, keyHint, enforced}`; a `license` stream event on change. Keys never expire in Polar; `updatesUntil` = key `created_at` + the tier's update period (Pro 365 days, Supporter unlimited), capped by a Polar `expires_at` if one ever appears. A build whose `BuildDate` (assembly metadata, `-p:HubBuildDate=` in release builds) is after `updatesUntil` runs as Free (`updates-expired`). Renewal = a new key that replaces the old one. Revalidation every 30 days; network errors, timeouts, 429 and 5xx never downgrade, explicit Polar rejections mark the key invalid. The key is never logged (last 4 chars only). Pro routes carry `ProFeature` metadata; one middleware answers `402 {error:"pro-required", feature}` for usage history/limits/pricing, reports/customers, tasks and dictation. Free: events, sessions, stream, permissions, adapters, settings, AI provider configuration, `/v1/usage/current` (status line), license. Without Pro the daily summary uses its template (no AI run). Mission control and custom agents are gated in the desktop. `Licensing.Enforce` defaults to true; tests default it off; debug builds read `AGENTHUB_LICENSE_ENFORCE`, `AGENTHUB_POLAR_*` (sandbox), release builds ignore them.
**Consequence:** No infrastructure to run; one network call on activation and at most every 30 days. The Polar organization id and benefit ids are empty until the products exist (activation answers `not-configured`). "Activation limit reached" is detected from the 403 `detail` text (not a documented code). Bypassable by patching the binary – accepted at this price.

## D-046 Open-source notices are generated (M5)

**Context:** The hub ships self-contained (the .NET runtime included) and the app bundles hundreds of crates and npm packages; the hand-written notices listed direct dependencies only.
**Decision:** `scripts/notices/generate-notices.ps1` regenerates `THIRD_PARTY_NOTICES` with full license texts for what ships: `cargo about` (JSON, Windows x64 + ARM64 targets, no dev-dependencies, own crates filtered by name), the npm runtime `dependencies` tree read offline from node_modules (peers/optionals excluded), NuGet packages incl. transitive and the .NET/ASP.NET runtime packs from the NuGet cache, plus assets (Geist OFL-1.1, SQLite, Whisper models downloaded at runtime). A summary at the top flags copyleft (none) and MPL-2.0 packages with their source URLs; dual-licensed packages elect the permissive option. Fallback texts live in `scripts/notices/licenses/`.
**Consequence:** Rerun after every dependency change and before each release (`cargo install cargo-about --locked --features cli` once). Legal drafts (EULA, privacy, refund, trademarks; EN + TR) are in `docs/legal/` with placeholders and need a lawyer's review before publishing.

## D-047 Free and open source under Apache-2.0; licensing removed (M5)

**Context:** M5 was planned as a paid release (Polar keys, Free/Pro gate, D-045). Market check (2026-10-09): most comparable tools are free or open source (herdr, Zed's agent panel, Conductor, Parallel Code, Claude Squad, Nimbalyst, usage widgets), the agent vendors ship their own multi-agent views, and keeping up with vendor hook/event/usage changes is a large load for one maintainer. A closed app that installs hooks into agent configs and sees terminals also needs trust it cannot easily earn.
**Decision:** The app is free and open source under Apache-2.0 (patent grant, no copyleft; all shipped dependencies are permissive or MPL-2.0, D-046). No paid tier: the hub licensing (Polar client, license store, `/v1/license`, `ProFeature` 402 gate, `BuildDate`) is removed and every feature is free. The public repo is a new repository created from a scrubbed tree as one initial commit (no employer-internal names, no commercial drafts); the private repo keeps its history. Releases go to GitHub Releases, which also host the updater's `latest.json`; CI builds them. The first release is unsigned or signed with an own certificate; afterwards the project applies to SignPath Foundation (free OSS signing; needs a released build, verifiable CI builds, per-release approval, MFA, a "Code signing policy" section and a privacy policy).
**Consequence:** No payment, tax or license infrastructure; EULA and refund drafts are dropped, the privacy policy stays. Contributions (mainly new adapters as `adapter.json` + fixtures) become the way to share the maintenance load, so contributor docs and CI are part of M5. The brand switch (D-044) still applies the final name before the public repo is created.

## D-048 Packaging, updater and CI for the open-source release (M5)

**Context:** The hub was not bundled (the app looked for it next to its exe), only the hook was an externalBin (x64), the bundle shipped adapter fixtures, there was no updater, and dictation had no whisper.cpp native runtime package (only the `Whisper.net` bindings), so it could not load a model in any build.
**Decision:** `scripts/release.ps1 -Arch x64|arm64 [-Sign]`: UI build → hub `dotnet publish` self-contained single file per RID (no trimming/AOT; native DLLs stay separate files, only this RID's `runtimes/<rid>` and `runtimes/<variant>/<rid>` folders are kept; IIS/static-asset leftovers dropped) → `binaries/<exePrefix>-hub-<triple>.exe` + its files as resources installed next to the app exe (where `locate_hub_exe` looks) → adapters staged without `fixtures/` → `tauri build --target` with a generated overlay config (`target/release-staging/tauri.release.conf.json`: hub sidecar, signing, updater artifacts). `mainBinaryName` = `exePrefix` (build check). NSIS per-user, English + Turkish, `installerHooks` close the app with Tauri's macro and then stop only the hub inside `$INSTDIR` (wait 5 s, then kill). `scripts/sign.ps1` signs with a local certificate by thumbprint (`AGENTHUB_SIGN_THUMBPRINT`), skipped with a warning when unset. Updater: `tauri-plugin-updater`; feed = `brand.json` `updateEndpoint` (a `latest.json` asset on the public repo's latest release), minisign key in `plugins.updater.pubkey`; either empty → `update_check` answers `not-configured` and the app runs normally. Commands `update_check` / `update_install` (events `update://progress`, `update://ready`); on Windows the plugin runs the app's normal shutdown, starts the passive installer (which relaunches the app) and exits – no process plugin. `app_info` also returns `repository`, `website`, `supportEmail`. Frontend: About (Apache-2.0, repo/issues/discussions links when `repository` is set, open-source licenses viewer loading `THIRD_PARTY_NOTICES` through a small Vite virtual module), "Check for updates on start" (default on, 4 s after launch, silent unless an update is available), update card with progress. Whisper: `Whisper.net.Runtime` (CPU, win-x64 + win-arm64) and `Whisper.net.Runtime.Vulkan` (GPU, x64 only; ARM64 falls back to CPU). CI: `ci.yml` (UI build/tests, clippy, Rust tests, Playwright e2e, hub build/tests on `windows-latest`), `release.yml` on `v*` tags (x64 + arm64 cross-build, `latest.json` only when signatures exist, draft release; SignPath step as a placeholder).
**Consequence:** The installer is ~40 MB before the Whisper runtimes (the hub sidecar is ~110 MB uncompressed). Updates need the user's minisign key pair (public key in config, private key + password as repo secrets) and the repo URL in `brand.json`. Unsigned builds are blocked where Smart App Control is on, so a release needs a code signing certificate. Not verified automatically: installing, updating from an older build, dictation in the packaged build, an ARM64 build (the aarch64 Rust target is not installed locally; CI builds it).

## D-049 Final brand Kotilo, robot snail, public repo files (M5)

**Context:** The working name had to be replaced before the public repo. Candidates were checked against USPTO (classes 9/42), domains, GitHub and package registries (2026-10-11). "Den Den" leans on One Piece IP; "Shellix" contains the famous SHELL mark; KOTILO had no USPTO record and free npm/crates/NuGet/PyPI names.
**Decision:** Product name **Kotilo** (Finnish for a snail shell, *koti* = home): `brand.json` name `Kotilo`, slug/exePrefix `kotilo`, identifier `dev.kotilo.app`, repository and website `https://github.com/kotilo-dev/kotilo` (support = GitHub issues, no support email), update feed `…/releases/latest/download/latest.json`; `legacy` lists the working-name values (`agent-hub`, `agenthub-hook`) so a dev install migrates (D-044). Mascot: a robot snail with a spiral shell whose core and antennas carry the status colour; the app icon is its single-line glyph (`apps/desktop/src-tauri/icons/source/kotilo.svg`, all sizes generated with `tauri icon`, also the favicon and About image). Agent config backups are now named `<file>.<exePrefix>-backup-<stamp>`; the diagnostics zip `<exePrefix>-diagnostics-<stamp>.zip`. The brand guard also rejects the new identity literals. Public repo files: `LICENSE` (Apache-2.0 text), `NOTICE` ("The Kotilo Authors"), user-facing `README` (code signing policy section for SignPath), `CONTRIBUTING`, `SECURITY` (GitHub private vulnerability reporting), issue/PR templates; no per-file license headers. Privacy policy rewritten for the free app; EULA, refund and store listing deleted. Planning docs no longer name the removed proprietary integration or private source repos (AGENTS rule 1 is now "no proprietary code").
**Consequence:** Internal names stay (`agent-hub` folder, `AgentHub.sln`, `agenthub-*` crates, `AGENTHUB_*`, `X-AgentHub-Token`, Copilot `agenthub.json`, OpenCode `agenthub.js`, schema `$id`s). The GitHub org is `kotilo-dev` (`kotilo-app` was taken; matches the `kotilo.dev` domain, which the user still has to register); EU/TR trademark checks are the user's. Claude Code plan limits need the status line helper that was deferred in M0 (D-005) and is still not built; docs say "not shown yet".

## D-050 First release unsigned, SignPath afterwards (M5)

**Context:** Windows warns about unsigned installers (SmartScreen, can be clicked through) and Smart App Control blocks them outright. SignPath Foundation signs open-source projects for free but expects a released, verifiable project; an own open-source certificate costs money and identity checks.
**Decision:** `v0.1.0` is published as an unsigned beta from the CI release workflow. Right after it, apply to SignPath Foundation; the release workflow's signing step stays a placeholder until accepted. The README's code signing policy already says releases are unsigned until then.
**Consequence:** Early users on machines with Smart App Control enabled cannot run v0.1.0 (they can build from source); everyone else sees a SmartScreen warning. The release notes say both. Updates stay verified by the minisign key regardless of code signing.

## D-051 SignPath Foundation readiness (M5)

**Context:** SignPath Foundation's terms (signpath.org/terms) require a "Code signing policy" on the home and download pages with the statement "Free code signing provided by SignPath.io, certificate by SignPath Foundation.", named team roles (authors, reviewers, approvers), MFA for the team, a privacy statement, manual approval per signing request, and enforced metadata: every signed binary has the project's product name and the same product version. The v0.1.0 binaries did not all meet the last point: `kotilo-hook.exe` had no version resource and `kotilo-hub.exe` had `0.1.0+<commit>` as product version.
**Decision:** The hook sidecar embeds a version resource at build time (`crates/hook/build.rs`, `tauri-winres`): product and company name from `brand.json`, version from `tauri.conf.json`. The hub drops the source revision from its informational version, and `scripts/release.ps1` fails when the hub's `<Version>` differs from the app version. Only our own binaries are signed (installer, uninstaller, app, hub, hook); third-party DLLs are not. The README's code signing policy names the roles (one maintainer for now) and carries the statement verbatim; release notes link to it (download page).
**Consequence:** Bumping the version still means editing `tauri.conf.json`, `package.json` and `hub/Directory.Build.props`, but a mismatch now stops the release build. The SignPath artifact configuration must list exactly the five files above and enforce product name `Kotilo` and the release version.

## D-052 Robot snail mascot (M6)

**Context:** PRD §5 lists an optional desktop mascot; D-049 picked the robot snail (concept B: spiral shell, core and antennas in the status colour). The old prototype's "Bip" was a 16×16 pixel sprite in a Win32 layered window; its state resolver and sprite loader had been ported to the hub but nothing used them. The user chose (2026-10-11) vector art exactly like concept B, both placements selectable in Settings (walk along the taskbar by default, or sit in the bottom-right corner), and off by default with a one-time suggestion.
**Decision:** The mascot is a small transparent Tauri webview window `mascot` (`index.html?view=mascot`, 2H × 2H logical px with H = 16 × scale, snail bottom-centred; created only while on). The art is one React SVG (`features/mascot/MascotSnail.tsx`) with tokens `--mascot-*` that do not follow the app theme, because it sits on the user's desktop; state is a data attribute with CSS animations, and `prefers-reduced-motion` turns them off. The aggregate state is computed in the main window (`mascotLogic.ts`, the old resolver ported: perm > error > input > sweat > work > done 3 s > sleep; DND/quiet hours → sleep) over own agents and hub sessions merged per pane; sweat = a `usage.burn_projection` notification for the still-running block; done = a working → idle transition after at least `rules.minTurnForCompleted`. The main window sends `mascot_set_config` / `mascot_update`; Rust (`platform/mascot/`) owns the window, the pure walk geometry (tested) and the Windows calls (`SHAppBarMessage` taskbar edge, `SHQueryUserNotificationState` full-screen hide, `SPI_GETCLIENTAREAANIMATION`, `SetWindowPos(SWP_NOACTIVATE)`), walks only for work/sweat with a ~30 fps thread that exits when standing, and checks full screen / work area / DPI every 2 s while visible. Clicks, the native right-click menu and drag come back as `mascot:clicked`, `mascot:menu`, `mascot:position`. Hub: `buddy.mascotEnabled` defaults to false, new `buddy.mascotOffered`, and the settings file gets `Version` (1) so files written before it turn the mascot off once; the unused C# `MascotState`/`SpriteSheet` and the sprite fixture are deleted.
**Consequence:** The mascot costs one more WebView2 renderer while it is on and nothing while it is off. Only the primary monitor is used and the snail never climbs a vertical taskbar (it walks along the work area's bottom instead). Mascot settings save immediately (fresh GET, change only `buddy`, PUT) without touching an unsaved Settings draft. Real-desktop behaviour (taskbar positions, auto-hide, DPI, full screen, menu focus) is covered by manual tests M6-1…M6-10.

## D-053 Assistant chat popup without history (M7)

**Context:** PRD §5 lists a small assistant chat; the old prototype's "Bip" chat was never ported (only an unused `claude -p` runner, a `buddy_chats` table that would have stored the first 60 characters of a message as a title, a transcript reader and a markdown parser). The provider layer was single-turn and non-streaming. The user decided (2026-10-11) that the chat keeps **no history at all** – nothing on disk, also not in the agent CLIs' own session files ("verdiğimiz mesaj gizlilik bozulmasın") – and that it is a **general chat** without session or usage context.
**Decision:** `IAiProvider.ChatAsync` streams multi-turn answers: OpenAI-compatible endpoints with `stream: true` (SSE, JSON fallback), Claude Code with stream-json and the conversation rendered into the prompt (no `--resume`), other CLIs in plain mode (answer at the end). CLIs run without session files where their installed `--help` offers it – Claude Code `--no-session-persistence`, Codex `exec --ephemeral`, Qwen `--chat-recording false`; Copilot CLI, OpenCode and Gemini CLI have no such option, so `ephemeral: false` and the popup warns that the agent keeps its own copy (Droid/Cursor unverified: "may keep"). The hub serves `GET /v1/assistant/info` and `POST /v1/assistant/chat` (chunked NDJSON meta → text → done, client abort = cancel, one chat at a time, 40 messages / 32k chars); logs carry only provider, model, duration, outcome and counts. `buddy_chats` is dropped (migration 010) and the old chat code deleted. The desktop's `RegisterHotKey` thread became app-wide (dictation + assistant); `buddy.hotkey` (default `Ctrl+Alt+Space`, must differ from the other hotkeys) toggles a focusable, transparent, always-on-top 400×580 popup at the bottom right of the monitor under the cursor. Rust streams the hub answer to the page over a Tauri `Channel`; the conversation lives only in the page's memory and is cleared on every open and close. The mascot opens the assistant on click in sleep/done/work and from its menu.
**Consequence:** Every opening is a new chat by design, and the popup does not hide on focus loss (that would discard the chat). Each turn resends the whole conversation, so long chats cost more tokens with CLI providers. One-shot AI jobs (daily summary, dictation cleanup) still let Claude Code keep its session file, as before M7. Focus, placement on mixed-DPI monitors and hotkey conflicts are covered by manual tests M7-1…M7-8.
