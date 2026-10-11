# Contributing to Kotilo

Thanks for helping. Kotilo is a volunteer-run open-source project, and the most valuable contributions are usually bug reports with clear steps, fixes, and support for new agents (most of which is data: an `adapter.json`, fixtures and tests).

Questions and ideas: [GitHub Discussions](https://github.com/kotilo-dev/kotilo/discussions). Bugs and feature requests: [GitHub Issues](https://github.com/kotilo-dev/kotilo/issues). Security issues: **do not open a public issue**, see [SECURITY.md](SECURITY.md).

## Setup

Prerequisites (Windows 11, x64 or ARM64):

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Rust](https://rustup.rs/) stable with the MSVC toolchain (`rustup component add clippy`)
- [Node.js](https://nodejs.org/) LTS
- Git

```sh
git clone https://github.com/kotilo-dev/kotilo.git
cd kotilo
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build   # before the first cargo build, see below
```

Run the UI build before the first `cargo build`: `tauri::generate_context!` needs `apps/desktop/dist` to exist.

## Build and test

| Area | Build | Test |
|---|---|---|
| Hub (.NET 10) | `dotnet build hub/AgentHub.sln` | `dotnet test hub/AgentHub.sln` |
| Rust | `cargo build --workspace` | `cargo test --workspace` |
| UI | `npm --prefix apps/desktop run build` | `npm --prefix apps/desktop test` |
| App | `npm --prefix apps/desktop run tauri dev` | `npm --prefix apps/desktop run e2e` |

- Lint Rust with `cargo clippy --workspace --all-targets -- -D warnings`. CI fails on any warning; the .NET build treats warnings as errors too.
- The e2e suite runs Playwright against the Vite dev server in `--mode e2e` with mocked IPC and a fake hub. Install the browser once with `npx playwright install chromium` (in `apps/desktop`). Screenshots land in `apps/desktop/test-results/screens/`.
- CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of the above on `windows-latest` for every pull request.

Some technical names still use the project's original working name (`agenthub-hook`, `AGENTHUB_*` environment variables, `hub/AgentHub.sln`, crate names). They are protocol and build names, kept stable on purpose; please don't rename them in a drive-by change.

## Hard rules

These are not style preferences. A pull request that breaks one of them will not be merged.

1. **No vendor branding.** The product name, logo, icons, package identity and domain must not contain an agent vendor's name or logo. Plain-text compatibility statements ("works with Claude Code") are fine.
2. **Never touch credentials.** No code may read, copy, store or transmit any agent's login or token files (OAuth tokens, API key files, credential stores of the agents). AI features run the user's own installed, unmodified agent CLI, or an endpoint the user configured. Kotilo's own AI provider keys go only into the platform credential vault (Windows Credential Manager), never into settings files or logs.
3. **Agent config files belong to the user.** Write them only through backup-first mergers; never rewrite a file that is not valid JSON/TOML; only add or remove entries Kotilo owns (identified by the hook sidecar command). Tests use temporary directories, never the real `~/.claude`, `~/.codex`, ….
4. **No transcript content at rest.** Prompts, responses and dictated audio are never written to the database or logs; only counts and metadata. The hook sidecar strips content fields before anything leaves it.
5. **No global input in automated tests.** Tests and scripts must not send hotkeys, keystrokes, clipboard pastes or sounds to the live desktop. Use UIA/Playwright against Kotilo's own windows and silent harnesses for audio/Whisper. If a check needs the real desktop, describe it as a manual test instead.
6. **Platform code stays in the platform layer.** `#[cfg(...)]` and `OperatingSystem.Is…()` belong only in platform-layer files; core logic must build and test on Windows and macOS.
7. **No proprietary or employer-internal code.** Only contribute code you have the right to release under Apache-2.0. Do not add integrations for private, company-internal tools or models; local and private models are supported generically through OpenAI-compatible endpoints and user-defined adapters.
8. **Third-party code:** a new dependency must have a license compatible with Apache-2.0 distribution (permissive or MPL-2.0; no GPL, LGPL or AGPL in shipped code). Regenerate `THIRD_PARTY_NOTICES` with `scripts/notices/generate-notices.ps1`.

## Workflow

- **Open an issue first** for anything larger than a small fix (new feature, new agent, refactor, dependency), so we can agree on the approach before you spend time on it.
- **Keep pull requests small** and focused on one change. Match the surrounding code's style and comment density; prefer the simplest working solution.
- **Tests next to behavior.** Every parser, state mapping and config merger has fixture-based tests. Bug fixes come with a test that fails without the fix.
- **UI changes:** include a screenshot (the e2e suite can produce one). User-facing strings go through the i18n files (English and Turkish), never hard-coded in components; colors use design tokens only (see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)).
- **Languages:** code, identifiers, comments and commit messages in English.
- **Commits:** an imperative summary line, then a body with what and why.
- Record non-obvious design decisions in [docs/DECISIONS.md](docs/DECISIONS.md).

### Coding conventions

- **C#:** .NET 10, nullable enabled, warnings as errors, file-scoped namespaces, records for data, `TimeProvider` for time, no static mutable state in Hub.Core.
- **Rust:** stable, `clippy -D warnings`, `thiserror` for errors, no `unwrap()` outside tests, platform code behind traits.
- **TypeScript/React:** strict mode, function components, Zustand stores, Tailwind with design tokens.

### License of contributions

Kotilo is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is licensed under the same license (inbound = outbound, as in section 5 of the license). No CLA and no DCO sign-off are required.

## Adding an agent

There are two ways to support another agent CLI.

### 1. A user-defined agent (no code)

Any agent can be added locally without changing Kotilo: an `adapter.json` in `%APPDATA%\kotilo\adapters\<id>\` (or through **Settings → Agents → Add custom agent**). The agent then reports its state with the hook sidecar or by HTTP, using the [Agent Integration Protocol](docs/agent-protocol.md) (`session-start`, `working`, `waiting-permission`, `waiting-input`, `done`, `error`, `session-end`, optional `usage`), and/or Kotilo detects prompts on screen with `screenRules`. Start here if you only need it for yourself, or to try out an agent before proposing built-in support.

### 2. A built-in agent

Built-in support ships with Kotilo and installs the agent's hooks for the user. Please open a "New agent support" issue first. An agent counts as supported when all of the following hold (PRD §5.4):

1. **Detection:** when installed, the agent is detected and can be launched in a terminal.
2. **Hook / plugin install:** one-click install and uninstall, backup-first, never touching the user's own entries.
3. **State mapping:** at least Working vs. Done is right; WaitingPermission / WaitingInput too, when the agent signals them.
4. **Project mapping:** a session is linked to the right project and, when started in Kotilo, the right terminal tab.
5. **Usage:** if the agent writes token data, cost is computed from it; if not, the adapter says `"usage": "none"` and the UI shows "no data". Never invent numbers.
6. **Fixtures and tests:** unit tests based on real, scrubbed recordings (no personal data, no prompt text).

**Re-verify every path, event name and payload field against the vendor's current documentation** (and, ideally, a live install) before writing code. Do not guess; if something cannot be verified, leave it out and say so in the pull request.

What to add:

**`adapters/<id>/adapter.json`**, validated against [`schema/adapter.v1.json`](schema/adapter.v1.json). The id must match `^[a-z0-9][a-z0-9-]*$` and the folder name.

| Field | Required | Meaning |
|---|---|---|
| `v` | yes | Always `1`. |
| `id`, `displayName` | yes | Stable id and the name shown in the UI. |
| `avatar` | yes | `letter` (one character), `bg` and `ink` (`#rrggbb`). |
| `detect` | yes | `executables` (e.g. `["foo.exe", "foo"]`) and/or `nodeScripts` (a path fragment of the agent's npm package, e.g. `@vendor/foo-cli`) to recognize it in a terminal and tell whether it is installed. |
| `launch` | yes | `command` and `args` that **New agent** runs. |
| `gracefulClose` | no | Key steps (`keys`, `repeat`, `gapMs`, `waitMs`) that let the agent exit cleanly before its process tree is killed. |
| `permissionKeys` | no | Keys the agent's own permission prompt accepts: `allowOnce`, `alwaysAllow`, `deny` (e.g. `"1"`, `"y"`, `"Esc"`, `"Enter"`). Without them the card only offers "Answer in terminal". |
| `hooks` | no | Informational: the Windows hook command form the agent needs (`shell`: `cmd`, `cmdUnquoted`, `powershell`, `any`) and the `events` Kotilo registers. The hub's installer is the source of truth. |
| `usage` | no | `builtIn` (a hub reader for the agent's own files), `protocol` (protocol `usage` events) or `none`. |
| `screenRules` | no | Regex rules over the last `lines` of the terminal screen that set `waitingPermission`, `waitingInput`, `working` or `done` for prompts the agent has no hook for (`clearOn`: `output` or `input`). No lookaround or backreferences. |

Look at the existing adapters (`adapters/claude-code`, `adapters/codex`, `adapters/cursor`, …) for real examples.

**The code half, in the hub** ([`hub/Hub.Infrastructure/Adapters/BuiltInAdapters.cs`](hub/Hub.Infrastructure/Adapters/BuiltInAdapters.cs) lists them):

- An `IAgentAdapter` in `hub/Hub.Core/Adapters/` that maps the agent's raw hook payloads to normalized events (state mapping, session id, project folder), and its id in `AgentIds`.
- A hook installer in `hub/Hub.Infrastructure/<Agent>/`: usually built on the shared `JsonHooksMerger` (`hub/Hub.Infrastructure/Hooks/`), or its own `IHookInstaller` for a plugin folder or a different format. Backup first, refuse invalid files, idempotent install, uninstall removes only Kotilo's entries.
- An `IUsageSource` that reads the agent's own token/usage files incrementally, or none (and `"usage": "none"`).
- **Content scrubbing in the hook sidecar:** if the agent's payloads carry prompt, response, tool output or file content in fields not yet covered, add them to the per-agent content fields in [`crates/hook/src/lib.rs`](crates/hook/src/lib.rs). Nothing with conversation text may reach the hub.
- The desktop side keeps small per-agent lists (agent kind in `apps/desktop/src-tauri/src/agents/`, identity and i18n strings in `apps/desktop/src/app/`); search for an existing agent id such as `qwen` to find every place.

**Fixtures and tests:**

- Scrubbed sample hook payloads, settings files and usage/session files in `adapters/<id>/fixtures/` or `hub/tests/Hub.Core.Tests/Fixtures/<id>/`.
- Adapter mapping tests (`hub/tests/Hub.Core.Tests/<Agent>AdapterTests.cs`), installer tests against a temporary directory (install, reinstall, uninstall, existing user hooks preserved, invalid file refused) and usage parser tests (`hub/tests/Hub.Infrastructure.Tests/`).
- Sidecar tests for any new content fields.

**Docs:** add the agent to the supported agents table in the in-app user guide (`apps/desktop/docs/user-guide.md` and the Turkish translation in `apps/desktop/docs/tr/`) and in [README.md](README.md), including its known limits.
