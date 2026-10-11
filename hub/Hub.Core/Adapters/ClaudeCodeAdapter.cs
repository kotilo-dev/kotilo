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
        };
    }

    private static HookEventKind Kind(string name) =>
        Enum.TryParse<HookEventKind>(name, ignoreCase: false, out var k) && k is not (HookEventKind.Other or HookEventKind.Interrupt or HookEventKind.PostCompact)
            ? k
            : HookEventKind.Other;
}
