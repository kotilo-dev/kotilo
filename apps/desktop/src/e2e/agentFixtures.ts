/**
 * Agent fixtures for the browser e2e build (M3 wave 3): the eight built-in adapter definitions
 * (copied from `adapters/<id>/adapter.json`, hook event lists trimmed), one user adapter and
 * one invalid user file, as the hub (`GET /v1/adapters`) and the desktop
 * (`agents_definitions`) report them. Only invented demo data besides the agents' names.
 */
import type { AdapterDefinition as HubDefinition, AdapterDto, HookStatusDto } from "../lib/hubTypes";
import type { AdapterDefinition, AdapterDefinitions } from "../lib/ipc";

const builtIn: HubDefinition[] = [
  {
    v: 1,
    id: "claude-code",
    displayName: "Claude Code",
    avatar: { letter: "C", bg: "#2a2230", ink: "#f0a37d" },
    detect: { executables: ["claude.exe", "claude"] },
    launch: { command: "claude", args: [] },
    permissionKeys: { allowOnce: "1", alwaysAllow: "2", deny: "Esc" },
    hooks: { shell: "cmd", events: ["SessionStart", "PreToolUse", "Stop"] },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "codex",
    displayName: "Codex CLI",
    avatar: { letter: "X", bg: "#1d2a26", ink: "#7fd8b4" },
    detect: { executables: ["codex.exe", "codex"] },
    launch: { command: "codex", args: [] },
    permissionKeys: { allowOnce: "y", alwaysAllow: "p", deny: "Esc" },
    hooks: { shell: "cmdUnquoted", events: ["SessionStart", "PermissionRequest", "Stop"] },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    avatar: { letter: "P", bg: "#1f2430", ink: "#a5c8ff" },
    detect: { executables: ["copilot.exe", "copilot"] },
    launch: { command: "copilot", args: [] },
    permissionKeys: { allowOnce: "1", deny: "Esc" },
    hooks: { shell: "powershell", events: ["sessionStart", "permissionRequest", "agentStop"] },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "cursor",
    displayName: "Cursor CLI",
    avatar: { letter: "U", bg: "#21252b", ink: "#d3dae3" },
    detect: { executables: ["cursor-agent.exe", "cursor-agent"] },
    launch: { command: "cursor-agent", args: [] },
    permissionKeys: { allowOnce: "y", deny: "n" },
    hooks: { shell: "any", events: ["sessionStart", "stop"] },
    usage: "none",
    screenRules: [{ id: "permission", state: "waitingPermission", pattern: "\\(y\\)[\\s\\S]*\\((?:esc or )?n\\)|\\(y/n\\)", lines: 10 }],
  },
  {
    v: 1,
    id: "droid",
    displayName: "Factory Droid",
    avatar: { letter: "D", bg: "#2b2620", ink: "#f2b56b" },
    detect: { executables: ["droid.exe", "droid"] },
    launch: { command: "droid", args: [] },
    hooks: { shell: "cmd", events: ["SessionStart", "Notification", "Stop"] },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "gemini",
    displayName: "Gemini CLI",
    avatar: { letter: "G", bg: "#1e2433", ink: "#8ab4f8" },
    detect: { executables: ["gemini.cmd", "gemini"] },
    launch: { command: "gemini", args: [] },
    permissionKeys: { allowOnce: "1", deny: "Esc" },
    hooks: { shell: "powershell", events: ["SessionStart", "Notification", "AfterAgent"] },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "opencode",
    displayName: "OpenCode",
    avatar: { letter: "O", bg: "#26231e", ink: "#f0d9a8" },
    detect: { executables: ["opencode.exe", "opencode"] },
    launch: { command: "opencode", args: [] },
    permissionKeys: { allowOnce: "Enter", deny: "Esc" },
    usage: "builtIn",
  },
  {
    v: 1,
    id: "qwen",
    displayName: "Qwen Code",
    avatar: { letter: "Q", bg: "#262236", ink: "#b39cf5" },
    detect: { executables: ["qwen.cmd", "qwen"] },
    launch: { command: "qwen", args: [] },
    permissionKeys: { allowOnce: "1", alwaysAllow: "2", deny: "Esc" },
    hooks: { shell: "cmdUnquoted", events: ["SessionStart", "Notification", "Stop"] },
    usage: "builtIn",
  },
];

