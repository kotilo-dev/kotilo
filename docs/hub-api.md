# Hub API (v1)

The hub (`kotilo-hub.exe`) serves a loopback-only HTTP API on `127.0.0.1:<port>`. Port and token come from `port.json` in the hub data folder (`%LOCALAPPDATA%\kotilo\hub`, or `AGENTHUB_DATA_DIR`); both change on every start. TypeScript types for every shape below: [`apps/desktop/src/lib/hubTypes.ts`](../apps/desktop/src/lib/hubTypes.ts). The hook ingest side is documented in [agent-protocol.md](agent-protocol.md).

## Conventions

- **Auth:** every route needs the header `X-AgentHub-Token: <token>`; a missing or wrong token gets `401`. Requests that carry an `Origin` header get `403`, which blocks browsers. The desktop app keeps the token in Rust; the webview goes through the `hub_request` command and `hub:event` events.
- **JSON:** camelCase. Enums are camelCase strings, except session states (`state`, `from`, `to`), which keep the PascalCase names (`WaitingPermission`). Timestamps are ISO-8601 with an offset, dates (`DateOnly`) are `yyyy-MM-dd`, and durations inside settings are .NET TimeSpan strings (`00:00:05`).
- **Errors:** any non-2xx body is `{ "error", "message", "fields" }`, where `fields` is `{ "<dotted.path>": ["…"] }` or null.
  - `error` values: `invalidRequest` (400), `notFound` (404), `unknownAdapter` (404), `noHooks` (409), `invalidConfig` (422), `io` (500).
- **Privacy:** prompt and response text never reach the hub (the hook strips it). Tool output never reaches it either, and a tool's arguments arrive reduced to metadata: paths, command, search pattern, URL, query, a short description and TodoWrite todos (texts ≤ 200 chars); edit strings, written file content, notebook sources, sub-agent prompts and MCP arguments are dropped, and an `apply_patch` body is replaced by the file paths it names. The pending permission's command and path and the activity timeline live only in memory (never in SQLite or logs).

## Stream – `GET /v1/stream` (WebSocket)

Each JSON text frame is `{ "type": "…", "data": … }`. On connect the hub sends one full snapshot of each state type, in this order: `sessions`, `usage`, `limits`, `health`, `tasks`. After that it sends a fresh snapshot of a type whenever that type changes.

- **Coalescing:** each state type is sent at most once per 100 ms, so session frames peak at about 10/s.
- **`notification` events** are sent one by one, in order. They are not part of the snapshot.
- **`activity` deltas** are not part of the snapshot either: on connect a client gets no timeline (fetch `GET /v1/sessions/{agent}/{id}/activity` when it needs one). Afterwards, at most every 100 ms, the hub sends one `activity` frame per session whose timeline changed, holding only the entries that are new or changed since the previous frame (merge them by `id`) and the session's current plan.
- **Slow clients:** each client has a 512-frame queue; when it is full, the oldest frames are dropped.
- Anything the client sends is ignored, and the hub closes the stream with `1000` when it shuts down.

| type | data |
|---|---|
| `sessions` | `SessionDto[]`, same as `GET /v1/sessions` |
| `usage` | `UsageCurrent`, same as `GET /v1/usage/current` |
| `limits` | `LimitDto[]`, same as `GET /v1/limits` |
| `health` | `HealthDto`, same as `GET /v1/health` |
| `tasks` | `{ today, overdue }`: open personal tasks due today / overdue (local time). Resent on every task change and when the clock moves a task into today or overdue (checked once a minute) |
| `activity` | `ActivityFrame` `{ agent, sessionId, entries, plan }` (delta, see Activity below) |
| `notification` | `NotificationDto` (below) |

**Notifications.** The hub's rule engine decides which notifications fire: session rules (spec §11.1), `todo.completed`, and the `usage.*` rules. Global quiet hours and do-not-disturb are applied before sending. The desktop app shows the toast and suppresses it itself when the agent's pane is visible and the window is focused.

Fields:
- `title` and `body` are ready to show in the hub language (`settings.language`). The title follows the pattern `<project>: <state>`.
- `severity` is `attention` (waiting for permission or input, reminder, error), `warning` (stale, context, usage) or `info` (completed, todo).
- The structured fields (`ruleId`, `agent`, `sessionId`, `paneId`, `projectName`, `projectRoot`, `state`, `at`) let a client write its own text.

