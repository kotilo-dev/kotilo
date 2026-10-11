# Manual tests

Checks that need the real desktop, a microphone or another program's window (AGENTS.md rule 6: automated tests never send global input or sound). Run them before a release and after changing the code they name.

## Dictation (M2b, `src-tauri/src/platform/dictation/`)

Preparation: `npm --prefix apps/desktop run tauri dev`; download a speech model in Dictation; keep Settings → Dictation at its defaults unless a step says otherwise.

| # | Steps | Expected |
|---|---|---|
| D1 | Notepad focused, hold `Ctrl+Alt+D`, say a sentence, release | Overlay at the bottom of Notepad's monitor (no focus change, Notepad's caret keeps blinking), level bars move, then "Transcribing…", text appears in Notepad, overlay says inserted and hides after ~1.6 s; start/stop sounds play |
| D2 | Tap `Ctrl+Alt+D`, speak, tap again | Same as D1; the overlay says "Press the shortcut again to finish" while recording |
| D3 | Start dictating, press `Esc`; again, click ✕ during "Transcribing…" | "Cancelled", nothing inserted; Esc works normally in other programs afterwards |
| D4 | Copy an image to the clipboard, dictate into Notepad (paste mode) | Text pasted; after ~0.5 s the image is back on the clipboard; Win+V history does not show the dictated text |
| D5 | Windows Terminal and an agent pane in Kotilo, dictate two lines | Pasted with Shift+Insert, no stray characters; in type mode a new line arrives as Shift+Enter (no message sent early) |
| D6 | Notepad started "as administrator", dictate into it | Overlay: "the window runs as administrator – text is on the clipboard"; Ctrl+V pastes it |
| D7 | Microphone muted / privacy setting off, dictate | Overlay: no sound heard (with the privacy hint), error sound |
| D8 | Delete the model, dictate | Overlay: model missing, nothing recorded |
| D9 | Another program registers `Ctrl+Alt+D` first (e.g. set the same key in a second Kotilo profile), open Dictation | Warning naming the shortcut as taken; change it in Settings → Dictation, save – works at once without restart |
| D10 | Dictate, then `Ctrl+Alt+Shift+D` in another field | The last text is inserted again |
| D11 | AI cleanup on (Settings → Dictation), dictate with filler words | "AI is cleaning up…", cleaned text inserted; with the claude CLI missing: raw text inserted and the overlay notes the cleanup failed |
| D12 | File output on, dictate | Entry with a `## yyyy-MM-dd HH:mm` heading appended to the file |
| D13 | Close the main window while idle | The app exits (the hidden overlay window does not keep it running) |
| D14 | Two monitors with different scaling, dictate into a window on each | Overlay is centred at the bottom of the right monitor at the right size |

## Agents (M3, `adapters/*`, `hub/Hub.Infrastructure/{Copilot,OpenCode,Gemini,Qwen,Droid,Cursor}/`)

Preparation: `npm --prefix apps/desktop run tauri dev`; the agent installed and signed in; Settings → Agents → Install for that agent; start the agent from "New agent" in a workspace. Common checks for every agent (A0): the card turns "Installed and up to date"; the pane header shows the agent; prompt → Working, turn end → Idle/Done; a permission prompt raises the card and its keys land on the right option; closing the tab exits the agent cleanly; Uninstall removes only Kotilo's entries (diff the backup next to the config file).

