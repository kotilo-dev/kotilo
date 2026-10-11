# Troubleshooting

## SmartScreen warning on install or launch

Development builds are **unsigned**. Windows SmartScreen shows
"Windows protected your PC" / "Unknown publisher" the first time you run the
installer, and sometimes the first time you launch the app. Click **More info**,
then **Run anyway**. This is expected and not a sign of a corrupted download.

## WebView2 missing

If `npm run tauri dev` fails to open a window, or an installed build fails to start,
with an error mentioning WebView2: install the
[Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
The NSIS installer normally installs it for you automatically if it's missing
(it uses WebView2's "download bootstrapper" mode), but a locked-down machine or an
offline install can still end up without it.

## Background service not running

Overview, Mission control, Usage, Reports, Projects, Tasks, Dictation and the background service
sections of Settings show **Background service not running** when the app can't reach
it. The app starts the service when it opens and restarts it after a short wait if
it stops, so a brief notice right after startup is normal. If it stays:

- Restart agent-hub.
- Check the service's log in `%LOCALAPPDATA%\kotilo\hub\logs` (`hub-<date>.log`)
  and the app's log (Settings → About & diagnostics → **Open logs folder**).
- Terminals, files, the viewer and agent states from the app's own tracking keep
  working meanwhile; agent toasts fall back to the app's own rule (see
  [Notifications](user-guide.md#notifications)).

## Agent states or the permission card don't appear

- Check **Settings → Agents → Agent integrations**: the agent should show **Installed
  and up to date**. Install or **Update** it if not.
- **Codex** runs new hooks only after you approve them. Open Codex, run `/hooks` and
  approve the Kotilo entries. This is needed again after an update changes them.
- An agent started before the integration was installed keeps its old hook settings;
  start a new session.
- The permission card needs the background service. Without it, answer the agent in
  its terminal as usual.

## The timeline shows no activity or no changed files

- Activity and the plan come from the agent's integration, as above. They live only in
  the background service's memory, so after it restarts the timeline starts empty
  until the agent uses its next tool.
- **OpenCode** reports tool calls only with the current plugin: click **Update** (or
  **Repair**) on its card and restart OpenCode.
- The plan appears only for agents that keep a to-do list through hooks (Claude Code's
  TodoWrite).
- **Changed files** need `git` on `PATH` and a workspace inside a git repository. A
  commit or checkout made outside Kotilo shows up after the next file change or
  the refresh button.

## Hook errors in an agent after moving or uninstalling Kotilo

Agent hooks installed by Kotilo call a fixed path:
`%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe`. If an agent reports hook errors
(e.g. "command not found" for that path):

- **If you uninstalled Kotilo without first removing the integration**: reinstall
  Kotilo and use **Uninstall** in Settings → Agents → Agent integrations before
  removing it again, or remove the entries that mention `kotilo-hook` from the
  agent's settings file by hand (`~/.claude/settings.json` for Claude Code,
  `~/.codex/hooks.json` for Codex).
- **If the hook helper is missing or outdated**: open Kotilo (the background
  service copies the helper into place at startup) and click **Update** on the
  agent's integration card.
- The hook helper always exits silently (exit code 0) and never prints anything, so a
  problem in it can't stop an agent from working.

## "The agent's settings file can't be read"

Kotilo refuses to change an agent's settings file that isn't valid JSON or whose
`hooks` section has an unexpected shape. Nothing was written. Fix the file in an
editor (or restore one of the `.kotilo-backup-<timestamp>` copies next to it) and
try again.

## Build fails with unresolved external symbol `___chkstk_ms`

If `cargo build`/`cargo test`/`npm run tauri dev`/`npm run tauri build` fails at the
link step with errors like `unresolved external symbol ___chkstk_ms` or
`__isnan` (typically while linking `rusqlite`'s bundled SQLite): this happens when the
`CC` environment variable is set to a GNU compiler (e.g. `CC=gcc` from a MinGW
install) while building for the `x86_64-pc-windows-msvc` target. The repository
already works around this via `.cargo/config.toml`, which forces `CC`/`CXX` to empty
so the `cc` crate locates the real MSVC `cl.exe` instead — if you still hit this
error, check that you're building from the repository root (so `.cargo/config.toml`
is picked up) and that nothing else in your shell profile re-exports `CC`/`CXX` after
Cargo reads its config. See "the `.cargo/config.toml` CC/CXX override" in
`docs/development.md` in the repository for the full explanation.

## Where logs and state live

| Location | Contents |
|---|---|
| `%LOCALAPPDATA%\kotilo\logs\kotilo.log` | The desktop app's log file (Rust + frontend). Rotated at startup, kept as up to 5 files of ~1 MB each. Turn on Settings → About & diagnostics → **Verbose logging** before reproducing an intermittent problem. |
| `%LOCALAPPDATA%\kotilo\diagnostics\` | Zips written by **Collect diagnostics** (`kotilo-diagnostics-<timestamp>.zip`, 5 most recent kept). |
| `%LOCALAPPDATA%\kotilo\hub\logs\` | The background service's daily logs (`hub-<date>.log`, 14 days). |
| `%LOCALAPPDATA%\kotilo\hub\` | The background service's database, settings and price table — see [Data locations](user-guide.md#data-locations) |
| `%APPDATA%\kotilo\state.json` | Workspaces, layout, open tabs, UI language |
| `%APPDATA%\kotilo\settings.json` | The app settings |
| `%APPDATA%\kotilo\state.json.corrupt` / `settings.json.corrupt` | Present if Kotilo had to fall back to defaults because the real file was invalid JSON |
| `~/.claude/settings.json`, `~/.codex/hooks.json` and their `.kotilo-backup-<timestamp>` copies | The agents' own settings, and Kotilo's pre-write backups of them |
| Chrome DevTools console (via the remote-debugging tip in `docs/development.md` in the repository) | Frontend errors/warnings — the most useful source of detail for a UI-side bug |

## Reporting a problem

When something goes wrong, the main thing to send the maintainers is a diagnostics
zip:

1. **Collect diagnostics** — Settings → About & diagnostics → **Collect diagnostics**,
   or the command palette's **Help: Collect diagnostics**. This reveals the zip in
   Explorer and copies its path to the clipboard
   (`%LOCALAPPDATA%\kotilo\diagnostics\kotilo-diagnostics-<timestamp>.zip`).
   It contains: the app/OS/WebView2 versions, the app's log files, a copy of
   `settings.json` and the non-sensitive parts of `state.json` (workspace and open
   file **paths** are included — needed for debugging — but never file contents),
   and a summary of open panes/agents. It does **not** contain terminal output,
   file contents, or agent conversations. Your Windows username is masked in most
   paths, but may still appear in a few — the zip's own `README.txt` explains
   exactly what's inside and what isn't, so read it before sharing if that matters
   to you.
2. **What you did** — step by step (e.g. "opened a Claude Code tab → sent a message → …").
3. **What you expected** and **what happened instead**.
4. **Does it happen every time?** If not, roughly how often.
5. **The agent involved** with its version (`claude --version`, `codex --version`) —
   already covered for the app/OS/WebView2 side by the diagnostics zip.
6. **A screenshot or short screen recording** of the moment it happens — the agent's
   header strip, the Agents panel and the last lines of the terminal are especially
   useful.

Additional files, depending on the problem (see
[Where logs and state live](#where-logs-and-state-live)):
- Background service problems (usage, notifications, integrations, the permission
  card): the latest `hub-<date>.log` from `%LOCALAPPDATA%\kotilo\hub\logs` — the
  diagnostics zip doesn't include it yet;
- Agent hook problems: only the Kotilo entries of the agent's hook settings (the
  `hooks` section of `~/.claude/settings.json`, or `~/.codex/hooks.json`) and a
  listing of `%LOCALAPPDATA%\kotilo\hub\bin\`;
- **If Kotilo does not start** (so it can't collect its own diagnostics): zip
  `%LOCALAPPDATA%\kotilo\logs` by hand and send that, plus Event Viewer →
  Windows Logs → Application entries for `agenthub.exe`, and whether the WebView2
  Runtime is installed.
