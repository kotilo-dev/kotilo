using System.Text.Json;

namespace Hub.Core.Sessions;

/// <summary>A context fill reading (0..100) and when it was taken.</summary>
public sealed record ContextSample(double Percent, DateTimeOffset At);

/// <summary>
/// Context window size per model id prefix (spec §18.4, <c>models.json</c>). The longest matching prefix wins;
/// unknown models have no size, so no transcript-based reading and no warning.
/// </summary>
public sealed class ModelContextTable
{
    /// <summary>Extended-context sessions report the model without a marker; a fill above the standard window means 1M.</summary>
    public const long ExtendedWindow = 1_000_000;

    private readonly List<KeyValuePair<string, long>> _prefixes;

    public ModelContextTable(IEnumerable<KeyValuePair<string, long>> prefixes) =>
        _prefixes = prefixes.Where(p => p.Value > 0).OrderByDescending(p => p.Key.Length).ToList();

    public static ModelContextTable Empty { get; } = new([]);

    /// <summary>Parses <c>{ "models": { "claude-": 200000, … } }</c>.</summary>
    public static ModelContextTable Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var list = new List<KeyValuePair<string, long>>();
        if (doc.RootElement.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in models.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.Number && p.Value.TryGetInt64(out var size))
                {
                    list.Add(new(p.Name, size));
                }
            }
        }

        return new ModelContextTable(list);
    }

    public long? WindowFor(string? model)
    {
        if (string.IsNullOrEmpty(model))
        {
            return null;
        }

        foreach (var p in _prefixes)
        {
            if (model.StartsWith(p.Key, StringComparison.OrdinalIgnoreCase))
            {
                return p.Value;
            }
        }

        return null;
    }
}

/// <summary>Picks the context fill to show and warn on (spec §18.4).</summary>
public static class ContextUsageResolver
{
    /// <summary>Statusline first, then transcript; readings taken before the last compact / clear are ignored.</summary>
    public static double? Resolve(ContextSample? statusLine, ContextSample? transcript, DateTimeOffset? resetAt)
    {
        if (statusLine is not null && (resetAt is null || statusLine.At > resetAt))
        {
            return statusLine.Percent;
        }

        if (transcript is not null && (resetAt is null || transcript.At > resetAt))
        {
            return transcript.Percent;
        }

        return null;
    }

    /// <summary>
    /// Percent from the last main-chain assistant message: input + cache read + cache creation over the model's window.
    /// Null for unknown models.
    /// </summary>
    public static double? FromTokens(long contextTokens, string? model, ModelContextTable table)
    {
        if (table.WindowFor(model) is not { } window || contextTokens < 0)
        {
            return null;
        }

        if (contextTokens > window && window < ModelContextTable.ExtendedWindow)
        {
            window = ModelContextTable.ExtendedWindow;
        }

        return Math.Min(100, contextTokens * 100.0 / window);
    }
}