| # | Agent | Steps | Expected |
|---|---|---|---|
| A1 | Copilot CLI | A0; run a shell command that needs approval; answer `1` and `Esc` from the card | Card shows the command; `1` runs it, `Esc` denies. Note which shell ran the hook (pwsh or powershell.exe, `AGENTHUB_DEBUG=1`) |
| A2 | Copilot CLI | End one session with `/exit`, kill another with the tab's ✕ | Usage row (tokens, no USD) only for the `/exit` session |
| A3 | Copilot CLI | Empty hook output on `permissionRequest` | The agent still shows its own prompt (our hook decides nothing) |
| A4 | OpenCode v2 | A0; restart the service (`opencode service stop`) after install | Plugin loads, events arrive in order; the session has no terminal tab link (D-028); permission card `Enter`/`Esc` |
| A5 | OpenCode v2 | One turn with a priced provider | Usage row with OpenCode's own cost |
| A6 | Gemini CLI (API key) | A0 in an untrusted folder, then in a trusted one | Untrusted: no events and the "folder trust" hint; trusted: states work. Deny a permission → card stays until the next prompt (known gap) |
| A7 | Gemini CLI | Compare the usage row with `/stats` | Same input/output/cached numbers |
| A8 | Qwen Code | A0 from a workspace whose path has spaces | Hooks run (8.3 short path); `1`/`2`/`Esc` land on once/always/deny; context % after a turn; a deny leads to "waiting for input" |
| A9 | Factory Droid | Install with (a) no files, (b) existing `hooks.json`, (c) hooks only in `settings.json` | Entries go to `hooks.json` in (a) and (b), into `settings.json` in (c); existing user hooks keep running |
| A10 | Factory Droid | A0; capture the permission menu (option order and keys) | Card shows the last command; record the keys for `adapter.json` (none shipped yet) |
| A11 | Cursor CLI | A0 | Hooks fire on Windows at all (one report says CLI hooks don't); no tool call is blocked; double fires don't flicker the state |
| A12 | Cursor CLI | Trigger an approval prompt; screenshot it | Pane turns "Needs permission" from the screen rule; `y`/`n` from the card work; adjust the regex in `adapters/cursor/adapter.json` if the wording differs |
| A13 | Cursor + Claude Code integration installed | Run Cursor with tool calls | Tool calls are not blocked (D-025 `{}` is neutral); no fake Claude Code session appears |
| A14 | Custom agent | Wizard: add an agent with a screen rule; run `kotilo-hook --agent <id> --event waiting-permission --json "{\"tool\":\"Bash\",\"command\":\"ls\"}"` in its pane | The agent appears in "New agent"; the protocol event raises the permission card |

## AI providers (M3, `hub/Hub.Infrastructure/Ai/`)

| # | Steps | Expected |
|---|---|---|
| P1 | Settings → AI → Test for each installed agent CLI | ok + latency; no files appear in the agent's session list for the test (scratch folder runs are skipped). OpenCode needs a provider other than its free "Console" tier, which refuses headless runs; Qwen and Gemini answer "not signed in" until you sign in once |
| P2 | Add an Ollama endpoint with a dummy key, Test, then Remove key | Key appears in Windows Credential Manager as `agent-hub/ai/<name>` and is gone after removal; `settings.json` and the hub log never contain it |
| P3 | Daily summary and dictation cleanup on the Ollama endpoint | "Fully local" badge; summary and cleanup work with the network cable unplugged |

## Mission control, timeline, composer, split pane (M4, `apps/desktop/src/features/{mission,timeline,composer}/`, `features/terminal/`)

Preparation: `npm --prefix apps/desktop run tauri dev`; Claude Code and Codex integrations installed (Codex hooks approved in `/hooks`); a workspace that is a git repository with a commit; a speech model downloaded for M4-3. Steps send real keys into live agents, so they need the user at the desktop (AGENTS.md rule 6).

| # | Steps | Expected |
|---|---|---|
| M4-1 | Claude Code pane: type a one-line message in the composer, `Enter`; then a three-line message (`Shift+Enter` between lines), `Enter` | Each message arrives as one prompt and is submitted once (no "pasted text" left waiting, no extra empty prompt); the multi-line one keeps its line breaks; the composer clears; focus stays in the composer |
| M4-2 | Same as M4-1 in a Codex pane; then in a plain PowerShell tab (send button) with a multi-line message | Codex: as in M4-1 (the 40 ms Enter delay is enough – note if Enter gets swallowed into the paste). PowerShell: the multi-line paste warning appears first; with "Paste" each line runs |
| M4-3 | Composer mic: click, speak, click again; then start, press `Ctrl+Alt+D` | Text lands at the caret in the composer (not in the terminal, clipboard unchanged); the same overlay as live dictation; the hotkey stops the composer recording. With the global dictation shortcut turned off the mic still works |
| M4-4 | `Win+Shift+S` a region, `Ctrl+V` in the composer, send to Claude Code | `.kotilo/attachments/screenshot-….png` created in the workspace, chip shown, the one-time `.gitignore` hint appears once (never again after "Got it", also after a restart); the agent receives `@.kotilo/attachments/…png` and reads the image; `.gitignore` itself is untouched |
| M4-5 | Composer `@` + part of a file name, `↓`, `Tab`; `Esc` in the composer | Suggestions from the workspace, the relative path inserted; `Esc` returns focus to the terminal and terminal keys work normally |
| M4-6 | Saved prompts: save a message, restart the app, insert it, filter, delete it; then Collect diagnostics | Prompt survives the restart (`%APPDATA%\kotilo\settings.json` → `composer.savedPrompts`); insert puts it at the caret; the diagnostics zip has only `savedPromptCount`, no prompt text |
| M4-7 | Split: Claude Code and Codex tabs side by side (tab menu "Split right", then again by dragging a tab onto the right half, then the header split button); make the window narrow; trigger a permission prompt in the right half | Both agents run and render at the right width (no garbled TUI after resize); the permission card stays inside the right half and scrolls; its keys go to the right agent; the timeline switches when you click into each half |
| M4-8 | In a split, close the split with each half's ×, with the tab menu "Close split", and by closing one half's tab; restart the app while split | No terminal closes or restarts except the one whose tab was closed; the split comes back after the restart (agent tabs show their "Start" prompt as usual) |
| M4-9 | Timeline with a live Claude Code session: ask it to read a few files, edit one, run a command, and keep a to-do list (TodoWrite) | Activity rows appear within about a second, newest first, with read/edit/command letters, running → done with durations; a "New prompt" line per prompt; the plan shows the to-do items with `done / total`; a denied permission shows "denied" |
| M4-10 | Same session: open Changed files; click the edited file; edit a file in another editor; `git commit` from an external terminal | Edited file listed under the agent's group with `+n −m`, a Bash-made change under "Other changes"; the diff tab shows HEAD ↔ working copy read-only; the external edit appears after ~1 s; after the external commit the list empties after the next file event or the refresh button |
| M4-11 | Restart the background service (kill `Hub.Service`) during a session | The timeline starts empty and fills again with the next tool call; no activity text in `%LOCALAPPDATA%\kotilo\hub\logs` or `hub.db` |
| M4-12 | Mission control (`Alt+3`) with two in-app agents and one agent started in an external terminal; switch filters; click a tile; minimise the window for a while | Tiles show the last 5 lines of each pane, updating about once a second; the external session says "Running outside Kotilo" with metadata only and is not clickable; filter counts match; a click opens the right workspace and tab with the terminal focused; no CPU use from previews while minimised |
| M4-13 | `Alt+1` … `Alt+9` with focus in a terminal, in the composer and on Settings; `Ctrl+,` | Alt+3 opens Mission control, Alt+9 and `Ctrl+,` open Settings; the rail tooltips show the same numbers; nothing reaches the agent |

## Mascot (M6, `apps/desktop/src/features/mascot/`, `src-tauri/src/platform/mascot/`)

Preparation: stop any running dev app, `dotnet build hub/AgentHub.sln` (tauri dev does not rebuild the hub), then `npm --prefix apps/desktop run tauri dev`; Claude Code (or Codex) integration installed. Steps click and drag on the real desktop, so they need the user (AGENTS.md rule 6).

| # | Steps | Expected |
|---|---|---|
| M6-1 | Fresh settings (or an older settings file): start the app, start an agent and let it work | The mascot is off; the one-time "Mascot suggestion" card appears once; **No thanks** never shows it again (also after a restart); on a second profile **Turn on** shows the snail |
| M6-2 | Mascot on, taskbar at the bottom: run an agent turn, then let it finish; trigger a permission prompt; answer it; let a turn end with a question | Snail stands asleep (dim, Zz) → walks along the top of the taskbar while working, turns at the screen edges → short hop when the turn ends (with "Celebrate finished work") → stops with red halo and "!" on the permission → "?" when waiting for input; colours change within about a second |
| M6-3 | Click the snail in each state; type in Notepad first, then click | Permission/input/error: Kotilo comes to the front on the agent that waited longest with its terminal focused; sweat: Usage; sleep/work/done: Kotilo comes to the front. The snail window itself never shows in Alt+Tab or the taskbar |
| M6-4 | Right-click the snail; choose each item; also open the menu and click elsewhere | Menu at the cursor with "Hide for 1 hour", "Turn off mascot", "Mascot settings…"; hide → gone, Settings shows "Hidden until …" and **Show now** brings it back; turn off → gone and the toggle is off; settings → Settings → Mascot; clicking elsewhere closes the menu |
| M6-5 | Drag the snail along the taskbar; restart the app | It follows the pointer horizontally only, faces the drag direction, walking pauses while dragging; the position is kept after the restart |
| M6-6 | Settings → Mascot: sizes Small/Medium/Large; placement "Sit in the corner" and back | 32/48/64 px snail, never clipped; corner = bottom right of the work area, no walking or dragging; back to taskbar resumes walking |
| M6-7 | Move the taskbar to the top / left / right (or turn on auto-hide), with an agent working | The snail walks along the bottom of the work area (no climbing); no flicker; returns to the taskbar top edge when the taskbar is back at the bottom |
| M6-8 | Display scale 100 % → 150 % while the snail is visible; with two monitors, change which one is primary | The snail keeps its size in logical px and re-lays out within ~2 s; it stays on the primary monitor |
| M6-9 | Play a video full screen, start a full-screen game, start a PowerPoint slide show | The snail hides within ~2 s and comes back after leaving full screen |
| M6-10 | Windows Settings → Accessibility → Visual effects → Animation effects off, with an agent working; then watch Task Manager with the snail standing | No walking, bobbing or halo pulse (state still shown by colour and bubble); with the snail standing, no measurable CPU from Kotilo's mascot |

## Assistant popup (M7, `apps/desktop/src/features/assistant/`, `src-tauri/src/platform/assistant/`, `hub/Hub.Service/Api/AssistantEndpoints.cs`)

Preparation: stop any running dev app, `dotnet build hub/AgentHub.sln`, then `npm --prefix apps/desktop run tauri dev`; Settings → AI: Assistant on, provider Claude Code (later also Codex and an OpenAI-compatible endpoint such as Ollama). Steps press global hotkeys on the real desktop, so they need the user (AGENTS.md rule 6).

| # | Steps | Expected |
|---|---|---|
| M7-1 | Focus Notepad, press `Ctrl+Alt+Space`; type a question, `Enter` | The popup appears at the bottom right of the monitor under the cursor with rounded corners (no square frame), focus in the message box; the answer streams in; no Alt+Tab entry, no taskbar button |
| M7-2 | Ask a follow-up that needs the first answer ("make it shorter"); ask for code | The assistant uses the earlier turn; code renders highlighted with a copy button that works |
| M7-3 | During a long answer press `Esc`; then `Esc` again; reopen with the hotkey | First `Esc` stops (partial text kept, "stopped"); second closes; reopening shows an empty new chat. Starting a new question right after a stop gives no "busy" error |
| M7-4 | Hotkey while the popup is open and focused; click another app, press it again | Focused → hides; in the background → comes back focused with the chat kept |
| M7-5 | Settings → AI: set the assistant shortcut to the dictation shortcut; then to one another app holds (e.g. one registered by another tool); turn the assistant off | Same as dictation → field error on save; taken by another app → "Shortcut is used by another app"; off → the hotkey does nothing |
| M7-6 | Privacy: with Claude Code, chat a few turns; then look at `~/.claude/projects/` for a new folder/file for the buddy folder, `%LOCALAPPDATA%\kotilo\hub\hub.db` (`buddy_chats` gone) and `%LOCALAPPDATA%\kotilo\hub\logs` | No new Claude session file from the chat; no chat text in the database or logs (only provider, duration, outcome, counts). With Gemini/Copilot/OpenCode as provider the footer warns that the agent keeps its own copy |
| M7-7 | Provider not installed / not signed in / Ollama stopped | The turn shows a clear error with "Settings → AI"; that button hides the popup and brings Kotilo up on Settings → AI |
| M7-8 | Mascot on: click it while it sleeps; right-click → "Open assistant"; click during a permission wait. Dictation hotkey (hold and tap), `Esc` cancel and paste-last afterwards | Sleep click and the menu item open the assistant; the permission click still jumps to the agent; dictation hotkeys behave exactly as before |
