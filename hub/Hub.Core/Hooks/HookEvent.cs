namespace Hub.Core.Hooks;

/// <summary>
/// A normalized agent event, mapped from a hook envelope by the agent's adapter. Only metadata is kept: prompt text, tool output
/// and assistant messages are never copied (spec §1.2, §5.3). The tool's command/path is kept for the permission card,
/// in memory only.
/// </summary>
public sealed record HookEvent(
    string SessionId,
    HookEventKind Kind,
    string HookEventName,
    DateTimeOffset ReceivedAt)
{
    /// <summary>Adapter id (<c>claude-code</c>, <c>codex</c>, …). Sessions are keyed by agent + session id.</summary>
    public string Agent { get; init; } = HookEnvelope.DefaultAgent;

    /// <summary>Kotilo terminal pane the agent runs in; null when started outside the app.</summary>
    public string? PaneId { get; init; }

    public string? WorkspaceId { get; init; }

    public string? TranscriptPath { get; init; }

    public string? Cwd { get; init; }

    public string? ToolName { get; init; }

    /// <summary><c>tool_input.command</c> (shell tools), truncated. In memory only: never stored or logged.</summary>
    public string? ToolCommand { get; init; }

    /// <summary><c>tool_input.file_path</c> / <c>path</c> / <c>notebook_path</c> (edit tools). In memory only.</summary>
    public string? ToolPath { get; init; }

    /// <summary>Notification text. Short UI message from Claude Code, not conversation content.</summary>
    public string? Message { get; init; }

    public string? NotificationType { get; init; }

    /// <summary>SessionStart source: startup / resume / clear / compact / fork.</summary>
    public string? Source { get; init; }

    /// <summary>SessionEnd reason.</summary>
    public string? Reason { get; init; }

    public string? Model { get; init; }

    /// <summary>StopFailure error type (rate_limit, overloaded, authentication_failed, …).</summary>
    public string? ErrorType { get; init; }

    /// <summary>StopFailure API error text; used only to classify the error and read a reset time, never stored.</summary>
    public string? ErrorDetails { get; init; }

    public int? PromptLength { get; init; }

    /// <summary>Set when the event comes from a subagent.</summary>
    public string? AgentId { get; init; }

    public int? HookPid { get; init; }

    public int? ParentPid { get; init; }

    /// <summary>Hook's ancestor chain, nearest first, as collected by agenthub-hook (decision D-021).</summary>
    public IReadOnlyList<ProcessRef> ProcessChain { get; init; } = [];

    /// <summary>Risk the agent itself reported for a permission request (protocol <c>risk</c>); null: the hub classifies.</summary>
    public Sessions.PermissionRisk? Risk { get; init; }

    /// <summary>Token counts of a <see cref="HookEventKind.Usage"/> event.</summary>
    public ReportedUsage? Usage { get; init; }

    /// <summary>Context window fill (0..100) the agent itself reported with this event (Qwen <c>Stop.context_usage</c>).</summary>
    public double? ContextPercent { get; init; }

    /// <summary><c>tool_use_id</c>: pairs a tool's Pre and Post events (activity timeline). In memory only.</summary>
    public string? ToolUseId { get; init; }

    /// <summary>Every file an <c>apply_patch</c> call names (agenthub-hook replaces the patch body by them). In memory only.</summary>
    public IReadOnlyList<string>? ToolPaths { get; init; }

    /// <summary>A short label of a tool call without path or command: search pattern, URL, query or description (clipped).</summary>
    public string? ToolDetail { get; init; }

    /// <summary>Tool run time the agent reported on its Post event (Qwen <c>duration_ms</c>, Cursor <c>duration</c>).</summary>
    public long? ToolDurationMs { get; init; }

    /// <summary>A TodoWrite plan (<c>tool_input.todos</c>, texts clipped by agenthub-hook). In memory only.</summary>
    public IReadOnlyList<TodoItem>? Todos { get; init; }
}

/// <summary>One plan item of a TodoWrite call: text and <c>pending</c> | <c>in_progress</c> | <c>completed</c>.</summary>
public sealed record TodoItem(string Text, string Status);

public sealed record ProcessRef(int Pid, string Name);

/// <summary>
/// One model call's usage as an agent reports it (protocol <c>usage</c>). <paramref name="InputTokens"/> excludes
/// <paramref name="CachedTokens"/> (cache reads); <paramref name="CostUsd"/> is the agent's own figure, if it has one.
/// </summary>
public sealed record ReportedUsage(string? Model, long InputTokens, long OutputTokens, long CachedTokens, decimal? CostUsd);
