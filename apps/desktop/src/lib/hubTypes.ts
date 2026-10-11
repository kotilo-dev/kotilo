/**
 * Wire types of the hub's loopback API (docs/hub-api.md). The webview never talks to the hub directly:
 * it calls the Rust `hub_request` command and listens to `hub:event` (stream frames), so the token stays in Rust.
 *
 * Conventions: camelCase fields; enums as camelCase strings, except `SessionDto.state` / transition states which keep
 * the hub's PascalCase names; timestamps are ISO-8601 strings with offset; `DateOnly` is `yyyy-MM-dd`;
 * durations inside settings (`TimeSpanString`) are .NET `[d.]hh:mm:ss` strings.
 */

export type IsoDateTime = string;
/** `yyyy-MM-dd` */
export type IsoDate = string;
/** .NET TimeSpan, e.g. `00:00:05` or `1.00:00:00`. */
export type TimeSpanString = string;
/** .NET TimeOnly, e.g. `23:00:00`. */
export type TimeOnlyString = string;

/** Adapter id (`adapters/<id>/adapter.json`). */
export type AgentId = "claude-code" | "codex" | (string & {});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface HubError {
  /** `invalidRequest`, `notFound`, `invalidConfig`, `unknownAdapter`, `io`. */
  error: string;
  message: string;
  /** Validation errors per field (dotted paths for nested settings, e.g. `rules.contextThresholdPercent`). */
  fields: Record<string, string[]> | null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionState =
  | "Unknown"
  | "Idle"
  | "Working"
  | "WaitingPermission"
  | "WaitingInput"
  | "Ended"
  | "Stale"
  | "Error";

export type PermissionRisk = "other" | "deletesFiles" | "writesDatabase" | "network" | "installsPackages" | "gitPush";

/** The request a session waits on; only while `state === "WaitingPermission"`. Never stored by the hub. */
export interface PendingPermission {
  tool: string | null;
  /** Shell command (Bash-like tools), truncated to 4000 chars. */
  command: string | null;
  /** File path for edit tools. */
  path: string | null;
  /** Null when there is no command to judge (file edits). */
  risk: PermissionRisk | null;
  since: IsoDateTime;
}

export type SessionErrorKind = "apiError" | "usageLimit" | "rateLimited" | "overloaded" | "authError";

export interface SessionDto {
  sessionId: string;
  agent: AgentId;
  paneId: string | null;
  projectRoot: string;
  projectName: string;
  state: SessionState;
  stateSince: IsoDateTime;
  lastEventAt: IsoDateTime;
  currentTool: string | null;
  model: string | null;
  tokens: number;
  costUsd: number | null;
  contextUsedPercent: number | null;
  turnStartedAt: IsoDateTime | null;
  endedAt: IsoDateTime | null;
  activeSubagents: number;
  /** Agent's own short UI message (e.g. Claude Code notification text); not conversation content. */
  lastNotification: string | null;
  error: { kind: SessionErrorKind; resetsAt: IsoDateTime | null } | null;
  tasks: { completed: number; inProgress: number; total: number } | null;
  pendingPermission: PendingPermission | null;
}

export interface TransitionDto {
  from: SessionState;
  to: SessionState;
  at: IsoDateTime;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Activity timeline (M4, hub memory only)

export type ActivityToolKind = "read" | "edit" | "write" | "bash" | "search" | "task" | "other";
export type ActivityStatus = "running" | "ok" | "failed" | "denied";

/** One tool call. `target`: path relative to the project (forward slashes) when inside it, else the absolute path, else the command / label (≤ 200 chars); absent when the call names none. */
export interface ActivityToolEntry {
  id: number;
  kind: ActivityToolKind;
  tool: string;
  target?: string;
  /** Every file of a multi-file call (`apply_patch`), relative like `target`; absent otherwise. */
  paths?: string[];
  startedAt: IsoDateTime;
  /** Set once the call finished (absent when the end was inferred from the turn ending). */
  durationMs?: number;
  status: ActivityStatus;
}

/** A user prompt was submitted. */
export interface ActivityTurnMarker {
  id: number;
  kind: "turn";
  at: IsoDateTime;
}

export type ActivityEntry = ActivityToolEntry | ActivityTurnMarker;

export type ActivityPlanStatus = "pending" | "in_progress" | "completed";

/** The agent's latest TodoWrite plan (texts ≤ 200 chars). */
export interface ActivityPlan {
  items: { text: string; status: ActivityPlanStatus }[];
}

/** `GET /v1/sessions/{agent}/{id}/activity`: the last 200 entries, oldest first (ids ascend). */
export interface ActivityDto {
  entries: ActivityEntry[];
  plan: ActivityPlan | null;
}

/** Stream `activity`: entries new or changed since the previous frame of this session (merge by `id`), and the current plan. */
export interface ActivityFrame {
  agent: string;
  sessionId: string;
  entries: ActivityEntry[];
  plan: ActivityPlan | null;
}

// ---------------------------------------------------------------------------
// Usage, limits, health
// ---------------------------------------------------------------------------

export interface TotalsDto {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  tokens: number;
  costUsd: number;
  hasUnpricedEntries: boolean;
  entries: number;
}

export interface UsageCurrent {
  at: IsoDateTime;
  activeBlock: {
    start: IsoDateTime;
    end: IsoDateTime;
    tokens: number;
    costUsd: number;
    remainingMinutes: number;
    tokensPerMinute: number;
    projectedTokens: number;
    projectedCostUsd: number;
  } | null;
  today: { tokens: number; costUsd: number; sessions: number | null };
  week: { tokens: number; costUsd: number; sessions: number | null };
  backfillDone: boolean;
}

export interface DailyUsage {
  date: IsoDate;
  tokens: number;
  costUsd: number;
  hasUnpricedEntries: boolean;
  sessions: number;
  /** Only agents with usage that day. */
  byAgent: Record<string, { tokens: number; costUsd: number; hasUnpricedEntries: boolean }>;
}

export interface UsageBlockDto {
  id: string;
  start: IsoDateTime;
  end: IsoDateTime;
  lastEntryAt: IsoDateTime | null;
  isGap: boolean;
  isActive: boolean;
  totals: TotalsDto;
}

export interface BreakdownRow {
  key: string;
  name: string;
  totals: TotalsDto;
}

export interface LimitDto {
  agent: AgentId;
  window: "fiveHour" | "weekly";
  usedPercent: number;
  resetsAt: IsoDateTime;
}

export interface HealthDto {
  version: string | null;
  uptime: number;
  status: "ok" | "info" | "warning" | "error";
  issues: { check: string; severity: "Info" | "Warning" | "Error"; detail: string[] }[];
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type WaitKind = "permission" | "input";

export interface WaitSpanDto {
  sessionId: string;
  projectRoot: string;
  projectName: string;
  kind: WaitKind;
  start: IsoDateTime;
  end: IsoDateTime;
  seconds: number;
  tool: string | null;
  isOpen: boolean;
}

export interface WaitReport {
  from: IsoDate;
  to: IsoDate;
  totalSeconds: number;
  count: number;
  averageSeconds: number;
  medianSeconds: number;
  permissionSeconds: number;
  inputSeconds: number;
  duringQuietHoursSeconds: number;
  topPermissionTool: string | null;
  longest: WaitSpanDto | null;
  /** 24 entries, local hours 0..23. */
  byHourSeconds: number[];
  byProject: { projectRoot: string; projectName: string; seconds: number }[];
  byDay: { date: IsoDate; permissionSeconds: number; inputSeconds: number }[];
  /** Up to 50 longest spans that started in the range. */
  longestSpans: WaitSpanDto[];
}

export type CostGrouping = "customer" | "project" | "model" | "agent";
export type CostRowKind = "normal" | "unassigned" | "buddy";

export interface CostReport {
  from: IsoDate;
  to: IsoDate;
  groupBy: CostGrouping;
  sessions: number;
  totals: TotalsDto;
  rows: {
    kind: CostRowKind;
    key: string;
    /** Already localized for `unassigned` / `buddy` (per `lang`). */
    name: string;
    color: string | null;
    projects: string[];
    sessions: number;
    totals: TotalsDto;
    /** 0..1 of the total cost (token share when nothing is priced). */
    share: number;
  }[];
}

export interface DailySummary {
  date: IsoDate;
  markdown: string;
  model: string | null;
  generatedAt: IsoDateTime;
}

export interface DailySummaryDetail {
  summary: DailySummary | null;
  input: {
    date: IsoDate;
    activeMinutes: number;
    sessions: number;
    tokens: number;
    costUsd: number;
    waitMinutes: number;
    hasActivity: boolean;
  };
}

export interface DailySummaryStatus {
  enabled: boolean;
  /** `HH:mm` local. */
  scheduledAt: string;
  withoutAi: boolean;
  model: string;
  generationAvailable: boolean;
  reason: string | null;
}

export interface Customer {
  id: number;
  name: string;
  color: string;
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectDto {
  root: string;
  name: string;
  manual: boolean;
  hidden: boolean;
  lastActivity: IsoDateTime | null;
  done: number;
  inProgress: number;
  total: number;
  percent: number;
  files: number;
  next: { file: string; text: string; group: string | null } | null;
  git: {
    branch: string | null;
    isDetached: boolean;
    hasUpstream: boolean;
    ahead: number;
    behind: number;
    changed: number;
    lastCommitAt: IsoDateTime | null;
    lastCommitSubject: string | null;
    checkedAt: IsoDateTime;
  } | null;
  customerId: number | null;
  /** The user's display name; null when `name` is the folder name. */
  alias: string | null;
}

export type TodoItemState = "open" | "inProgress" | "done";

export interface TodoFileDto {
  relativePath: string;
  done: number;
  inProgress: number;
  total: number;
  lastWriteUtc: IsoDateTime;
  groups: {
    title: string | null;
    level: number;
    done: number;
    total: number;
    items: { text: string; state: TodoItemState; line: number }[];
  }[];
}

// ---------------------------------------------------------------------------
// Personal tasks
// ---------------------------------------------------------------------------

export type TaskPriority = "low" | "normal" | "high";
export type TaskDueState = "none" | "upcoming" | "today" | "overdue";

export interface PersonalTask {
  id: number;
  text: string;
  title: string;
  details: string | null;
  projectRoot: string | null;
  projectName: string | null;
  dueDate: IsoDate | null;
  /** `HH:mm` */
  dueTime: string | null;
  priority: TaskPriority;
  dueState: TaskDueState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  completedAt: IsoDateTime | null;
}

/** Body of `POST /v1/tasks` and `PUT /v1/tasks/{id}` (PUT replaces every field). */
export interface TaskInput {
  text: string;
  projectRoot?: string | null;
  dueDate?: IsoDate | null;
  dueTime?: string | null;
  priority?: TaskPriority;
}

// ---------------------------------------------------------------------------
// Dictation
// ---------------------------------------------------------------------------

export interface DictationRecord {
  id: number;
  createdAt: IsoDateTime;
  durationSeconds: number;
  rawText: string;
  finalText: string;
  cleaned: boolean;
  mode: string | null;
  model: string | null;
  language: string | null;
  outputs: string | null;
}

export interface DictationModel {
  id: "large" | "small";
  fileName: string;
  size: number;
  installed: boolean;
  selected: boolean;
  partialBytes: number;
  downloading: boolean;
  /** 0..1 while downloading. */
  progress: number | null;
  error: string | null;
}

/** `POST /v1/dictation/transcribe` (body: f32 LE mono samples at 16 kHz). */
export interface DictationTranscribeResult {
  status: "ok" | "noSpeech" | "cancelled";
  /** Whisper output after removing annotations and known hallucinations; empty unless `ok`. */
  rawText: string;
  /** Speech length after trimming silence. */
  speechSeconds: number;
  model: "large" | "small";
  language: string;
}

/** `POST /v1/dictation/cleanup`. */
export interface DictationCleanupResult {
  finalText: string;
  /** False when AI cleanup is off, failed or was cancelled (then `finalText` is the input). */
  cleaned: boolean;
  note: "cleanupFailed" | null;
}

/** `POST /v1/dictations`. */
export interface DictationSaveResult {
  /** Null when history is off. */
  id: number | null;
  /** What the desktop sent plus `"file"` when the file output was written. */
  outputs: ("type" | "clipboard" | "file")[];
  fileError: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface RuleOptions {
  waitingPermissionEnabled: boolean;
  waitingInputEnabled: boolean;
  completedEnabled: boolean;
  staleEnabled: boolean;
  waitingReminderEnabled: boolean;
  todoCompletedEnabled: boolean;
  contextHighEnabled: boolean;
  contextThresholdPercent: number;
  contextRearmPercent: number;
  errorEnabled: boolean;
  errorDebounce: TimeSpanString;
  minTurnForCompleted: TimeSpanString;
  reminderAfter: TimeSpanString;
  debounce: TimeSpanString;
  settle: TimeSpanString;
}

export interface UsageRuleOptions {
  blockThresholdEnabled: boolean;
  blockTokenThresholds: number[];
  resetMargin: number;
  dailyCostEnabled: boolean;
  dailyCostThresholdUsd: number;
  burnProjectionEnabled: boolean;
}

export interface QuietHours {
  enabled: boolean;
  start: TimeOnlyString;
  end: TimeOnlyString;
}

export interface BuddySettings {
  enabled: boolean;
  /** Desktop mascot (robot snail, M6); off by default. */
  mascotEnabled: boolean;
  /** The one-time "turn on the mascot" suggestion was answered. */
  mascotOffered: boolean;
  hotkey: string;
  /** 2 | 3 | 4 = 32 / 48 / 64 px tall (the hub rejects anything else). */
  mascotScale: number;
  walkArea: "taskbar" | "corner";
  /** Short "done" hop after finished work. */
  celebrate: boolean;
  showBuddySessions: boolean;
  /** "Hide for 1 hour" from the mascot menu. */
  mascotHiddenUntil: IsoDateTime | null;
  /** 0..1 along the walking axis, kept after a drag. */
  mascotPosition: number;
}

export interface TaskSettings {
  hotkey: string;
  reminders: boolean;
}

export interface DictationSettings {
  enabled: boolean;
  hotkey: string;
  pasteLastHotkey: string;
  model: "large" | "small";
  language: "tr" | "en" | "auto";
  useGpu: boolean;
  aiCleanup: boolean;
  mode: "Clean" | "Message" | "Email" | "Custom";
  customPrompt: string;
  vocabulary: string;
  outputFocused: boolean;
  insertMethod: "paste" | "type";
  outputClipboard: boolean;
  outputFile: boolean;
  filePath: string;
  soundCues: boolean;
  maxMinutes: number;
  keepHistory: boolean;
}

export interface InsightSettings {
  gitEnabled: boolean;
  uncommittedThreshold: number;
  uncommittedInToast: boolean;
  dailySummaryEnabled: boolean;
  /** `HH:mm` */
  dailySummaryTime: string;
  dailySummaryWithoutAi: boolean;
  healthInfoBarLevel: "Info" | "Warning" | "Error";
}

/** `GET/PUT /v1/settings`: PUT sends the whole object back (every section required). */
export interface HubSettings {
  language: "en-US" | "tr-TR";
  rules: RuleOptions;
  usageRules: UsageRuleOptions;
  quietHours: QuietHours;
  doNotDisturbUntil: IsoDateTime | null;
  suppressWhenTerminalFocused: boolean;
  buddy: BuddySettings;
  tasks: TaskSettings;
  dictation: DictationSettings;
  tasksGlob: string;
  insights: InsightSettings;
  /** Always in GET; optional on PUT (left out = unchanged). */
  ai?: AiSettings;
}

// ---------------------------------------------------------------------------
// AI providers (M3)
// ---------------------------------------------------------------------------

/** `cli:<adapter id>` (e.g. `cli:claude-code`, `cli:codex`) or `openai:<provider name>`. */
export type AiProviderId = string;

export type AiErrorKind =
  | "none"
  | "notInstalled"
  | "notLoggedIn"
  | "unreachable"
  | "unauthorized"
  | "timeout"
  | "failed"
  | "cancelled"
  | "notConfigured";

/** An OpenAI-compatible endpoint in `settings.ai.providers`. The key is never here: see `PUT /v1/ai/providers/{name}/key`. */
export interface AiProviderSettings {
  /** 1–48 of `A-Z a-z 0-9 . _ -`, unique (case-insensitive). */
  name: string;
  kind: "openai";
  /** With or without the trailing `/v1`. */
  baseUrl: string;
  /** Default model when a feature names none. */
  model: string | null;
  /** Read-only (ignored on PUT). */
  hasKey: boolean;
}

export interface AiFeatureChoice {
  provider: AiProviderId;
  /** Null uses the provider's default (required for an `openai:` provider without a default model). */
  model: string | null;
}

export interface AiSettings {
  providers: AiProviderSettings[];
  assistant: AiFeatureChoice;
  dailySummary: AiFeatureChoice;
  dictationCleanup: AiFeatureChoice;
}

/** One entry of `GET /v1/ai/providers`: CLI agents only when installed, plus every configured endpoint. */
export interface AiProviderInfo {
  id: AiProviderId;
  kind: "cli" | "openai";
  displayName: string;
  installed: boolean;
  /** CLI: the headless flags were checked against the installed CLI's `--help`. Always true for `openai`. */
  verified: boolean;
  /** `openai` only. */
  hasKey: boolean | null;
  baseUrl: string | null;
  isLoopback: boolean;
}

/** `GET /v1/ai/providers`. */
export interface AiProvidersResponse {
  providers: AiProviderInfo[];
  /** Every enabled AI feature uses an `openai:` provider on a loopback host. */
  fullyLocal: boolean;
  /** False where no platform vault exists yet (keys cannot be saved). */
  secretStoreAvailable: boolean;
}

/** `POST /v1/ai/test` `{ provider, model? }`: never echoes the answer. */
export interface AiTestResult {
  ok: boolean;
  errorKind: AiErrorKind;
  latencyMs: number;
}

/** `GET /v1/ai/providers/{name}/models`. */
export interface AiModelsResponse {
  models: string[];
  errorKind: AiErrorKind;
}

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  contextWindow: number | null;
}

export interface PricingDto {
  path: string;
  error: string | null;
  models: Record<string, ModelPrice>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export type HookState = "missing" | "installed" | "outdated" | "invalidConfig" | "unsupported";

export interface HookStatusDto {
  state: HookState;
  configPath: string | null;
  needsApproval: boolean;
  /** Why installed hooks may still stay silent: Gemini folder trust, or the agent's own "hooks off" setting. */
  hint: HookHint | null;
}

export type HookHint = "folderTrust" | "hooksDisabled";

export type AdapterSource = "builtIn" | "user";

export type ScreenRuleState = "waitingPermission" | "waitingInput" | "working" | "done";

/** `adapter.json` as written (`schema/adapter.v1.json`); the hub validated it. */
export interface AdapterDefinition {
  v: 1;
  id: AgentId;
  displayName: string;
  avatar: { letter: string; bg: string; ink: string };
  detect: { executables?: string[]; nodeScripts?: string[] };
  launch: { command: string; args?: string[] };
  gracefulClose?: { keys: string; repeat?: number; gapMs?: number; waitMs?: number }[];
  permissionKeys?: { allowOnce?: string; alwaysAllow?: string; deny?: string };
  hooks?: { shell: "cmd" | "cmdUnquoted" | "powershell" | "any"; events: string[] };
  usage?: "none" | "builtIn" | "protocol";
  screenRules?: { id: string; state: ScreenRuleState; pattern: string; lines?: number; clearOn?: "output" | "input" }[];
}

export interface AdapterDto {
  id: AgentId;
  displayName: string;
  source: AdapterSource;
  /** Null when the file is missing or invalid (see `error`). */
  definition: AdapterDefinition | null;
  /** Null for protocol (hookless) adapters. */
  hooks: HookStatusDto | null;
  /** Why the definition is not used (invalid file, id taken by a built-in adapter); null when fine. */
  error: string | null;
}

export interface HookActionResult {
  state: HookState;
  backupPath: string | null;
  needsApproval: boolean;
}

// ---------------------------------------------------------------------------
// Stream (`/v1/stream`, forwarded by Rust as `hub:event`)
// ---------------------------------------------------------------------------

export type NotificationSeverity = "info" | "warning" | "attention";

export interface NotificationDto {
  /** `session.waiting_permission`, `session.completed`, `todo.completed`, `usage.daily_cost`, … */
  ruleId: string;
  agent: AgentId | null;
  sessionId: string | null;
  paneId: string | null;
  projectName: string | null;
  projectRoot: string | null;
  state: SessionState | null;
  /** Ready to show, in the hub's language: "<project>: <state>". */
  title: string;
  body: string;
  severity: NotificationSeverity;
  at: IsoDateTime;
}

/** Stream `tasks`: open personal tasks due today / overdue (nav badge). */
export interface TaskCounts {
  today: number;
  overdue: number;
}

export type StreamMessage =
  | { type: "sessions"; data: SessionDto[] }
  | { type: "usage"; data: UsageCurrent }
  | { type: "limits"; data: LimitDto[] }
  | { type: "health"; data: HealthDto }
  | { type: "tasks"; data: TaskCounts }
  | { type: "activity"; data: ActivityFrame }
  | { type: "notification"; data: NotificationDto };
