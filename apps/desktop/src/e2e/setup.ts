/**
 * Browser e2e mode (`vite --mode e2e`, loaded before main.tsx by vite.config.ts): replaces the
 * Tauri backend with `@tauri-apps/api/mocks` and answers hub routes from `fixtures.ts`.
 * URL params: `theme=dark|light`, `lang=en|tr`. `window.__e2e.emit(type, data)` pushes a
 * hub stream frame. Never part of a real build.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { DEFAULT_SETTINGS } from "../stores/settingsStore";
import * as fx from "./fixtures";
import * as agentFx from "./agentFixtures";
import * as composerFx from "./composerFixtures";
import * as timelineFx from "./timelineFixtures";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const language = params.get("lang") === "tr" ? "tr" : "en";
// `ai=local`: Settings → AI with every feature on the local endpoint ("Fully local").
const aiLocal = params.get("ai") === "local";

const workspace = { id: "ws-demo", name: "orders-service", path: "C:\\src\\orders-service", expandedDirs: [] as string[] };
// `panes=a,b`: pane ids `pty_spawn` hands out in turn (default: the Claude and Codex fixture panes).
const paneIds = params.get("panes")?.split(",") ?? ["pane-claude", "pane-codex"];
let spawned = 0;

function hubRoute(method: string, path: string): unknown {
  const url = new URL(path, "http://hub");
  const p = url.pathname;
  const q = url.searchParams;
  if (method === "POST" && p === "/v1/ai/test") return { ok: true, errorKind: "none", latencyMs: 840 };
  if (method !== "GET") return p.startsWith("/v1/tasks") ? fx.tasks[0] : null;
  switch (p) {
    case "/v1/sessions":
      return fx.sessions;
    case "/v1/usage/current":
      return fx.usageCurrent;
    case "/v1/usage/daily":
      return fx.dailyUsage;
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
      return aiLocal ? fx.hubSettingsAiLocal : fx.hubSettings;
    case "/v1/ai/providers":
      return fx.aiProviders(aiLocal);
    case "/v1/adapters":
      return fx.adapters;
    case "/v1/customers":
      return [];
    case "/v1/pricing":
      return { path: "pricing.json", error: null, models: {} };
    default:
      if (p.startsWith("/v1/sessions/") && p.endsWith("/activity")) return timelineFx.activityFor(p);
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
mockIPC(
  (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "load_state":
        return { ui: { language }, layout: {} };
      case "save_state_slice":
        return null;
      case "settings_get":
        return { ...DEFAULT_SETTINGS, theme };
      case "settings_set":
        // Echo what the app saved (M4: saved composer prompts must survive the round trip).
        return { ...DEFAULT_SETTINGS, theme, ...(args.settings as object | undefined) };
      case "fs_quick_open":
        return composerFx.quickOpen(String(args.query ?? ""));
      case "clipboard_save_image":
        return `${String(args.dirRel)}/screenshot-20261008-101500.png`;
      case "pty_write":
        composerFx.ptyWrites.push(String(args.data ?? ""));
        return null;
      case "workspace_list":
        return { workspaces: [workspace], activeId: workspace.id };
      case "fs_read_dir":
        return args.rel ? [] : [
          { name: "src", rel: "src", isDir: true },
          { name: "tasks", rel: "tasks", isDir: true },
          { name: "README.md", rel: "README.md", isDir: false },
        ];
      case "git_changes":
        return timelineFx.gitChanges;
      case "git_show_head":
        return timelineFx.showHead(String(args.path ?? ""));
      case "fs_read_text":
        return timelineFx.readText(String(args.rel ?? ""));
      case "git_head":
        return { kind: "branch", name: "feature/approval-flow" };
      case "update_check":
        return updateCheckResult();
      case "update_install":
        return runUpdateInstall();
      case "app_info":
        return { osBuild: 26300, version: "0.1.0", gitSha: "e2e", webview2: "e2e", os: "Windows 11", buildDate: "2026-10-04" };
      case "pty_profiles":
        return [{ id: "pwsh", name: "PowerShell", program: "pwsh.exe", args: [], available: true }];
      case "pty_spawn": {
        const paneId = paneIds[spawned++ % paneIds.length]!;
        return { paneId, pid: 1000 + spawned };
      }
      case "pick_folders":
        return [];
      case "pty_busy":
        return { busy: false, processes: [] };
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
      case "hub_status":
        return { state: "running", pid: 4242 };
      case "hub_request":
        return hubRoute(String(args.method ?? "GET"), String(args.path ?? ""));
      case "plugin:notification|is_permission_granted":
        return false;
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

async function pushHubSnapshot(): Promise<void> {
  await emit("hub:status", { connected: true });
  await emit("hub:event", { type: "sessions", data: fx.sessions });
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
    __e2e: { emit: (type: string, data: unknown) => Promise<void>; pushHubSnapshot: () => Promise<void> };
  }
}

window.__e2e = { emit: (type, data) => emit("hub:event", { type, data }), pushHubSnapshot };
// The app registers its listeners after an async bootstrap; resend a few times so the first
// snapshot is never lost (the spec also pushes once the page is ready).
for (const delay of [500, 1500, 3000]) window.setTimeout(() => void pushHubSnapshot(), delay);
