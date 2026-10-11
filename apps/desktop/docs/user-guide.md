# User guide

Kotilo is a desktop workspace for AI coding agents: real terminals with live agent
status, permission requests you can answer from a card, usage, costs and plan limits,
project progress, personal tasks and dictation history.

This guide (plus [Keybindings](keybindings.md) and [Troubleshooting](troubleshooting.md))
is also built into the app — press **F1** or click the **?** button in the status bar
to open it any time, no repository access needed. It follows the app's language
(English or Turkish).

## Installation

Kotilo ships as a per-user NSIS installer: `Kotilo_<version>_x64-setup.exe`
(for example `agent-hub_0.1.0_x64-setup.exe`).

- **No administrator rights are needed.** The installer runs in per-user mode
  (`installMode: currentUser`).
- It installs into `%LOCALAPPDATA%\kotilo`, and creates Start Menu and desktop
  shortcuts plus a per-user (`HKCU`) uninstall registry entry.
- It requires the **WebView2 Runtime**. Most Windows 11 machines already have it; if
  not, the installer downloads and installs it for you (it uses WebView2's
  "download bootstrapper" mode).
- Because builds are **unsigned**, Windows SmartScreen will show an "Unknown
  publisher" warning the first time you run the installer (and possibly the first
  time you launch the app). Click **More info**, then **Run anyway**.

### Upgrading