## Ingest and adapters

| Route | Notes |
|---|---|
| `POST /v1/events` (alias `/v1/hook`) | Hook envelope v1 / Agent Integration Protocol v1 ([agent-protocol.md](agent-protocol.md)) → `202`; `503` when the pipeline queue is full |
| `POST /v1/statusline` | Claude Code statusLine JSON → `202` |
| `GET /v1/adapters` | `AdapterDto[]`: built-in adapters first (display order), then user adapters by id |
| `POST /v1/adapters/reload` | Re-reads the built-in and user `adapter.json` files → `200 AdapterDto[]` |
| `POST /v1/adapters/{id}/hooks/install` / `…/uninstall` | `200 HookActionResult`; `404 unknownAdapter` (no usable adapter with that id); `409 noHooks` (protocol adapter); `422 invalidConfig`; `500 io` |

`AdapterDto`: `{ id, displayName, source: "builtIn" | "user", definition, hooks, error }`.
- `definition` is the `adapter.json` object as written ([`schema/adapter.v1.json`](../schema/adapter.v1.json): avatar, detect, launch, gracefulClose, permissionKeys, hooks, usage, screenRules), or `null` when the file is missing or invalid.
- `hooks` is `{ state, configPath, needsApproval, hint }` for agents with a hook installer and `null` for protocol (hookless) adapters. `state` is `missing | installed | outdated | invalidConfig | unsupported`. `needsApproval` (Codex): installed, but the user still has to approve the hooks in the agent. `hint` is `null` or why installed hooks may still stay silent: `folderTrust` (Gemini CLI runs hooks, also user-level ones, only in folders the user trusted; folder trust is on by default) or `hooksDisabled` (the agent's own setting switches all hooks off: Gemini `hooksConfig.enabled: false`, Qwen `disableAllHooks: true`, Droid `hooksDisabled: true`).
- Factory Droid: `configPath` is the file Droid reads the hooks from: `~\.factory\hooks.json` when it exists or when `~\.factory\settings.json` has no non-empty `hooks`, otherwise the `hooks` key of `settings.json` (creating `hooks.json` would hide those). Install also removes Kotilo entries left in the other file (`outdated` until then); uninstall cleans both. Droid snapshots hooks at startup, so a change applies from the next session. Cursor CLI: `configPath` is `~\.cursor\hooks.json`; only observational events are registered (D-025).
- Copilot CLI: `configPath` is Kotilo's own `$COPILOT_HOME\hooks\agenthub.json` (deleted on uninstall). OpenCode: `configPath` is the plugin file `$XDG_CONFIG_HOME\opencode\plugins\agenthub.js` (default `~\.config\opencode\plugins`); `installed` = byte-identical to what Kotilo renders for the current hook exe, `outdated` = an older plugin or another exe path, `invalidConfig` = a file with that name that is not Kotilo's (install refuses after a backup). A running OpenCode service picks up a new plugin only after it restarts.
- `error` is `null`, or why the definition is not used: invalid JSON or schema (first errors), id ≠ folder name, or a user id that a built-in adapter already has (then a second entry with that id is listed, with `source: "user"`). A built-in adapter with a broken file keeps working (`error` set, `definition: null`).
- Built-in definitions come from `AGENTHUB_ADAPTERS_DIR` (the desktop app passes its bundled `adapters` folder), else the nearest `adapters` folder above the hub exe. User definitions come from `%APPDATA%\kotilo\adapters\<id>\adapter.json` (`AGENTHUB_USER_ADAPTERS_DIR` overrides the folder). Every valid user definition gets the protocol adapter; events for ids without an adapter are rejected.
- Health (`/v1/health`): a `HooksBroken` issue has `detail: [setup]` for Claude Code (`Missing` or `WrongPath`) and `["WrongPath", "<agent id>"]` for any other agent whose installed hook entries point at an exe that no longer exists.

## Sessions

| Route | Response |
|---|---|
| `GET /v1/sessions[?includeEnded=true]` | `SessionDto[]`. By default this is the live tracker view, which includes sessions that ended in the last 30 minutes. `includeEnded=true` adds persisted sessions from the last 7 days (up to 200). |
| `GET /v1/sessions/{agent}/{id}/transitions` | `TransitionDto[]`, oldest first; `404` for an unknown session |
| `GET /v1/sessions/{agent}/{id}/activity` | `ActivityDto` `{ entries, plan }` (memory only, see below); `404` for a session the hub does not track |

`pendingPermission` is set only while `state` is `WaitingPermission`. It holds `{ tool, command, path, risk, since }`. `risk` is one of `deletesFiles`, `writesDatabase`, `network`, `installsPackages`, `gitPush` or `other`, and is `null` when there is no command (file edits).

### Activity (memory only)

`GET /v1/sessions/{agent}/{id}/activity` → `{ entries, plan }` for a session the hub tracks (`404` otherwise; a known session without tool events answers `{ entries: [], plan: null }`).

- **Entries**, oldest first, at most the last 200 per session; ids ascend across the hub. A tool entry is `{ id, kind, tool, target?, paths?, startedAt, durationMs?, status }`; a turn marker (a real user prompt submit) is `{ id, kind: "turn", at }`.
  - `kind`: `read` (Read, LS, view, read_file, …), `search` (Grep, Glob, web fetch/search), `edit` (Edit, MultiEdit, replace, NotebookEdit, apply_patch), `write` (Write, Create, write_file), `bash` (Bash, shell, Execute, powershell, run_shell_command), `task` (Task / sub-agents) or `other` (MCP tools, TodoWrite, unknown names).
  - `target`: the tool's path relative to the session's project root with forward slashes when inside it, else the absolute path; else its command; else its pattern / URL / query / description. Single line, at most 200 characters; absent when the call names nothing. `paths`: every file of a multi-file call (Codex `apply_patch`), relative like `target`.
  - `status`: `running`, `ok`, `failed` (PostToolUseFailure, or still running when the turn was interrupted / failed / the session ended), `denied` (a permission prompt was shown and the turn ended without the tool's Post event). A tool still running when a turn ends normally becomes `ok` without `durationMs`.
  - Pairing: a Post event finishes the running entry with the same `tool_use_id`, else the oldest running entry with the same tool name. Agents that send only Post events (Copilot CLI, Cursor CLI) add finished entries; `startedAt` is then the Post time minus the reported duration, if any. Cursor's double report of one call (`postToolUse` + `afterShellExecution` / `afterFileEdit` within 3 s) becomes one entry.
- **Plan:** the latest TodoWrite (Claude Code, and any agent whose tool input carries `todos`) as `{ items: [{ text, status: "pending" | "in_progress" | "completed" }] }`, or `null`.
- Per agent: Claude Code, Codex, Qwen Code (Pre + Post, `tool_use_id`), Gemini CLI and Factory Droid (Pre + Post, FIFO by name), Copilot CLI and Cursor CLI (Post only; Copilot `permissionRequest` opens an entry), OpenCode (plugin v2 forwards `session.tool.called` / `.success` / `.failed` with the tool name and its path, command or pattern, paired by call id). Protocol (custom) agents have no tool events.
- A timeline is dropped 10 minutes after its session ends (or the tracker forgets it), after 12 hours without events, or when more than 256 sessions have one (least recently active first). Nothing of it is written to SQLite, files or logs, so a hub restart starts with no timelines (D-036).

## Usage and limits

| Route | Params | Response |
|---|---|---|
| `GET /v1/usage/current` | – | `UsageCurrent`: the active 5-hour block, today and the week |
| `GET /v1/usage/daily` | `days` 1..90 (default 30) | `DailyUsage[]`, one row per local day including empty days, with `byAgent` |
| `GET /v1/usage/blocks` | `days` 1..90 (default 7) | `UsageBlockDto[]`, newest first; gaps have `isGap: true` |
| `GET /v1/usage/breakdown` | `by` = `project` (default), `model` or `agent`; `days` | `BreakdownRow[]`, by tokens descending |
| `GET /v1/limits` | – | `LimitDto[]` `{ agent, window, usedPercent, resetsAt }`: windows `fiveHour` / `weekly`, per agent (Claude first, then Codex, then other agents as their limits appear). Claude limits come from the statusLine, Codex limits from rollout `rate_limits`. Expired windows are left out. |

Costs are local API-price estimates. `hasUnpricedEntries` marks totals that include models with no price (for example Codex without a `pricing.json` entry); show `—` for those, not `$0`. `GET /v1/pricing` returns `{ path, error, models }` for the active price table.

Usage rows come from each agent's usage sources (Claude transcripts, Codex rollouts; files are watched, databases polled) and from Agent Integration Protocol `usage` events. A cost the agent reported itself (`costUsd`) is kept when `pricing.json` changes; every other cost follows the price table.

## Reports

| Route | Params | Response |
|---|---|---|
| `GET /v1/reports/waits` | `from`, `to` (`yyyy-MM-dd`, inclusive local days; default the last 7 days; at most 366 days) | `WaitReport` |
| `GET /v1/reports/cost` | `from`, `to` (default the last 30 days); `groupBy` = `customer`, `project` (default), `agent` or `model`; `format` = `json` (default), `csv` or `xlsx`; `lang` = `en` or `tr` (default: hub language) | JSON `CostReport`, or a file download (see below) |
| `GET /v1/reports/daily-summaries` | `limit` 1..365 (default 30) | `DailySummary[]`, newest first |
| `GET /v1/reports/daily-summaries/{date}` | – | `DailySummaryDetail`: the stored summary (or null) plus the day's metrics |
| `GET /v1/reports/daily-summaries/status` | – | `DailySummaryStatus` |
| `GET/POST /v1/customers`, `PUT/DELETE /v1/customers/{id}` | body `{ name, color, archived }` | `Customer`; `404` for an unknown id |

**Cost export formats.** `csv` returns `text/csv` with a BOM; `tr` uses `;` and a decimal comma. `xlsx` returns one sheet per grouping plus a daily sheet. Both are sent as attachments.

**Daily summaries.** Generating a summary is not exposed yet: it needs the AI runner and localized template labels from a client. `status.generationAvailable` is `false` with `reason: "clientRequired"`. Stored summaries are served as they are. `status.model` is `ai.dailySummary.model`, or its provider id when no model is set.

## Projects

| Route | Body / params | Response |
|---|---|---|
| `GET /v1/projects[?includeHidden=true]` | – | `ProjectDto[]` with todo progress, the next open item, git status (when git is available), `customerId` and `alias` (the user's display name, `null` when `name` is the folder name) |
| `GET /v1/projects/files?root=…` | – | `TodoFileDto[]` with groups and items; `400` without `root`, `404` for an unknown root |
| `POST /v1/projects/folders` | `{ path }` (an existing folder) | `201 { root }` (resolved to the git root) |
| `PUT /v1/projects/alias` | `{ root, alias }` (`null` clears it) | `204` |
| `PUT /v1/projects/hidden` | `{ root, hidden }` | `204` |
| `PUT /v1/projects/customer` | `{ root, customerId }` (`null` unassigns) | `204`; `404` for an unknown customer |

## Personal tasks

| Route | Body / params | Response |
|---|---|---|
| `GET /v1/tasks` | `filter` = `open` (default), `done` or `all`; `q` searches the text and the project name | `PersonalTask[]` in display order (overdue → deadline → priority → newest; completed ones newest first) |
| `POST /v1/tasks` | `TaskInput` | `201 PersonalTask` |
| `PUT /v1/tasks/{id}` | `TaskInput` (replaces every field) | `PersonalTask` |
| `POST /v1/tasks/{id}/complete` | `{ completed }` (default `true`) | `PersonalTask` |
| `DELETE /v1/tasks/{id}` | – | `204` |

**Validation.** `text` is required (at most 10 000 characters). `dueTime` is `HH:mm` and needs a `dueDate`. `priority` is `low`, `normal` or `high`. Changing the deadline re-arms the reminder.

## Dictation

| Route | Response |
|---|---|
| `GET /v1/dictations?limit=` (1..500, default 100) | `DictationRecord[]`, newest first |
| `DELETE /v1/dictations/{id}` / `DELETE /v1/dictations` | `204`; `404` for an unknown id |
| `GET /v1/dictation/models` | `DictationModel[]` (`large`, `small`): installed, selected, partial bytes, downloading/progress, last error |
| `POST /v1/dictation/models/{id}/download` / `…/cancel` | the model list; the download runs in the background and resumes via Range; SHA-256 is checked |
| `DELETE /v1/dictation/models/{id}` | `204` |
| `POST /v1/dictation/preload` | `202`; loads the selected model in the background. `409 modelMissing` when it is not installed |
| `POST /v1/dictation/transcribe` | Body `application/octet-stream`: little-endian f32 mono samples at 16 kHz → `200 DictationTranscribeResult`. `409 modelMissing` / `409 busy`; `400` when the length is not a multiple of 4; `413 tooLarge` over the limit; `415` for another content type |
| `POST /v1/dictation/cleanup` | `{ text }` → `200 DictationCleanupResult` |
| `POST /v1/dictation/cancel` | `204`; cancels the transcription or cleanup in flight |
| `POST /v1/dictations` | `{ durationSeconds, rawText, finalText, cleaned, outputs }` → `200 DictationSaveResult` |

Model download progress is not on the stream yet; poll `GET /v1/dictation/models`.

**Live dictation** (M2b, D-020). The desktop app records, inserts the text and shows the overlay. The hub transcribes, cleans up, writes the file output and keeps the history. A dictation runs in these steps:

1. **Preload.** When recording starts, the desktop calls `preload`.
2. **Transcribe.** When recording stops, it posts the audio to `transcribe`, already downmixed and resampled to 16 kHz.
   - The body limit is `dictation.maxMinutes` × 60 s + 1 s of samples, which is 4 bytes × 16 000 per second.
   - The hub trims leading and trailing silence. Less than 0.3 s of speech answers `status: "noSpeech"` without loading the model, so silence never fails with `modelMissing`.
   - Short speech is padded to 1.2 s.
   - Whisper runs with the settings' model, language, vocabulary prompt and GPU choice.
   - Bracketed annotations and known hallucination lines are removed. If nothing is left, the answer is `noSpeech`.
   - `status` is `"ok" | "noSpeech" | "cancelled"`. The answer also carries `rawText`, `speechSeconds`, `model` and `language`.
3. **Cleanup.** When `dictation.aiCleanup` is on, the desktop calls `cleanup`.
   - It runs the `ai.dictationCleanup` provider (see [AI providers](#ai-providers)) with the mode, custom prompt and vocabulary from the settings, with a 60 s timeout.
   - It answers `{ finalText, cleaned, note }`. On failure `finalText` is the input and `note` is `"cleanupFailed"`; when cancelled, the input comes back with no note.
   - With AI cleanup off, it answers the input with `cleaned: false`.
4. **Save.** After inserting the text, the desktop posts the result to `POST /v1/dictations`.
   - `outputs` lists what the desktop did itself: `"type"` (inserted into the focused field) and `"clipboard"`.
   - When `dictation.outputFile` is on, the hub appends a `## yyyy-MM-dd HH:mm` entry to `dictation.filePath`. It expands environment variables, creates the folder and adds `"file"` to `outputs`. A write failure comes back as `fileError` and is not an error status.
   - When `dictation.keepHistory` is on, the hub saves the record. `mode` is saved only when the text was cleaned; `model` and `language` come from the settings.
   - The answer is `{ id, outputs, fileError }`, where `id` is `null` when history is off.

**Rules:**
- One transcription or cleanup runs at a time. A second one answers `409 busy`; a cleanup that hits a busy hub answers `cleanupFailed`.
- `cancel` ends whichever is running: a transcription then answers `cancelled`, and a cleanup returns its input.
- The model is unloaded after 10 minutes without dictation.
- Audio is never written to disk or logs, and transcript text is never logged.

## Settings

| Route | Response |
|---|---|
| `GET /v1/settings` | `HubSettings` |
| `PUT /v1/settings` | Send back the whole object from GET with your changes (every section is required, except `ai`: left out, it stays unchanged). Returns `200 HubSettings`, or `400` with `fields` keyed by dotted path (`rules.contextThresholdPercent`, `dictation.hotkey`, `ai.providers[0].baseUrl`, …). |

The hub's internal bookkeeping (last scheduled summary, seen Claude versions, health toast days, the wrapped statusLine command) is not part of the API. No secrets live in these settings.

## AI providers

The hub's own AI jobs (assistant, daily summary, dictation cleanup) each run on a provider the user picks (M3, ARCHITECTURE §3a):

- **`cli:<adapter id>`** runs the user's installed agent CLI headless, one process per request, in an empty scratch folder (`<data>\buddy\ai-scratch`) with `AGENTHUB_INTERNAL=1` (the hook sidecar drops these runs' events). Tools are off or read-only and no auto-approve flag is ever passed. Authentication is the agent's own login; no credential file is read. Ids: `claude-code`, `codex`, `copilot`, `opencode` (flags verified against the installed `--help`), `gemini`, `qwen`, `droid`, `cursor` (from docs/source only, `verified: false`).
- **`openai:<name>`** calls `POST {baseUrl}/chat/completions` (`/v1` is added when the base URL does not end in a version segment) with `{model, messages: [system, user], stream: false}` and, when a key is stored, `Authorization: Bearer <key>`.

Prompts and answers are never logged or stored; the log gets provider id, error kind, duration and character counts.

**Settings** (`HubSettings.ai`):

```json
{
  "providers": [{ "name": "ollama", "kind": "openai", "baseUrl": "http://localhost:11434", "model": "llama3.1:8b", "hasKey": false }],
  "assistant": { "provider": "cli:claude-code", "model": "haiku" },
  "dailySummary": { "provider": "openai:ollama", "model": null },
  "dictationCleanup": { "provider": "cli:codex", "model": null }
}
```

- `providers[].name`: 1–48 of `A-Z a-z 0-9 . _ -`, unique. `kind` is `openai`. `baseUrl`: an http(s) URL without credentials, query or fragment. `hasKey` is read-only.
- Feature `provider` must be `cli:<known adapter id>` or `openai:<name in providers>`; an `openai:` feature needs a `model` here or on its provider. Models use `A-Z a-z 0-9 . _ : / @ # + - [ ]` (they reach agent command lines).
- Removing a provider deletes its stored key.
- **Migration:** pre-M3 settings had a Claude model alias per feature (`buddy.model`, `insights.dailySummaryModel`, `dictation.aiModel`); they become `cli:claude-code` with that model and are no longer part of the API. A new install defaults every feature to `cli:claude-code` / `haiku`. The toggles `insights.dailySummaryWithoutAi` and `dictation.aiCleanup` stay where they were.

| Route | Body | Response |
|---|---|---|
| `GET /v1/ai/providers` | – | `AiProvidersResponse`: `{ providers: AiProviderInfo[], fullyLocal, secretStoreAvailable }`. CLI entries only for agents whose executable is found (PATH + known install folders); `verified` says whether the headless flags were checked locally. |
| `PUT /v1/ai/providers/{name}/key` | `{ key }` | `204`. Stored in Windows Credential Manager (generic credential `agent-hub/ai/<name>`, local machine persistence); never in settings or logs. `404` unknown provider, `400` with `fields.key` (1–1280 characters, no control characters), `501 notSupported` without a vault (non-Windows for now). |
| `DELETE /v1/ai/providers/{name}/key` | – | `204` (also when there was no key). |
| `GET /v1/ai/providers/{name}/models` | – | `{ models: string[], errorKind }` from `GET {baseUrl}/models` (15 s). `404` for a name not in `ai.providers`. |
| `POST /v1/ai/test` | `{ provider, model? }` | `{ ok, errorKind, latencyMs }`. Runs the fixed prompt "Reply with OK" (60 s); the answer itself is never returned. `400` with `fields` for a malformed provider id or model. An unknown provider answers `ok: false, errorKind: "notConfigured"`. |

`errorKind`: `none`, `notInstalled`, `notLoggedIn`, `unreachable` (connection refused, DNS, TLS), `unauthorized` (HTTP 401/403), `timeout`, `failed`, `cancelled`, `notConfigured` (unknown provider, or no model for an `openai:` provider).

`fullyLocal` is true when every enabled AI feature (assistant while `buddy.enabled`; daily summary while enabled and not `dailySummaryWithoutAi`; dictation cleanup while `dictation.enabled` and `aiCleanup`) uses an `openai:` provider whose base URL host is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`). Agent CLIs always count as not local.

Failures keep the old behaviour: the daily summary falls back to its template, the dictation cleanup returns the raw text with `cleanupFailed`.
