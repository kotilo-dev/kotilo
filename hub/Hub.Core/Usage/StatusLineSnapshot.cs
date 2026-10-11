using System.Text.Json;

namespace Hub.Core.Usage;

/// <summary>Fields Kotilo takes from Claude Code's statusLine JSON (spec §9). Unknown fields are ignored.</summary>
public sealed record StatusLineSnapshot(string SessionId, DateTimeOffset At)
{
    public string? ModelId { get; init; }

    public string? ModelDisplayName { get; init; }

    public double? ContextUsedPercent { get; init; }

    public long? ContextWindowSize { get; init; }

    public decimal? SessionCostUsd { get; init; }

    public string? Version { get; init; }

    public string? Cwd { get; init; }

    /// <summary>Plan limits (D-074); null for API-key users and before the session's first API response.</summary>
    public PlanLimits? Limits { get; init; }

    public static StatusLineSnapshot? Parse(ReadOnlySpan<byte> json, DateTimeOffset at)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Str(root, "session_id") is not { Length: > 0 } sessionId)
            {
                return null;
            }

            var model = Obj(root, "model");
            var context = Obj(root, "context_window");
            var cost = Obj(root, "cost");
            return new StatusLineSnapshot(sessionId, at)
            {
                ModelId = model is { } m ? Str(m, "id") : null,
                ModelDisplayName = model is { } m2 ? Str(m2, "display_name") : null,
                ContextUsedPercent = context is { } c && c.TryGetProperty("used_percentage", out var p) && p.ValueKind == JsonValueKind.Number
                    ? p.GetDouble() : null,
                ContextWindowSize = context is { } c2 && c2.TryGetProperty("context_window_size", out var s) && s.ValueKind == JsonValueKind.Number
                    && s.TryGetInt64(out var size) ? size : null,
                SessionCostUsd = cost is { } k && k.TryGetProperty("total_cost_usd", out var t) && t.ValueKind == JsonValueKind.Number
                    && t.TryGetDecimal(out var usd) ? usd : null,
                Version = Str(root, "version"),
                Cwd = Str(root, "cwd"),
                Limits = PlanLimits.Parse(root, at),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static JsonElement? Obj(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
