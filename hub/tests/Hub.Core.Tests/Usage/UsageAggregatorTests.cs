using Hub.Core.Usage;
using static Hub.Core.Tests.Usage.UsageTestData;

namespace Hub.Core.Tests.Usage;

public class UsageAggregatorTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");

    [Fact]
    public void Day_boundary_follows_local_time()
    {
        // 2026-09-30 21:30 UTC is 2026-10-01 00:30 in Istanbul (UTC+3).
        var lateUtc = new DateTimeOffset(2026, 9, 30, 21, 30, 0, TimeSpan.Zero);
        var earlierUtc = new DateTimeOffset(2026, 9, 30, 20, 30, 0, TimeSpan.Zero);

        var days = UsageAggregator.Daily([Entry(lateUtc, 5), Entry(earlierUtc, 7)], Istanbul, new DateOnly(2026, 9, 30), new DateOnly(2026, 10, 1));

        days.Select(d => (d.Date, d.Totals.TotalTokens)).Should().Equal(
            (new DateOnly(2026, 9, 30), 7L),
            (new DateOnly(2026, 10, 1), 5L));
    }

    [Fact]
    public void Daily_includes_empty_days_and_counts_sessions()
    {
        var d = new DateTimeOffset(2026, 9, 28, 9, 0, 0, TimeSpan.Zero);
        var days = UsageAggregator.Daily(
            [Entry(d, 1, session: "a"), Entry(d.AddMinutes(1), 1, session: "a"), Entry(d.AddMinutes(2), 1, session: "b")],
            Istanbul, new DateOnly(2026, 9, 27), new DateOnly(2026, 9, 29));

        days.Should().HaveCount(3);
        days[0].Totals.Should().Be(UsageTotals.Zero);
        days[1].Sessions.Should().Be(2);
        days[1].Totals.Entries.Should().Be(3);
    }

    [Theory]
    [InlineData(2026, 9, 28, 2026, 9, 28)] // Monday
    [InlineData(2026, 10, 1, 2026, 9, 28)] // Thursday
    [InlineData(2026, 10, 4, 2026, 9, 28)] // Sunday belongs to the previous Monday
    [InlineData(2026, 10, 5, 2026, 10, 5)]
    public void Week_starts_on_monday(int y, int m, int d, int ey, int em, int ed) =>
        UsageAggregator.WeekStart(new DateOnly(y, m, d)).Should().Be(new DateOnly(ey, em, ed));

    [Fact]
    public void Week_to_date_crosses_month_in_local_time()
    {
        var sundayBefore = new DateTimeOffset(2026, 9, 27, 12, 0, 0, TimeSpan.Zero);
        var mondayEarlyLocal = new DateTimeOffset(2026, 9, 27, 21, 30, 0, TimeSpan.Zero); // Mon 00:30 Istanbul
        var thursday = new DateTimeOffset(2026, 10, 1, 8, 0, 0, TimeSpan.Zero);

        UsageAggregator.WeekToDate([Entry(sundayBefore, 1), Entry(mondayEarlyLocal, 10), Entry(thursday, 100)], Istanbul, new DateOnly(2026, 10, 1))
            .TotalTokens.Should().Be(110);
    }

    [Fact]
    public void Breakdowns_group_and_sort_by_tokens()
    {
        var t = new DateTimeOffset(2026, 9, 30, 9, 0, 0, TimeSpan.Zero);
        var entries = new[]
        {
            Entry(t, 5, project: "a", model: "claude-opus-5-5"),
            Entry(t, 50, project: "b", model: "claude-haiku-4-5"),
            Entry(t, 1, project: "a", model: UsageEntry.SyntheticModel),
        };

        UsageAggregator.ByProject(entries).Select(b => (b.Key, b.Totals.TotalTokens)).Should().Equal(("b", 50L), ("a", 6L));
        UsageAggregator.ByModel(entries).Select(b => b.Key).Should().Equal("claude-haiku-4-5", "claude-opus-5-5");
    }
}
