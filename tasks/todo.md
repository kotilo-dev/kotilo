# U-3 – macOS beta (planned 2026-10-23)

Goal: a macOS beta with the same core as Linux (terminals, agent status, permission card, hub, usage, tasks, themes, updates); Windows-only extras (dictation, mascot, global hotkeys, away summary, ConPTY, WT schemes) stay off via `app_info.features`. Builds run on GitHub's macOS runners; there is no Mac here, so every behaviour check is done by an outside tester (checklist below). Signing/notarization once the user's Apple Developer account exists; until then ad-hoc signed test builds.

Found in the code (2026-10-23): macOS builds and tests already pass in CI (U-1); `ps`-based process listing, the Unix hook socket and Unix shell detection work on macOS. Gaps below.

## Track A – Hook + hub (`crates/hook/**`, `hub/**`)
- [x] Hook `default_data_dir` on macOS = `~/Library/Application Support/<slug>/hub` (today `~/.local/share`, so the hub would get no hook events); also set `AGENTHUB_DATA_DIR` in the pane env
- [x] `HookCommandLine` off Windows: POSIX-quoted path for every shell kind (`cmdUnquoted`, `any`, `powershell`); the macOS BinDir has a space (Codex/Qwen/Cursor hooks would not run) and the Gemini `powershell` form is a sh syntax error on Linux too
- [x] User adapters folder: hub and desktop agree on macOS (hub `ApplicationData` = `~/.config`, desktop = `~/Library/Application Support`)
- [x] Fixtures + tests for each

