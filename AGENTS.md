# AGENTS.md – working on Kotilo

Instructions for AI coding agents (Claude Code, Codex, Copilot, …) and humans working in this repository. Read this first, then `PRD.md`, `ARCHITECTURE.md` and `DESIGN_SYSTEM.md`. User-facing overview: `README.md`; contributor guide: `CONTRIBUTING.md`.

## What this is

**Kotilo** – a Windows-first (macOS later), free and open-source (Apache-2.0) desktop workspace for AI coding agents: real terminals plus live agent status, permission handling, usage/cost/limits, tasks and dictation. It grew out of two earlier private prototypes:

- **AgentDeck** → `apps/desktop` (Tauri 2: Rust + React/TS).
- **Claude Control Center** → `hub/` (.NET 10 headless service).

Internal names (`agent-hub` folder, `AgentHub.sln`, `agenthub-*` crates, `AGENTHUB_*` env vars) stay from the working name; product identity comes from `brand.json` (D-044). Status: see `tasks/todo.md`.

## Hard rules

1. **No proprietary code.** Never port, reference or support employer-internal, proprietary or closed-source code or integrations. Everything here must be publishable under Apache-2.0.
2. **No vendor branding.** The product name, logo, icons, package identity and domain must not contain "Claude", "Anthropic" or any other agent vendor's name or logo. Plain-text compatibility statements ("works with Claude Code") are fine.
3. **Never touch credentials.** Do not read, copy, store or transmit any agent's login or token files (`~/.claude/.credentials.json`, OAuth tokens, API key files). AI features run the user's own installed, unmodified agent CLI headless.
4. **Agent config files are the user's.** Write only through backup-first mergers; never rewrite invalid JSON/TOML; only add/remove entries this product owns (identified by the brand hook marker `<exePrefix>-hook`, today `kotilo-hook`, plus the legacy markers in `brand.json`). Tests use temp directories, never the real `~/.claude`, `~/.codex`, ….
5. **No transcript content at rest.** Prompts, responses and dictated audio are never written to the database or logs; only counts and metadata.
6. **No global input in automated tests.** Do not send hotkeys, keystrokes, clipboard pastes or sounds to the live desktop from tests or scripts. Use UIA/Playwright against our own windows, and silent harnesses for audio/Whisper. If a check needs the real desktop, ask the user to run it.
7. **Platform code stays in the platform layer.** `#[cfg(...)]` / `OperatingSystem.Is…()` only in platform-layer files; core logic must build and test on Windows and macOS.

## Layout (target)

```
apps/desktop/      Tauri app – src/ (React), src-tauri/ (Rust core + platform layer)
crates/hook/       agenthub-hook sidecar (Rust)
crates/proto/      shared types generated from schema/
hub/               Hub.Core, Hub.Infrastructure, Hub.Service, Hub.Contracts, tests/
adapters/<id>/     adapter.json + fixtures (+ OpenCode plugin)
schema/            JSON Schemas (hook envelope, hub API)
docs/              user guide, DECISIONS.md, manual tests
tasks/todo.md      current phase plan with checkboxes
```

## Commands

| Area | Build | Test |
|---|---|---|
| Hub (.NET 10) | `dotnet build hub/AgentHub.sln` | `dotnet test hub/AgentHub.sln` |
| Rust | `cargo build --workspace` | `cargo test --workspace` |
| UI | `npm --prefix apps/desktop run build` | `npm --prefix apps/desktop test` |
| App | `npm --prefix apps/desktop run tauri dev` | `npm --prefix apps/desktop run e2e` (Playwright, Vite `--mode e2e`, mocked IPC + fake hub; screenshots in `apps/desktop/test-results/screens/`) |

Run the UI build before the first `cargo build`: `tauri::generate_context!` needs `apps/desktop/dist` to exist. Clippy runs with `cargo clippy --workspace --all-targets -- -D warnings`.

Windows PATH note: if `dotnet`, `cargo`, `node` or `git` are not on the agent shell's PATH, use their install folders directly (see the user's dev notes).

## Workflow

- Work in phases (M0…M6, `PRD.md` §11). At the start of a phase write a checkbox plan in `tasks/todo.md`; tick items as they are verified.
- Record non-obvious decisions in `docs/DECISIONS.md` as `D-001 …` (context, decision, consequence).
- Extensibility is data-only in v1: user adapters (`adapter.json`), the Agent Integration Protocol and OpenAI-compatible AI providers (`PRD.md` §5.5, `ARCHITECTURE.md` §3a). No code plugins. Keep the protocol schema versioned and backward compatible.
- Never store an AI provider key in settings or logs; use the platform credential vault.
- New agent support = an adapter that meets `PRD.md` §5.4: detection, backup-first hook install/uninstall, state mapping, project mapping, usage parsing (or explicit "no data"), fixtures + tests. Re-verify paths/event names against the vendor's current docs; never guess.
- Prefer the simplest working solution; match the surrounding code's style and comment density.
- Before calling something done: build, run the relevant tests, and for UI changes look at it (Playwright screenshot against the dev server). Report failures honestly.
- Commit only when asked. Messages: imperative summary line, body with what/why.

## Conventions

- **Languages:** code, identifiers, comments and commit messages in English. Planning docs may be Turkish. UI strings English (default) + Turkish, never hard-coded in components.
- **C#:** .NET 10, nullable enabled, warnings as errors, file-scoped namespaces, records for data, `TimeProvider` for time, no static mutable state in Core.
- **Rust:** stable, `clippy -D warnings`, `thiserror` for errors, no `unwrap()` outside tests, platform code behind traits.
- **TypeScript/React:** strict mode, function components, Zustand stores, Tailwind with design tokens only (no raw hex in components – see `DESIGN_SYSTEM.md`).
- **Tests next to behavior:** every parser, state mapping and config merger has fixture-based tests.
- **Third-party code:** add its license to `THIRD_PARTY_NOTICES` when adding a dependency.
