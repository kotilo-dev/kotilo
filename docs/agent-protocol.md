# Agent Integration Protocol – v1

Status: v1 (M3). The protocol lets any agent CLI report its state to Kotilo without code in Kotilo: a user adapter (`adapter.json`) plus a few events. The built-in adapters (Claude Code, Codex, …) use the same transport and envelope, each with its own payload mapping; the normalized model they map to is the one below.

Schemas: [`schema/agent-protocol.v1.json`](../schema/agent-protocol.v1.json) (protocol events), [`schema/hook-envelope.v1.json`](../schema/hook-envelope.v1.json) (envelope), [`schema/adapter.v1.json`](../schema/adapter.v1.json) (adapter definition).

## 1. Register the agent

Create `%APPDATA%\kotilo\adapters\<id>\adapter.json` (the folder name must be the id; `AGENTHUB_USER_ADAPTERS_DIR` overrides the parent folder). Then press *Reload* in Settings → Agents (`POST /v1/adapters/reload`) or restart the app.

```json
{
  "v": 1,
  "id": "my-agent",
  "displayName": "My Agent",
  "avatar": { "letter": "M", "bg": "#1d2430", "ink": "#9cc4ff" },
  "detect": { "executables": ["my-agent.exe", "my-agent"] },
  "launch": { "command": "my-agent", "args": [] },
  "permissionKeys": { "allowOnce": "y", "deny": "Esc" },
  "usage": "protocol",
  "screenRules": [
    { "id": "approve", "state": "waitingPermission", "pattern": "Allow this command\\? \\(y/n\\)", "lines": 3, "clearOn": "input" }
  ]
}
```

- The file is validated against the schema. An invalid file is listed in Settings with its error and ignored; it never stops the app.
- Built-in ids (`claude-code`, `codex`, …) can't be reused: the built-in adapter wins and the user file is listed with an error.
- `usage`: `protocol` when the agent sends `usage` events, `none` when it has no data. (`builtIn` is for agents with a hub reader.)
- `screenRules` (optional) detect prompts the agent can't report, from the last `lines` (default 6, max 50) visible lines of its terminal. `state` is `waitingPermission`, `waitingInput`, `working` or `done`; `clearOn` is `output` or `input` (absent: the state lasts while the rule matches). Patterns use the common regex subset: no lookaround, no backreferences.
- `hooks` is for agents with a native hook system (informational; built-in adapters only). A user adapter has no hook installer: the agent (or a wrapper script) calls Kotilo itself.

## 2. Transport

**Sidecar (recommended):**

```
kotilo-hook --agent <id> --event <event> [--session <id>] [--json <payload>]
```

- The payload is `--json` if given, else stdin (≤ 1 MiB). Anything that is not a JSON object becomes `{}`.
- `--session <id>` sets `payload.sessionId` unless the payload already has one.
- The sidecar adds the envelope (time, pane, process chain), removes content (`question` → `question_length`, `prompt` → `prompt_length`; `message` is clipped), and sends it to the hub within 300 ms. When the hub is down it spools the event and the hub replays it on start.
- It always exits 0 and writes nothing to stdout, so it never blocks the agent.
- Inside an Kotilo terminal it adds `paneId` / `workspaceId` (`AGENTHUB_PANE_ID`, `AGENTHUB_WORKSPACE_ID`). Events from Kotilo's own headless AI runs (`AGENTHUB_INTERNAL=1`) are dropped.
- The exe lives in `%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe` (the folder may be added to `PATH`).

**Direct HTTP:** `POST http://127.0.0.1:<port>/v1/events`, header `X-AgentHub-Token: <token>`, body = the envelope below. Port and token are in `port.json` in the hub data folder (`%LOCALAPPDATA%\kotilo\hub`, or `AGENTHUB_DATA_DIR`); both change on every hub start. Requests with an `Origin` header are refused. Answer: `202` (queued) or `503` (queue full). A direct caller must keep content out of the payload itself (rule: no prompt, response or question text).

## 3. Envelope

```json
{ "v": 1, "agent": "my-agent", "event": "waiting-permission", "receivedAt": "2026-10-06T10:00:00.000Z",
  "paneId": "…", "workspaceId": "…", "hookPid": 1234, "parentPid": 1200,
  "processChain": [{ "pid": 1200, "name": "my-agent.exe" }],
  "payload": { "sessionId": "s-42", "tool": "shell", "command": "npm install" } }
```

