/**
 * Browser e2e mode (`vite --mode e2e`, loaded before main.tsx by vite.config.ts): replaces the
 * Tauri backend with `@tauri-apps/api/mocks` and answers hub routes from `fixtures.ts`.
 * URL params: `theme=dark|light`, `lang=en|tr`, `colorTheme=<catalogue id>` (D-057: used as both
 * the dark and the light colour theme). `window.__e2e.emit(type, data)` pushes a
 * hub stream frame. Never part of a real build.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS } from "../stores/settingsStore";
import * as fx from "./fixtures";
import * as agentFx from "./agentFixtures";
import * as composerFx from "./composerFixtures";
import * as timelineFx from "./timelineFixtures";
import * as watchFx from "./watchFixtures";
import * as assistantFx from "./assistantFixtures";
import * as themeFx from "./themeFixtures";
import * as worktreeFx from "./worktreeFixtures";
import * as docsFx from "./docsFixtures";
import * as contextFx from "./contextFixtures";

declare global {
  interface Window {
    /** D-068: every `clipboard_write_text` in order. */
    __e2eClipboard: string[];
    /** Every `open_external_url` in order. */
    __e2eOpenedUrls: string[];
    /** D-072: what the webview hands the Kotilo Deck client, and keys sent to panes. */
    __e2eCompanion: { agents: unknown[]; usage: unknown[]; sent: unknown[]; keys: { paneId: string; keys: string }[] };
    /** D-075: the tray menus (item texts, "---" for separators) and tooltips in order. */
    __e2eTray: { menus: string[][]; tooltips: string[] };
    /** What the mocked `pick_files` dialog returns (absolute paths); unset → cancelled. */
    __e2ePickedFiles?: string[];
  }
}
window.__e2eTray = { menus: [], tooltips: [] };
window.__e2eClipboard = [];
window.__e2eOpenedUrls = [];
window.__e2eCompanion = { agents: [], usage: [], sent: [], keys: [] };

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const language = params.get("lang") === "tr" ? "tr" : "en";
const colorTheme = params.get("colorTheme");
const appearance = colorTheme ? { darkTheme: colorTheme, lightTheme: colorTheme } : DEFAULT_SETTINGS.appearance;
// `ai=local`: Settings → AI with every feature on the local endpoint ("Fully local").
const aiLocal = params.get("ai") === "local";
// `watch=1`: a force-push hit on the waiting Codex permission and on Claude timeline entries.
const watchHits = params.get("watch") === "1";
const hubSessions = watchFx.withWatchSessions(fx.sessions, watchHits);
// `deck=connected`: the Kotilo Deck client reports a connected deck 1.0.1 (D-072).
const deckConnected = params.get("deck") === "connected";
// `restore=agent`: the workspace comes back with a restored (not yet started) Claude tab.
const restoreAgent = params.get("restore") === "agent";
/** U-3: `?platform=macos` (or `linux`) makes `app_info` report that OS with the extras off. */
const platform = params.get("platform") === "macos" ? "macos" : params.get("platform") === "linux" ? "linux" : "windows";
const offWindows = {
  globalHotkeys: false,
  dictation: false,
  mascot: false,
  awaySummary: false,
  bundledConpty: false,
  windowsTerminalSchemes: false,
  windowAcrylic: false,
};
const restoredTerminals = {
  "ws-demo": { tabs: [{ title: "claude", titleEdited: false, profileId: "pwsh", cwdRel: "", agentCommand: "claude" }], activeIndex: 0 },
};

const workspace = { id: "ws-demo", name: "orders-service", path: "C:\\src\\orders-service", expandedDirs: [] as string[] };
// `workspaces=2`: a second workspace; `workspace_set_active` switches and emits `workspaces:changed`.
// `workspaces=4`: four workspaces for the D-080 group tests (groups live in this mock only).
type MockWorkspace = { id: string; name: string; path: string; expandedDirs: string[]; group?: string };
const extraWorkspace = (id: string, name: string): MockWorkspace => ({ id, name, path: `C:\\src\\${name}`, expandedDirs: [] });
let workspaceList: MockWorkspace[] = params.get("workspaces") === "2"
  ? [workspace, extraWorkspace("ws-billing", "billing-api")]
  : params.get("workspaces") === "4"
    ? [workspace, extraWorkspace("ws-billing", "billing-api"), extraWorkspace("ws-blog", "blog"), extraWorkspace("ws-game", "space-game")]
    : [workspace];
