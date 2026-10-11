/**
 * Fake hub data for the browser e2e build (`vite --mode e2e`). Typed against hubTypes.ts so
 * the fixtures break the build when the API shape changes. Only invented demo data.
 */
import type {
  AiProvidersResponse,
  BreakdownRow,
  CostReport,
  DailySummary,
  DailySummaryStatus,
  DailyUsage,
  DictationModel,
  DictationRecord,
  HealthDto,
  HubSettings,
  LimitDto,
  PersonalTask,
  ProjectDto,
  SessionDto,
  TodoFileDto,
  TotalsDto,
  UsageBlockDto,
  UsageCurrent,
  WaitReport,
} from "../lib/hubTypes";

const NOW = new Date("2026-10-04T12:00:00+03:00");
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const day = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export const fixtureNow = NOW;

function totals(tokens: number, costUsd: number, unpriced = false): TotalsDto {
  return {
    input: Math.round(tokens * 0.2),
    output: Math.round(tokens * 0.05),
    cacheCreate: Math.round(tokens * 0.1),
    cacheRead: Math.round(tokens * 0.65),
    tokens,
    costUsd,
    hasUnpricedEntries: unpriced,
    entries: Math.max(1, Math.round(tokens / 4000)),
  };
}

const baseSession = {
  turnStartedAt: null,
  endedAt: null,
  activeSubagents: 0,
  lastNotification: null,
  error: null,
  tasks: null,
  pendingPermission: null,
} satisfies Partial<SessionDto>;

export const sessions: SessionDto[] = [
  {
    ...baseSession,
    sessionId: "demo-codex-1",
    agent: "codex",
    paneId: "pane-codex",
    projectRoot: "C:\\src\\gateway",
    projectName: "gateway",
    state: "WaitingPermission",
    stateSince: iso(1.2),
    lastEventAt: iso(1.2),
    currentTool: "Bash",
    model: "gpt-5-codex",
    tokens: 88_000,
    costUsd: null,
    contextUsedPercent: 27,
    pendingPermission: {
      tool: "Bash",
      command: "dotnet ef database update --project Gateway",
      path: null,
      risk: "writesDatabase",
      since: iso(1.2),
    },
  },
  {
    ...baseSession,
    sessionId: "demo-claude-1",
    agent: "claude-code",
    paneId: "pane-claude",
    projectRoot: "C:\\src\\orders-service",
    projectName: "orders-service",
    state: "Working",
    stateSince: iso(2),
    lastEventAt: iso(0.1),
    currentTool: "Edit",
    model: "claude-sonnet-5",
    tokens: 312_000,
    costUsd: 1.24,
    contextUsedPercent: 41,
    turnStartedAt: iso(2),
    tasks: { completed: 3, inProgress: 1, total: 6 },
  },
  {
    ...baseSession,
    sessionId: "demo-claude-2",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:\\src\\docs-site",
    projectName: "docs-site",
    state: "Idle",
    stateSince: iso(6),
    lastEventAt: iso(6),
    currentTool: null,
    model: "claude-haiku-5",
    tokens: 41_000,
    costUsd: 0.31,
    contextUsedPercent: 12,
  },
];

export const usageCurrent: UsageCurrent = {
  at: NOW.toISOString(),
  activeBlock: {
    start: iso(160),
    end: iso(-140),
    tokens: 1_240_000,
    costUsd: 4.82,
    remainingMinutes: 140,
    tokensPerMinute: 7750,
    projectedTokens: 2_325_000,
    projectedCostUsd: 9.04,
  },
  today: { tokens: 1_610_000, costUsd: 6.41, sessions: 6 },
  week: { tokens: 9_870_000, costUsd: 38.2, sessions: 31 },
  backfillDone: true,
};

export const limits: LimitDto[] = [
  { agent: "claude-code", window: "fiveHour", usedPercent: 62, resetsAt: iso(-120) },
  { agent: "claude-code", window: "weekly", usedPercent: 38, resetsAt: iso(-4000) },
  { agent: "codex", window: "weekly", usedPercent: 31, resetsAt: iso(-3000) },
];

