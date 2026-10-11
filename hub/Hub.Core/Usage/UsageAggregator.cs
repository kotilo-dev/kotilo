namespace Hub.Core.Usage;

public sealed record DailyUsage(DateOnly Date, UsageTotals Totals, int Sessions);

public sealed record UsageBreakdown(string Key, UsageTotals Totals);

/// <summary>Day / week totals in the local time zone (week starts Monday) and per-key breakdowns (spec §7.4).</summary>
public static class UsageAggregator
{
    public static DateOnly LocalDate(DateTimeOffset t, TimeZoneInfo zone) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(t, zone).DateTime);

    public static DateOnly WeekStart(DateOnly date)
    {
        var offset = ((int)date.DayOfWeek + 6) % 7; // Monday = 0
        return date.AddDays(-offset);
    }

    /// <summary>One row per day in [<paramref name="from"/>, <paramref name="to"/>], including empty days.</summary>
    public static IReadOnlyList<DailyUsage> Daily(IEnumerable<UsageEntry> entries, TimeZoneInfo zone, DateOnly from, DateOnly to)
    {
        var byDay = entries
            .GroupBy(e => LocalDate(e.Timestamp, zone))
            .Where(g => g.Key >= from && g.Key <= to)
            .ToDictionary(g => g.Key, g => g.ToList());

        var result = new List<DailyUsage>();
        for (var d = from; d <= to; d = d.AddDays(1))
        {
            result.Add(byDay.TryGetValue(d, out var list)
                ? new DailyUsage(d, UsageTotals.Sum(list), list.Select(e => e.SessionId).Distinct().Count())
                : new DailyUsage(d, UsageTotals.Zero, 0));
        }

        return result;
    }

    public static UsageTotals Day(IEnumerable<UsageEntry> entries, TimeZoneInfo zone, DateOnly day) =>
        UsageTotals.Sum(entries.Where(e => LocalDate(e.Timestamp, zone) == day));

    /// <summary>Monday-based week containing <paramref name="day"/>, up to and including that day.</summary>
    public static UsageTotals WeekToDate(IEnumerable<UsageEntry> entries, TimeZoneInfo zone, DateOnly day)
    {
        var start = WeekStart(day);
        return UsageTotals.Sum(entries.Where(e =>
        {
            var d = LocalDate(e.Timestamp, zone);
            return d >= start && d <= day;
        }));
    }

    public static IReadOnlyList<UsageBreakdown> ByProject(IEnumerable<UsageEntry> entries) =>
        Breakdown(entries, e => e.ProjectRoot ?? "?");

    /// <summary>Model breakdown; the synthetic placeholder model is left out (D-010).</summary>
    public static IReadOnlyList<UsageBreakdown> ByModel(IEnumerable<UsageEntry> entries) =>
        Breakdown(entries.Where(e => !e.IsSynthetic), e => (e.Model ?? "?") + (e.IsFast ? PricingTable.FastSuffix : ""));

    public static IReadOnlyList<UsageBreakdown> BySession(IEnumerable<UsageEntry> entries) =>
        Breakdown(entries, e => e.SessionId ?? "?");

    private static List<UsageBreakdown> Breakdown(IEnumerable<UsageEntry> entries, Func<UsageEntry, string> key) =>
        entries.GroupBy(key, StringComparer.OrdinalIgnoreCase)
            .Select(g => new UsageBreakdown(g.Key, UsageTotals.Sum(g)))
            .OrderByDescending(b => b.Totals.TotalTokens)
            .ToList();
}
