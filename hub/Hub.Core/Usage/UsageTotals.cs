namespace Hub.Core.Usage;

/// <summary>Summed usage. <see cref="CostUsd"/> covers priced entries; <see cref="HasUnpricedEntries"/> flags the rest.</summary>
public sealed record UsageTotals(
    long Input,
    long Output,
    long CacheCreate,
    long CacheRead,
    decimal CostUsd,
    bool HasUnpricedEntries,
    int Entries)
{
    public static UsageTotals Zero { get; } = new(0, 0, 0, 0, 0m, false, 0);

    public long TotalTokens => Input + Output + CacheCreate + CacheRead;

    public static UsageTotals Sum(IEnumerable<UsageEntry> entries)
    {
        long input = 0, output = 0, create = 0, read = 0;
        decimal cost = 0;
        var unpriced = false;
        var count = 0;
        foreach (var e in entries)
        {
            input += e.Input;
            output += e.Output;
            create += e.CacheCreate;
            read += e.CacheRead;
            if (e.CostUsd is { } c)
            {
                cost += c;
            }
            else
            {
                unpriced = true;
            }

            count++;
        }

        return new UsageTotals(input, output, create, read, cost, unpriced, count);
    }
}
