using System.Text.Json;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// GitHub Copilot CLI hooks (1.0.91, docs/research/agents-copilot-opencode.md §1.2). Kotilo registers the camelCase
/// events, whose payloads are camelCase (<c>sessionId</c>, <c>toolName</c>, <c>toolArgs</c> as a JSON string) and carry no
/// event name: the hook command passes it with <c>--event</c>. <c>preToolUse</c> is never registered (a failing hook
/// blocks the tool). The model is not in any payload; prompt text arrives only as <c>prompt_length</c> (AGENTS.md rule 5).
/// </summary>
public sealed class CopilotAdapter : IAgentAdapter
{
    /// <summary>Events Kotilo registers in <c>~/.copilot/hooks/agenthub.json</c>.</summary>
    public static readonly IReadOnlyList<string> Events =
    [
        "sessionStart", "sessionEnd", "userPromptSubmitted", "postToolUse", "permissionRequest", "notification", "agentStop", "errorOccurred",
    ];

    public string Id => AgentIds.Copilot;

    public string DisplayName => "GitHub Copilot CLI";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var p = envelope.Payload;
        var sessionId = JsonFields.GetString(p, "sessionId") ?? JsonFields.GetString(p, "session_id");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var notificationType = JsonFields.GetString(p, "notification_type");
        var kind = KindOf(envelope.Event, notificationType, p);
        var args = ToolArgs(p);
        var error = JsonFields.GetObject(p, "error");
        var errorMessage = error is { } err ? JsonFields.GetString(err, "message") : null;
        var e = new HookEvent(sessionId, kind, envelope.Event, envelope.ReceivedAt)
        {
            Agent = Id,
            PaneId = envelope.PaneId,
            WorkspaceId = envelope.WorkspaceId,
            TranscriptPath = JsonFields.GetString(p, "transcriptPath"),
            Cwd = JsonFields.GetString(p, "cwd"),
            ToolName = Clip(JsonFields.GetString(p, "toolName"), AdapterMapping.MaxMessageLength),
            Message = AdapterMapping.Truncate(JsonFields.GetString(p, "message")),
            NotificationType = notificationType,
            Source = JsonFields.GetString(p, "source"),
            Reason = JsonFields.GetString(p, "reason"),
            PromptLength = JsonFields.GetInt(p, "prompt_length"),
            ErrorType = kind == HookEventKind.Error ? ErrorKind(error is { } e1 ? JsonFields.GetString(e1, "name") : null, errorMessage) : null,
            ErrorDetails = kind == HookEventKind.Error ? AdapterMapping.Truncate(errorMessage) : null,
            HookPid = envelope.HookPid,
            ParentPid = envelope.ParentPid,
            ProcessChain = envelope.ProcessChain,
        };
        return AdapterMapping.WithToolInput(e, args);
    }

    /// <summary>
    /// Event name → kind. <c>notification</c> goes through <see cref="Sessions.NotificationClassifier"/>
    /// (<c>permission_prompt</c>, <c>elicitation_dialog</c>), except <c>agent_idle</c>, which ends the turn.
    /// A recoverable <c>errorOccurred</c> (the CLI retries) changes nothing.
    /// </summary>
    internal static HookEventKind KindOf(string eventName, string? notificationType, JsonElement payload) => eventName switch
    {
        "sessionStart" => HookEventKind.SessionStart,
        "sessionEnd" => HookEventKind.SessionEnd,
        "userPromptSubmitted" => HookEventKind.UserPromptSubmit,
        "postToolUse" => HookEventKind.PostToolUse,
        "postToolUseFailure" => HookEventKind.PostToolUseFailure,
        "permissionRequest" => HookEventKind.PermissionRequest,
        "notification" when notificationType == "agent_idle" => HookEventKind.Done,
        "notification" => HookEventKind.Notification,
        "agentStop" => HookEventKind.Stop,
        "errorOccurred" when payload.ValueKind == JsonValueKind.Object
            && payload.TryGetProperty("recoverable", out var r) && r.ValueKind == JsonValueKind.True => HookEventKind.Other,
        "errorOccurred" => HookEventKind.Error,
        _ => HookEventKind.Other,
    };

    /// <summary>
    /// The tool's arguments: <c>toolInput</c> (permissionRequest) or <c>toolArgs</c> (tool events), each either an object or a
    /// JSON string. Null when absent or not parseable.
    /// </summary>
    internal static JsonElement? ToolArgs(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var name in (ReadOnlySpan<string>)["toolInput", "toolArgs"])
        {
            if (!payload.TryGetProperty(name, out var value))
            {
                continue;
            }

            if (value.ValueKind == JsonValueKind.Object)
            {
                return value;
            }

            if (value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 1 and <= 1_000_000 } text && text.TrimStart().StartsWith('{'))
            {
                try
                {
                    using var doc = JsonDocument.Parse(text);
                    return doc.RootElement.Clone();
                }
                catch (JsonException)
                {
                    return null;
                }
            }
        }

        return null;
    }

    /// <summary>Protocol error kind (<c>rateLimit</c>, <c>usageLimit</c>, <c>auth</c>, <c>overloaded</c>, else <c>api</c>) from the error's name and text.</summary>
    internal static string ErrorKind(string? name, string? message)
    {
        var text = $"{name} {message}";
        bool Has(string s) => text.Contains(s, StringComparison.OrdinalIgnoreCase);
        if (Has("rate limit") || Has("ratelimit") || Has("429"))
        {
            return "rateLimit";
        }

        if (Has("quota") || Has("premium request"))
        {
            return "usageLimit";
        }

        if (Has("unauthorized") || Has("authentication") || Has("401"))
        {
            return "auth";
        }

        return Has("overloaded") || Has("503") ? "overloaded" : "api";
    }

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