export const health: HealthDto = { version: "0.1.0", uptime: 3600, status: "ok", issues: [] };

export const dailyUsage: DailyUsage[] = Array.from({ length: 30 }, (_, i) => {
  const d = 29 - i;
  const claude = d % 6 === 0 ? 0 : 400_000 + ((d * 137_000) % 900_000);
  const codex = d % 3 === 0 ? 150_000 + ((d * 53_000) % 300_000) : 0;
  const byAgent: DailyUsage["byAgent"] = {};
  if (claude) byAgent["claude-code"] = { tokens: claude, costUsd: claude / 250_000, hasUnpricedEntries: false };
  if (codex) byAgent.codex = { tokens: codex, costUsd: 0, hasUnpricedEntries: true };
  return {
    date: day(d),
    tokens: claude + codex,
    costUsd: claude / 250_000,
    hasUnpricedEntries: codex > 0,
    sessions: (claude ? 3 : 0) + (codex ? 1 : 0),
    byAgent,
  };
});

export const blocks: UsageBlockDto[] = Array.from({ length: 6 }, (_, i) => ({
  id: `b${i}`,
  start: iso(160 + i * 360),
  end: iso(-140 + i * 360),
  lastEntryAt: iso(i * 360),
  isGap: i === 3,
  isActive: i === 0,
  totals: i === 3 ? totals(0, 0) : totals(1_240_000 - i * 150_000, 4.82 - i * 0.6),
}));

export const breakdown: Record<string, BreakdownRow[]> = {
  project: [
    { key: "C:\\src\\orders-service", name: "orders-service", totals: totals(4_200_000, 16.4) },
    { key: "C:\\src\\gateway", name: "gateway", totals: totals(2_100_000, 0, true) },
    { key: "C:\\src\\docs-site", name: "docs-site", totals: totals(900_000, 3.1) },
  ],
  model: [
    { key: "claude-sonnet-5", name: "claude-sonnet-5", totals: totals(4_600_000, 17.9) },
    { key: "gpt-5-codex", name: "gpt-5-codex", totals: totals(2_100_000, 0, true) },
    { key: "claude-haiku-5", name: "claude-haiku-5", totals: totals(500_000, 1.6) },
  ],
  agent: [
    { key: "claude-code", name: "Claude Code", totals: totals(5_100_000, 19.5) },
    { key: "codex", name: "Codex CLI", totals: totals(2_100_000, 0, true) },
  ],
};

export const waits: WaitReport = {
  from: day(7),
  to: day(0),
  totalSeconds: 5_430,
  count: 37,
  averageSeconds: 147,
  medianSeconds: 64,
  permissionSeconds: 3_900,
  inputSeconds: 1_530,
  duringQuietHoursSeconds: 0,
  topPermissionTool: "Bash",
  longest: null,
  byHourSeconds: Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 18 ? 200 + ((h * 97) % 400) : 0)),
  byProject: [
    { projectRoot: "C:\\src\\gateway", projectName: "gateway", seconds: 2_900 },
    { projectRoot: "C:\\src\\orders-service", projectName: "orders-service", seconds: 2_530 },
  ],
  byDay: Array.from({ length: 8 }, (_, i) => ({ date: day(7 - i), permissionSeconds: 300 + i * 90, inputSeconds: 120 + i * 30 })),
  longestSpans: [],
};

export function costReport(groupBy: CostReport["groupBy"]): CostReport {
  const rows = (breakdown[groupBy === "customer" ? "project" : groupBy] ?? breakdown.project!).map((r, i) => ({
    kind: "normal" as const,
    key: r.key,
    name: r.name,
    color: null,
    projects: [r.name],
    sessions: 4 + i,
    totals: r.totals,
    share: [0.72, 0.18, 0.1][i] ?? 0,
  }));
  return { from: day(30), to: day(0), groupBy, sessions: 31, totals: totals(7_200_000, 19.5, true), rows };
}

