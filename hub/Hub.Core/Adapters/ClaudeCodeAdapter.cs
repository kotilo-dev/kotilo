using System.Text.Json;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>Claude Code hooks: event names are already the normalized kinds (spec §5.3).</summary>
public sealed class ClaudeCodeAdapter : IAgentAdapter
{
    public string Id => AgentIds.ClaudeCode;

    public string DisplayName => "Claude Code";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var e = AdapterMapping.Base(Id, envelope, Kind);
        if (e is null)
        {
            return null;
        }

        var p = envelope.Payload;
        return e with
        {
            Message = AdapterMapping.Truncate(JsonFields.GetString(p, "message")),
            NotificationType = JsonFields.GetString(p, "notification_type"),
            PermissionMode = JsonFields.GetString(p, "permission_mode"),
            Reason = JsonFields.GetString(p, "reason"),
            ErrorType = JsonFields.GetString(p, "error"),
            ErrorDetails = AdapterMapping.Truncate(JsonFields.GetString(p, "error_details")),
            BackgroundTasks = e.Kind is HookEventKind.Stop or HookEventKind.SubagentStop ? BackgroundTasks(p) : null,
            BackgroundShell = HasBackgroundShell(p),
        };
    }

    private static bool HasBackgroundShell(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object
        && payload.TryGetProperty("background_tasks", out var v)
        && v.ValueKind == JsonValueKind.Array
        && v.EnumerateArray().Any(x => x.ValueKind == JsonValueKind.Object && JsonFields.GetString(x, "type") == "shell");

    public const int MaxBackgroundTasks = 10;

    public const int MaxBackgroundLabelLength = 60;

    private static readonly string[] BackgroundLabelFields = ["description", "agent_type", "name", "type"];

    /// <summary>
    /// D-079: the <c>background_tasks</c> types that are work a paused turn waits for. Anything else (an artifact's
    /// live-update subscription, <c>monitor</c>, <c>MCP task</c>, unknown types) can stay open for the whole session and
    /// must not keep it Working.
    /// </summary>
    private static readonly string[] WorkTaskTypes = ["shell", "subagent", "workflow", "teammate", "cloud session"];

    /// <summary>
    /// <c>background_tasks</c>: one short label per work entry (D-079), taken from the first of <c>description</c>,
    /// <c>agent_type</c>, <c>name</c>, <c>type</c>; a bare string entry is its type. An empty list when nothing is work,
    /// null when the field is missing.
    /// </summary>
    internal static IReadOnlyList<string>? BackgroundTasks(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("background_tasks", out var v)
            || v.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        return v.EnumerateArray()
            .Where(IsWorkTask)
            .Take(MaxBackgroundTasks)
            .Select(Label)
            .ToList();

        static string Label(JsonElement x)
        {
            var label = x.ValueKind == JsonValueKind.String
                ? x.GetString()
                : BackgroundLabelFields
                    .Select(name => JsonFields.GetString(x, name))
                    .FirstOrDefault(s => !string.IsNullOrWhiteSpace(s));
            label = string.IsNullOrWhiteSpace(label) ? "task" : label.Trim().ReplaceLineEndings(" ");
            return AdapterMapping.Clip(label, MaxBackgroundLabelLength)!;
        }
    }

    private static bool IsWorkTask(JsonElement task)
    {
        var kind = task.ValueKind switch
        {
            JsonValueKind.String => task.GetString(),
            JsonValueKind.Object => JsonFields.GetString(task, "type"),
            _ => null,
        };
        return kind is not null && WorkTaskTypes.Contains(kind.Trim(), StringComparer.OrdinalIgnoreCase);
    }

    private static HookEventKind Kind(string name) =>
        Enum.TryParse<HookEventKind>(name, ignoreCase: false, out var k) && k is not (HookEventKind.Other or HookEventKind.Interrupt or HookEventKind.PostCompact)
            ? k
            : HookEventKind.Other;
}
