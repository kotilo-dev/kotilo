using System.Text.Json;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Adapters;

/// <summary>
/// Agent Integration Protocol v1 (docs/agent-protocol.md, schema/agent-protocol.v1.json): the adapter every user-defined
/// agent gets. Event names are the protocol's kebab-case names and payload keys are camelCase. Text fields are kept only
/// as far as the UI needs them (tool, command, path, error message clipped); a question's text never arrives
/// (the hook sends <c>question_length</c>).
/// </summary>
public sealed class GenericAdapter(string id, string displayName) : IAgentAdapter
{
    /// <summary>Session id used when an event has none but comes from an Kotilo pane.</summary>
    public const string PaneSessionPrefix = "pane:";

    public string Id => id;

    public string DisplayName => displayName;

    public HookEvent? Map(HookEnvelope envelope)
    {
        var p = envelope.Payload;
        var sessionId = JsonFields.GetString(p, "sessionId");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            if (string.IsNullOrWhiteSpace(envelope.PaneId))
            {
                return null;
            }

            sessionId = PaneSessionPrefix + envelope.PaneId;
        }

        var kind = KindOf(envelope.Event);
        var usage = kind == HookEventKind.Usage ? UsageOf(p) : null;
        if (kind == HookEventKind.Usage && usage is null)
        {
            // A usage event without its token counts says nothing; keep it as a plain activity ping.
            kind = HookEventKind.Other;
        }

        return new HookEvent(sessionId, kind, envelope.Event, envelope.ReceivedAt)
        {
            Agent = id,
            PaneId = envelope.PaneId,
            WorkspaceId = envelope.WorkspaceId,
            Cwd = JsonFields.GetString(p, "cwd"),
            Model = JsonFields.GetString(p, "model"),
            ToolName = Clip(JsonFields.GetString(p, "tool"), AdapterMapping.MaxMessageLength),
            ToolCommand = Clip(JsonFields.GetString(p, "command"), AdapterMapping.MaxCommandLength),
            ToolPath = Clip(JsonFields.GetString(p, "path"), AdapterMapping.MaxCommandLength),
            Risk = RiskOf(JsonFields.GetString(p, "risk")),
            ErrorType = kind == HookEventKind.Error ? JsonFields.GetString(p, "kind") ?? "api" : null,
            ErrorDetails = kind == HookEventKind.Error ? AdapterMapping.Truncate(JsonFields.GetString(p, "message")) : null,
            Reason = JsonFields.GetString(p, "reason"),
            Usage = usage,
            HookPid = envelope.HookPid,
            ParentPid = envelope.ParentPid,
            ProcessChain = envelope.ProcessChain,
        };
    }

    /// <summary>Protocol event name → normalized kind; unknown names are kept as <see cref="HookEventKind.Other"/>.</summary>
    public static HookEventKind KindOf(string eventName) => eventName switch
    {
        "session-start" => HookEventKind.SessionStart,
        "working" => HookEventKind.Working,
        "waiting-permission" => HookEventKind.PermissionRequest,
        "waiting-input" => HookEventKind.WaitingInput,
        "done" => HookEventKind.Done,
        "error" => HookEventKind.Error,
        "session-end" => HookEventKind.SessionEnd,
        "usage" => HookEventKind.Usage,
        _ => HookEventKind.Other,
    };

    /// <summary>A risk name as the hub API spells it (<c>deletesFiles</c>, …, <c>other</c>); anything else is null.</summary>
    public static PermissionRisk? RiskOf(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        foreach (var risk in Enum.GetValues<PermissionRisk>())
        {
            if (string.Equals(JsonNamingPolicy.CamelCase.ConvertName(risk.ToString()), value, StringComparison.Ordinal))
            {
                return risk;
            }
        }

        return null;
    }

    private static ReportedUsage? UsageOf(JsonElement p)
    {
        if (JsonFields.GetLong(p, "inputTokens") is not { } input || JsonFields.GetLong(p, "outputTokens") is not { } output
            || input < 0 || output < 0)
        {
            return null;
        }

        var cached = Math.Max(0, JsonFields.GetLong(p, "cachedTokens") ?? 0);
        decimal? cost = JsonFields.GetDouble(p, "costUsd") is { } c && c is >= 0 and < 1_000_000 ? (decimal)c : null;
        return new ReportedUsage(JsonFields.GetString(p, "model"), input, output, cached, cost);
    }

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
