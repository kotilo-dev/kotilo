using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// OpenCode v2 (<c>@opencode/cli</c> 2.0.22) through Kotilo's server plugin (<c>adapters/opencode/plugin.js</c>). The plugin
/// forwards OpenCode's own event names (<c>permission.asked</c>, <c>session.execution.succeeded</c>, …) with a slim camelCase
/// payload it builds itself: <c>sessionId</c>, <c>cwd</c>, and for permissions and tool calls (<c>session.tool.called</c> /
/// <c>.success</c> / <c>.failed</c>, paired by <c>toolUseId</c>) <c>tool</c> plus <c>command</c>, <c>path</c> or <c>pattern</c>;
/// never message text. The plugin runs in OpenCode's shared background service, not in the pane's process tree, so the
/// hook's process chain says nothing about the agent process and is dropped here.
/// </summary>
public sealed class OpenCodeAdapter : IAgentAdapter
{
    /// <summary>Events the plugin forwards (sub-agent sessions are filtered out in the plugin).</summary>
    public static readonly IReadOnlyList<string> Events =
    [
        "session.created", "session.deleted", "session.status", "session.idle", "session.execution.started",
        "session.execution.succeeded", "session.execution.interrupted", "session.execution.failed",
        "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
        "session.tool.called", "session.tool.success", "session.tool.failed",
    ];

    public string Id => AgentIds.OpenCode;

    public string DisplayName => "OpenCode";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var p = envelope.Payload;
        var sessionId = JsonFields.GetString(p, "sessionId");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var kind = KindOf(envelope.Event);
        return new HookEvent(sessionId, kind, envelope.Event, envelope.ReceivedAt)
        {
            Agent = Id,
            PaneId = envelope.PaneId,
            WorkspaceId = envelope.WorkspaceId,
            Cwd = WindowsPath(JsonFields.GetString(p, "cwd")),
            ToolName = Clip(JsonFields.GetString(p, "tool"), AdapterMapping.MaxMessageLength),
            ToolCommand = Clip(JsonFields.GetString(p, "command"), AdapterMapping.MaxCommandLength),
            ToolPath = Clip(WindowsPath(JsonFields.GetString(p, "path")), AdapterMapping.MaxCommandLength),
            ToolUseId = JsonFields.GetString(p, "toolUseId"),
            ToolDetail = Clip(JsonFields.GetString(p, "pattern"), AdapterMapping.MaxDetailLength),
            Source = kind == HookEventKind.SessionStart ? "startup" : null,
            Reason = JsonFields.GetString(p, "reason"),
            ErrorType = kind == HookEventKind.Error ? ErrorKind(JsonFields.GetString(p, "errorType"), JsonFields.GetInt(p, "status")) : null,
            ErrorDetails = kind == HookEventKind.Error ? AdapterMapping.Truncate(JsonFields.GetString(p, "message")) : null,
            HookPid = envelope.HookPid,
        };
    }

    public static HookEventKind KindOf(string eventName) => eventName switch
    {
        "session.created" => HookEventKind.SessionStart,
        "session.deleted" => HookEventKind.SessionEnd,
        "session.status" or "session.execution.started" or "permission.replied" or "form.replied" or "form.cancelled" => HookEventKind.Working,
        "permission.asked" => HookEventKind.PermissionRequest,
        "form.created" => HookEventKind.WaitingInput,
        "session.tool.called" => HookEventKind.PreToolUse,
        "session.tool.success" => HookEventKind.PostToolUse,
        "session.tool.failed" => HookEventKind.PostToolUseFailure,
        "session.execution.succeeded" or "session.idle" => HookEventKind.Done,
        "session.execution.interrupted" => HookEventKind.Interrupt,
        "session.execution.failed" => HookEventKind.Error,
        _ => HookEventKind.Other,
    };

    /// <summary>OpenCode stores Windows paths with forward slashes (<c>C:/src/app</c>); the hub uses backslashes.</summary>
    public static string? WindowsPath(string? path) =>
        path is { Length: >= 3 } && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '/' ? path.Replace('/', '\\') : path;

    /// <summary>Protocol error kind from OpenCode's structured error (<c>type</c>, HTTP <c>status</c>).</summary>
    internal static string ErrorKind(string? type, int? status)
    {
        var t = type ?? string.Empty;
        bool Has(string s) => t.Contains(s, StringComparison.OrdinalIgnoreCase);
        if (status == 429 || Has("rate"))
        {
            return "rateLimit";
        }

        if (status is 401 or 403 || Has("auth"))
        {
            return "auth";
        }

        if (status is 503 or 529 || Has("overload"))
        {
            return "overloaded";
        }

        return Has("quota") || Has("usage") ? "usageLimit" : "api";
    }

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