export const summaries: DailySummary[] = [
  {
    date: day(1),
    markdown: "## Yesterday\n\n- orders-service: approval flow finished, 14 tests added.\n- gateway: migration prepared.",
    model: "claude-haiku-5",
    generatedAt: iso(900),
  },
];

export const summaryStatus: DailySummaryStatus = {
  enabled: true,
  scheduledAt: "18:00",
  withoutAi: false,
  model: "claude-haiku-5",
  generationAvailable: false,
  reason: "clientRequired",
};

export const projects: ProjectDto[] = [
  {
    root: "C:\\src\\orders-service",
    name: "orders-service",
    manual: false,
    hidden: false,
    lastActivity: iso(1),
    done: 18,
    inProgress: 2,
    total: 30,
    percent: 60,
    files: 2,
    next: { file: "tasks/todo.md", text: "Approval flow: reject path", group: "Phase 3" },
    git: {
      branch: "feature/approval-flow",
      isDetached: false,
      hasUpstream: true,
      ahead: 2,
      behind: 0,
      changed: 5,
      lastCommitAt: iso(40),
      lastCommitSubject: "Add approval states",
      checkedAt: iso(1),
    },
    customerId: null,
    alias: null,
  },
  {
    root: "C:\\src\\gateway",
    name: "gateway",
    manual: false,
    hidden: false,
    lastActivity: iso(2),
    done: 7,
    inProgress: 1,
    total: 9,
    percent: 78,
    files: 1,
    next: { file: "tasks/todo.md", text: "Cancellation status column", group: null },
    git: null,
    customerId: null,
    alias: null,
  },
];

export const todoFiles: TodoFileDto[] = [
  {
    relativePath: "tasks/todo.md",
    done: 2,
    inProgress: 1,
    total: 4,
    lastWriteUtc: iso(30),
    groups: [
      {
        title: "Phase 3",
        level: 2,
        done: 2,
        total: 4,
        items: [
          { text: "Approval states", state: "done", line: 4 },
          { text: "Approval UI", state: "done", line: 5 },
          { text: "Approval flow: reject path", state: "inProgress", line: 6 },
          { text: "Audit log", state: "open", line: 7 },
        ],
      },
    ],
  },
];

export const tasks: PersonalTask[] = [
  {
    id: 1,
    text: "Renew the signing certificate\nOV certificate expires next month.",
    title: "Renew the signing certificate",
    details: "OV certificate expires next month.",
    projectRoot: null,
    projectName: null,
    dueDate: day(1),
    dueTime: null,
    priority: "high",
    dueState: "overdue",
    createdAt: iso(5000),
    updatedAt: iso(5000),
    completedAt: null,
  },
  {
    id: 2,
    text: "Review gateway migration",
    title: "Review gateway migration",
    details: null,
    projectRoot: "C:\\src\\gateway",
    projectName: "gateway",
    dueDate: day(0),
    dueTime: "16:00",
    priority: "normal",
    dueState: "today",
    createdAt: iso(300),
    updatedAt: iso(300),
    completedAt: null,
  },
];

export const dictations: DictationRecord[] = [
  {
    id: 1,
    createdAt: iso(25),
    durationSeconds: 14,
    rawText: "şey yarın sabah toplantıdan önce raporu gönder",
    finalText: "Yarın sabah toplantıdan önce raporu gönder.",
    cleaned: true,
    mode: "Clean",
    model: "large",
    language: "tr",
    outputs: "focused",
  },
];

export const dictationModels: DictationModel[] = [
  { id: "large", fileName: "ggml-large-v3-turbo-q5_0.bin", size: 574_000_000, installed: true, selected: true, partialBytes: 0, downloading: false, progress: null, error: null },
  { id: "small", fileName: "ggml-small-q5_1.bin", size: 190_000_000, installed: false, selected: false, partialBytes: 0, downloading: false, progress: null, error: null },
];