## Track B – Desktop core (`apps/desktop/src-tauri/**`)
- [x] Login-shell PATH at start (`$SHELL -ilc`), before the hub starts: a Finder/Dock launch only has `/usr/bin:/bin:…`, so agents, git and CLI providers are not found (and `/usr/bin/git` can pop the Xcode tools dialog)
- [x] Pane process tree on Unix: process group kill on pane close (SIGHUP → SIGTERM → SIGKILL), `pane_process_alive`, `pty_busy`, `pty_processes`, `pty_stop_leftovers` (the leftover strip's Stop does nothing today; graceful close never waits)
- [x] App lifecycle: Dock click reopens the main window (`RunEvent::Reopen`); Cmd+Q goes through the close guard; template tray icon

## Track C – Frontend (`apps/desktop/src/**`)
- [x] Shortcuts: Cmd instead of Ctrl for app shortcuts on macOS (one `Mod` key); terminal Cmd+C/V copy/paste, Ctrl+C/V always to the shell; Cmd+click opens links; route shortcuts by `e.code` (Option+digit types characters)
- [x] Copy: Finder instead of Explorer, Cmd in shortcut labels, "Same as system" (en + tr)

## Track D – Packaging (`scripts/**`, `.github/workflows/**`, `tauri.conf.json`)
- [x] `scripts/release-macos.sh`: hub `osx-arm64` / `osx-x64` (no Whisper natives; dictation is off), `.app` + `.dmg` + updater `.app.tar.gz`, per-arch names
- [x] `bundle.macOS`: minimum system version, hardened runtime, entitlements (hub needs JIT; check .NET's and Tauri's current docs before choosing)
- [x] `release.yml` `build-macos` job; `latest.json` `darwin-aarch64` / `darwin-x86_64`; signing + notarization steps that run only when the Apple secrets exist
- [x] CI smoke test (`scripts/macos-smoke.sh`, CI `macos-smoke` + each release build): the app starts through Launch Services, the hub answers, a hook started with an almost empty environment reaches the hub, nothing is left after quit
- [ ] Unsigned test build for the tester (manual run of the release workflow, macOS only)

## Docs and trial
- [x] D-062 (macOS beta scope, data folders, hook command form, signing), README macOS section
- [x] Tester checklist (`docs/manual-tests.md`, English: the tester is not us): install, open, terminal + agent, permission card, hooks for two agents, update
- [ ] Tester run on a real Mac; Apple Developer ID signing + notarization once the account is ready

# 0.3.5 – Performance from the second-machine measurement (planned 2026-10-23)

Input: `docs/test/kotilo-performans-analizi-2026-10-23.md` (15 min, 0.3.4, corporate Windows machine). Idle: hub reads ~456 KB/s with no DB growth and holds ~300 MB private memory. With 2+ working agents WebView2 uses 1.55× the agents' CPU and GPU 3D reaches 13–31 %. Checked against the code: PTY output is already batched (16 ms / 64 KB, raw binary channel) and causes no React work per chunk, so the report's H1 does not hold as written.

## Wave 1
- [x] Hub: the 30 s clock refresh recomputes from the in-memory entries instead of reloading 35 days of `usage_entries`; session totals/context queries only after new rows; tests
- [x] Hub: Workstation GC (`ServerGarbageCollection=false`; Server GC is the `Microsoft.NET.Sdk.Web` default)
- [x] Desktop: the "background service is not running" banner refreshes the hook status when the hub stream (re)connects (it was read once at start, so a slow hub start left it on for good)

## Wave 2 (after the user's reduced-motion check on the second machine)
- [x] Working-state animations (D-063; re-measurement 2026-10-24: WebView2 44 % → 11 % with Windows animations off): shimmer removed, Blocked halo on `transform`/`opacity`, all animations pause while the window is unfocused or hidden
- [x] Hub: usage refresh merges the rows `Upsert` wrote instead of reloading 35 days on every transcript write (2.4–2.9 MB/s while agents worked); tests
- [x] Dictation overlay window created on first use (not at start) and closed after 10 min hidden
- [x] Project scan: todo files with an unchanged write time are reused, not re-read every 60 s; tests
- [x] Idle reads remained (0.3.6 measurement: ~3.9 MB of SQLite pages every 60 s): the project activity sweep reads only recent rows via `ix_usage_ts`, full window at start and every 15 min (D-064); HealthMonitor re-reads the agent configs every 30 s (a few KB, left as is)
- [x] Terminal: WebGL reloads 1 s after a context loss (at most 3 times per terminal); it stayed on the DOM renderer until a tab switch
- [x] One log line per notification: the source logs it; `AppHost` only logs a quiet-hours/DND drop
- [ ] Hook latency test (process start + process snapshot + loopback POST per event)
- [x] Re-run the measurement (report Annex A) on the second machine and compare with its §6 targets (`kotilo-performans-analizi-2026-10-24-v0.3.5.md`: memory targets met; UI targets only with Windows animations off; idle hub reads 2 KB/s on thin evidence)
- [x] Third measurement with Windows animations ON (0.3.6, raw samples `docs/test/2026-10-25-v0.3.6-*.zip`): hub fixed (load reads 2,373 → ~110 KB/s, CPU 10.7 → 1.7 %); unfocused WebView2 2–3 % under load; focused, a Working ring alone held WebView2 at ~25 % of a core + 25 % GPU, also with no agent output (a background shell kept the session Working)

## Wave 3 (0.3.7, after the 0.3.6 measurement)
- [x] Spinner `steps(8)`: Chromium draws a frame per step only (e2e trace, one working agent: 60 → 16 frames/s) (D-064)
- [x] Working only for background work (`backgroundTasks`): the ring stands still in the header pill, agents list, status bar and Mission Control; Mission Control shows "Background: …" (D-064)
- [x] Hub: incremental project activity sweep (above)
- [ ] Fourth measurement: focused idle with a background shell, and A/B/C with Windows animations on; note the times of focus changes

# U-2 – Linux core (planned 2026-10-17)

Goal: Kotilo runs on Linux with its core (terminals, agent status, permission card, hub, usage); extras that are Windows-only today (global hotkeys, dictation paste, mascot, taskbar badge) stay off. macOS follows in U-3 (needs a Mac and an Apple Developer account).

## Core
- [x] Shell detection on macOS/Linux: login shell (`$SHELL`) first, then zsh, bash, fish, pwsh (PATH + standard folders incl. Homebrew); agent command via `-i -c … ; exec <shell> -l -i`
- [x] Hook process chain off Windows (`/proc` on Linux, one `/bin/ps` on macOS); app found with or without `.exe`; hook socket at a fixed `/tmp/<exePrefix>-<pid>.sock` (a hook with an empty environment finds it too)
- [x] Extras off on Linux: `app_info.features` from the platform layer; Dictation route/section, Mascot section/offer, away summary, bundled ConPTY, WT scheme import and the assistant hotkey are hidden; no mascot/overlay window is created

## Packaging
- [x] Linux release script: `scripts/release-linux.sh` ran on Fedora 44 (WSL): AppImage 170 MB, .deb/.rpm 77 MB; `/usr/bin/{kotilo,kotilo-hook,kotilo-hub}`, resources in `/usr/lib/Kotilo`
- [x] Release workflow: `build-linux` job on ubuntu-22.04, AppImage/.deb/.rpm + `.sig` on the draft release, `latest.json` `linux-x86_64` (AppImage), `linux-x86_64-deb`, `linux-x86_64-rpm`; a signed trial build in the VM produced all three signatures

## Trial
- [x] Real Linux desktop (Hyper-V VM, Ubuntu 22.04 GNOME, installed .deb): terminal opens, hub starts and connects, hooks install to `/usr/bin/kotilo-hook`, a Claude session stays listed Idle → Working → Blocked (permission card) → Idle
  - Fixed on the way: the hub named its tools and git with `.exe`; no process listing off Windows dropped hook-tracked agents after two ticks (`platform/processes.rs`); stale hook socket on exit
  - WSL Fedora 44 + WSLg: builds, hub starts and connects, state in `~/.config/kotilo`, logs in `~/.local/share/kotilo/logs` (fixed: were written to the working dir). WSLg's compositor (weston `rdp-backend.so`) segfaults ~20 s after start and takes the window down; needs software rendering (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `LIBGL_ALWAYS_SOFTWARE=1`) and X11 (`GDK_BACKEND=x11`) to start at all
- [ ] Installed package: install, start, update (install + start done in the VM; update needs the first release with Linux entries)

# U-1 – Builds and tests pass on macOS and Linux (planned 2026-10-17)

Goal: AGENTS.md rule 7 holds in CI. The `desktop-unix` and `hub-unix` jobs (PR #1) turn green and become blocking. No Linux/macOS release yet (U-2 Linux core package, U-3 macOS with an Apple Developer account).

## Rust
- [x] Hook endpoint in the platform layer (`platform/hook_endpoint.rs`): named pipe on Windows, Unix socket `<temp>/<exePrefix>-<pid>.sock` (mode 0600, removed on drop) elsewhere; `ipc_server` only accepts connections
- [x] `agenthub-hook`: `endpoint_for_pid` + Unix socket `real_connect` (was a no-op stub); tests
- [x] Dictation overlay window handle through `os::handle` (was a Windows-only `hwnd()` call)
- [x] Transparent windows on macOS: `macos-private-api` feature + `app.macOSPrivateApi`
- [x] `pty`: no unused `job` placeholder off Windows
- [x] Clippy `-D warnings` and `cargo test --workspace` green on macOS and Linux: hook integration test over the real endpoint (passes over the Unix socket); terminal links resolve `/...` absolute paths; `image_filename` splits on both separators; Windows-only tests gated (shell detection, Git Bash drive links, case-insensitive watcher paths)

## Hub
- [x] The 15 failing tests: Windows path fixtures → platform-neutral fixtures (or Windows-only where the behaviour is Windows-only: npm `.cmd` shim, locked install target)
- [x] `ProjectRootResolverTests.Fixed_root_inside_a_repo_stays_its_own_root`: real bug – the fixed-root check rewrote paths to `\`, so a fixed root never matched on Unix; now compares with the platform separator

## CI
- [x] Drop `continue-on-error` from `desktop-unix` and `hub-unix`: all six CI jobs green on 53bb22d

## Next (U-2)
- Unix shell detection (`$SHELL`, bash/zsh/fish) – `pty` detects only Windows shells, so no terminal opens on macOS/Linux yet
- Process tree query for the hook sidecar (`process_chain` is a stub off Windows: agents that drop the pane environment are not mapped)

# 0.3.2 – Performance and second-machine findings (planned 2026-10-15)

User (priority): with several sessions open, one agent's script bottlenecked the machine and Kotilo-attributed CPU stayed after the agent was stopped and closed. Diagnostics zip (0.3.1, 3 pwsh panes): agents ended with `/exit` (`SessionEnd`) while their panes stayed open — the Job Object only kills on pane close. Screenshots: the permission card offered "Always allow" on a Yes/No prompt (its key `2` = No); the Context bar shows 38 % / 75 % where Claude shows 8 % / 15 % (1M window divided by 200k); status green/blue while "Waiting for 1 background agent"; status yellow while a permission prompt was on screen (no PermissionRequest hook in the log).

User decisions (2026-10-15): leftover processes after the agent exits → a warning strip with a **Stop** button (no automatic kill); a turn that ends with background work still running stays **Working** until that work finishes.

Verified in the Claude Code docs (hooks, statusline, model-config): `Stop`/`SubagentStop` carry `background_tasks` (non-empty = paused waiting for background work); `SessionStart` may carry `model`; Fable 5.x, Sonnet 5+, Haiku 5.5, Opus 4.7+ run with the 1M window by default; `permission_suggestions` is not an exact list of dialog options, so the dialog's options are read from the screen.

## Track A – Hub (C#) · owns `hub/**`
- [x] Context: `models.default.json` 1M for the default-1M families (longest prefix wins; Opus 4.6/Sonnet 4.6 stay 200k with the existing >200k bump); tests
- [x] `Stop` with non-empty `background_tasks` keeps the session Working (no completed toast, no unseen); a later `Stop`/`SubagentStop` with empty `background_tasks` finishes it; fixtures + tests
- [x] `UsageService`/`ProjectService`: drain the wake semaphore per iteration (like `StreamHub`); periodic 30 s refresh only while a block is active; tests
- [x] `TranscriptUsageParser`: cheap `"usage"` marker check before `JsonDocument.Parse`
- [x] Sessions that never end: non-Ended sessions without a live process and no event for N hours → Ended; git insights only for Working/recently active sessions; `transcript_offsets` pruned for files that no longer exist

## Track B – Rust (desktop core + platform) · owns `apps/desktop/src-tauri/**`, `adapters/**`
- [x] `apply_hook` `Stop`: non-empty `background_tasks` → stay Working; tests
- [x] Leftover processes: after `SessionEnd` (or the record's removal) a pane whose shell still has non-shell descendants emits `pty:leftover { paneId, processes[] }`; command `pty_stop_leftovers(paneId)` terminates the shell's descendants (not the shell); cleared when they exit
- [x] Pane close: remember every `(pid, creation time)` seen under the pane by the tick and terminate the survivors on teardown (orphans whose parent died are not reachable by the descendant walk); tests on the pure part
- [x] Claude permission screen rule (`waitingPermission`, "Do you want to …?" + numbered options) as a safety net when no PermissionRequest hook arrives
- [x] Diagnostics zip includes the hub logs (`%LOCALAPPDATA%\<slug>\hub\logs`, last 2 MB of the active file)
- [x] Taskbar overlay failure logged once per error kind, not on every badge update
- [x] Watcher batch: `HashSet` for dirs; `cmdline_cache` pruned to live pids
- [x] CSP: allow WebAssembly (`'wasm-unsafe-eval'`) so the image addon's sixel decoder loads

## Track C – Frontend · owns `apps/desktop/src/**`
- [x] Permission card: read the pane's buffer tail, parse the numbered options of the visible dialog; "Always allow" only when option 2 is a "Yes, and don't ask again …" style answer (label taken from the screen), Yes/No dialogs show Allow once / Deny; unknown layout → Allow once / Deny / Answer in terminal; unit tests on the parser + e2e screenshot
- [x] Leftover strip in the pane ("Agent exited – N processes still running: python.exe …" + Stop + dismiss); i18n EN/TR; e2e
- [x] Background work label ("Background: backend-expert") where the status shows Working because of background tasks, if the hub/desktop exposes it
- [x] `fs:changed`: coalesce per animation frame/250 ms, skip `set` when a dir listing is unchanged; hub/`agents:changed` frames skip `set` when equal
- [x] 1 s timers paused while the window is unfocused or the view is hidden (AgentsPanel, AgentPane, Mission/Overview, mascot recompute)
- [x] Timeline rail split: session/plan/activity above, changed files below, each with its own scroll; draggable splitter (react-resizable-panels like the left column), ratio in the `layout` slice (`timelineSplitSizes`, default 60/40, min sizes); e2e screenshot with a long activity list
- [x] Status icons instead of plain dots (agents list, status bar): working = spinning arc (no spin with reduced motion), permission = shield with "!", input = chat bubble, done = check, idle = hollow circle, error = x; same colours, labelled from the i18n status names; e2e screenshots light/dark

## Integration
- [x] All checks (dotnet test 1057, cargo test 637+83 + clippy, npm test 935, e2e 84), DECISIONS D-060, manual tests G-1…G-11 in `docs/manual-tests.md`
- [ ] Version 0.3.2; user tests on the second machine

# 0.4 – Phone notifications through ntfy (planned 2026-10-13, D-059)

User: agent states on the phone; ntfy with a generated UUID topic and a "Set up on phone" button that shows a QR the ntfy app can add directly; keep settings simple.

## Before starting
- [ ] Check on a real iPhone whether the ntfy iOS app opens `ntfy://ntfy.sh/<topic>` (if yes: one QR for both platforms, drop the iPhone tab)
- [ ] Re-read ntfy publish docs (headers, limits of the public server) and pick the QR library (licence)

## Hub (C#)
- [ ] `PhoneNotifier` channel next to the toast feed: receives every notification that passed the rules and `NotificationGate`, maps severity → ntfy `Priority` (attention = 4/high, warning = 3, info = 2), `Title` = project · agent, body = state + waiting time; metadata only (rule 5); `HttpClient` with timeout, failures logged without the topic
- [ ] Settings: `phone.enabled` (false), `phone.server` ("https://ntfy.sh"), `phone.onlyWhenAway` (true); validation (https URL; http only with an explicit flag); topic in `ISecretStore` (`kotilo-ntfy-topic`), never in settings/logs/diagnostics
- [ ] Endpoints: `POST /v1/phone/topic` (create or renew: `kotilo-` + UUID "N"), `GET /v1/phone/setup` (server, topic, `ntfy://` link – for the local app only), `POST /v1/phone/test`, `PUT /v1/presence { away }` (desktop idle state)
- [ ] Only-when-away: skip publishing while the desktop reports present; nothing reported (app closed, hub alone) = away
- [ ] Tests: priority/title mapping, no transcript fields in the payload, gate + away logic, topic never in logs (fake HTTP handler, temp secret store); schema + contract tests

## Desktop (Rust + UI)
- [ ] Report presence to the hub from the existing idle watcher (D-056): away after `agents.awaySummaryMinutes`, present on input
- [ ] Settings → Notifications: one "Phone (ntfy)" block – toggle, **Set up on phone** (dialog: Android tab with QR of `ntfy://<host>/<topic>?display=Kotilo` + "Install ntfy" link; iPhone tab with server/topic and Copy buttons), **Send test**, **Renew link** (confirm: the phone must be set up again), "Only when I'm away"; **Advanced**: server URL + iOS `upstream-base-url` hint
- [ ] QR rendered locally (no web service); i18n EN/TR; Playwright screenshots of the block and the dialog (light/dark)
- [ ] `THIRD_PARTY_NOTICES` regenerated

## Docs and checks
- [ ] README/user guide: phone notifications, what is sent, how to renew
- [ ] Manual tests N-1… in `docs/manual-tests.md`: Android QR subscribe, iPhone manual subscribe, test message, permission while away arrives with high priority, no message while present, DND/quiet hours, renew link → old subscription silent, topic absent from logs and diagnostics zip

# 0.3.1 – Fixes from testing on a second machine (2026-10-13)

User: a PowerShell profile that changes to the home folder made new terminals and agents start outside the workspace; a restored Claude tab's start button could not be clicked; asked for a "keep running in the tray" setting.
- [x] PowerShell panes: `-NoExit -Command "Set-Location -LiteralPath '<cwd>'[; <agent>]"` so the workspace folder wins over the profile (`pty::wrap_agent_command`, tests)
- [x] Start/exit/search overlays above xterm's layers (`z-10`): xterm's link-layer canvas swallowed the click; e2e `restore.spec.ts` (`?restore=agent`)
- [x] D-058 close to tray: setting in Settings → About, tray icon with Show/Quit, `CloseGuard` hides instead of closing
- [x] Agent questions vs. the permission card: Claude's `AskUserQuestion` goes through its permission dialog, so the card's Allow/Deny sent `1`/`Esc` to a multiple-choice question (picked the first answer or cancelled it). The hub now treats a question tool (`AskUserQuestion`, plan approval `ExitPlanMode`) as WaitingInput and the desktop hides the card for them even with an older hub; the card takes focus also when the window comes back (only from this pane's terminal or an empty input), ignores Enter/Space/Esc in the first 400 ms after taking focus, and the result note is a small top-right pill (2.5 s) instead of a strip over the agent's prompt
- [x] Workspace rows: arrow cursor instead of the text cursor (`select-none`); inactive roots get a "Switch" button on hover/selection, a double click switches, the ○ dot has a bigger hit area; "Make active" stays in the context menu; e2e `workspaces.spec.ts` (`?workspaces=2`)
- [x] Right click pasted twice in an agent: with mouse tracking on, xterm reports the click to the program (which may paste itself) and Kotilo pasted too. Now the click is left to a mouse-tracking program, as in Windows Terminal; Shift+right click still pastes; a selection is still copied; e2e `paste.spec.ts`
- [ ] Manual checks F-1–F-15 (`docs/manual-tests.md`, run list `tasks/manual-test-run.md` §5) – needs the user and a build with these fixes
# 0.3 – Unseen finished work + terminal colour schemes (planned 2026-10-11)

User: after D-054 a finished turn sends one "completed" toast; "o an bilgisayar başında değilse ya da bildirimi pas geçtiyse bir süre sonra unutabilir". Second track: terminal colour schemes for the terminal area only (app chrome keeps the design tokens).

User decisions (2026-10-11):
- **Seen** for hub sessions is stored in the hub (survives restarts; mascot, Mission and badge agree). It clears when: an in-app session is opened (existing `navigateToAgent`/set_focus path) or gets a new prompt; an outside session's Mission card is clicked; "Mark all as seen" in Mission.
- **Taskbar badge** = unseen finished + waiting (permission/input/error); orange when something waits, blue when only finished work; no badge at 0.
- **Back-at-the-desk summary**: on by default, away threshold 10 min (setting); single toasts while away still go out (they stay in the Windows notification centre); respects DND/quiet hours.
- **Windows Terminal schemes**: copy-import (the chosen scheme's colours are copied into Kotilo settings; WT's file is only read).
- Unseen reminder: one reminder per finished turn after X min (default **off**, 30 min), like the waiting reminder.

## Findings that shape the plan
- Own panes: Rust `AgentState::Done` vs `Idle` (`agents/mod.rs` `seen`/`set_focus`/`ack`). Hub has no seen concept; `SessionInfo.LastCompletedAt` exists and is persisted but not in `SessionDto`. `paneSession.ts` notes "the hub has no done, not yet seen"; `missionLogic.groupOf` shows every hub Idle as done.
- No taskbar overlay/tray code; `windows` crate already has `Win32_UI_Shell`. No idle detection anywhere; `Win32_UI_Input_KeyboardAndMouse` is enabled.
- Terminal theme: `xtermThemeFor` (`terminalRegistry.ts`) reads `--terminal-bg`/`--ansi-*` CSS vars; live update in `TerminalView.tsx` `apply()`. Containers have no background, so FitAddon's leftover strip shows `--bg`. WT settings paths exist in `platform/fonts.rs` (private, not JSONC-aware). Terminal settings live in Rust `settings/mod.rs` (`TerminalSettings`), not the hub.

## Track A – Hub (C#) · owns `hub/**`
- [x] `SessionInfo.SeenAt` (persisted, migration); `Unseen` = `LastCompletedAt > SeenAt` and state is Idle/Ended; a new prompt (Working) marks seen
- [x] `SessionDto`: `lastCompletedAt`, `unseen`; `POST /v1/sessions/{agent}/{id}/seen`, `POST /v1/sessions/seen` (all); changes published on the `sessions` stream
- [x] Rule `session.unseen_reminder`: `RuleOptions.UnseenReminderEnabled` (false) + `UnseenReminderAfter` (30 min), once per completion (rule state store), DND/quiet hours as usual; settings DTO/validation; schema + contract tests

## Track B – Rust (desktop core + platform) · owns `apps/desktop/src-tauri/**`
- [x] `platform/idle` (`GetLastInputInfo`, stub elsewhere) + a 5 s watcher emitting `user:returned { awayMs }` when input resumes after ≥ `agents.awaySummaryMinutes`
- [x] `platform/taskbar`: overlay icon with a drawn count (1–9, 9+) and tone (attention/done), cleared at 0; command `taskbar_set_badge { count, tone }`
- [x] WT scheme import: shared WT settings reader (move out of `fonts.rs`), small JSONC stripper (comments, trailing commas), parse `schemes[]`; command `terminal_wt_schemes` → name + 16 ANSI + bg/fg/cursor/selection; never writes
- [x] Settings: `appearance.darkTheme`/`lightTheme` (ids `[a-z0-9-]{1,64}`, else default), `agents.awaySummary` (true), `agents.awaySummaryMinutes` (10, 1–240), `terminal.colorScheme` ("app"), `terminal.importedSchemes` (≤ 50, colours `#rrggbb`, invalid entries dropped); tests

## Track C1 – Frontend: unseen work · owns `features/agents|mission|mascot|workspace/paneSession*`, `stores/agentStore|hubStore`, `lib/hubTypes`
- [x] Hub sessions with `unseen` render as Done (blue) in Mission, tree/pane status; Mission card click marks seen; "Mark all as seen" button; opening an in-app pane marks its hub session seen too
- [x] Badge: count unseen + waiting across own agents and hub sessions (deduped by pane/session) → `taskbar_set_badge`
- [x] Back-at-the-desk: on `user:returned`, one toast "While you were away: N finished, M waiting" if anything is unseen/waiting and not DND/quiet; skip when 0
- [x] Mascot: calm "done" look while unseen finished work exists (after the 3 s hop), lower priority than work/input/perm
- [x] Settings UI: unseen reminder (hub Notifications section), away summary toggle + minutes (agents section); i18n EN/TR

## Track C2 – Frontend: app themes + terminal schemes · owns `app/theme/**`, `features/terminal/**`, `index.css`, Settings `AppearanceSection`/`TerminalSection`
User (2026-10-11, after a Catppuccin mockup of the whole app): "Dahil et" – themes for the **whole app** in Appearance, with the best-known dev themes. Terminal follows the app theme by default; Settings → Terminal can pick a separate scheme or an imported WT scheme. "System" mode uses the chosen dark and light theme.
Settings (shared types already added in `ipc.ts`/`settingsStore.ts`): `theme` = mode (system/dark/light), `appearance.darkTheme` ("kotilo-dark"), `appearance.lightTheme` ("kotilo-light"), `terminal.colorScheme` ("app" | theme id | "imported:<name>"), `terminal.importedSchemes`.
- [x] Catalogue (values from each project's official palette, licences in THIRD_PARTY_NOTICES): Kotilo Dark/Light (today's tokens), Catppuccin Mocha/Macchiato/Frappé/Latte, Tokyo Night Night/Storm/Moon/Day, Rosé Pine Main/Moon/Dawn, Dracula, Nord, One Dark/One Light, Gruvbox Dark/Light, Solarized Dark/Light, GitHub Dark/Light, Kanagawa Wave/Dragon/Lotus, Everforest Dark/Light; terminal-only: Campbell
- [x] Token derivation: surfaces, borders, text steps, accent and status colours from the theme palette, applied as CSS variables on `<html>`; `data-theme` = the variant's kind (dark/light); agent identity and mascot colours stay; a contrast test over the whole catalogue (text ≥ 4.5:1, status/accent ≥ 3:1 on bg) with fallback to Kotilo tokens
- [x] Terminal: `xtermThemeFor` resolves app theme / chosen scheme / imported scheme; host container background = terminal background; live switch without reopening tabs
- [x] Settings → Appearance: mode + dark theme + light theme pickers with swatch previews; Settings → Terminal: scheme picker ("Same as app" default) + "Import from Windows Terminal…" (hidden when none found), imported ones removable; i18n EN/TR
- [x] Unit tests (catalogue, derivation, contrast, resolution, import mapping); e2e screenshots of Appearance and a few themes (Catppuccin Mocha, Latte, Gruvbox Dark)

## Integration
- [x] Released 0.3.0 (ec7bc3b, run 38168645519, published 2026-10-11 19:52Z); README + site screenshots updated; manual test run collected in `tasks/manual-test-run.md`
- [x] All checks (UI 916, Rust desktop 613 + clippy, hub 709 + 224 + 78, e2e 70); D-056 (unseen work + badge + away summary), D-057 (terminal colour schemes); user guide EN/TR; manual tests U-1… (badge, away summary, WT import) for the user

---

# 0.2.1 – D-054 fixes + terminal images and fonts (started 2026-10-11)

User report: a PowerShell tab in Kotilo does not look like their usual PowerShell. Kotilo starts `pwsh -NoLogo` (profile loads), so the differences come from the terminal itself. The user's setup: oh-my-posh prompt (needs a Nerd Font; Windows Terminal uses `MesloLGM Nerd Font`), `fastfetch --logo-type sixel` in the profile, Windows Terminal scheme "One Half Dark" with 80 % opacity + acrylic. User decision (2026-10-11): 0.2.1 = the D-054 fixes + images and fonts only; colour schemes / background later; "unseen work" items not in 0.2.1.

- [x] D-054: `idle_prompt` after a finished turn keeps the session idle; periodic-check changes are published (382f496)
- [x] Spike: the system ConPTY (build 26300) strips sixel; Microsoft's ConPTY 1.25 passes it; `SetDllDirectoryW` switches portable-pty to it, off = system ConPTY (both verified)
- [x] Bundled ConPTY (D-055): `scripts/fetch-conpty.ps1` (pinned version + SHA-256, Microsoft signature check), `release.ps1` installs `conpty\`, Rust `platform::conpty::select` at startup, setting `terminal.bundledConpty` (default on, after restart), THIRD_PARTY_NOTICES
- [x] Images: `@xterm/addon-image` 0.9.0 (sixel + iTerm inline, 32 MB cache)
- [x] Font: `platform::fonts` (registry font families, Windows Terminal faces read-only), `terminal_font_suggestion`, default terminal font gets the Nerd Font in front; Settings hint; tests
- [x] Docs: D-055, user guide EN/TR, manual tests T-1…T-6, README build note
- [x] All checks green (UI 855, Rust 588 + clippy, hub 694 + 222 + 76, e2e 64); user ran T-1…T-5 ("testler ok", 2026-10-11)
- [x] Version 0.2.1 (c28466f), tag, release run 38161858934 green, published 2026-10-11 18:16Z
- [x] T-6 (user confirmed both files after updating, 2026-10-11): after the user updates, `%LOCALAPPDATA%\Kotilo\conpty\` holds conpty.dll + OpenConsole.exe (build log and installer size +~430 KB say yes; NSIS content not inspected – no 7-Zip)

## Later (recorded)
- Colour schemes → moved to 0.3 (top of this file)

---

# M6 – Robot snail mascot (v0.2, planned 2026-10-11)

Goal: the robot snail from D-049 (concept B: spiral shell, core and antennas in the status colour) lives on the desktop and shows the agents' combined state at a glance; clicking it takes you to the agent that needs you.

User decisions (2026-10-11): **vector art** exactly like concept B (not pixel art); **both placements**, chosen in Settings – walks along the top of the taskbar (default) or sits still in the bottom-right corner; **off by default**, offered once (Settings + a one-time "Turn on the mascot" suggestion when the first agent starts working).

## Findings that shape the plan
- State is already in the main window's frontend: own panes from the Rust `AgentTracker` (`agents:changed`), outside sessions from the hub stream (`sessions`). Nothing aggregates them for a mascot; the hub's `MascotStateResolver` (ported from the old prototype's "Bip") is used only by tests, and `SpriteSheet` is pixel-art code with no data.
- The dictation overlay is the pattern for a secondary window: transparent, undecorated, `skip_taskbar`, `always_on_top`, shown with `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` (`platform/dictation/win_window.rs`), own capability file.
- Hub `buddy` settings exist (`mascotEnabled` default **true**, `mascotScale` 2–4, `walkArea` taskbar|corner, `celebrate`, `mascotHiddenUntil`, `mascotPosition`) but no UI and no i18n; e2e/test fixtures use `mascotScale: 1`, which the hub rejects.
- "Burn projection exceeds" exists only as the `usage.burn_projection` notification; DND/quiet hours live in the notification settings.
- Jump-to-agent is frontend-only: `navigateToAgent` (`features/agents/navigate.ts`), `goToSession` for hub sessions.
- No Win32 Shell APIs enabled yet (`SHAppBarMessage` for the taskbar edge, `SHQueryUserNotificationState` for full screen need `Win32_UI_Shell`).

## Design (D-052)
- **Window:** a small Tauri webview window `mascot` (`index.html?view=mascot`), sized tightly around the snail (+ room for the halo/bubble) so little transparent area catches clicks; created only while the mascot is on; capability file with `core:default` + events only.
- **Art:** one React SVG component from concept B, colours from design tokens (status colours), state = CSS class: `sleep` (dim, Zz), `work` (walk cycle: foot wave + bob), `perm` (red core + antennas, halo pulse, "!" bubble), `input` ("?" bubble), `error` (red core, "!"), `sweat` (amber, drops, slow walk), `done` (short hop + sparkle, only if `celebrate`). Scale 2/3/4 = 32/48/64 px tall. Reduced motion (Windows animation effects off) = no walk/bob, state only.
- **Movement (platform layer, Rust):** walk geometry is a pure, tested function (work area, taskbar edge, position 0..1, direction, speed, turn at edges, corner placement); the Windows part reads the taskbar edge (`SHAppBarMessage`) and full-screen/presentation mode (`SHQueryUserNotificationState`, hide), moves the window with `SetWindowPos(SWP_NOACTIVATE)` from a timer that runs only while walking (≈30 fps), and follows display/DPI changes. Non-Windows: stub.
- **State (main window frontend):** `mascotLogic.ts` = port of the hub resolver (perm > error > input > sweat > work > done 3 s > sleep; DND → sleep; speed factor), over own agents + hub sessions (deduped by pane), burn flag from `usage.burn_projection` for the current block → `mascot_update` command → Rust forwards to the mascot window.
- **Interaction:** click → `mascot:clicked` → main window: perm/input → focus the main window and `navigateToAgent` (oldest waiting first), sweat → Usage page, otherwise show the main window. Right click → native menu: Hide for 1 hour, Turn off mascot, Settings. Drag along the walking axis → `mascotPosition`.
- **Hub:** `mascotEnabled` default false (+ one-time migration for settings files that only carry the old default), add `mascotOffered`; delete the unused pixel `SpriteSheet` and the C# resolver (logic moves to TS, tests move with it).

## Wave 1 (parallel, file ownership)
- [x] A – Art + mascot view (FE `features/mascot/`): SVG component, state classes/animations, `?view=mascot` page listening to `mascot:state`, click/drag/right-click → events; e2e page rendering every state at every scale + screenshots
- [x] B – Rust: `platform/mascot/` (window create/destroy, show without activation, taskbar/full-screen/DPI, move timer), pure walk geometry + tests, commands `mascot_update` / `mascot_set_config`, events, capability file, `Win32_UI_Shell` feature
- [x] C – Main window + hub: `mascotLogic.ts` + tests, wiring (agents + sessions + burn + DND), click handling, Settings → Mascot section (on/off, size, placement, celebrate) EN/TR, one-time offer, hub default/migration/`mascotOffered`, delete `SpriteSheet` + C# resolver, fix fixtures (`mascotScale`)

## Wave 2 – checks
- [x] Integrate, hub/Rust/clippy/UI/e2e green, D-052, manual tests M6-1… in `docs/manual-tests.md` (walk on taskbar left/bottom/right/top, auto-hide taskbar, two monitors, DPI 100/150 %, full-screen video hides it, click/right-click/drag, reduced motion), user guide EN/TR section, screenshots
- [x] Manual tests M6-1…M6-10 on the real desktop – user: "denedim çalışıyor" (2026-10-11)

Wave 2 checks (2026-10-11, integrated tree): hub 698 + 214 + 64 (one Infrastructure test failed once while Rust/UI builds ran in parallel, green on two reruns), Rust 557 + 67 + 11 + 3 + 1 + 1 + clippy clean, UI build + 805 unit tests, e2e 51 (incl. mascot states/scales/drag/click and Settings → Mascot EN/TR light/dark). Screens: `test-results/screens/mascot-lineup-s3.png`, `settings-mascot-*.png`. Not run: the real app (`tauri dev`) – the window, walking and menu are only checked by the manual tests.

---

# M7 – Assistant chat popup (planned 2026-10-11)

Goal: a small chat window opened with a global hotkey for quick everyday questions, answered by the AI provider the user picked for "Assistant" (Settings → AI). Found missing after M6 (user: "kısayol ile açılıp günlük soruları sorduğumuz popup… settings'de bulamadım"): the old prototype's "Bip" chat was never ported.

User decisions (2026-10-11): **no history at all** – every opening is a new chat, the conversation ends when the window closes, nothing is written to disk ("verdiğimiz mesaj gizlilik bozulmasın"); **general chat** – the assistant gets no session or usage context (fix the "Answers questions about your sessions and usage" description).

## Findings that shape the plan
- `BuddyService.AskAsync` is `claude -p`-only (resume via Claude's own transcripts) and has no callers or API; the provider layer (`IAiProvider.CompleteAsync(AiRequest{System, User})`) is single-turn, non-streaming (OpenAI `stream=false`, Claude CLI stream thrown away, other CLIs collect stdout).
- `BuddyChatRepository` (`buddy_chats`, migration 004) would store the first 60 chars of the first message as a title – conflicts with rule 5 and the user's decision; `BuddyTranscriptReader` and `MarkdownLite` are unused leftovers. Nothing writes the table today.
- **Agent CLIs keep their own transcripts** (`~/.claude/projects/…`, `~/.codex/sessions/…`): a CLI-backed chat would leave the conversation on disk even though Kotilo stores nothing. Use each CLI's no-persistence mode where it exists (Claude Code: verify `--no-session-persistence` in the installed `--help`; Codex and others: verify) and show a note in the window for providers that cannot run ephemerally.
- Hub stream (`/v1/stream`) broadcasts to every client – not suitable for a private answer stream; no SSE/progressive endpoint exists yet.
- Desktop hotkeys: `RegisterHotKey` on a dedicated thread owned by dictation (`platform/dictation/win_hotkeys.rs`, closed `HotkeyId` enum, presses go to the dictation controller) – needs a small generalisation for a second consumer. `buddy.hotkey` defaults to `Ctrl+Alt+Space`; no duplicate-hotkey validation.
- No focusable secondary window exists yet (overlay and mascot are no-activate); main disables WebView2 browser accelerators (`lib.rs`), a new focusable webview needs the same. `react-markdown` + `remark-gfm` + highlight already in the app.

## Design (D-053)
- **Hub:** `IAiProvider` gets a streaming multi-turn call (`AiChatRequest{System, Messages[], Model, Timeout}` + `onText`): OpenAI-compatible with `stream=true` (SSE), Claude CLI with stream-json and the conversation rendered into the stdin prompt (no `--resume`), other CLIs plain (answer at the end), all CLIs in no-persistence mode where supported; `POST /v1/assistant/chat` returns a chunked NDJSON stream (`{type:"text",text}` … `{type:"done",errorKind,error?}`), client abort = cancel (process tree killed), one chat at a time (409 busy). Logs: provider, duration, outcome, character counts only. Remove `AskAsync`, `BuddyChatRepository`, `BuddyTranscriptReader`, `MarkdownLite` (+ tests) and drop `buddy_chats` with a new migration. Settings validation: `buddy.hotkey` must differ from the dictation/paste-last/task hotkeys.
- **Rust:** the hotkey thread becomes app-level (dictation keeps its ids; a new `Assistant` id routes to an assistant handler); registers `buddy.hotkey` while `buddy.enabled`, reports "taken" to the main window. Window `assistant` (`?view=assistant`): 400×580, undecorated, always on top, skip taskbar, takes focus, placed bottom-right of the monitor under the cursor, browser accelerators off; the hotkey toggles it; hiding destroys the page state (new chat next time). Command `assistant_chat(messages, channel)` streams the hub NDJSON to the page over a Tauri `Channel`; `assistant_stop`; capability file.
- **UI:** popup page: header (title, provider·model, new chat, close), messages (user right/accent, assistant left with markdown + code copy), composer (Enter send, Shift+Enter newline, Esc stops a running answer or closes, Ctrl+N new chat), footer "Nothing is saved · tools off · sent to <provider>" plus the no-persistence warning when needed; errors with a hint (not installed / not signed in → Settings → AI). Settings → Assistant (or the AI section): on/off, hotkey field (reuse the dictation hotkey input), "taken" warning, link to the provider choice; EN/TR; fixed description. Mascot: right-click "Open assistant", click in sleep/done opens it.

## Wave 1 (parallel, file ownership)
- [x] A – Hub: streaming chat on providers + endpoint + no-persistence flags (verified against installed `--help`) + cleanup migration + hotkey validation; fixture tests (fake CLI, fake SSE server)
- [x] B – Rust: app-level hotkey thread, `assistant` window + placement + toggle, `assistant_chat`/`assistant_stop` with Channel streaming, mascot menu item hook; tests for the pure parts
- [x] C – UI: popup page + markdown + keyboard, Settings → Assistant + i18n EN/TR, mascot "Open assistant" wiring; unit tests + e2e screenshots with a mocked stream

## Wave 2 – checks
- [x] Integrate, hub/Rust/clippy/UI/e2e green, D-053, manual tests M7-1… (hotkey toggle from another app, focus, streaming, stop, Esc, provider switch incl. OpenAI-compatible/Ollama, nothing on disk: no new files under `~/.claude/projects` for the buddy folder, no rows/logs with text), user guide EN/TR
- [x] Manual tests M7-1…M7-8 on the real desktop – user: "herşey çalıştı" (2026-10-11)

Wave 2 checks (2026-10-11, integrated tree): hub 690 + 222 + 75, Rust 583 + 67 + 11 + 3 + 1 + 1 + clippy clean, UI build + 853 unit tests, e2e 64 (13 assistant: multi-turn with code, streaming + Stop, error turn, unavailable/off, Settings EN/TR light/dark). Lead fixes at integration: popup window transparent without native shadow (the page paints the rounded card), Rust listens for `assistant:settings` and brings the main window up. CLI no-persistence flags verified against the installed `--help` (Claude Code 2.1.296, Codex 0.160.0, Qwen 0.25.0; none in Copilot 1.0.91, OpenCode 2.0.22, Gemini 0.62.0). Not run: the real app.

---

# M5 – Open-source release (in progress, replanned 2026-10-09)

Goal: publish the app as free, open-source software under Apache-2.0 – a public repo with clean history, signed per-user installers for x64 + ARM64 built by CI, the Tauri updater fed from GitHub Releases, complete notices, contributor docs – and keep the maintenance load low (adapters stay data-only, contributions welcome).
User decisions (2026-10-09, D-047): no paid tier – the market is full of free/open-source tools and the vendors build the same features, so licensing is removed; license Apache-2.0; the public repo is a new repo with a single initial commit from a scrubbed tree (the private repo keeps its history); the brand stays in one place and the final name is applied before the public repo is created. Earlier M5 decisions on Polar, pricing, Certum and tax are void.

## Findings that shape the plan
- Licensing exists in the hub only (wave 1): `Hub.Core/Licensing`, `Hub.Infrastructure/Licensing` (Polar client, store), `Hub.Service/Api/LicenseEndpoints.cs`, `Hosting/{LicenseService,LicenseConfig}.cs`, the `ProFeature` metadata on routes (`SettingsEndpoints`, `UsageEndpoints`, `WorkEndpoints`) + the 402 gate in `IngestServer`, the Pro check in `DailySummaryService`, `BuildDate` assembly metadata (used only by licensing), tests + `Fixtures/polar`, `hub-api.md` §License. The desktop has no license code yet.
- SignPath Foundation signs OSS for free (verified 2026-10-09, signpath.org/terms): OSI license without commercial dual-licensing, no proprietary components, the exact form already released, verifiable builds from source (CI), manual approval per release, MFA for all team members, defined roles, a "Code signing policy" section on the home and download pages crediting SignPath, a privacy policy, metadata restrictions (product name = project name), and a verifiable reputation for executables. So: first release unsigned (or with an own certificate), apply after it.
- A removed proprietary integration and the private source repos were named in the planning docs and are in the private git history; the code was clean (M0). Commercial material: `docs/legal/{eula,refund}*`, `docs/store-listing.md`, PRD §7/§12.
- The updater can be fed from the public repo's GitHub Releases (`latest.json` asset); no own server.

## Wave 1 (done 2026-10-08, kept unless noted)
- [x] Brand switch (`brand.json`, D-044) – kept
- [x] Licensing (hub, D-045) – superseded by D-047, removed in wave 2
- [x] Generated notices (D-046) – kept; legal drafts: privacy + trademarks kept, EULA + refund dropped

Wave 1 checks (2026-10-08): hub 725 + 228 + 76, Rust 521 + 67 + 11 + 3 + 1 + 1 + clippy, UI 738, e2e 33.

## Wave 2 (parallel)
- [x] Remove licensing (hub): the files and touchpoints above, `AGENTHUB_LICENSE_ENFORCE` / `AGENTHUB_POLAR_*`, the license stream event, `hub-api.md` §License; every feature free; tests green without license setup
- [x] Packaging + updater (Rust/scripts): `scripts/release.ps1 -Arch x64|arm64 [-Sign]`, hub sidecar for both triples (self-contained single file, native DLLs as separate files), fixtures excluded from the bundle, NSIS per-user EN + TR with a preinstall hook that stops the hub, `mainBinaryName`; `tauri-plugin-updater` (minisign public key in config, endpoint = `latest.json` on the public repo's latest release from `brand.json`), commands check/download/install; `scripts/sign.ps1` optional (local certificate by thumbprint, skipped with a warning when unset); Whisper.net win-arm64 check; unsigned x64 build verified locally
- [x] CI (GitHub Actions, `windows-latest` + ARM64 cross-build): PR/push workflow = hub, Rust + clippy, UI, e2e; release workflow on a `v*` tag = both installers + updater artifacts + `latest.json` uploaded to a draft release, updater key from a repo secret; signing step left as a hook for SignPath
- [x] Frontend: About (version, Apache-2.0, repo / issues / discussions links from `brand.json`, not-affiliated text, open-source licenses viewer, check for updates), update prompt + "check for updates on start" setting (default on); EN/TR, tests, e2e

Wave 2 checks (2026-10-09): hub 707 + 214 + 61, Rust 527 + 67 + 11 + 3 + 1 + 1 + clippy, UI 770, e2e 40; unsigned x64 installer 46 MB (hub, hook, adapters without fixtures, Whisper CPU + Vulkan runtimes). Found and fixed: the hub had no Whisper native runtime package (dictation could not load a model). Notices regenerated (364 crates, 137 npm, 23 NuGet). Decision D-048. Not run: installer, update from an older build, ARM64 build, packaged dictation (manual).

## Wave 3 – public repo preparation
- [x] Scrub: no proprietary-integration or private-repo references in the tree (AGENTS rule 1 = no proprietary code), EULA/refund/store listing deleted, PRD §7/§12 rewritten, privacy policy for the free app, About description lists all supported agents
- [x] Hygiene scan: no secrets; a real-looking corporate user name in Rust tests replaced (`alice`), captured-looking ids in the buddy fixture replaced, private artifact link removed, `.gitignore` guards (`.env*`, certificates, `*.db`, local Claude files)
- [x] Repo files: `LICENSE`, `NOTICE`, `README` (code signing policy section), `CONTRIBUTING`, `SECURITY.md`, issue + PR templates; no per-file license headers
- [x] Apply the final brand name **Kotilo** (D-049): `brand.json` (repo `kotilo-dev/kotilo`, legacy = working name), `tauri.conf.json`, icons from the robot-snail glyph, docs, backup/diagnostics names from the brand, brand guard extended. Migration of a real working-name install verified by the user
- [x] Checks: hub, Rust (+ clippy), UI, e2e green locally and in CI; CI release dry run produces both installers + `latest.json`; decisions D-047…; docs (user guide update section EN/TR, troubleshooting, manual tests: install + update from an older build, uninstall leaves agent configs clean, ARM64)

Wave 3 local checks (2026-10-11, after the brand switch): hub 707 + 214 + 61, Rust 527 + 67 + 11 + 3 + 1 + 1 + clippy, UI 770 (`ProjectsPage` "opens a todo file" failed once under load, passes alone), e2e 40; About screenshot shows the Kotilo icon, all-agents description and repo links. CI on GitHub (private repo, draft PR #1): first run found four machine-dependent tests (culture-dependent vocabulary dedupe – a real bug, a pooled connection broken by the 413 test, an AI test needing an installed agent CLI, a slow update-prompt e2e), a later run a flaky F1 e2e; all fixed, CI green (216201f). Release dry run (tag `v0.1.0` on the private repo): x64 48 MB + ARM64 39 MB installers, both `.sig` made with key `10C0FDD1B970F4AB`, `latest.json` with both platforms, draft release created. Install test by the user on that x64 build (2026-10-11): per-user install without admin, SmartScreen "Run anyway", working-name data migrated to `kotilo`, hook repair rewrote entries to `kotilo-hook.exe`, live Claude Code status, About 0.1.0, uninstall left agent configs clean. Dry-run release, tag and PR #1 deleted afterwards.

- [x] Create the public repo from the scrubbed tree as one initial commit (user approves first), push, first release `v0.1.0` (beta)

Public release (2026-10-11): repo `kotilo-dev/kotilo` (initial commit 11795a7 + README screenshots 4099704), CI green, tag `v0.1.0`, Release run green (x64 48 MB + ARM64 39 MB, `.sig` + `latest.json`), published as "Kotilo 0.1.0 (beta)" (unsigned, D-050); `releases/latest/download/latest.json` answers 200.

- [x] SignPath readiness (D-051): hook exe version resource, hub product version without commit hash, release script version check, README code signing policy with roles and the required statement
- [ ] SignPath Foundation application (user submits); after acceptance: GitHub integration, artifact configuration (5 own binaries, metadata enforced), signing step in `release.yml`, first signed release

## Needs the user (outside the repo)
- Register the `kotilo.dev` domain (GitHub org `kotilo-dev` created 2026-10-11; `kotilo-app` was taken); trademark check done 2026-10-11 (TMview: only an expired 2007 Finnish KOTILO in 20/35/36; TÜRKPATENT: only "Kotiloğulları" food marks, none in 9/42); enable Discussions and create the `bug`, `enhancement`, `new agent` labels
- Before v0.1.0: Claude Code plan limits need the status line helper (deferred since D-005, never built) – build it or keep the docs' "not shown yet"
- Updater key pair generated 2026-10-11 (private key in the user's profile, outside the repo; public key in `tauri.conf.json`); add the private key + password as repo secrets once the public repo exists
- Signing (D-050, decided 2026-10-11): `v0.1.0` ships unsigned as a beta; apply to SignPath Foundation right after it is published. Release notes must explain SmartScreen ("More info → Run anyway") and that Smart App Control blocks the unsigned build
- Launch posts (r/ClaudeAI, r/ChatGPTCoding, Show HN, X); manual desktop checks (M2 permission card, M2b D1–D14, M3 A1–A14 + P1–P3, M4-1…M4-13)
- Optional later: GitHub Sponsors, Microsoft Store free listing, winget manifest

---

# M4 – Mission control, timeline + diff, composer, split pane, design system (done 2026-10-08)

Goal (PRD §11, §5.1 Zaman akışı / Görev kontrol, §5.2 composer + split pane; DESIGN_SYSTEM §7.6–§7.10; mockups `docs/design/mockups/{Main,MissionControl}.dc.html`).
User decisions (2026-10-08): timeline lives in hub memory only; Mission control is a new page (Overview keeps stats, its session grid moves there); saved prompts may be stored in desktop settings (user-authored, an explicit rule-5 exception); of the optional items only the split pane is in M4 – custom title bar (§7.1), sidebar session cards (§7.2), Mica and the mascot move to a later phase.

## Findings that shape the plan
- **Rule-5 gaps today:** the sidecar does not scrub `tool_response` (nor Edit `old_string`/`new_string`, Write `content`) for claude-code and codex; with `AGENTHUB_DEBUG=1` the desktop writes whole payloads to `hooks.log`. Fixed first.
- No per-session tool log anywhere; `session_transitions` only records state changes. `SessionDto.currentTool` is cleared on PostToolUse; `tasks` are counts only (D-051).
- Tool events per agent: Pre+Post (claude-code, codex, qwen, droid, gemini), Post only (copilot, cursor), none (opencode plugin – extend if v2 exposes tool events). Qwen paths are in `absolute_path`.
- No git diff anywhere (desktop reads `.git/HEAD` only; hub `GitRunner` does `status --porcelain=v2`). Monaco diff exists for disk-vs-buffer (`ExternalChangeBanner`).
- Overview already has a limit strip + session grid (no preview, no filters); hidden terminals keep their xterm buffers (`terminalRegistry`).
- Composer building blocks exist: `fsQuickOpen` (@file), `clipboardSaveImage`, `ptyWrite`, bracketed-paste aware paste guard. Dictation has no in-app start/stop.
- Design debt is in the imported AgentDeck components (legacy `var(--color-*)` inline styles, `text-[10px]`, hard-coded scrims, non-reactive `strings` in 35 files, Turkish comments).

## Contracts

**Activity (hub, memory only – extends D-015):** per session a ring of the last 200 entries `{id, tool, kind: "read"|"edit"|"write"|"bash"|"search"|"task"|"other", target (path relative to the project when inside it, else command clipped to 200 chars), startedAt, durationMs?, status: "running"|"ok"|"failed"|"denied"}`; Pre/Post paired by `tool_use_id` when present, else FIFO by tool name; Post-only agents create completed entries. Turn markers from UserPromptSubmit (`{kind:"turn", at}`). Plan: Claude `TodoWrite` `tool_input.todos` → `{items:[{text, status: "pending"|"in_progress"|"completed"}]}` kept in memory only (text clipped to 200 chars). `GET /v1/sessions/{agent}/{id}/activity` → `{entries, plan|null}`; stream frame `activity` `{agent, sessionId, entries (delta), plan}` coalesced like other frames. Never SQLite, never logs; cleared when the session ends + 10 min.

**Changed files (desktop, git CLI, no libgit2):** `git_changes(workspaceId)` → `[{path, status: "M"|"A"|"D"|"R"|"?", added, removed}]` (`git -c core.quotepath=off diff --numstat -M HEAD` + untracked from `status --porcelain=v2 -z`, 5 s timeout, `GIT_OPTIONAL_LOCKS=0`), `git_show_head(workspaceId, path)` → HEAD content or null. Refresh on `fs:changed` (debounced). The timeline marks files the agent touched (activity targets) and shows the rest under "Other changes".

**Composer (per agent pane):** input with `@` file suggestions (fsQuickOpen), image paste → `clipboard_save_image` into `<workspace>/.agent-hub/attachments/` (gitignore hint) and an `@path` chip, mic button (dictation into the composer: new `dictation_start_composer(paneId)` / stop – text comes back as an event, never inserted via the OS), saved prompts (desktop settings `composer.savedPrompts[{id, title, text}]`, D-0xx rule-5 exception). Send = bracketed paste of the text into the pane PTY followed by Enter; Shift+Enter = newline in the composer; never steals keys from the terminal (§7.6).

**Mission control:** route `/mission` (Alt+ shortcut, nav rail item), header summary, segmented filter All / Needs you / Working / Done, limit strip (reuse `LimitMeter`), tile grid (§7.8) with live preview = last 5 non-blank lines of the pane's xterm buffer (plain text, read ~1/s only while the page is visible; external sessions show `lastNotification`/current tool instead). Tile click → workspace + pane. Preview text stays in the webview (rule 5).

**Split pane:** a terminal panel can show two panes side by side (drag a tab to the right half or "Split right" in the tab menu / header §7.3 split button); layout persisted in `state.json`; each half keeps its own header strip, permission card and composer.

## Wave 1 (parallel)
- [x] Privacy + activity (hub/crates): scrub `tool_response`, Edit/Write content, `MultiEdit` edits for claude-code and codex (keep `file_path`, `command`, `todos`); strip payloads from the desktop `hooks.log` (only agent/event/session/pane); hub activity ring + plan + API + stream frame; per-adapter target mapping (incl. Qwen `absolute_path`, Cursor `afterFileEdit`/`afterShellExecution`, Codex `apply_patch` paths when cheap); OpenCode plugin tool events if 2.0.x exposes them (verify in source); tests
- [x] Rust desktop: `git_changes`, `git_show_head` (+ tests with a temp repo), composer dictation start/stop (controller target "composer" emitting `dictation:composer {paneId, text}`), split-pane state in `state.json` if Rust owns layout persistence; tests
- [x] Design system cleanup (frontend, no features): legacy AgentDeck components onto tokens (HelpModal, QuickPick, TerminalView/Panel, AboutPanel, PdfView, ViewerTabStrip, ErrorBoundary, AgentsPanel, WorkspacesPanel/Tree), `--scrim` token, no text below 11 px, a type scale in `@theme` for the common arbitrary sizes, `useStrings()` everywhere, English comments in touched files; e2e screenshots before/after

Wave 1 checks (2026-10-08): hub 702 + 208 + 61, Rust 511 + 67 + 11 + 1 + 1 + clippy, UI 647, e2e 24. Decisions D-035…D-039. Smart App Control turned itself on mid-wave and blocked fresh rustc proc-macro DLLs; the user turned it off (M5 code signing is mandatory because of it).

## Wave 2 (parallel, frontend)
- [x] Mission control page (route, filters, limit strip, tiles, live preview, navigation), Overview keeps stats; EN/TR, tests, e2e
- [x] Timeline right rail in the workspace (§7.7): plan, activity (tool letter icons §5, running/failed/edit/read colours), changed files with `+n −m`, Monaco diff tab (HEAD vs working copy, read-only), turn markers; EN/TR, tests, e2e
- [x] Composer (§7.6) + saved prompts + composer dictation, and split pane (§7.3 split button, two panes side by side); EN/TR, tests, e2e

Wave 2 checks (2026-10-08): hub 702 + 208 + 61, Rust 516 + 67 + 11 + 1 + 1 + clippy, UI 737, e2e 33. Decisions D-040…D-043. Integration: timeline follows the focused split half, permission card capped to the pane height, shared e2e window globals in `e2e/globals.d.ts`.

## Wave 3 – checks
- [x] Hub, Rust (+ clippy), UI, e2e green; decisions D-035…; docs (`hub-api.md` activity, help EN/TR: mission control, timeline, composer, split pane); manual tests (composer dictation, split pane with two live agents, diff on a real repo)
- [x] Real app start; timeline with a live Claude Code / Codex session where possible without the user's desktop

Wave 3 (2026-10-08): docs EN/TR (user guide sections, Alt+1…9, keybindings, troubleshooting, hub-api note), manual tests M4-1…M4-13. Real app: rebuilt the stale hub binary (tauri dev does not rebuild it); live `/activity` for this Claude Code session returned paired Pre/Post entries with durations, a running Bash entry and a turn marker. Open: timeline toggle shortcut, manual checks M4-1…M4-13 on the user desktop.

## Later (recorded)
- Custom title bar with workspace tabs and limit badge (§7.1), sidebar session cards (§7.2), Mica, mascot surface; "changes since turn start" snapshots; OpenCode pane mapping.

---

# M3 – Other agents, custom agents, protocol, AI provider

Goal (PRD §11, §5.4, §5.5; ARCHITECTURE §3, §3a): Copilot CLI, Gemini CLI, Qwen Code, Factory Droid, OpenCode, Cursor CLI adapters; user-defined agents (`adapter.json`); Agent Integration Protocol v1; data-driven screen rules for hookless prompts; selectable AI provider (agent CLI or OpenAI-compatible endpoint).
Research (2026-10-06, sources + UNVERIFIED marks): `docs/research/agents-copilot-opencode.md`, `agents-gemini-qwen.md`, `agents-droid-cursor.md`. Only Copilot CLI 1.0.91 and OpenCode 2.0.22 are installed here; the other four are built from source/docs with synthetic fixtures (as Codex, D-011) and stay "unverified live" until a manual run.

## Findings that shape the plan
- `adapter.json` is never read at runtime; agent data is copied by hand into C# (`AdapterRegistry.Default`), Rust (`AgentKind`, `heuristic.rs`, Claude-only graceful close) and TS (`permissionKeys.ts`, `paneSession.ts`). → one source of truth first.
- No shared hook merger or usage-source abstraction; AI work is `claude -p` only (`BuddyService`).
- The hook command's shell differs per agent on Windows: cmd + unquoted (Codex, Qwen), cmd quoted (Droid), PowerShell `& '…'` (Gemini, Copilot `powershell` field), PowerShell or bash (Cursor).
- A silent hook (no stdout, exit 0) is not neutral everywhere: Cursor permission hooks block on empty stdout, Copilot `preToolUse` blocks on a crash, Qwen injects stdout into the model context. → per-agent event lists avoid blocking events; Cursor gets `{}` on stdout.
- **Risk today:** Cursor also runs the Claude hooks from `~/.claude/settings.json` (its `PreToolUse` becomes a permission hook). The sidecar must detect Cursor (`cursor_version` in the payload / `CURSOR_VERSION` env) on `--agent claude-code`, answer neutrally and drop the event.
- Payloads carry content (Gemini `prompt_response`, `details.newContent`; Qwen `last_assistant_message`; …) → per-agent scrub list in the sidecar (rule 5).
- The hub's own headless AI runs fire hooks too → the runner sets `AGENTHUB_INTERNAL=1` and the sidecar drops those events.
- Permission keys: only "allow once" and "deny" are stable everywhere; "always" is offered only where its key is fixed.
- OpenCode is v2 (`@opencode/cli`): plugin `export default {id, setup(ctx)}` in `~/.config/opencode/plugins/`, running in a shared background service (no per-tab env). `opencode.db` also holds login tokens → the reader selects named columns from `session_v2` / `project` only, read-only. v1 (`opencode-ai`) is not supported.
- Copilot tokens are only in `events.jsonl` `session.shutdown` (clean `/exit`); no plan quota on disk.
- Gemini hooks fire only in trusted folders and send nothing after a denied permission (needs a stale-wait fallback).

## Contracts

**adapter.json v1 (extended, backward compatible):** optional `hooks: { shell: "cmd"|"cmdUnquoted"|"powershell"|"any", events: string[] }` (informational), `screenRules: [{ id, state: "waitingPermission"|"waitingInput"|"working"|"done", pattern /*regex over the last N visible lines*/, lines?, clearOn?: "output"|"input" }]`, `usage: "none"|"builtIn"|"protocol"`. Built-in adapters ship as resources (Tauri `resources/adapters/**`; the hub reads them next to its exe); user adapters live in `%APPDATA%\agent-hub\adapters\<id>\adapter.json`. Built-in ids win; an invalid user file is reported (`GET /v1/adapters` → `{id, displayName, source: "builtIn"|"user", hooks, error?}`), never fatal.

**Agent Integration Protocol v1** (`schema/agent-protocol.v1.json`, `docs/agent-protocol.md`): `session-start {sessionId, cwd}`, `working`, `waiting-permission {tool, command?|path?, risk?}`, `waiting-input {question?}` (question not stored), `done`, `error {kind, message?}`, `session-end`, `usage {model, inputTokens, outputTokens, cachedTokens?, costUsd?}`. Transport: `agenthub-hook --agent <id> --event <event> [--session <id>] [--json <payload>]` or `POST /v1/events`. Unknown fields are ignored; `v` is checked.

**AI provider:** `IAiProvider { Id; CompleteAsync(AiRequest{system, user, model?, timeout}, ct) → AiResult{text?, errorKind} }`. Providers: `cli:<adapter id>` for installed agents with a verified headless command (tools off), and `openai:<name>` (`/v1/chat/completions`; base URL, model, optional key). The key lives in Windows Credential Manager (`Hub.Infrastructure/Platform`, target `agent-hub/ai/<name>`), never in settings or logs; the API returns only `hasKey`. Settings: `ai.providers[]` and per feature `ai.assistant | dailySummary | dictationCleanup = {provider, model}`; today's `"haiku"` settings migrate to `cli:claude-code`. "Fully local" badge when every feature uses a loopback `openai:` endpoint.

## Wave 1 – foundation (parallel)
- [x] Sidecar: `--json` / `--session`, protocol event names, per-agent scrub lists, `AGENTHUB_INTERNAL` drop, Cursor detection on claude-code hooks (neutral answer + drop), `{}` stdout mode for Cursor, BOM strip; tests
- [x] Hub adapter core: adapter.json loader (built-in + user, schema validation, errors), `GenericAdapter` (protocol → HookEvent), event kinds for waiting-input / error / usage, registry owned by `AppHost` (no static default in the parser), extracted `JsonHooksMerger` (Claude-style matcher groups / flat / Cursor `version` / own file; per-shell command form), `IUsageSource` + `UsageService` refactor (Claude and Codex unchanged), protocol `usage` → usage entries, per-agent limit stores; schema + protocol doc; tests
- [x] Desktop: load adapter definitions (bundled + user) and serve them to the UI; `AgentKind` → adapter id string; detection from `detect`, graceful close from `gracefulClose` for every agent; screen-rule engine (vt100 parser per agent pane, rules from adapter.json, feeds the heuristic state); tests
- [x] AI provider (hub): `IAiProvider`, `CliAiProvider` (Buddy runner generalised per agent, `AGENTHUB_INTERNAL=1`, scratch cwd), `OpenAiCompatibleProvider`, credential vault, settings + migration, Buddy / daily summary / dictation cleanup on providers, `POST /v1/ai/test`; tests with a fake HTTP server and a fake CLI

Wave 1 checks (2026-10-06): hub 500 + 160 + 58, Rust 489 + 58 + 11 + 1 + 1 + clippy, UI 587 (tsc green after aligning `AdapterDto` fixtures and making the integration card null-safe for protocol adapters). Decisions D-021…D-026. Open from wave 1: live check of the CLI AI answer formats and of Credential Manager; adapter fixtures are bundled with the resources (exclude before M5 packaging); Copilot hook commands must use `--agent copilot --event …` (the sidecar does not parse positional args).

## Wave 2 – adapters (parallel; each: adapter.json, fixtures, mapping, installer, usage, tests)
- [x] Copilot CLI: own file `~/.copilot/hooks/agenthub.json`, events per research (no `preToolUse`), usage from `session.shutdown`, limits unknown
- [x] Gemini CLI: `~/.gemini/settings.json` (JSONC), PowerShell command form, no model/transcript events, chat JSONL usage deduped by id, folder-trust hint, stale permission fallback
- [x] Qwen Code: `~/.qwen/settings.json`, unquoted cmd form, usage from `usageMetadata` only, context % from `Stop`
- [x] Factory Droid: `~/.factory/hooks.json` when it exists or `settings.json` has no `hooks` (otherwise merge into `settings.json`), delta-based usage from `*.settings.json` via `transcript_path`
- [x] OpenCode v2: plugin `adapters/opencode/plugin.js` → `~/.config/opencode/plugins/agenthub.js` (POSTs to the hub via `port.json`), pane mapping via process chain / `--session` (live check), usage from `session_v2` named columns only
- [x] Cursor CLI: `~/.cursor/hooks.json` observational events only + `{}` stdout, usage "no data", waiting-permission via a screen rule, dedupe double fires

Wave 2 checks (2026-10-06): hub 657 + 208 + 58, Rust 490 + 60 + 11 + 1 + 1 + clippy, UI 587, e2e 8. Decisions D-027…D-030. Carried to wave 3: `HookStatusDto.hint` UI strings (folderTrust, hooksDisabled); permission keys and OpenCode `Enter` move from the `permissionKeys.ts` mirror to definitions + `pane_send_keys`; OpenCode v1/v2 detection needs an exe-path `detect` field; OpenCode pane mapping (tui plugin or `--session`) is a follow-up. Manual live list per agent: see the wave reports in D-027…D-030.

## Wave 3 – UI
- [x] Agent identity, permission keys, launch menu and pane header from adapter definitions (no hard-coded lists); Settings → Agents: integration cards for every adapter (folder-trust / needs-approval hints), user adapters with their errors
- [x] "Add custom agent" wizard (command, detection, keys, screen rules, protocol snippet to copy) with validation; writes the user adapter file through a desktop command
- [x] Settings → AI: providers (add OpenAI-compatible: base URL, model, key → vault), per-feature selection, Test button, fully-local badge; EN + TR; help docs
- [x] Unit tests + e2e screenshots (dark/light, EN/TR)

Wave 3 checks (2026-10-06): hub 657 + 208 + 58, Rust 498 + 60 + 11 + 1 + 1 + clippy, UI 644, e2e 22 (screens: settings-agents-*, settings-agents-wizard-rules-*, workspace-cursor-permission-*, settings-ai-*). Decisions D-031…D-033. Fixed on the way: a user adapter with `hooks: null` broke the desktop `hooks_status` (hub client). Follow-ups: agent header strip wraps in narrow panes; `agentDisplayName` outside React does not re-render when definitions load late; "Load models" before saving an endpoint; e2e port collision when two runs overlap.

## Wave 4 – checks
- [x] Hub, Rust (+ clippy), UI, e2e green; D-021… in `docs/DECISIONS.md`; `docs/hub-api.md`, `docs/agent-protocol.md`, manual test list per agent
- [x] Live checks here (2026-10-06): real app start (`tauri dev`) – all 8 adapters load without errors, hub stream connects, desktop log clean; AI provider test against every installed CLI (claude-code, codex, copilot ok; gemini, qwen not signed in → `notLoggedIn`; opencode free Console tier refuses headless runs). Found and fixed: spool replay raised stale notifications (D-034); Qwen "no auth type" mapped to `notLoggedIn`. Hook installs into the real `~/.copilot` / OpenCode plugin folder are left to the user (manual A1–A5).
- [ ] Manual checks for the user: each installed agent live in the app (state, permission card, usage); Cursor ↔ Claude hook interaction if Cursor gets installed

---

# M2b – Live dictation

Goal (PRD §5 Dikte, CCC spec §22): global hotkey → microphone → local Whisper → text into the field that had focus (and/or clipboard/file), with a non-activating overlay. Same behaviour as CCC (`ClaudeCodeControlCenter/src/Ccc.App/Hosting/DictationController.cs`, `Services/{AudioRecorder,TextInjector}.cs`, `Views/DictationOverlay.xaml`).
Split (D-020): the desktop app (Rust) owns hotkeys, microphone, overlay window, sounds and text insertion; the hub owns Whisper, transcript cleanup, AI cleanup, file output and history. Dictation needs the desktop app running.

## Contracts

**Hub** (all under the token, `docs/hub-api.md`):
- `POST /v1/dictation/preload` → `202`; loads the selected model in the background. `409 {error:"modelMissing"}` when the selected model is not installed (checked before recording starts).
- `POST /v1/dictation/transcribe` – body `application/octet-stream`: little-endian f32 mono samples at 16 kHz (already downmixed/resampled by the desktop). Size limit `MaxMinutes(≤30)·60·16000·4` + 1 s; this route only. Hub: `TrimSilence`; speech < 0.3 s → `{status:"noSpeech"}`; `PadTo(1.2 s)`; Whisper with the settings' model, language, vocabulary prompt, GPU; `CleanTranscript`; empty → `noSpeech`. `200 {status:"ok"|"noSpeech"|"cancelled", rawText, speechSeconds, model, language}`; `409 modelMissing`. Audio is never written anywhere.
- `POST /v1/dictation/cleanup` `{text}` → `200 {finalText, cleaned, note: null|"cleanupFailed"}` (AI cleanup with the settings' mode/custom prompt/vocabulary/model, 60 s timeout; raw text back on failure; `cleaned:false` when AI cleanup is off).
- `POST /v1/dictation/cancel` → `204`; cancels the transcription/cleanup in flight (that request answers `{status:"cancelled"}` / raw text).
- `POST /v1/dictations` `{durationSeconds, rawText, finalText, cleaned, outputs: ("type"|"clipboard")[]}` → hub appends to the file when `outputFile` is on (adds `"file"`), saves history when `keepHistory` (mode only when cleaned; model/language from settings) → `200 {id: number|null, outputs, fileError: string|null}`.
- Model unload after 10 min idle (as CCC).

**Desktop events/commands:**
- Tauri event `dictation:overlay` → overlay window: `{ phase: "hidden"|"recording"|"transcribing"|"cleaning"|"result", mode: "undecided"|"hold"|"toggle", elapsedMs, level /*0..1 RMS*/, result: null | { ok: boolean, message: DictationMessage }, sound: null|"start"|"stop"|"error" }`.
  `DictationMessage` = `"inserted"|"done"|"cancelled"|"noSpeech"|"silent"|"noMicrophone"|"modelMissing"|"cleanupFailed"|"elevatedTarget"|"noTarget"|"fileFailed"|"hubUnavailable"|"failed"`.
- Tauri event `dictation:done` `{ id: number|null }` (Dictation screen refreshes history).
- Commands: `dictation_reload()` (re-read hub settings, re-register hotkeys; called on hub connect and after Settings save), `dictation_cancel()` (overlay ✕), `dictation_status()` → `{ enabled, hotkey: {gesture, error: null|"invalid"|"taken"}, pasteLastHotkey: {…}, phase }`.
- Overlay window: label `dictation-overlay`, URL `index.html?view=dictation-overlay`, 380×58, no decorations, transparent, always on top, not in taskbar/Alt-Tab, never activates (WS_EX_NOACTIVATE + show without activation), bottom-centre of the target window's monitor work area, 28 px above the bottom.

## Wave 1 (parallel)
- [x] Hub: the routes above, per-route body limit, cancel, idle unload, tests (fake transcriber), `docs/hub-api.md` (hub 394 + 103 + 50)
- [x] Rust core (no cfg): hotkey gesture parser (same format as `Hub.Core/Buddy/HotkeyGesture.cs`), hold-to-talk (350 ms), downmix + resample to 16 kHz + RMS, controller state machine over platform/hub traits (start, hold/toggle stop, Esc/✕ cancel, max minutes, silent/no-speech, outputs, paste last); tests with fakes
- [x] Rust platform (Windows): RegisterHotKey thread + GetAsyncKeyState polling, temporary Esc hotkey, microphone via cpal (WASAPI shared, default device), target window + elevation check + focus, SendInput paste (Shift+Insert for terminal classes, Ctrl+V otherwise) with full clipboard save/restore + history exclusion, Unicode typing, overlay window styles/position
- [x] Frontend: overlay view (dot/spinner/icon, 18 level bars, timer, texts EN/TR, ✕, auto-hide 1.6 s / 4.5 s), (sound cues: Rust plays them natively; the view ignores `sound`), Dictation screen hotkey status + history refresh, Settings save → `dictation_reload`; tests + e2e screenshots of overlay states

## Wave 2
- [x] Build/test everything: hub 394 + 103 + 50, Rust 460 + 35 + 10 + 1 + 1 + clippy, UI 587, e2e 8 (overlay screenshots dark + light); help docs (EN/TR) and keybindings updated; manual test list in `docs/manual-tests.md`
- [x] D-020 in `docs/DECISIONS.md`
- [x] Real app start (a `tauri dev` run, 18:54): dictation starts, settings reload after the hub stream connects, no hotkey registration warnings, the app exits cleanly with the hidden overlay
- [ ] Manual tests D1–D14 on the real desktop (hotkey, microphone, insertion into Notepad / Windows Terminal / an elevated window) – needs the user, AGENTS rule 6


---

# M2 – UI merge (done)

Goal (PRD §11): CCC screens in React (Overview, Usage, Reports, Tasks, Dictation, Settings), agent header strip, permission card – on the DESIGN_SYSTEM tokens, EN + TR.
M0/M1 are done (commits `07ef55c`, `78e7c0d`, `3d02699`); decisions D-001…D-013. Antigravity stays post-v1 (user decision 2026-10-04).
References: `DESIGN_SYSTEM.md`, mockups in `docs/design/mockups/` (Main = agent workspace, Permission, MissionControl), CCC screen designs `ClaudeCodeControlCenter/docs/design/screens/*.dc.html` + spec §12, §18, §21, §22 (read-only source).

## Contracts

**Desktop ↔ hub:** the token never reaches the webview. Rust exposes
- `hub_request(method, path, body?)` → JSON (only paths under `/v1/`; GET/POST/PUT/DELETE), errors map to `hub_unavailable` / hub status;
- Tauri events from one WebSocket to `GET /v1/stream`: `hub:status` `{connected}`, `hub:event` `{type, data}`.

**Stream messages** (`/v1/stream`, JSON text frames `{ "type", "data" }`; full snapshot on connect, then on change):
`sessions` (as `/v1/sessions`, plus `pendingPermission`), `usage` (as `/v1/usage/current`), `limits` (`[{agent, window: "fiveHour"|"weekly", usedPercent, resetsAt}]`), `notification` (`{ruleId, agent, sessionId, paneId?, title, body, severity}`), `health` (as `/v1/health`).

**Pending permission** (in memory only, never DB/log): `{ tool, command?, path?, risk?: "deletesFiles"|"writesDatabase"|"network"|"installsPackages"|"gitPush"|"other", since }`.

**Permission keys** (adapter.json `permissionKeys`, sent to the pane PTY):
- Codex (verified in `codex-rs/tui/src/keymap.rs` defaults, 0.160.0): allow once `y`, always for this command prefix `p` (only when offered), deny `Esc` (“No, and tell Codex what to do differently”).
- Claude Code (verified live, v2.1.289, in our own PTY): `1` = “Yes” (runs at once), `2` = the “Yes, and always allow …” option (its text varies), `Esc` = cancel. The option list length varies (3–4), so only 1, 2 and Esc are used.

Full REST list is written by the hub work into `docs/hub-api.md` together with TS types in `apps/desktop/src/lib/hubTypes.ts`.

## Wave 1 (parallel)
- [x] Hub: `/v1/stream` WebSocket, REST for screens (usage daily/blocks/breakdown incl. agent, reports: waits/cost/daily summary + CSV/XLSX export, projects + todo progress, personal tasks CRUD, dictation history list/delete/clear + model status, hub settings GET/PUT, limits), pending permission + risk classifier, notifications on the stream; `docs/hub-api.md`, `hubTypes.ts`
- [x] Frontend foundation: DESIGN_SYSTEM tokens (Tailwind 4 `@theme`, dark default, light `[data-theme="light"]`), bundled Geist + Geist Mono (OFL), terminal theme §8, i18n (EN + TR, language setting, existing strings moved), app shell with nav rail and empty routes
- [x] Rust: hub stream client (reconnect, port.json re-read), `hub_request` command, events

Wave 1 checks: hub 394 + 103 + 29, Rust 430 + 35 + 10 + 2, UI 476 tests green. One UI test (`ErrorBoundary` "Collect diagnostics") failed once under full-suite load and passed in every rerun – watch for flakiness.

## Wave 2 (parallel, after wave 1)
- [x] Screens A: Overview, Usage (charts), Reports (daily summary, waits, cost + export)
- [x] Screens B: Projects, Tasks (personal tasks CRUD + quick add), Dictation (history, models, settings), Settings (app + hub rules, quiet hours, agent integrations per adapter incl. Codex “approve in /hooks”)
- [x] Workspace: agent header strip (§7.3), pane frame states (§7.4), permission card (§7.5) with key sending + result strip; Claude Code keys verified live
- [x] Notifications: hub rule engine is the decider, desktop shows toasts (single owner), suppressed when the agent's pane is visible and focused

## Wave 3
- [x] Playwright against the Vite dev server with a fake hub: screenshots of every screen (dark + light, EN + TR)
- [x] All builds/tests green (hub 394 + 103 + 29, Rust 431 + 35 + 10 + 2, UI 560, e2e 6 with 34 screenshots); D-014…D-019

## Wave 4 – M2 close-out
- [x] Real app (`tauri dev`): window opens with the nav rail, supervisor starts the hub from `hub/Hub.Service/bin/Debug`, stream connects, `/v1/health` answers (hooks "Missing" on this machine is expected – not installed)
- [ ] Permission card keys against a live agent in the real app – needs the user at the desktop (install the integration, run an agent, answer a prompt from the card)
- [x] Hub validation `fields` pass through `hub_request` (`AppError.fields`); Settings marks the rejected field and flags its section until the next edit
- [x] Nav badge for today/overdue tasks: stream type `tasks` `{today, overdue}` (resent on task writes and when the clock changes a due state, checked once a minute)
- [x] `ProjectDto.alias` separate from `name`; the editor edits the alias, folder name as placeholder
- [x] In-app help docs updated to M2 and in Turkish (`apps/desktop/docs/tr/`), Help follows the UI language
- [x] Checks: hub 394 + 103 + 30, Rust 432 + 35 + 10 + 1 + 1 + clippy, UI 571, e2e 6 (34 screenshots, badge visible)

## Open after M2
- [ ] Daily summary generation needs the AI provider (M3)

## Deferred (recorded)
- Live dictation – M2b (above)
- Mission control, timeline + diff, composer – M4