const userAdapter: HubDefinition = {
  v: 1,
  id: "local-llm",
  displayName: "Local LLM Agent",
  avatar: { letter: "L", bg: "#1c262e", ink: "#86c8f0" },
  detect: { executables: ["local-llm.exe", "local-llm"] },
  launch: { command: "local-llm", args: ["--tui"] },
  permissionKeys: { allowOnce: "y", deny: "n" },
  usage: "protocol",
  screenRules: [
    { id: "approve", state: "waitingPermission", pattern: "Allow this command\\? \\(y/n\\)", lines: 3, clearOn: "input" },
    { id: "thinking", state: "working", pattern: "Thinking…", lines: 2 },
  ],
};

const hooks = (state: HookStatusDto["state"], configPath: string, extra: Partial<HookStatusDto> = {}): HookStatusDto => ({
  state,
  configPath,
  needsApproval: false,
  hint: null,
  ...extra,
});

const HOOKS: Record<string, HookStatusDto> = {
  "claude-code": hooks("installed", "C:\\Users\\demo\\.claude\\settings.json"),
  codex: hooks("installed", "C:\\Users\\demo\\.codex\\hooks.json", { needsApproval: true }),
  copilot: hooks("missing", "C:\\Users\\demo\\.copilot\\hooks\\agenthub.json"),
  cursor: hooks("installed", "C:\\Users\\demo\\.cursor\\hooks.json"),
  droid: hooks("outdated", "C:\\Users\\demo\\.factory\\hooks.json", { hint: "hooksDisabled" }),
  gemini: hooks("installed", "C:\\Users\\demo\\.gemini\\settings.json", { hint: "folderTrust" }),
  opencode: hooks("missing", "C:\\Users\\demo\\.config\\opencode\\plugins\\agenthub.js"),
  qwen: hooks("invalidConfig", "C:\\Users\\demo\\.qwen\\settings.json"),
};

export const adapters: AdapterDto[] = [
  ...builtIn.map((d) => ({ id: d.id, displayName: d.displayName, source: "builtIn" as const, definition: d, hooks: HOOKS[d.id] ?? null, error: null })),
  { id: "broken-agent", displayName: "", source: "user", definition: null, hooks: null, error: "$.avatar.bg: does not match the pattern ^#[0-9a-fA-F]{6}$" },
  { id: userAdapter.id, displayName: userAdapter.displayName, source: "user", definition: userAdapter, hooks: null, error: null },
];

function desktopShape(d: HubDefinition, source: "builtIn" | "user"): AdapterDefinition {
  return {
    ...d,
    detect: { executables: d.detect.executables ?? [], nodeScripts: d.detect.nodeScripts ?? [] },
    launch: { command: d.launch.command, args: d.launch.args ?? [] },
    gracefulClose: d.gracefulClose ?? [],
    permissionKeys: d.permissionKeys ?? null,
    screenRules: d.screenRules ?? [],
    source,
  };
}

/** `agents_definitions`: what the desktop loaded (the invalid file is in `errors`). */
export const definitions: AdapterDefinitions = {
  definitions: [...builtIn.map((d) => desktopShape(d, "builtIn")), desktopShape(userAdapter, "user")],
  errors: [
    {
      id: "broken-agent",
      path: "C:\\Users\\demo\\AppData\\Roaming\\kotilo\\adapters\\broken-agent\\adapter.json",
      source: "user",
      message: "avatar.bg must be a #rrggbb color",
    },
  ],
};

/** `agents_installed`: the agents "on PATH" in the demo. */
export const installedAgents = ["claude-code", "codex", "cursor", "gemini", "local-llm"];
