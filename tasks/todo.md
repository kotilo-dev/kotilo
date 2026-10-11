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

- [ ] Create the public repo from the scrubbed tree as one initial commit (user approves first), push, first release `v0.1.0` (beta)

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