let activeWorkspaceId = workspace.id;
let workspaceGroups: { id: string; name: string }[] = [];
let nextGroupId = 1;
function workspacesChanged() {
  void emit("workspaces:changed", { workspaces: workspaceList, activeId: activeWorkspaceId, groups: workspaceGroups });
}
function mockError(code: string, message: string): never {
  throw { code, message };
}
function checkGroupName(name: string, exceptId?: string): string {
  const trimmed = name.trim();
  if (!trimmed) mockError("invalid_name", "group name must not be empty");
  if (workspaceGroups.some((g) => g.id !== exceptId && g.name.toLowerCase() === trimmed.toLowerCase())) mockError("already_exists", "a group with this name already exists");
  return trimmed;
}
function moveToGroup(workspaceId: string, groupId: string | null) {
  const ws = workspaceList.find((w) => w.id === workspaceId);
  if (!ws) mockError("not_found", "workspace not found");
  const { group: _old, ...rest } = ws;
  const moved: MockWorkspace = groupId ? { ...rest, group: groupId } : rest;
  workspaceList = [...workspaceList.filter((w) => w.id !== workspaceId), moved];
}
// `panes=a,b`: pane ids `pty_spawn` hands out in turn (default: the Claude and Codex fixture panes).
const paneIds = params.get("panes")?.split(",") ?? ["pane-claude", "pane-codex"];
let spawned = 0;

// The hub keeps what the app saves with PUT /v1/settings (the mascot saves each change on top of a fresh GET).
let savedHubSettings: unknown = null;

function hubRoute(method: string, path: string, body?: unknown): unknown {
  const url = new URL(path, "http://hub");
  const p = url.pathname;
  const q = url.searchParams;
  if (method === "POST" && p === "/v1/ai/test") return { ok: true, errorKind: "none", latencyMs: 840 };
  if (method === "GET" && p === "/v1/adapters/claude-code/statusline") {
    return { state: "missing", configPath: "C:/Users/demo/.claude/settings.json", wrappedCommand: null, helperAvailable: true };
  }
  if (method === "PUT" && p === "/v1/settings") {
    savedHubSettings = body ?? null;
    return null;
  }
  if (method === "POST" && p === "/v1/watch/test") return watchFx.testResult(body as Parameters<typeof watchFx.testResult>[0]);
  if (method !== "GET") return p.startsWith("/v1/tasks") ? fx.tasks[0] : null;
  switch (p) {
    case "/v1/sessions":
      return hubSessions;
    case "/v1/sessions/history":
      return fx.sessionHistory;
    case "/v1/usage/current":
      return fx.usageCurrent;
    case "/v1/usage/daily":
      return fx.dailyUsage.slice(-Number(q.get("days") ?? 30));
    case "/v1/usage/blocks":
      return fx.blocks;
    case "/v1/usage/breakdown":
      return fx.breakdown[q.get("by") ?? "project"] ?? [];
    case "/v1/limits":
      return fx.limits;
    case "/v1/health":
      return fx.health;
    case "/v1/reports/waits":
      return fx.waits;
    case "/v1/reports/cost":
      return fx.costReport((q.get("groupBy") as "project" | null) ?? "project");
    case "/v1/reports/daily-summaries":
      return fx.summaries;
    case "/v1/reports/daily-summaries/status":
      return fx.summaryStatus;
    case "/v1/projects":
      return fx.projects;
    case "/v1/projects/files":
      return fx.todoFiles;
    case "/v1/tasks":
      return fx.tasks;
    case "/v1/dictations":
      return fx.dictations;
    case "/v1/dictation/models":
      return fx.dictationModels;
    case "/v1/settings":
      return savedHubSettings ?? (aiLocal ? fx.hubSettingsAiLocal : fx.hubSettings);
    case "/v1/watch":
      return watchFx.overview;
    case "/v1/ai/providers":
      return fx.aiProviders(aiLocal);
    case "/v1/adapters":
      return fx.adapters;
    case "/v1/customers":
      return [];
    case "/v1/pricing":
      return { path: "pricing.json", error: null, models: {} };
    default:
      if (p.startsWith("/v1/sessions/") && p.endsWith("/activity")) return watchFx.withWatchActivity(timelineFx.activityFor(p), watchHits);
      if (p.startsWith("/v1/reports/daily-summaries/")) return { summary: fx.summaries[0] ?? null, input: { date: "2026-10-03", activeMinutes: 312, sessions: 7, tokens: 1_610_000, costUsd: 6.41, waitMinutes: 22, hasActivity: true } };
      return null;
  }
}

