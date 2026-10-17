namespace Hub.Core.Sessions;

/// <summary>Current view of one agent session (spec §6.4), plus bookkeeping the state machine needs.</summary>
public sealed record SessionInfo(
    string SessionId,
    string ProjectRoot,
    string ProjectName,
    string? TranscriptPath,
    SessionState State,
    DateTimeOffset StateSince,
    DateTimeOffset LastEventAt,
    string? CurrentTool,
    string? LastNotification,
    string? Model,
    int? ParentPid,
    long TokensThisSession,
    decimal? CostUsdThisSession,
    double? ContextUsedPercent)
{
    /// <summary>Adapter id; together with <see cref="SessionId"/> it identifies the session.</summary>
    public string Agent { get; init; } = Hooks.HookEnvelope.DefaultAgent;

    /// <summary>Kotilo terminal pane the session runs in, when started inside the app.</summary>
    public string? PaneId { get; init; }

    /// <summary>When the current turn started (last UserPromptSubmit, or first Working event if none was seen).</summary>
    public DateTimeOffset? TurnStartedAt { get; init; }

    public DateTimeOffset? LastCompletedAt { get; init; }

    /// <summary>When the user last looked at the session's finished work (opened it, marked it seen, or sent a new prompt).</summary>
    public DateTimeOffset? SeenAt { get; init; }

    /// <summary>A turn finished after the user last looked, and the session is not working or waiting.</summary>
    public bool IsUnseen =>
        (State is SessionState.Idle or SessionState.Ended or SessionState.Stale) && HasUnseenCompletion;

    /// <summary>A turn finished after <see cref="SeenAt"/>, whatever the current state.</summary>
    public bool HasUnseenCompletion => LastCompletedAt is { } done && done > (SeenAt ?? DateTimeOffset.MinValue);

    public DateTimeOffset? EndedAt { get; init; }

    public string? EndReason { get; init; }

    public int ActiveSubagents { get; init; }

    /// <summary>
    /// Labels of the background work a finished turn is waiting for (Claude Code <c>Stop.background_tasks</c>); the session
    /// stays Working while this is non-empty. In memory only (never persisted).
    /// </summary>
    public IReadOnlyList<string> BackgroundTasks { get; init; } = [];

    /// <summary>Set while <see cref="State"/> is <see cref="SessionState.Error"/>.</summary>
    public SessionError? Error { get; init; }

    /// <summary>Context reading from the statusLine (preferred source, spec §18.4).</summary>
    public ContextSample? StatusLineContext { get; init; }

    /// <summary>Context computed from the last transcript entry (fallback).</summary>
    public ContextSample? TranscriptContext { get; init; }

    /// <summary>Last <c>/compact</c> or <c>/clear</c>: older context readings no longer apply.</summary>
    public DateTimeOffset? ContextResetAt { get; init; }

    /// <summary>Claude Code task list counts, when the session has one (spec §8.3).</summary>
    public Projects.TaskListProgress? Tasks { get; init; }

    /// <summary>Set only while <see cref="State"/> is <see cref="SessionState.WaitingPermission"/>. In memory only (never persisted).</summary>
    public PermissionPrompt? PendingPermission { get; init; }

    public static string ProjectNameFrom(string projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
        {
            return "?";
        }

        // Both separators on every OS: roots recorded on Windows keep their names elsewhere.
        var trimmed = projectRoot.TrimEnd('\\', '/');
        var name = trimmed[(trimmed.LastIndexOfAny(['\\', '/']) + 1)..];
        return string.IsNullOrEmpty(name) ? trimmed : name;
    }
}

/// <summary>Transcript-derived usage for one session.</summary>
public sealed record SessionUsage(long Tokens, decimal? CostUsd, string? LastModel);
