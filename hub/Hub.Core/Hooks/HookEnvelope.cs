using System.Text.Json;

namespace Hub.Core.Hooks;

public enum HookParseError
{
    None,
    InvalidJson,
    MissingPayload,
    MissingSessionId,

    /// <summary>The envelope names an agent no adapter is registered for.</summary>
    UnknownAgent,

    /// <summary>The envelope's <c>v</c> is not a version this hub reads.</summary>
    UnsupportedVersion,
}

/// <summary>
/// Hook envelope v1 (<c>schema/hook-envelope.v1.json</c>) as written by agenthub-hook: routing metadata plus the agent's
/// own stdin JSON, untouched, in <see cref="Payload"/>. Adapters turn it into a normalized <see cref="HookEvent"/>.
/// </summary>
public sealed record HookEnvelope(string Agent, string Event, DateTimeOffset ReceivedAt, JsonElement Payload)
{
    /// <summary>Envelopes without <c>agent</c> come from the original Claude-only hook (CCC compatibility).</summary>
    public const string DefaultAgent = "claude-code";

    public const int CurrentVersion = 1;

    public int Version { get; init; } = 1;

    public string? PaneId { get; init; }

    public string? WorkspaceId { get; init; }

    public int? HookPid { get; init; }

    public int? ParentPid { get; init; }

    public IReadOnlyList<ProcessRef> ProcessChain { get; init; } = [];

    public static HookEnvelope? Parse(ReadOnlySpan<byte> json, out HookParseError error)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = 64 });
            return FromElement(doc.RootElement, out error);
        }
        catch (JsonException)
        {
            error = HookParseError.InvalidJson;
            return null;
        }
    }

    /// <summary>
    /// Tolerant: unknown fields are ignored and wrong-typed optional fields read as absent. A missing or <c>null</c>
    /// payload reads as <c>{}</c> (a protocol event like <c>done</c> may carry nothing); any other non-object is rejected.
    /// </summary>
    public static HookEnvelope? FromElement(JsonElement root, out HookParseError error)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            error = HookParseError.MissingPayload;
            return null;
        }

        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind == JsonValueKind.Null)
        {
            payload = EmptyPayload;
        }
        else if (payload.ValueKind != JsonValueKind.Object)
        {
            error = HookParseError.MissingPayload;
            return null;
        }

        var agent = JsonFields.GetString(root, "agent");
        var name = JsonFields.GetString(root, "event");
        error = HookParseError.None;
        return new HookEnvelope(
            string.IsNullOrWhiteSpace(agent) ? DefaultAgent : agent,
            string.IsNullOrWhiteSpace(name) ? JsonFields.GetString(payload, "hook_event_name") ?? string.Empty : name,
            JsonFields.GetDate(root, "receivedAt") ?? JsonFields.GetEpochMs(root, "tsMs") ?? DateTimeOffset.UtcNow,
            payload.Clone())
        {
            Version = JsonFields.GetInt(root, "v") ?? 1,
            PaneId = JsonFields.GetString(root, "paneId"),
            WorkspaceId = JsonFields.GetString(root, "workspaceId"),
            HookPid = JsonFields.GetInt(root, "hookPid"),
            ParentPid = JsonFields.GetInt(root, "parentPid"),
            ProcessChain = Chain(root),
        };
    }

    private static readonly JsonElement EmptyPayload = EmptyObject();

    private static JsonElement EmptyObject()
    {
        using var doc = JsonDocument.Parse("{}");
        return doc.RootElement.Clone();
    }

    private static List<ProcessRef> Chain(JsonElement root)
    {
        var list = new List<ProcessRef>();
        if (!root.TryGetProperty("processChain", out var chain) || chain.ValueKind != JsonValueKind.Array)
        {
            return list;
        }

        foreach (var item in chain.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object && JsonFields.GetInt(item, "pid") is { } pid)
            {
                list.Add(new ProcessRef(pid, JsonFields.GetString(item, "name") ?? string.Empty));
            }
        }

        return list;
    }
}

/// <summary>Null-safe readers for hook JSON: a missing or wrong-typed field is simply absent.</summary>
public static class JsonFields
{
    public static string? GetString(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    public static int? GetInt(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i)
            ? i
            : null;

    public static long? GetLong(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var i)
            ? i
            : null;

    public static double? GetDouble(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? v.GetDouble()
            : null;

    public static DateTimeOffset? GetDate(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.TryGetDateTimeOffset(out var d)
            ? d
            : null;

    public static JsonElement? GetObject(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    internal static DateTimeOffset? GetEpochMs(JsonElement obj, string name)
    {
        if (GetLong(obj, name) is not { } ms)
        {
            return null;
        }

        try
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(ms);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }
}