// `update=available`: `update_check` finds 0.2.0 and `update_install` streams progress, then
// `update://ready`; `update=install-error` finds it but the install fails. Default: the build
// has no updater (`not-configured`, silent on start).
const updateScenario = params.get("update");
const UPDATE_TOTAL = 18_400_000;
const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function updateCheckResult(): unknown {
  if (updateScenario === "available" || updateScenario === "install-error") {
    return {
      status: "available",
      current: "0.1.0",
      version: "0.2.0",
      notes: "Split pane remembers its layout per workspace.\nFaster Mission control previews.\nFixes for Codex permission prompts.",
      date: "2026-10-09",
    };
  }
  return { status: "not-configured" };
}

async function runUpdateInstall(): Promise<null> {
  for (const fraction of [0, 0.35, 0.62]) {
    await emit("update://progress", { downloaded: Math.round(UPDATE_TOTAL * fraction), total: UPDATE_TOTAL });
    await delay(300);
  }
  if (updateScenario === "install-error") throw "The update signature could not be verified.";
  // Long enough for the spec to see the progress state.
  await delay(1500);
  await emit("update://progress", { downloaded: UPDATE_TOTAL, total: UPDATE_TOTAL });
  await emit("update://ready", null);
  return null;
}

mockWindows("main");
let nextRid = 1000;

