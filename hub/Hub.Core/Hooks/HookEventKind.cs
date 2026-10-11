namespace Hub.Core.Hooks;

public enum HookEventKind
{
    Other,
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    Notification,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    SessionEnd,

    /// <summary>The user interrupted the turn (Codex <c>Interrupt</c>).</summary>
    Interrupt,

    /// <summary>The conversation was compacted mid-session; older context readings no longer apply.</summary>
    PostCompact,

    /// <summary>The agent is busy (protocol <c>working</c>): a turn is running, optionally in <see cref="HookEvent.ToolName"/>.</summary>
    Working,

    /// <summary>The agent asks the user something (protocol <c>waiting-input</c>, Copilot elicitation, OpenCode form).</summary>
    WaitingInput,

    /// <summary>The turn finished normally (protocol <c>done</c>): back to the prompt, like <see cref="Stop"/>.</summary>
    Done,

    /// <summary>The turn ended on an error (protocol <c>error</c>); <see cref="HookEvent.ErrorType"/> holds the kind.</summary>
    Error,

    /// <summary>Token usage of one model call (protocol <c>usage</c>); <see cref="HookEvent.Usage"/> holds the numbers.</summary>
    Usage,
}