Download the new installer and run it — installing over an existing install works
without uninstalling first. Your data (workspaces, settings, terminal layout, usage
history) is untouched; it lives outside the program files (see
[Data locations](#data-locations)).

### Uninstalling

1. **Before uninstalling**, remove the agent integrations you installed: open
   **Settings → Agents** and click **Uninstall** on each agent under **Agent
   integrations**. The uninstaller does *not* edit your agents' settings files — see
   [Agent integrations](#agent-integrations).
2. Run the uninstaller (from the Start Menu entry, or via "Apps" in Windows
   Settings).

The uninstaller removes the app, its shortcuts, and its registry entry. Your data
folders stay (see [Data locations](#data-locations)); delete them yourself if you
want a completely clean removal. If you skipped step 1, the hook helper copy in
`%LOCALAPPDATA%\kotilo\hub\bin` keeps your agents' hooks from failing: it always
exits silently.

## Data locations

| File | Contents |
|---|---|
| `%APPDATA%\kotilo\state.json` | Workspace list, active workspace, expanded tree folders, open viewer tabs, panel/window layout, open terminal tabs, UI language. Written atomically (temp file + rename) with a short debounce. |
| `%APPDATA%\kotilo\settings.json` | The app settings (Appearance, Editor, Terminal, Files, Agents, About in [Settings](#settings)) and your composer's saved prompts — kept separate from `state.json` so a settings write can never corrupt your layout or vice versa. |
| `%LOCALAPPDATA%\kotilo\logs\kotilo.log` | The desktop app's own log file — see [Logs and diagnostics](#logs-and-diagnostics). |
| `%LOCALAPPDATA%\kotilo\diagnostics\` | Zips written by **Collect diagnostics**. |
| `%LOCALAPPDATA%\kotilo\hub\` | The background service's data: `hub.db` (sessions, usage, tasks, dictation history), `settings.json` (notification, usage, project, task and dictation settings), `pricing.json`, `logs\`, and `bin\kotilo-hook.exe` (the hook helper your agents' hooks call). |

If `state.json` or `settings.json` is corrupted (e.g. hand-edited into invalid JSON),
Kotilo starts with defaults instead of crashing, and renames the bad file to
`state.json.corrupt` / `settings.json.corrupt` so nothing is silently lost.

Prompts, responses and dictated audio are never stored — only counts and metadata
(for example a prompt's length, token counts, tool names). The one exception is a
prompt you save yourself in the [composer](#composer). The agents' recent tool activity
for the [Timeline](#timeline) is kept in the background service's memory only.

## Logs and diagnostics

The desktop app writes a rotating log file to `%LOCALAPPDATA%\kotilo\logs\kotilo.log`
(rotated on startup, kept as up to 5 files of ~1 MB each). It records things like
startup/shutdown, PTY spawn failures, hook errors, and IPC/frontend error
messages — never terminal input/output, clipboard contents, file contents, or agent
prompts/responses. The background service keeps its own daily logs in
`%LOCALAPPDATA%\kotilo\hub\logs` (14 days).

If something goes wrong, use **Collect diagnostics** (Settings → About & diagnostics,
or the command palette's **Help: Collect diagnostics**) to package the logs plus some
non-sensitive app state into a zip under `%LOCALAPPDATA%\kotilo\diagnostics\`
(the 5 most recent are kept) — see
[Reporting a problem](troubleshooting.md#reporting-a-problem) for what to do with
it. **Help: Open logs folder** (or the About section's button) opens the log
folder directly in Explorer.

An unexpected crash shows a recovery screen instead of a blank window, with its
own **Reload** and **Collect diagnostics** buttons — note that **Reload closes all
running terminals and agents** (they're respawned fresh, not resumed).

## Navigation

A rail on the far left switches between the app's screens. Each button's tooltip
shows its shortcut, and `Alt+1` … `Alt+9` work from anywhere (even with a terminal
focused):

| Shortcut | Screen | What it's for |
|---|---|---|
| `Alt+1` | Workspace | Files, terminals, agents, viewer — see [Layout and panels](#layout-and-panels) |
| `Alt+2` | Overview | The active block, today and this week, limits, a session summary, project progress |
| `Alt+3` | Mission control | Every live agent session as a tile with its latest output — see [Mission control](#mission-control) |
| `Alt+4` | Usage | Daily tokens/cost, 5-hour blocks, breakdowns |
| `Alt+5` | Reports | Daily summary, waits, cost reports with export |
| `Alt+6` | Projects | Todo-file progress, git state, display names and customers |
| `Alt+7` | Tasks | Your own notes and to-dos |
| `Alt+8` | Dictation | Speech models and dictation history |
| `Alt+9` | Settings | All settings (at the bottom of the rail) |

`Ctrl+1` … `Ctrl+9` stay reserved for switching workspaces.

## The background service

Usage, costs, limits, notifications, projects, tasks and the agent integrations are
handled by Kotilo's background service. The app starts it (hidden) when it opens
and restarts it if it stops. When it can't be reached, those screens show
**Background service not running**; terminals, files and the viewer keep working.
It listens only on `127.0.0.1` and accepts only requests that carry its access
token (stored in its data folder).

## Layout and panels

The Workspace screen is split into three main columns — **Workspaces**/**Agents**
(left), **Terminal** (middle), **Viewer** (right) — plus a status bar at the bottom.
The left column itself splits vertically into Workspaces (top) and Agents (bottom).
On the far right sits the [Timeline](#timeline) rail.

- Drag the thin dividers between columns (or between Workspaces/Agents) to resize.
  Sizes persist across restarts.
- Toggle a whole column: `Ctrl+B` (left column), `Ctrl+J` (Terminal), `Ctrl+Shift+U`
  (Viewer). A hidden column keeps running in the background (a hidden terminal keeps
  its process and scrollback; a collapsed panel is never unmounted) — toggling it back
  on just makes it visible again.
- The window remembers its position, size, and every panel size/visibility across
  restarts.

## Workspaces

**Adding a workspace:** click **+** in the Workspaces panel header (opens a folder
picker; you can select multiple folders at once), drag a folder from Explorer onto
the window, or use the command palette's **Workspaces: Add workspace…**. The same
folder cannot be added twice. A project on the Projects screen that isn't a
workspace yet has an **Add as workspace** button.

**Switching workspaces:** click a workspace's name, click the **○/●** button next to
it (● = active), or press `Ctrl+1`…`Ctrl+9` to jump to the Nth workspace in the list.
Only the *active* workspace's tree is shown expanded; switching away collapses it in
the UI (its expanded-folder state is remembered and restored when you switch back).
Terminals and viewer tabs are per-workspace and keep running/open in the background
when you switch away.

**The file tree:**
- Folders sort before files, alphabetically, case-insensitively.
- Single-click a file to select it (viewer stays as-is); double-click (or Enter) opens
  it in an *italic* preview tab that gets replaced by the next file you preview.
  `Ctrl`+click (or `Ctrl+Enter`) opens it in a permanent (non-italic) tab instead.
  Typing in a preview tab pins it automatically.
- Keyboard: `↑`/`↓` move selection, `←`/`→` collapse/expand, `Enter` opens (double-click
  equivalent; `Ctrl+Enter` = new pinned tab), `F2` renames, `Delete` deletes.
- Right-click a file or folder for: New File, New Folder, Rename, Delete (moves to the
  Recycle Bin), Copy Path, Copy Relative Path, Reveal in Explorer, **Open terminal
  here** (new terminal tab in that folder, or the file's parent folder), and **Save
  clipboard image here**.
- Right-click a workspace's root row for: Make active, New File/Folder, Rename
  (display name only — doesn't touch the folder on disk), Remove (doesn't delete
  anything from disk; if the workspace has unsaved files it asks to save/discard
  first), Open in Explorer, Save clipboard image here, Move up/Move down.
- **Hidden by default:** `.git`, `node_modules`, `dist`, `target`, `.DS_Store` — edit
  the list in Settings → Files. Patterns are **name-only globs** applied at every
  depth (e.g. `*.log`); a pattern containing `/` or `\`, or starting with `!`, is
  rejected. Turn on **Respect .gitignore** to also hide anything your repo's
  `.gitignore` files (and `.git/info/exclude`) ignore, walking from the workspace root
  downward — `.gitignore` files above the workspace root are not consulted.
- The tree updates live as files change on disk (created by an agent, git operations,
  etc.), typically within a second.
- **Filter box** in the panel header: type part of a filename to fuzzy-search the
  active workspace; click a result to reveal and select it in the tree, `Esc` clears it.
- **Save clipboard image here**: after a screenshot (e.g. `Win+Shift+S`), right-click
  a folder (or the workspace root, or press `Ctrl+V` with a folder selected in the
  tree) and choose **Save clipboard image here**. It's saved as
  `screenshot-YYYYMMDD-HHMMSS.png` (a numeric suffix like `-2` is added on a same-second
  collision), revealed/selected in the tree, and its workspace-relative path is copied
  to the clipboard (so you can paste the path straight into an agent that can't accept
  pasted images) — this can be turned off in Settings → Files. If the clipboard
  has no image, you get a "No image in clipboard" notice and nothing is written.

## Viewer

- Tabs are per-workspace; a dirty (unsaved) tab shows a `●` dot. Middle-click a tab to
  close it; `×` also closes it.
- **Preview vs. pinned tabs:** a preview tab is shown in italics and is replaced by the
  next file you preview; a pinned tab stays open. Editing a preview tab's content pins
  it automatically.
- **Text/code files** open in Monaco: `Ctrl+S` saves. Encoding (UTF-8, UTF-8 BOM,
  UTF-16 LE/BE, or ANSI as a read-only fallback) and line endings (LF/CRLF) are
  detected on open and preserved exactly on save — editing and saving a CRLF file
  never turns it into LF. A file with mixed line endings shows a notice and is saved
  with the dominant ending. `Shift+Alt+F` formats JSON (Monaco's built-in formatter)
  and XML.
  - Files over 5 MB, and files whose encoding can't be decoded losslessly, open
    **read-only** with a notice explaining why; `Ctrl+S` on a read-only file shows a
    toast instead of saving. Files over 50 MB aren't opened as text at all (too large
    even to view); images/PDFs/other binary reads are capped at 100 MB.
  - If the file changes on disk (e.g. an agent edits it): a clean (no local changes)
    document reloads silently; a dirty document shows a banner with **Reload**
    (discard your edits), **Keep mine** (your version wins on the next save), and
    **Compare** (a side-by-side diff against the on-disk version).
- **Markdown** (`.md`): a mode switcher in the tab strip toggles **Edit** / **Preview**
  / **Split**. Preview renders GitHub-flavored Markdown (tables, task lists) with
  syntax-highlighted code blocks; relative image paths resolve against the workspace;
  clicking a relative `.md` link opens it in the viewer, an `#anchor` link scrolls to
  that heading, and `https://` links open in your default browser. `Ctrl+Shift+M`
  toggles Edit/Preview.
- **HTML** (`.html`/`.htm`): Source (Monaco) / Preview modes. Preview renders in a
  sandboxed iframe with scripts off by default (a checkbox turns scripts on for that
  tab); relative CSS/image references resolve against the file's folder.
- **Images** (png, jpg, jpeg, gif, webp, bmp, ico) and **SVG**: Fit / 100% / zoom
  (`Ctrl`+scroll wheel or the +/− buttons), checkerboard background behind
  transparency, and a footer showing width × height and file size. SVG also has a
  Source mode (plain text/XML editing).
- **PDF**: page-by-page rendering with lazy loading, a page-number box, zoom controls
  and Fit width, and `Ctrl+F` in-document text search (jumps between matching pages;
  no in-page highlighting).
- **Anything else** (binaries, `.exe`, `.lnk`, unrecognized types, etc.): "No preview
  available" with an **Open with default app** button (suppressed for executables/
  shortcuts — only Reveal in Explorer is offered for those).
- Closing a dirty tab, removing a workspace with dirty tabs, or closing the app with
  any dirty tabs open all ask you to save or discard first.

## Terminals

- Each workspace has its own set of terminal tabs. The **+** button (with a **▾**
  dropdown) opens a new tab using your default shell or any detected profile
  (PowerShell 7 `pwsh`, Windows PowerShell, `cmd`, Git Bash, WSL — whichever are
  actually installed). The **New agent ▶** menu starts a tab running one of your
  configured agent commands (default: `claude`, `codex`); it's hidden if you clear
  the agent command list in Settings → Agents.
- **Agent tabs are not auto-started when the app reopens.** A restored agent tab shows
  a "Start `<command>` / Start shell only" prompt instead of launching the agent
  immediately — click to start it (or just start a plain shell in that tab).
- Switching workspaces or screens doesn't stop background terminals — they keep
  running and keep their scrollback (10,000 lines).
- **Copy/paste** follows Windows Terminal conventions: `Ctrl+C` copies if there is a
  selection (and clears it), otherwise sends SIGINT (interrupt); `Ctrl+V` pastes;
  `Ctrl+Shift+C`/`Ctrl+Shift+V` always copy/paste regardless of selection. Right-click
  copies if there's a selection, otherwise pastes. Turn on **Copy on select** in
  Settings → Terminal to copy a mouse selection to the clipboard automatically.
- **Paste warning:** pasting multi-line text into a plain shell (not a full-screen TUI
  like claude/codex, which use "bracketed paste") shows a "Paste N lines into the
  terminal?" confirmation — Enter pastes, Esc cancels, with a "Don't ask again"
  checkbox. Turn it off in Settings → Terminal.
- **Clickable links:** `Ctrl`+click a file path printed in the terminal output (e.g.
  `src/foo.ts:42`, including the line number) to open it in the viewer at that line;
  `Ctrl`+click a `https://` URL to open it in your browser. A tooltip on hover tells
  you which.
- In-terminal search: `Ctrl+Shift+F`.
- Closing a tab whose process is still running (something other than the shell
  itself) asks for confirmation and lists the running processes.

### Split pane

The terminal panel can show two tabs side by side, for example two agents working at
once. Ways to split:

- Right-click a tab and choose **Split right**: that tab opens in the right half, the
  active tab stays on the left.
- Drag a tab onto the right half of the terminal area (a "Drop here to open on the
  right" zone appears while you drag).
- Click the split button in an agent's header strip: that agent stays on the left and
  its neighbouring tab (or a new terminal, when it is the only tab) opens on the right.

Each half has a thin title row, plus its own header strip, permission card and
composer. To go back to a single pane:

- the **×** in a half's title row takes that half away (its tab stays open as a tab);
- the tab menu's **Close split** keeps the left half;
- the header split button (now **Close split**) takes its own half away;
- closing either half's tab also leaves the other one alone in the panel.

Splitting never closes or duplicates a terminal. The split is remembered across
restarts; the [Timeline](#timeline) follows the half that last had focus. In a narrow
half the permission card scrolls instead of covering the whole pane. The header split
button exists on agent panes only; plain shell tabs split through the tab menu or by
dragging.

## Agents

### Agent states

Every agent has one of these states. Each one differs by shape or motion as well as
color, so they can be told apart without relying on color alone:

| State | Color | Meaning |
|---|---|---|
| Working | Amber, spinning | Actively running |
| Needs permission | Red-orange, pulsing | Waiting for you to allow or deny a tool |
| Waiting for input | Red-orange, pulsing | Finished its turn and asked you something |
| Done | Blue | Finished; you haven't looked at it yet |
| Idle | Green | Finished and you've seen it |
| Error | Red-orange with ⚠ | The turn ended with an error or a limit |

"Waiting for input" and "Error" come from the background service, so they need the
agent's integration (see below).

### The Agents panel

The **Agents** panel (bottom of the left column) lists every detected agent process
with its state. Rows are sorted blocked first, then done, working, idle. Clicking a
row jumps to that workspace and terminal tab (and turns a `done` row into `idle`).
The active workspace's root shows a small dot for its most urgent agent state, each
terminal tab shows a matching dot, and the status bar shows a count per state (idle
agents aren't counted there). `Ctrl+Shift+A` jumps to the next blocked agent (after
whichever pane you're focused on, wrapping around).

**How agents are tracked:**
- An agent with its integration installed (see [Supported agents](#supported-agents))
  reports prompts, permission requests and completion through its hooks.
- A custom agent reports through the Agent Integration Protocol (see
  [Custom agents](#custom-agents)).
- Without either, an agent is recognized by its process name (the **Executable
  names** of its definition) and a simple "output means working, ~3s of silence means
  idle" rule; it then shows only `working`/`idle`, unless a screen rule of its
  definition recognizes a prompt on the terminal screen.

**Starting an agent:** **New agent ▶** in the terminal panel and the palette's
**Agents: New …** list every installed agent (its program is found on `PATH`), then
the commands from **Settings → Agents → Agent commands** that no agent already covers.

### Agent header and frame

When an agent runs in a terminal tab, a header strip appears above the terminal: the
agent and project, branch and model, the state with how long it has lasted, how full
the context window is, the session's tokens (and estimated cost when the model has a
price), and the agent's most-used plan limit. A dash means the agent hasn't reported
that value. The terminal also gets a colored frame: a thin amber border while
working, a stronger red-orange border with a glow while it waits for you. The header
is display-only and never takes focus from the terminal.

### Permission card

When an agent asks for permission and the background service knows the request, a
card appears over the bottom of that agent's terminal. It shows what the agent wants
to do (the command, file or tool), how long it has been waiting, and a risk label
when the request looks risky (deletes files, writes to a database, network access,
installs packages, pushes to a remote).

| Button | Sends | Effect |
|---|---|---|
| **Allow once** | the agent's own key, e.g. `1` (Claude Code), `y` (Codex) | Allows this one request |
| **Always allow in this project** | e.g. `2` (Claude Code), `p` (Codex); only where the agent has a fixed key | The agent's own "always allow" option |
| **Deny** | e.g. `Esc`, `n` (Cursor CLI) | Rejects it; tell the agent what to do instead |
| **Answer in terminal** | nothing | Hides the card for this request and focuses the terminal |

The keys come from each agent's definition; the table in
[Supported agents](#supported-agents) lists them. For Cursor CLI the card appears when
its prompt is recognized on the terminal screen, without the command details.

The buttons press the agent's own keys in its terminal, so the result is exactly the
same as answering the agent's prompt yourself; a short note under the terminal
confirms which key was sent. While focus is inside the card, `Enter` allows once and
`Esc` denies; the terminal keeps its own `Esc` otherwise. Focus moves to **Allow
once** only when the card opens in the visible, focused window. For agents whose
keys aren't verified, only **Answer in terminal** is offered.

### Composer

Below every agent terminal there is a message field, the composer. You can always type
straight into the terminal as well; the composer is for longer messages, files, images,
dictation and prompts you reuse. It never takes the focus by itself and never catches
keys meant for the terminal.

- `Enter` sends, `Shift+Enter` starts a new line, `Esc` puts the focus back into the
  terminal.
- **Files:** type `@` and part of a file name to get suggestions from the workspace;
  `↑`/`↓` choose, `Enter` or `Tab` insert the workspace-relative path, `Esc` closes the
  list.
- **Images:** paste an image (`Ctrl+V`, for example after `Win+Shift+S`). It is saved
  as a PNG in `.kotilo/attachments/` inside the workspace (the folder is created
  when needed), shown as a chip, and sent as `@<path>` at the end of the message. The
  first time, a hint suggests adding `.kotilo/` to your `.gitignore` so the images
  aren't committed — Kotilo never edits `.gitignore` itself.
- **Microphone:** click the mic to dictate into the message, click again to stop; the
  text lands at the cursor and you can edit it before sending. It uses the speech model
  and settings of [Dictation](#dictation) and works even when the global dictation
  shortcut is off. Nothing is pasted through Windows or the clipboard.
- **Saved prompts:** the bookmark button opens your saved prompts. **Save message as
  prompt** stores the current text (its first line becomes the title); click a prompt to
  insert it at the cursor, filter the list, or delete one with **×**. Saved prompts are
  your own text and are kept in the app's `settings.json` (see
  [Data locations](#data-locations)) — the only prompt text Kotilo stores, and only
  because you saved it. Diagnostics zips contain just their number.

**How sending works:** the message goes into the agent's terminal as one paste,
followed by `Enter` a moment later — exactly as if you had pasted it and pressed
`Enter`. Agents that understand "bracketed paste" (Claude Code, Codex and other
full-screen TUIs) receive a multi-line message as one block; for a program that
doesn't, a multi-line message shows the usual paste warning first (see
[Terminals](#terminals)).

### Agent integrations

Open **Settings → Agents → Agent integrations**. Each agent has a card with its
avatar, whether its program is on `PATH`, its state (not installed, installed and up
to date, needs an update, settings file can't be read), the path of its settings file,
and **Install** / **Repair** / **Uninstall**. Claude Code's integration can also be
installed from the Agents panel's **⋯** menu, the banner at the top of that panel, and
the command palette. **Reload definitions** re-reads every agent definition, after you
edited a custom agent's file by hand.

A card can also say why installed hooks may stay silent:
- *The agent runs new hooks only after you approve them* (Codex): open the agent and
  approve the Kotilo hooks (Codex: in `/hooks`). Kotilo never approves them for
  you.
- *Hooks only run in folders you trusted in Gemini*: Gemini CLI runs hooks, also
  user-level ones, only in trusted folders.
- *Hooks are disabled in the agent's settings*: the agent's own switch turns every
  hook off (Gemini `hooksConfig.enabled`, Qwen `disableAllHooks`, Droid
  `hooksDisabled`).

Every entry calls `%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe`. For every
agent the installer:
- Makes a timestamped backup first (`<file>.kotilo-backup-<timestamp>`, next to the
  real file) before writing anything; the path is shown after install.
- Preserves everything else in the file — your own settings, other tools' hooks for
  the same events, unrelated keys.
- Is idempotent: installing again (or **Update**, after a new Kotilo version)
  replaces only Kotilo's own entries; **Uninstall** removes only Kotilo's
  entries and leaves everything else untouched.
- Refuses to touch the file (and reports it) if it can't be read — it never rewrites
  a file it doesn't understand.

The hook helper always exits silently and never prints anything, so it can't break
an agent. It reports to the background service; sessions started outside Kotilo
show up too (Mission control marks them **Running outside Kotilo**). Prompt and response
text is removed before anything is sent; only its length is kept.

### Supported agents

| Agent | Integration writes to | Permission card keys | Usage | Limits |
|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | `1` · `2` (always) · `Esc` | From its transcripts (plan limits not shown yet) | — |
| Codex CLI | `~/.codex/hooks.json` | `y` · `p` (always, when offered) · `Esc` | From its session files, with plan limits | Approve the hooks in `/hooks`; no "waiting for input" signal |
| GitHub Copilot CLI | `~/.copilot/hooks/agenthub.json` (its own file) | `1` · `Esc` | Only after a clean `/exit`; no cost (Copilot bills premium requests) | No plan limits |
| Gemini CLI | `~/.gemini/settings.json` | `1` · `Esc` | From its chat recordings | Hooks run only in trusted folders; after a deny the card stays until the next prompt |
| Qwen Code | `~/.qwen/settings.json` | `1` · `2` (always) · `Esc` | From its chat recordings | — |
| Factory Droid | `~/.factory/hooks.json` (or the `hooks` of `settings.json`) | none yet — answer in the terminal | From its session settings | A change applies from its next session |
| OpenCode (v2) | a plugin in `~/.config/opencode/plugins/` | `Enter` · `Esc` | From its database | Not linked to a terminal tab yet; restart OpenCode after install |
| Cursor CLI | `~/.cursor/hooks.json` | `y` · `n` | No data | Permission prompts are recognized on the screen, without details |

Gemini CLI, Qwen Code, Factory Droid and Cursor CLI were built from their
documentation and have not been checked against a live install yet. If an agent
changed its keys, use **Answer in terminal**.

### Custom agents

Any other agent CLI can be added without code. In **Settings → Agents** choose **Add
custom agent**; the wizard asks for:

1. **Name**: an id (lowercase letters, digits and `-`; it can't be a built-in agent's
   id), a display name, and an avatar letter and colour.
2. **Launch**: the command **New agent** runs, its arguments, and the executable names
   that recognize the agent in a terminal and tell whether it is installed.
3. **Permission keys** (optional): the keys the card sends for **Allow once**,
   **Always allow** and **Deny**. Key notation: a character (`y`, `1`), a named key
   (`Enter`, `Esc`, `Tab`, `Space`, `Up`, `Down`, `Left`, `Right`), `Ctrl+<letter>`,
   or several separated by spaces (`Down Enter`). Without keys the card only offers
   **Answer in terminal**.
4. **Screen rules** (optional): a regular expression over the last lines of the
   agent's screen sets a state while it matches — *needs permission*, *waiting for
   input*, *working* or *done* — for prompts the agent doesn't report itself. It can
   end when new output arrives or when you type. Lookaround and backreferences are not
   supported.
5. **Connect**: the commands the agent (or a wrapper script) runs to report its state.

The definition is saved as `%APPDATA%\kotilo\adapters\<id>\adapter.json`; **Edit**
and **Delete** on its card change or remove it. A definition with an error (for example
a hand-edited file) is listed with the error and ignored until it is fixed.

**Agent Integration Protocol.** A custom agent reports with the hook tool that ships
with Kotilo (`%LOCALAPPDATA%\kotilo\hub\bin\kotilo-hook.exe`):

```
kotilo-hook --agent <id> --event <event> [--session <id>] [--json <payload>]
```

| Event | Meaning |
|---|---|
| `session-start` | A session started (`cwd` in the payload sets the project) |
| `working` | The agent works on a turn |
| `waiting-permission` | It needs permission (`tool`, `command` or `path`; the permission card shows them) |
| `waiting-input` | It waits for your answer |
| `done` | The turn finished |
| `error` | The turn failed (`kind`: `usageLimit`, `rateLimit`, `overloaded`, `auth`, `api`) |
| `session-end` | The session ended |
| `usage` | Token counts (`model`, `inputTokens`, `outputTokens`, optional `cachedTokens`, `costUsd`) |

Inside an Kotilo terminal the tool links the events to that tab. It never prints
anything and always succeeds, so it can't break the agent; when the background service
is down it keeps the event and delivers it later. Prompt, answer and question text is
never stored. A program can also post the same events to the background service
directly (`POST /v1/events` with the port and token from `port.json` in its data
folder; both change on every start).

### Notifications

While the background service is running, it decides when to notify, using the rules
in **Settings → Notifications** (permission needed, waiting for your answer,
finished, went silent, reminders, errors and limits, completed todo items, context
almost full), quiet hours and **Do not disturb**. The app shows the Windows toast and
flashes the taskbar. No toast is shown when that agent's terminal is visible in the
focused window. **Settings → Agents → Notifications** turns all agent toasts off.

If the background service isn't running, the app falls back to its own rule: a toast
when an agent becomes `blocked` or `done` while the window isn't focused. Clicking a
toast doesn't jump to the pane (Windows notifications don't support that here) — use
`Ctrl+Shift+A` instead.

## Timeline

The Timeline rail on the right edge of the Workspace screen shows what the agent in the
focused terminal is doing. It follows the active tab (in a [split](#split-pane), the half
that last had focus); when that tab has no agent session, it shows the most recently
active session of the workspace folder. Hide or show it with the arrow button at its
top or the command palette's **View: Toggle Timeline** (no keyboard shortcut yet); drag
its left edge to resize it. Visibility and width are remembered.

- **Plan:** the agent's current to-do list with its progress (for example `3 / 5`) —
  the list Claude Code keeps with its TodoWrite tool.
- **Activity:** the agent's tool calls, newest first — a letter icon per kind (read,
  edit, write, command, search, sub-task), the file (relative to the project) or the
  command, and whether it is running, done, failed or was denied, with its duration.
  A **New prompt** line marks where each of your prompts started.
- **Changed files:** the workspace's uncommitted git changes compared with `HEAD`
  (modified, added, deleted, renamed, untracked) with `+added −removed` line counts.
  Files the agent edited or wrote are listed first; changes made some other way, also
  by the agent's shell commands, are under **Other changes**. The list refreshes after
  file changes on disk and with the refresh button; a commit or checkout made outside
  the app shows up after the next file change or a manual refresh.

Click a changed file to open a **diff tab** in the viewer, `<name> (diff)`: `HEAD` on
the left, your working copy on the right, read-only. Binary files and `HEAD` versions
larger than 2 MB show a notice instead. Diff tabs are not restored after a restart.

The activity and plan come from the agent's hooks and live in the background
service's memory only: they keep the last 200 tool calls per session, are dropped
10 minutes after the session ends, and are lost when the background service restarts.
File contents and tool output are never part of it. Agents that report tools only after
they finish (Copilot CLI, Cursor CLI) show finished entries only. The changed files
come from running `git` read-only in the workspace, so they need `git` on `PATH`.

## Overview

The Overview screen shows the numbers at a glance: a summary line (sessions, how many
need you, how many are working), the active 5-hour block with its remaining time, burn
rate and projection, today and this week, plan limits, a session summary with
**Open mission control** (the session tiles live on [Mission control](#mission-control)),
and project progress from todo files.

Costs are local estimates from the price table (Settings → Usage & costs), not
official figures. Limits are the agent's own most recent report, shown as a local
estimate.

## Mission control

Mission control (`Alt+3`) shows every live agent session as a tile, so you can watch
several agents at once. The header counts the agents and how many need you, are working
or are done; the filter next to it shows **All**, **Needs you** (waiting for permission
or for your answer, or ended with an error), **Working** or **Done** (finished, idle).
Sessions the background service considers stale appear only under **All**. The plan
limits strip is the same as on the Overview.

Each tile shows the project, agent and workspace (or model), the state and how long it
has lasted, and a preview: the last five non-empty lines of that agent's terminal,
refreshed about once a second while Mission control is open and the window is visible.
The preview is read from the terminal on screen and is never logged or stored. The
footer shows how long it has been waiting (or the context use, or the running tool),
active subagents, and the cost (or tokens, when the model has no price). Tiles that need
you are outlined.

Click a tile to jump to that agent's workspace and terminal tab. Sessions started
outside Kotilo are marked **Running outside Kotilo**; they have no preview and
can't be opened — their tile shows what the background service knows instead (a pending
permission, the agent's last notification or its current tool).

## Usage

Daily usage for the last 30 days as tokens or cost, filterable by agent; 5-hour
blocks of the last 7 days; and a breakdown of the last 30 days by project, model or
agent. A model without a price (for example Codex models) shows "—"; add it to
`pricing.json` to estimate its cost.

## Reports

- **Daily summary**: stored daily summaries with the day's numbers (active time,
  sessions, tokens, cost, waiting). Generating new summaries arrives with the AI
  provider in a later update.
- **Waits**: how long you kept agents waiting over the last 7 days — totals, average
  and median, permission vs. input, by hour of day and by project, and the longest
  waits.
- **Cost**: a date range grouped by customer, project, agent or model, with
  **Export CSV** and **Export Excel**. Customer labels are set on the Projects screen.

## Projects

Projects are found from agent activity; **Add project folder…** tracks one that has
no activity yet. Each project shows its todo progress (from files matching the todo
file pattern in Settings → Projects), the next open item, last activity and git
state (branch, changed files, ahead/behind). Selecting a project lists its todo
files; **Open** opens one in the viewer, and clicking an open item opens it at its line
(both only when the project is one of your workspaces). Under **Project
details** you can set a display name, a customer (used by cost reports) and hide the
project.

## Tasks

Personal notes and to-dos, separate from project todo files. Type in **Quick add**
and press Enter; the first line is the title, the rest is detail. Tasks can have a
due date and time, a priority and a project. Filter by open, completed or all, and
search text or project. Overdue and today's tasks are marked.

## Dictation

Dictation turns speech into text on this computer; audio is never stored.

**Live dictation.** Put the cursor where the text should go (an editor, a chat box, a
terminal – in this app or any other) and use the shortcut, `Ctrl+Alt+D` by default:

- **Hold** the shortcut while you speak; release it to finish.
- **Tap** it to start; tap it again to finish.
- `Esc` or the ✕ on the overlay cancels.

A small overlay at the bottom of the screen shows the level, the time and what happens
next (listening, transcribing, AI cleanup, result). It never takes the focus, so the text
goes into the window you started from. Recording stops by itself after the maximum length
in Settings → Dictation (5 minutes by default).

The text is pasted (the clipboard is restored afterwards) or typed, as set in Settings →
Dictation; terminals get Shift+Insert. A window that runs as administrator can't receive
input from this app – the text is then left on the clipboard and the overlay says so.
`Ctrl+Alt+Shift+D` pastes the last dictation again. Optional outputs: the clipboard and a
Markdown file. Turkish and English are recognised (or automatic); words from the
vocabulary list are spelled as written there.

The first dictation needs a speech model: download one on this screen (Large is more
accurate and fast with a graphics card; Small is lighter). The screen also shows the
shortcut and warns when another program already uses it, and keeps the dictation history
(copy, delete, clear; it can be turned off).

## AI providers

Kotilo's own AI jobs – the **assistant**, the **daily summary** and **dictation
cleanup** – run on a provider you pick in Settings → AI. Each feature has its own
provider and an optional model; leave the model empty to use the provider's default.

- **Agent CLIs.** Your installed agents (Claude Code, Codex, Copilot, OpenCode, …) run
  headless, with tools off, under your own sign-in. These runs use your own subscription
  or quota, and they never show up as sessions. Agents marked **Not verified** have a
  headless command taken from their docs that hasn't been checked against the installed
  version yet. OpenCode needs a configured provider: its free "Console" tier refuses runs
  outside the OpenCode app.
- **OpenAI-compatible endpoints.** Any server that speaks the OpenAI chat API: a local
  model through **Ollama** (`http://127.0.0.1:11434/v1`), **LM Studio**
  (`http://127.0.0.1:1234/v1`) or **llama.cpp** (`http://127.0.0.1:8080/v1`), or a hosted
  API. **Add endpoint…** asks for a name, the base URL (the presets only fill the URL), a
  default model (**Load models** lists what the server offers once the endpoint is saved)
  and an optional API key. Endpoints are saved right away; endpoints on this computer get
  a **Local** badge.

**Keys** go straight into Windows Credential Manager. They are never written to the
settings file or the logs, and the app only shows **Key saved**. **Remove key** deletes it;
deleting an endpoint deletes its key too, and features that used it switch to an agent CLI.

**Test** sends a fixed "Reply with OK" prompt and shows the time it took, or why it failed
(not installed, not signed in, unreachable, key rejected, timed out, …). The answer
itself is never shown or stored; testing an agent CLI uses your own quota.

**Fully local** appears when every AI feature that is on uses an endpoint on this
computer (`localhost`), so nothing leaves it. Speech recognition (Whisper) always runs
locally. Prompts and answers are never logged or stored; the log gets only the provider,
the duration and the outcome.

## Assistant

The assistant is a small chat window for quick everyday questions ("how do I undo the last
commit?", "what does this regex do?"). It is a general-purpose chat: it doesn't see your
sessions, files, terminals or usage, and the AI runs with tools off.

Turn it on in **Settings → AI**, in the **Assistant** row: **Turn on the assistant**, then
pick its **Shortcut** (default `Ctrl+Alt+Space`) and save. The shortcut works from any app
and toggles the window; **Open assistant** in the same row opens it too, and so does **Open
assistant** in the mascot's right-click menu. If another app already uses the shortcut, the
field says "Shortcut is used by another app" – pick a different one. It also can't be the
same as the dictation or task shortcuts. The provider and model come from the same row.

Keys in the window:

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | New line |
| `↑` (empty message box) | Edit the last question: it and its answer are removed and the text comes back |
| `Esc` | Stop the answer that is being written; otherwise close the window |
| `Ctrl+N` | New chat |

Answers stream in as they are written and support Markdown, tables and highlighted code.
Code blocks and whole answers have a copy button. While an answer runs, **Stop** ends it
and keeps what was written so far. If something goes wrong (agent CLI not installed or not
signed in, endpoint unreachable, timed out, …) the error shows on that question, with a
**Settings → AI** button when the fix lives there.

**Nothing is saved.** Every opening starts a new chat; the conversation exists only while
the window is open and is gone when it closes. Kotilo writes no message, answer or title to
its database, settings or logs (only the provider, the duration, the outcome and character
counts). Each question sends the conversation so far to the provider you picked, as the
footer says ("Nothing is saved · tools off · sent to …").

**Agent CLIs may keep their own copy.** When the assistant runs on an agent CLI, that CLI
may write the chat into its own session files, outside Kotilo's control. Kotilo starts the
CLIs that support it without session files (Claude Code, Codex, Qwen Code) and OpenAI-compatible
endpoints keep nothing on this computer. For the others the footer warns: "… keeps its own
copy of this chat in its session files" (GitHub Copilot CLI, OpenCode, Gemini CLI) or "…
may keep its own copy" when it isn't known (Cursor, Factory Droid). Pick a different
provider for the assistant if that matters to you.

## Mascot

Kotilo's robot snail can sit on your desktop and show your agents' combined state, so you
can see without opening the app whether an agent needs you. It is off by default: turn it on
in **Settings → Mascot** ("Show the robot snail on the desktop"), or with **Turn on** in the
one-time suggestion that appears when an agent first starts working.

The snail's core and antennas take the colour of the most urgent state across all agents,
including sessions started outside Kotilo:

| Snail | Meaning |
|---|---|
| Red core with a pulsing halo and "!" | An agent is waiting for your permission |
| Red core and "!" (no halo) | An agent stopped with an error |
| Red core and "?" | An agent is waiting for your answer |
| Amber, with sweat drops | Agents are working and the current 5-hour block is projected to cross your usage threshold |
| Amber, walking | Agents are working |
| Blue, a short hop | An agent finished a longer turn (only with "Celebrate finished work") |
| Dimmed, "Zz" | Nothing is running, or do not disturb / quiet hours are on |

**Click** the snail to bring Kotilo up: with a permission, an answer or an error waiting it
opens the agent that has waited longest; while sweating it opens Usage. **Right-click** for
**Hide for 1 hour**, **Turn off mascot**, **Mascot settings…** and, while the assistant is
on, **Open assistant**. **Drag** it along the
taskbar to move it; the place is remembered.

Settings: **Size** (Small, Medium, Large), **Placement** ("Walk along the taskbar" or "Sit in
the corner" at the bottom right) and **Celebrate finished work**. While it is hidden the
section shows "Hidden until …" with **Show now**.

The snail walks only while agents work and stands still otherwise, without using CPU. It
stays on the primary monitor, hides while a full-screen app, game or presentation runs, and
does not walk when Windows animation effects are turned off (Settings → Accessibility →
Visual effects).

## Command palette and quick open

- `Ctrl+Shift+P` (or typing `>` in the quick-open box) opens the **command palette**:
  fuzzy-search every registered command, grouped as "Category: Title" with its
  keybinding shown on the right. An empty query shows your most recently used
  commands first.
- `Ctrl+P` opens **quick open** (fuzzy file search in the active workspace). An empty
  query lists the active workspace's currently open tabs, most recently used first.
  `Enter` opens the highlighted file in a preview tab (like a double-click); `Ctrl+Enter`
  opens it pinned. If a search hits an internal index limit, a notice says the results
  may be incomplete.
- Both share one dialog: typing `>` while in file mode switches to command mode, and
  deleting the leading `>` in command mode switches back to file mode.
- **`Ctrl+P` behaves differently with a terminal focused** — see
  [Keybindings](keybindings.md) for the exact scoping rules.
- The palette's **Go** category opens each screen, and its **Help** category opens
  this guide, Keybindings, Troubleshooting, or About (same content as **F1**).

## Status bar

Shows, from left to right: the active workspace's name, its git branch (or a 7-character
short SHA if it's in a detached-HEAD state — nothing is shown if it isn't a git repo),
and on the right, the active document's encoding/line-ending (when a text file is open),
the agent counts per state (hidden entirely when there are no agents) and the **?**
help button. The git branch refreshes when you switch workspaces, when the window
regains focus, and every 5 seconds while the window is focused (polling stops while
unfocused).

## Settings

Open with `Ctrl+,`, `Alt+9`, the gear at the bottom of the navigation rail, or the
command palette. The section list is on the left.

**App sections — changes apply immediately:**

| Section | Settings |
|---|---|
| Appearance | Theme (Dark, Light, System), Language (Same as Windows, English, Türkçe) |
| Editor | Editor font family and size (8–32) for Monaco |
| Terminal | Terminal font family (default Geist Mono) and size (8–32), applied live to every open terminal; default shell ("Automatic" picks pwsh → Windows PowerShell → cmd → Git Bash → WSL); copy on select; warn before pasting multiple lines |
| Files | Hidden patterns (name-only globs; a pattern with `/`, `\` or a leading `!` is rejected), respect `.gitignore`, copy the path after saving a clipboard image |
| Agents | Agent commands for "New agent ▶", agent notifications on/off, [Agent integrations](#agent-integrations), [custom agents](#custom-agents) |
| About & diagnostics | Version and build, license (Apache-2.0), project links (source, issues, discussions – when the build has a repository), contact, **Check for updates**, **Check for updates on start** (on by default: one check a few seconds after launch; a found update shows a prompt with **Install and restart** / **Later**), the open-source licenses list (searchable), **Collect diagnostics**, **Copy version info**, **Open help**, **Verbose logging** (switches the log level from `info` to `debug` — turn it on before reproducing an intermittent problem), **Open logs folder** |

**Background service sections — saved with Save changes:** Notifications (rules,
quiet hours, Do not disturb, notification language), Usage & costs (usage alerts,
price table, daily summary time), Projects (todo file pattern, project folders, git
status), Tasks (due reminders), Dictation (model, language, cleanup, outputs,
history) and AI (provider and model per feature, see [AI providers](#ai-providers); endpoints
are saved at once). These edit a draft: **Save changes** sends it and **Discard** drops it; if the
service rejects a value, the field and its section are marked. They need the background
service; without it they show a notice instead.

Logs stay on this computer — nothing is sent automatically by any of the above.

## Themes and language

**Theme:** Dark (default), Light, or System (follows Windows' app mode). Switching
(Settings → Appearance, or the command palette's **Toggle theme**, which has no
default keybinding) updates the whole UI, Monaco's editor theme, and every open
terminal's color palette together — nothing needs a restart.

**Language:** English or Turkish; "Same as Windows" uses Turkish when Windows prefers
it, English otherwise. The whole UI and this help switch at once. Toasts use the
background service's notification language (Settings → Notifications).
