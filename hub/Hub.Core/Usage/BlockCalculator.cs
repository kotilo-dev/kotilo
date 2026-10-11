namespace Hub.Core.Usage;

/// <summary>A 5-hour usage block, or a gap between blocks (no entries).</summary>
public sealed record UsageBlock(
    DateTimeOffset Start,
    DateTimeOffset End,
    DateTimeOffset? LastEntryAt,
    bool IsGap,
    UsageTotals Totals)
{
    public string Id => (IsGap ? "gap-" : "block-") + Start.UtcDateTime.ToString("yyyyMMddTHHmm", System.Globalization.CultureInfo.InvariantCulture);
}

/// <summary>Live view of the active block (spec §7.4).</summary>
/// <param name="TokensPerMinute">Burn rate: all token types over the last 15 minutes.</param>
/// <param name="CostPerHour">Cost burn over the same window.</param>
/// <param name="ProjectedTokens">Total at block end if the burn rate holds.</param>
public sealed record ActiveBlockStatus(
    UsageBlock Block,
    TimeSpan Remaining,
    double TokensPerMinute,
    decimal CostPerHour,
    long ProjectedTokens,
    decimal ProjectedCostUsd);

/// <summary>
/// 5-hour block identification (spec §7.4; rules in decision D-010, independent of ccusage's code):
/// a block starts at the first entry floored to the UTC hour and lasts 5 hours; an entry more than
/// 5 hours after the block start or after the previous entry opens a new block, with a gap block in
/// between when the idle period itself exceeded 5 hours.
/// </summary>
public static class BlockCalculator
{
    public static readonly TimeSpan BlockLength = TimeSpan.FromHours(5);
    public static readonly TimeSpan BurnWindow = TimeSpan.FromMinutes(15);

    public static IReadOnlyList<UsageBlock> Identify(IEnumerable<UsageEntry> entries)
    {
        var sorted = entries.OrderBy(e => e.Timestamp).ToList();
        var blocks = new List<UsageBlock>();
        if (sorted.Count == 0)
        {
            return blocks;
        }

        var current = new List<UsageEntry>();
        var blockStart = FloorToHour(sorted[0].Timestamp);

        foreach (var e in sorted)
        {
            if (current.Count > 0)
            {
                var previous = current[^1].Timestamp;
                var sinceStart = e.Timestamp - blockStart;
                var sinceLast = e.Timestamp - previous;
                if (sinceStart > BlockLength || sinceLast > BlockLength)
                {
                    blocks.Add(Close(blockStart, current));
                    if (sinceLast > BlockLength)
                    {
                        blocks.Add(new UsageBlock(previous + BlockLength, e.Timestamp, null, true, UsageTotals.Zero));
                    }

                    current = [];
                    blockStart = FloorToHour(e.Timestamp);
                }
            }

            current.Add(e);
        }

        blocks.Add(Close(blockStart, current));
        return blocks;
    }

    /// <summary>The active block at <paramref name="now"/>, or null (spec §7.4 / D-010 "active" rule).</summary>
    public static ActiveBlockStatus? Active(IEnumerable<UsageEntry> entries, DateTimeOffset now)
    {
        var list = entries as IReadOnlyCollection<UsageEntry> ?? entries.ToList();
        var last = Identify(list).LastOrDefault(b => !b.IsGap);
        if (last?.LastEntryAt is not { } lastEntry || now >= last.End || now - lastEntry >= BlockLength)
        {
            return null;
        }

        var windowStart = now - BurnWindow;
        var recent = UsageTotals.Sum(list.Where(e => e.Timestamp > windowStart && e.Timestamp <= now && e.Timestamp >= last.Start));
        var tokensPerMinute = recent.TotalTokens / BurnWindow.TotalMinutes;
        var costPerHour = recent.CostUsd * (decimal)(60 / BurnWindow.TotalMinutes);
        var remaining = last.End - now;

        return new ActiveBlockStatus(
            last,
            remaining,
            tokensPerMinute,
            costPerHour,
            last.Totals.TotalTokens + (long)Math.Round(tokensPerMinute * remaining.TotalMinutes),
            Math.Round(last.Totals.CostUsd + (costPerHour * (decimal)remaining.TotalHours), 2));
    }

    /// <summary>Highest tokens/minute over 15-minute buckets of the block (Usage screen "tepe hız").</summary>
    public static double PeakTokensPerMinute(IEnumerable<UsageEntry> blockEntries) =>
        blockEntries
            .GroupBy(e => e.Timestamp.ToUnixTimeSeconds() / (long)BurnWindow.TotalSeconds)
            .Select(g => g.Sum(e => e.TotalTokens) / BurnWindow.TotalMinutes)
            .DefaultIfEmpty(0)
            .Max();

    public static DateTimeOffset FloorToHour(DateTimeOffset t)
    {
        var utc = t.ToUniversalTime();
        return new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }

    private static UsageBlock Close(DateTimeOffset start, List<UsageEntry> entries) =>
        new(start, start + BlockLength, entries[^1].Timestamp, false, UsageTotals.Sum(entries));
}