mockIPC(
  (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "load_state":
        return { ui: { language }, layout: {}, ...(restoreAgent ? { terminals: restoredTerminals } : {}) };
      case "save_state_slice":
        return null;
      case "settings_get":
        return { ...DEFAULT_SETTINGS, theme, appearance };
      case "settings_set":
        // Echo what the app saved (M4: saved composer prompts must survive the round trip).
        return { ...DEFAULT_SETTINGS, theme, appearance, ...(args.settings as object | undefined) };
      case "fs_quick_open":
        return composerFx.quickOpen(String(args.query ?? ""));
      case "clipboard_read_text":
        return "hello";
      case "clipboard_write_text":
        window.__e2eClipboard.push(String(args.text));
        return null;
      case "open_external_url":
        window.__e2eOpenedUrls.push(String(args.url));
        return null;
      case "clipboard_save_image":
        return `${String(args.dirRel)}/screenshot-20261008-101500.png`;
      case "pty_write":
        composerFx.ptyWrites.push(String(args.data ?? ""));
        return null;
      case "workspace_list":
        return { workspaces: workspaceList, activeId: activeWorkspaceId, groups: workspaceGroups };
      case "workspace_set_active":
        activeWorkspaceId = String(args.id);
        workspacesChanged();
        return null;
      case "workspace_reorder": {
        const ids = args.ids as string[];
        workspaceList = ids.map((id) => workspaceList.find((w) => w.id === id)).filter((w): w is MockWorkspace => !!w);
        workspacesChanged();
        return null;
      }
      case "workspace_group_create": {
        const name = checkGroupName(String(args.name ?? ""));
        const id = `group-${nextGroupId++}`;
        workspaceGroups = [...workspaceGroups, { id, name }];
        if (typeof args.workspaceId === "string") moveToGroup(args.workspaceId, id);
        workspacesChanged();
        return null;
      }
      case "workspace_group_rename": {
        const name = checkGroupName(String(args.name ?? ""), String(args.id));
        workspaceGroups = workspaceGroups.map((g) => (g.id === args.id ? { ...g, name } : g));
        workspacesChanged();
        return null;
      }
      case "workspace_group_remove":
        workspaceGroups = workspaceGroups.filter((g) => g.id !== args.id);
        workspaceList = workspaceList.map(({ group, ...w }) => (group === args.id || !group ? w : { ...w, group }));
        workspacesChanged();
        return null;
      case "workspace_group_move": {
        const idx = workspaceGroups.findIndex((g) => g.id === args.id);
        const to = args.direction === "up" ? idx - 1 : idx + 1;
        if (idx !== -1 && to >= 0 && to < workspaceGroups.length) {
          const next = [...workspaceGroups];
          [next[idx], next[to]] = [next[to]!, next[idx]!];
          workspaceGroups = next;
        }
        workspacesChanged();
        return null;
      }
      case "workspace_set_group":
        moveToGroup(String(args.workspaceId), typeof args.groupId === "string" ? args.groupId : null);
        workspacesChanged();
        return null;
      case "fs_read_dir":
        return docsFx.readDir(String(args.rel ?? "")) ?? (args.rel ? [] : [
          { name: "src", rel: "src", isDir: true },
          { name: "tasks", rel: "tasks", isDir: true },
          { name: "README.md", rel: "README.md", isDir: false },
        ]);
      case "git_changes":
        return timelineFx.gitChanges;
      case "git_show_head":
        return worktreeFx.showHead(String(args.path ?? ""), typeof args.rev === "string" ? args.rev : null) ?? docsFx.showHead(String(args.path ?? ""), typeof args.rev === "string" ? args.rev : null) ?? timelineFx.showHead(String(args.path ?? ""));
      case "fs_read_text":
        return worktreeFx.readText(String(args.rel ?? "")) ?? docsFx.readText(String(args.rel ?? "")) ?? contextFx.readText(String(args.rel ?? "")) ?? timelineFx.readText(String(args.rel ?? ""));
      case "worktree_list":
        return worktreeFx.list();
      case "worktree_create":
        return worktreeFx.create(String(args.name ?? ""));
      case "worktree_changes":
        return worktreeFx.changes(String(args.name ?? ""));
      case "worktree_merge":
        return worktreeFx.merge(String(args.name ?? ""), args.squash === true, typeof args.message === "string" ? args.message : null);
      case "worktree_remove":
        return worktreeFx.remove(String(args.name ?? ""), args.force === true, args.deleteBranch === true, args.forceBranch === true);
      case "docs_check":
        return docsFx.check();
      case "docs_mark_reviewed":
        return docsFx.markReviewed(String(args.path ?? ""));
      case "context_agents":
        return contextFx.agents;
      case "context_report":
        return contextFx.report(String(args.workspaceId ?? ""), String(args.agent ?? ""));
      case "context_read":
        return contextFx.read(String(args.path ?? ""));
      case "git_head":
        return { kind: "branch", name: "feature/approval-flow" };
      case "update_check":
        return updateCheckResult();
      case "update_install":
        return runUpdateInstall();
      case "terminal_font_suggestion":
        return null;
      case "fonts_installed":
        return ["Cascadia Code", "Consolas", "Inter", "Segoe UI"];
      case "terminal_wt_schemes":
        return themeFx.wtSchemes;
      case "app_info":
        if (platform !== "windows") {
          const os = platform === "macos" ? "macOS 15" : "Ubuntu 22.04";
          return { osBuild: 0, version: "0.1.0", gitSha: "e2e", webview2: "e2e", os, buildDate: "2026-10-04", platform, features: offWindows, homeDir: platform === "macos" ? "/Users/e2e" : "/home/e2e" };
        }
        return { osBuild: 26300, version: "0.1.0", gitSha: "e2e", webview2: "e2e", os: "Windows 11", buildDate: "2026-10-04", homeDir: "C:\\Users\\e2e" };
      case "pty_profiles":
        return [{ id: "pwsh", name: "PowerShell", program: "pwsh.exe", args: [], available: true }];
      case "pty_spawn": {
        window.__e2eWorktree.spawns.push({ cwdRel: String(args.cwdRel ?? ""), agentCommand: typeof args.agentCommand === "string" ? args.agentCommand : null });
        const paneId = paneIds[spawned++ % paneIds.length]!;
        return { paneId, pid: 1000 + spawned };
      }
      case "pick_folders":
        return [];
      case "pick_files":
        return window.__e2ePickedFiles ?? [];
      case "pty_busy":
        return { busy: false, processes: [] };
      case "pty_stop_leftovers":
        // 0.3.2: like Rust, the leftovers exit and an empty list clears the strip.
        window.__e2eLeftoverStops.push(String(args.paneId));
        void emit("pty:leftover", { paneId: String(args.paneId), processes: [] });
        return null;
      case "agents_definitions":
      case "agents_definitions_reload":
      case "agents_save_user_definition":
      case "agents_delete_user_definition":
        return agentFx.definitions;
      case "agents_installed":
        return agentFx.installedAgents;
      case "agents_list":
        return [];
      case "hooks_status":
        return { hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: "C:\\Users\\demo\\.claude\\settings.json" };
      case "dictation_status":
        return { enabled: true, hotkey: { gesture: "Ctrl+Alt+D", error: null }, pasteLastHotkey: { gesture: "Ctrl+Alt+Shift+D", error: null }, phase: "hidden" };
      case "assistant_info":
        return assistantFx.assistantInfo();
      case "assistant_chat":
        return assistantFx.assistantChat(args);
      case "assistant_stop":
        return assistantFx.assistantStop();
      case "assistant_hide":
        window.__e2eAssistant.hides += 1;
        return null;
      case "assistant_open":
        window.__e2eAssistant.opens += 1;
        return null;
      case "assistant_set_config":
        window.__e2eAssistant.configs.push(args.config);
        return { status: "ok", hotkey: String((args.config as { hotkey?: string } | undefined)?.hotkey ?? "") };
      case "taskbar_set_badge":
        // D-056: the overlay icon is Rust-drawn; nothing to show in the browser.
        return null;
      case "hub_status":
        return { state: "running", pid: 4242 };
      case "companion_status":
        return deckConnected ? { state: "connected", serverVersion: "1.0.1" } : { state: "notRunning" };
      case "companion_set_agents":
        window.__e2eCompanion.agents.push(args.state);
        return null;
      case "companion_set_usage":
        window.__e2eCompanion.usage.push(args.usage);
        return null;
      case "companion_send":
        window.__e2eCompanion.sent.push(args.event);
        return null;
      case "pane_send_keys":
        window.__e2eCompanion.keys.push({ paneId: String(args.paneId), keys: String(args.keys) });
        return null;
      case "hub_request":
        return hubRoute(String(args.method ?? "GET"), String(args.path ?? ""), args.body);
      case "plugin:notification|is_permission_granted":
        return false;
      // D-075: tray icon and its menu (Tauri resources are `[rid, id]` pairs).
      case "plugin:tray|new":
        return [nextRid++, "tray"];
      case "plugin:menu|new": {
        const items = ((args.options as { items?: unknown[] } | undefined)?.items ?? []) as ({ text?: string; item?: string } | unknown[])[];
        if (args.kind === "Menu") window.__e2eTray.menus.push(items.map((i) => (Array.isArray(i) ? "?" : i.item ? "---" : String(i.text ?? ""))));
        return [nextRid++, `menu-${nextRid}`];
      }
      case "plugin:tray|set_tooltip":
        window.__e2eTray.tooltips.push(String(args.tooltip ?? ""));
        return null;
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

async function pushHubSnapshot(): Promise<void> {
  await emit("hub:status", { connected: true });
  await emit("hub:event", { type: "sessions", data: hubSessions });
  await emit("hub:event", { type: "usage", data: fx.usageCurrent });
  await emit("hub:event", { type: "limits", data: fx.limits });
  await emit("hub:event", { type: "health", data: fx.health });
  await emit("hub:event", {
    type: "tasks",
    data: { today: fx.tasks.filter((t) => t.dueState === "today").length, overdue: fx.tasks.filter((t) => t.dueState === "overdue").length },
  });
}

declare global {
  interface Window {
    __e2e: { emit: (type: string, data: unknown) => Promise<void>; pushHubSnapshot: () => Promise<void>; deck: (type: string, payload: unknown) => Promise<void> };
    /** Pane ids `pty_stop_leftovers` was called with. */
    __e2eLeftoverStops: string[];
  }
}

window.__e2eLeftoverStops = [];
window.__e2e = {
  emit: (type, data) => emit("hub:event", { type, data }),
  pushHubSnapshot,
  deck: (type, payload) => emit("companion:message", { type, payload }),
};
// The app registers its listeners after an async bootstrap; resend a few times so the first
// snapshot is never lost (the spec also pushes once the page is ready).
for (const delay of [500, 1500, 3000]) window.setTimeout(() => void pushHubSnapshot(), delay);
