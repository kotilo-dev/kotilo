using Hub.Core.Usage;
using static Hub.Core.Tests.Usage.UsageTestData;

namespace Hub.Core.Tests.Usage;

public class BlockCalculatorTests
{
    private static readonly DateTimeOffset H10 = new(2026, 9, 30, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Block_starts_at_utc_hour_floor_and_lasts_five_hours()
    {
        var blocks = BlockCalculator.Identify([Entry(H10.AddMinutes(37), 100)]);

        var b = blocks.Should().ContainSingle().Subject;
        b.Start.Should().Be(H10);
        b.End.Should().Be(H10.AddHours(5));
        b.LastEntryAt.Should().Be(H10.AddMinutes(37));
        b.Totals.TotalTokens.Should().Be(100);
    }

    [Fact]
    public void Local_offset_is_floored_in_utc()
    {
        var istanbul = new DateTimeOffset(2026, 9, 30, 13, 37, 0, TimeSpan.FromHours(3)); // 10:37 UTC
        BlockCalculator.Identify([Entry(istanbul, 1)])[0].Start.Should().Be(H10);
    }

    [Fact]
    public void Entry_past_block_end_opens_new_block_without_gap()
    {
        var blocks = BlockCalculator.Identify(
        [
            Entry(H10.AddMinutes(5), 1),
            Entry(H10.AddHours(4), 2),
            Entry(H10.AddHours(5).AddMinutes(30), 4), // > 5 h after start, < 5 h after previous
        ]);

        blocks.Should().HaveCount(2);
        blocks.Should().NotContain(b => b.IsGap);
        blocks[0].Totals.TotalTokens.Should().Be(3);
        blocks[1].Start.Should().Be(H10.AddHours(5));
        blocks[1].Totals.TotalTokens.Should().Be(4);
    }

    [Fact]
    public void Exactly_five_hours_stays_in_the_same_block()
    {
        BlockCalculator.Identify([Entry(H10, 1), Entry(H10.AddHours(5), 1)]).Should().ContainSingle();
    }

    [Fact]
    public void Long_idle_period_inserts_a_gap_block()
    {
        var blocks = BlockCalculator.Identify([Entry(H10.AddMinutes(10), 1), Entry(H10.AddHours(9), 1)]);

        blocks.Select(b => b.IsGap).Should().Equal(false, true, false);
        blocks[1].Start.Should().Be(H10.AddMinutes(10).AddHours(5));
        blocks[1].End.Should().Be(H10.AddHours(9));
        blocks[1].Totals.Should().Be(UsageTotals.Zero);
        blocks[2].Start.Should().Be(H10.AddHours(9));
    }

    [Fact]
    public void Unsorted_input_is_sorted()
    {
        var blocks = BlockCalculator.Identify([Entry(H10.AddHours(2), 2), Entry(H10.AddMinutes(1), 1)]);
        blocks.Should().ContainSingle().Which.Totals.TotalTokens.Should().Be(3);
    }

    [Fact]
    public void Active_block_has_burn_rate_from_last_fifteen_minutes()
    {
        var now = H10.AddHours(2);
        var entries = new[]
        {
            Entry(H10.AddMinutes(5), 100_000, cost: 10m),     // outside the burn window
            Entry(now.AddMinutes(-10), 15_000, cost: 1.5m),
            Entry(now.AddMinutes(-1), 15_000, cost: 1.5m),
        };

        var active = BlockCalculator.Active(entries, now)!;

        active.Block.Totals.TotalTokens.Should().Be(130_000);
        active.Remaining.Should().Be(TimeSpan.FromHours(3));
        active.TokensPerMinute.Should().Be(2_000);
        active.CostPerHour.Should().Be(12m);
        active.ProjectedTokens.Should().Be(130_000 + (2_000 * 180));
        active.ProjectedCostUsd.Should().Be(13m + 36m);
    }

    [Fact]
    public void No_recent_entries_means_zero_burn()
    {
        var active = BlockCalculator.Active([Entry(H10.AddMinutes(1), 10)], H10.AddHours(1))!;
        active.TokensPerMinute.Should().Be(0);
        active.ProjectedTokens.Should().Be(10);
    }

    [Fact]
    public void Block_is_inactive_after_its_end()
    {
        BlockCalculator.Active([Entry(H10.AddMinutes(1), 10)], H10.AddHours(5)).Should().BeNull();
        BlockCalculator.Active([], H10).Should().BeNull();
    }

    [Fact]
    public void Unpriced_entries_are_flagged()
    {
        var totals = BlockCalculator.Identify([Entry(H10, 1, cost: null), Entry(H10.AddMinutes(1), 1, cost: 2m)])[0].Totals;
        totals.CostUsd.Should().Be(2m);
        totals.HasUnpricedEntries.Should().BeTrue();
    }
}
