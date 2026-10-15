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
            Reason = JsonFields.GetString(p, "reason"),
            ErrorType = JsonFields.GetString(p, "error"),
            ErrorDetails = AdapterMapping.Truncate(JsonFields.GetString(p, "error_details")),
            BackgroundTasks = e.Kind is HookEventKind.Stop or HookEventKind.SubagentStop ? BackgroundTasks(p) : null,
        };
    }

    public const int MaxBackgroundTasks = 10;

    public const int MaxBackgroundLabelLength = 60;

    private static readonly string[] BackgroundLabelFields = ["description", "agent_type", "name", "type"];

    /// <summary>
    /// <c>background_tasks</c> (shell, subagent, monitor, workflow, teammate, …): one short label per entry, taken from the
    /// first of <c>description</c>, <c>agent_type</c>, <c>name</c>, <c>type</c>. The element shape is not documented in
    /// detail, so anything else is ignored; an entry without a label still counts. Null when the field is missing.
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
            .Where(x => x.ValueKind is JsonValueKind.Object or JsonValueKind.String)
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

    private static HookEventKind Kind(string name) =>
        Enum.TryParse<HookEventKind>(name, ignoreCase: false, out var k) && k is not (HookEventKind.Other or HookEventKind.Interrupt or HookEventKind.PostCompact)
            ? k
            : HookEventKind.Other;
}