// M3 wave 3: all built-in adapters, a custom one and an invalid user file (agentFixtures.ts).
export { adapters } from "./agentFixtures";

export const hubSettings: HubSettings = {
  language: "en-US",
  rules: {
    waitingPermissionEnabled: true,
    waitingInputEnabled: true,
    completedEnabled: true,
    staleEnabled: true,
    waitingReminderEnabled: true,
    todoCompletedEnabled: false,
    contextHighEnabled: true,
    contextThresholdPercent: 80,
    contextRearmPercent: 60,
    errorEnabled: true,
    errorDebounce: "00:00:30",
    minTurnForCompleted: "00:00:20",
    reminderAfter: "00:05:00",
    debounce: "00:00:05",
    settle: "00:00:02",
  },
  usageRules: {
    blockThresholdEnabled: true,
    blockTokenThresholds: [1_000_000, 2_000_000],
    resetMargin: 0.1,
    dailyCostEnabled: false,
    dailyCostThresholdUsd: 20,
    burnProjectionEnabled: true,
  },
  quietHours: { enabled: false, start: "22:00:00", end: "08:00:00" },
  doNotDisturbUntil: null,
  suppressWhenTerminalFocused: true,
  buddy: {
    enabled: false,
    mascotEnabled: false,
    hotkey: "Ctrl+Alt+B",
    mascotScale: 1,
    walkArea: "taskbar",
    celebrate: true,
    showBuddySessions: false,
    mascotHiddenUntil: null,
    mascotPosition: 0.5,
  },
  tasks: { hotkey: "Ctrl+Alt+N", reminders: true },
  dictation: {
    enabled: true,
    hotkey: "Ctrl+Alt+D",
    pasteLastHotkey: "Ctrl+Alt+Shift+D",
    model: "large",
    language: "tr",
    useGpu: true,
    aiCleanup: false,
    mode: "Clean",
    customPrompt: "",
    vocabulary: "",
    outputFocused: true,
    insertMethod: "paste",
    outputClipboard: false,
    outputFile: false,
    filePath: "",
    soundCues: true,
    maxMinutes: 5,
    keepHistory: true,
  },
  tasksGlob: "**/tasks/*.md",
  insights: {
    gitEnabled: true,
    uncommittedThreshold: 20,
    uncommittedInToast: true,
    dailySummaryEnabled: true,
    dailySummaryTime: "18:00",
    dailySummaryWithoutAi: false,
    healthInfoBarLevel: "Warning",
  },
  ai: {
    providers: [{ name: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", hasKey: true }],
    assistant: { provider: "cli:claude-code", model: "haiku" },
    dailySummary: { provider: "cli:claude-code", model: null },
    dictationCleanup: { provider: "openai:ollama", model: null },
  },
};

/** Settings → AI with every feature on the local Ollama endpoint (`?ai=local`): "Fully local". */
export const hubSettingsAiLocal: HubSettings = {
  ...hubSettings,
  ai: { ...hubSettings.ai!, assistant: { provider: "openai:ollama", model: null }, dailySummary: { provider: "openai:ollama", model: "qwen3:14b" } },
};

/** `GET /v1/ai/providers`: two agent CLIs (Gemini not verified) and the Ollama endpoint with a stored key. */
export function aiProviders(local: boolean): AiProvidersResponse {
  return {
    providers: [
      { id: "cli:claude-code", kind: "cli", displayName: "Claude Code", installed: true, verified: true, hasKey: null, baseUrl: null, isLoopback: false },
      { id: "cli:gemini", kind: "cli", displayName: "Gemini CLI", installed: true, verified: false, hasKey: null, baseUrl: null, isLoopback: false },
      { id: "openai:ollama", kind: "openai", displayName: "ollama", installed: true, verified: true, hasKey: true, baseUrl: "http://127.0.0.1:11434/v1", isLoopback: true },
    ],
    fullyLocal: local,
    secretStoreAvailable: true,
  };
}
