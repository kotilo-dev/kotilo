namespace Hub.Core.Usage;

/// <summary>
/// One deduplicated API response's token usage, extracted from a transcript line (spec §7.2).
/// Only metadata: no prompt, response or tool content.
/// </summary>
public sealed record UsageEntry(
    string DedupKey,
    DateTimeOffset Timestamp,
    long Input,
    long Output,
    long CacheCreate5m,
    long CacheCreate1h,
    long CacheRead)
{
    /// <summary>Adapter id of the agent that wrote this usage.</summary>
    public string Agent { get; init; } = Hooks.HookEnvelope.DefaultAgent;

    public string? SessionId { get; init; }

    /// <summary>Transcript <c>cwd</c>; never decoded from the folder name (spec §4).</summary>
    public string? ProjectRoot { get; init; }

    public string? Model { get; init; }

    public bool IsSidechain { get; init; }

    /// <summary><c>usage.speed == "fast"</c>: billed at fast-mode rates.</summary>
    public bool IsFast { get; init; }

    /// <summary>Null when the model has no price (shown as "?").</summary>
    public decimal? CostUsd { get; init; }

    /// <summary><see cref="CostUsd"/> is the agent's own figure (protocol <c>costUsd</c>); a price-table change keeps it.</summary>
    public bool CostReported { get; init; }

    public long CacheCreate => CacheCreate5m + CacheCreate1h;

    /// <summary>All four token types (same definition as ccusage's total).</summary>
    public long TotalTokens => Input + Output + CacheCreate + CacheRead;

    /// <summary>Claude Code's placeholder model for locally generated messages.</summary>
    public bool IsSynthetic => Model == SyntheticModel;

    public const string SyntheticModel = "<synthetic>";
}
