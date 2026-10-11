using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hub.Core.Usage;

/// <summary>Prices in USD per million tokens.</summary>
public sealed record ModelPrice(
    decimal Input,
    decimal Output,
    decimal CacheWrite5m,
    decimal CacheWrite1h,
    decimal CacheRead)
{
    /// <summary>Context window in tokens, if known (used for context % in Faz 6).</summary>
    public long? ContextWindow { get; init; }
}

/// <summary>
/// Model-prefix → price lookup loaded from <c>pricing.json</c> (spec §7.3). Prices are never hardcoded in code.
/// Fast-mode responses use the <c>&lt;prefix&gt;-fast</c> entry.
/// </summary>
public sealed class PricingTable
{
    public const string FastSuffix = "-fast";

    private readonly KeyValuePair<string, ModelPrice>[] _byLongestPrefix;

    public PricingTable(IReadOnlyDictionary<string, ModelPrice> models)
    {
        Models = models;
        _byLongestPrefix = models.OrderByDescending(kv => kv.Key.Length).ToArray();
    }

    public static PricingTable Empty { get; } = new(new Dictionary<string, ModelPrice>());

    public IReadOnlyDictionary<string, ModelPrice> Models { get; }

    public static PricingTable Parse(string json)
    {
        var file = JsonSerializer.Deserialize(json, PricingJsonContext.Default.PricingFile)
            ?? throw new JsonException("pricing.json is empty.");
        return new PricingTable(file.Models ?? new Dictionary<string, ModelPrice>());
    }

    /// <summary>Exact match first, then the longest key that prefixes the model id.</summary>
    public ModelPrice? Find(string? model, bool fast = false)
    {
        if (string.IsNullOrEmpty(model))
        {
            return null;
        }

        if (fast)
        {
            // Fast mode only has a price where pricing.json declares one; never fall back to standard rates.
            return Models.TryGetValue(model + FastSuffix, out var exactFast) ? exactFast : LookupFast(model);
        }

        return Lookup(model);
    }

    /// <summary>Cost of one entry, or null when the model is not priced.</summary>
    public decimal? Cost(UsageEntry e)
    {
        if (e.IsSynthetic)
        {
            return 0m;
        }

        var p = Find(e.Model, e.IsFast);
        if (p is null)
        {
            return null;
        }

        return ((e.Input * p.Input)
            + (e.Output * p.Output)
            + (e.CacheCreate5m * p.CacheWrite5m)
            + (e.CacheCreate1h * p.CacheWrite1h)
            + (e.CacheRead * p.CacheRead)) / 1_000_000m;
    }

    private ModelPrice? Lookup(string key)
    {
        if (Models.TryGetValue(key, out var exact))
        {
            return exact;
        }

        foreach (var (prefix, price) in _byLongestPrefix)
        {
            if (!prefix.EndsWith(FastSuffix, StringComparison.Ordinal) && key.StartsWith(prefix, StringComparison.Ordinal))
            {
                return price;
            }
        }

        return null;
    }

    /// <summary>"claude-opus-5-5-20260101" fast → "claude-opus-5-5-fast".</summary>
    private ModelPrice? LookupFast(string model)
    {
        foreach (var (key, price) in _byLongestPrefix)
        {
            if (key.EndsWith(FastSuffix, StringComparison.Ordinal)
                && model.StartsWith(key[..^FastSuffix.Length], StringComparison.Ordinal))
            {
                return price;
            }
        }

        return null;
    }

}

internal sealed class PricingFile
{
    [JsonPropertyName("models")]
    public Dictionary<string, ModelPrice>? Models { get; set; }
}

[JsonSourceGenerationOptions(
    PropertyNameCaseInsensitive = true,
    ReadCommentHandling = JsonCommentHandling.Skip,
    AllowTrailingCommas = true)]
[JsonSerializable(typeof(PricingFile))]
internal sealed partial class PricingJsonContext : JsonSerializerContext;
