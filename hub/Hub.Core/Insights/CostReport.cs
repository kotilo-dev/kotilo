using System.Globalization;
using System.Text;
using Hub.Core.Usage;

namespace Hub.Core.Insights;

public enum CostGrouping
{
    Customer,
    Project,
    Model,

    /// <summary>By adapter id (<c>claude-code</c>, <c>codex</c>, …).</summary>
    Agent,
}

/// <summary>A customer label for projects (spec §18.2).</summary>
public sealed record Customer(long Id, string Name, string Color, bool Archived = false);

/// <summary>Group kind, so the UI can name the synthetic rows in its own language.</summary>
public enum CostRowKind
{
    Normal,

    /// <summary>Projects without a customer ("Atanmamış").</summary>
    Unassigned,

    /// <summary>Bip's own usage ("Buddy"), always separate.</summary>
    Buddy,
}

/// <param name="Key">Customer id, project root or model id; empty for synthetic rows.</param>
/// <param name="Projects">Project names in the group, most expensive first.</param>
/// <param name="Share">Share of the total cost (0..1); token share when nothing is priced.</param>
public sealed record CostRow(
    CostRowKind Kind, string Key, string Name, string? Color, IReadOnlyList<string> Projects, int Sessions, UsageTotals Totals, double Share);

/// <summary>One line of the raw daily sheet in the Excel export.</summary>
public sealed record CostDailyRow(DateOnly Date, string Project, string Customer, string Model, UsageTotals Totals);

public sealed record CostReport(CostGrouping Grouping, DateOnly Month, IReadOnlyList<CostRow> Rows, int Sessions, UsageTotals Totals)
{
    public IReadOnlyList<CostDailyRow> Daily { get; init; } = [];
}

/// <summary>
/// Builds the monthly cost report (spec §18.2) from usage entries. Amounts are the local API-price estimate.
/// </summary>
public sealed class CostReportBuilder(
    IReadOnlyDictionary<string, Customer> customerOfProject,
    Func<string, bool> isBuddyRoot,
    Func<string, string> projectName)
{
    /// <summary>Entries whose timestamps fall in <paramref name="month"/> (local) in <paramref name="zone"/>.</summary>
    public CostReport Build(IEnumerable<UsageEntry> entries, DateOnly month, CostGrouping grouping, TimeZoneInfo zone)
    {
        var first = new DateOnly(month.Year, month.Month, 1);
        return Build(entries, first, first.AddMonths(1).AddDays(-1), grouping, zone);
    }

    /// <summary>Entries in the local days [<paramref name="first"/>, <paramref name="last"/>]; the report's <c>Month</c> is <paramref name="first"/>.</summary>
    public CostReport Build(IEnumerable<UsageEntry> entries, DateOnly first, DateOnly last, CostGrouping grouping, TimeZoneInfo zone)
    {
        var from = Insights.WaitMetricsCalculator.StartOfDay(first, zone);
        var to = Insights.WaitMetricsCalculator.StartOfDay(last.AddDays(1), zone);
        var inMonth = entries.Where(e => e.Timestamp >= from && e.Timestamp < to).ToList();

        var groups = inMonth.GroupBy(e => GroupOf(e, grouping)).ToList();
        var total = UsageTotals.Sum(inMonth);
        var anyPriced = total.CostUsd > 0;

        var rows = groups
            .Select(g =>
            {
                var totals = UsageTotals.Sum(g);
                var projects = g.GroupBy(e => e.ProjectRoot ?? "")
                    .OrderByDescending(p => p.Sum(e => e.CostUsd ?? 0)).ThenByDescending(p => p.Sum(e => e.TotalTokens))
                    .Select(p => isBuddyRoot(p.Key) ? "Buddy" : projectName(p.Key))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                var share = anyPriced
                    ? (double)(totals.CostUsd / total.CostUsd)
                    : total.TotalTokens == 0 ? 0 : (double)totals.TotalTokens / total.TotalTokens;
                return new CostRow(g.Key.Kind, g.Key.Key, g.Key.Name, g.Key.Color, projects, Sessions(g), totals, share);
            })
            .OrderBy(r => r.Kind)                       // Normal rows, then Unassigned, then Buddy
            .ThenByDescending(r => r.Totals.CostUsd)
            .ThenByDescending(r => r.Totals.TotalTokens)
            .ToList();

        var daily = inMonth
            .GroupBy(e => (
                Date: DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(e.Timestamp, zone).DateTime),
                Root: e.ProjectRoot ?? "",
                Model: e.Model ?? "?"))
            .OrderBy(g => g.Key.Date).ThenBy(g => g.Key.Root, StringComparer.OrdinalIgnoreCase).ThenBy(g => g.Key.Model, StringComparer.Ordinal)
            .Select(g => new CostDailyRow(
                g.Key.Date,
                isBuddyRoot(g.Key.Root) ? "Buddy" : projectName(g.Key.Root),
                isBuddyRoot(g.Key.Root) ? "" : customerOfProject.TryGetValue(g.Key.Root, out var c) ? c.Name : "",
                g.Key.Model,
                UsageTotals.Sum(g)))
            .ToList();

        return new CostReport(grouping, first, rows, Sessions(inMonth), total) { Daily = daily };
    }

    private (CostRowKind Kind, string Key, string Name, string? Color) GroupOf(UsageEntry e, CostGrouping grouping)
    {
        var root = e.ProjectRoot ?? "";
        if (grouping != CostGrouping.Model && isBuddyRoot(root))
        {
            return (CostRowKind.Buddy, "", "Buddy", null);
        }

        switch (grouping)
        {
            case CostGrouping.Customer:
                return customerOfProject.TryGetValue(root, out var c)
                    ? (CostRowKind.Normal, c.Id.ToString(CultureInfo.InvariantCulture), c.Name, c.Color)
                    : (CostRowKind.Unassigned, "", "", null);
            case CostGrouping.Agent:
                return (CostRowKind.Normal, e.Agent, e.Agent, null);
            case CostGrouping.Project:
                return (CostRowKind.Normal, root, projectName(root),
                    customerOfProject.TryGetValue(root, out var pc) ? pc.Color : null);
            default:
                var model = e.Model ?? "?";
                return (CostRowKind.Normal, model, model, null);
        }
    }

    private static int Sessions(IEnumerable<UsageEntry> entries) =>
        entries.Select(e => e.SessionId).Where(s => s is not null).Distinct(StringComparer.Ordinal).Count();
}

/// <summary>
/// CSV for Turkish Excel (spec §18.2): UTF-8 with BOM, <c>;</c> separator, decimal comma via the given culture.
/// </summary>
public static class CostCsvExporter
{
    public static byte[] Export(CostReport report, IReadOnlyList<string> headers, Func<CostRow, string> rowName, CultureInfo culture)
    {
        var sb = new StringBuilder();
        sb.AppendJoin(';', headers.Select(Escape)).Append("\r\n");
        foreach (var row in report.Rows)
        {
            sb.AppendJoin(';', new[]
            {
                Escape(rowName(row)),
                Escape(string.Join(", ", row.Projects)),
                row.Sessions.ToString(culture),
                row.Totals.TotalTokens.ToString(culture),
                row.Totals.CostUsd.ToString("0.00", culture),
                (row.Share * 100).ToString("0.0", culture),
            }).Append("\r\n");
        }

        var preamble = Encoding.UTF8.GetPreamble();
        var body = Encoding.UTF8.GetBytes(sb.ToString());
        return [.. preamble, .. body];
    }

    private static string Escape(string value) =>
        value.IndexOfAny([';', '"', '\r', '\n']) >= 0 ? "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"" : value;
}