- `v` must be `1`; any other value is rejected. `agent` must be a loaded adapter id, else the event is rejected.
- `receivedAt` (or `tsMs`) is the event time; without both the hub uses its own clock.
- A missing or `null` `payload` reads as `{}`. Unknown fields anywhere are ignored.
- Compatibility for the original Claude hook: a missing `agent` means `claude-code`, a missing `event` means `payload.hook_event_name`.

## 4. Events

Payload keys are camelCase. Every event may carry `sessionId`, `cwd` and `model`.

| Event | Payload | Session state |
|---|---|---|
| `session-start` | `sessionId`, `cwd` | Idle (new session) |
| `working` | `tool?` | Working (turn timer starts) |
| `waiting-permission` | `tool?`, `command?`, `path?`, `risk?` | WaitingPermission; the permission card shows tool / command / path |
| `waiting-input` | `question_length?` (the sidecar turns `question` into it) | WaitingInput |
| `done` | – | Idle (turn finished; "completed" notification, turn duration) |
| `error` | `kind`, `message?` | Error |
| `session-end` | `reason?` | Ended |
| `usage` | `model`, `inputTokens`, `outputTokens`, `cachedTokens?`, `costUsd?` | unchanged; one usage row |

- **Session id:** `sessionId`, else `pane:<paneId>` when the event comes from an Kotilo pane, else the event is rejected. Sessions are keyed by agent + session id.
- **Project:** the first `cwd` of a session, resolved to its git root.
- **`risk`:** one of `deletesFiles`, `writesDatabase`, `network`, `installsPackages`, `gitPush`, `other`; any other value is ignored and the hub classifies `command` itself. `command` and `path` stay in memory only (never written to the database or logs).
- **`error.kind`:** `usageLimit` (a reset time in `message` is shown), `rateLimit`, `overloaded`, `auth`, `api`; anything else counts as `api`. The message is read, never stored.
- **`usage`:** `inputTokens` excludes `cachedTokens` (cache reads); `outputTokens` includes reasoning. One row per event, deduplicated by agent + session + event time (a replayed event is stored once). `costUsd` is kept as sent and survives price-table changes; without it the cost comes from `pricing.json` (unknown models: no cost). A usage event for a session the hub doesn't know is stored but creates no session.
- Unknown event names are accepted and only refresh the session's last-seen time.
- A session that stays Working without events for a while becomes Stale; a session whose agent process exits becomes Ended (process chain).

## 5. Examples

Windows cmd / PowerShell (one line each):

```
kotilo-hook --agent my-agent --event session-start --session s-42 --json "{\"cwd\":\"C:\\src\\demo\"}"
kotilo-hook --agent my-agent --event working --session s-42
kotilo-hook --agent my-agent --event waiting-permission --session s-42 --json "{\"tool\":\"shell\",\"command\":\"git push\",\"risk\":\"gitPush\"}"
kotilo-hook --agent my-agent --event usage --session s-42 --json "{\"model\":\"local-7b\",\"inputTokens\":1200,\"outputTokens\":80}"
kotilo-hook --agent my-agent --event done --session s-42
```

bash (stdin payload):

```
echo '{"sessionId":"s-42","kind":"rateLimit","message":"429"}' | kotilo-hook --agent my-agent --event error
```

## 6. Versioning

- The envelope `v` and the schema `$id` carry the version. v1 changes are additive only: new optional fields and new event names, which older hubs ignore.
- A breaking change becomes `v: 2`, and the hub then reads both versions for at least one release.
- `adapter.json` follows the same rule (`v: 1`, additive fields).

## 7. Built-in agents

Built-in adapters map their native hook payloads to the same normalized kinds (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `Interrupt`, `PostCompact`, `SubagentStart`, `SubagentStop`, `SessionEnd`, plus the protocol's `Working`, `WaitingInput`, `Done`, `Error`, `Usage`). The state machine is agent-independent; its states are Idle, Working, WaitingPermission, WaitingInput, Error, Stale and Ended.

| Agent | Waiting for permission | Waiting for input | Turn finished |
|---|---|---|---|
| Claude Code | `PermissionRequest`, `Notification` (permission) | `Notification` (elicitation / idle prompt) | `Stop` / `StopFailure` |
| Codex CLI | `PermissionRequest` | no signal | `Stop`; `Interrupt` → Idle |
| Protocol | `waiting-permission` | `waiting-input` | `done` / `error` |

The hub installs built-in agents' hooks itself (backup first, only entries whose command contains `kotilo-hook`); the routes are in [hub-api.md](hub-api.md#ingest-and-adapters).
