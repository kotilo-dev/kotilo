using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>Background worker cadence: usage refreshes without new data (each reloads 35 days of rows) and periodic git checks.</summary>
public sealed class UsageServiceTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 15, 12, 0, 0, TimeSpan.Zero);

    private static UsageSnapshot Snapshot(DateTimeOffset at, bool activeBlock)
    {
        var block = new UsageBlock(at.AddHours(-1), at.AddHours(4), at, false, UsageTotals.Zero);
        return UsageSnapshot.Empty with
        {
            At = at,
            ActiveBlock = activeBlock ? new ActiveBlockStatus(block, TimeSpan.FromHours(4), 10, 1, 100, 1) : null,
        };
    }

    [Fact]
    public void Clock_refresh_only_while_a_block_is_active()
    {
        var utc = TimeZoneInfo.Utc;
        UsageService.NeedsClockRefresh(Snapshot(T0, true), T0.AddSeconds(31), T0, utc).Should().BeTrue();
        UsageService.NeedsClockRefresh(Snapshot(T0, true), T0.AddSeconds(10), T0, utc).Should().BeFalse("30 s interval");
        UsageService.NeedsClockRefresh(Snapshot(T0, false), T0.AddMinutes(10), T0, utc).Should().BeFalse("nothing moves with the clock");
    }

    [Fact]
    public void Clock_refresh_drops_only_the_rows_that_left_the_window()
    {
        UsageEntry At(DateTimeOffset ts) => new($"k{ts.Ticks}", ts, 1, 1, 0, 0, 0);
        var rows = new[] { At(T0.AddDays(-36)), At(T0.AddDays(-34)), At(T0) };

        UsageService.Window(rows, T0.AddDays(-35)).Should().Equal(rows[1], rows[2]);
        var inside = rows[1..];
        UsageService.Window(inside, T0.AddDays(-35)).Should().BeSameAs(inside, "nothing to drop, no copy");
    }

    [Fact]
    public void Merge_replaces_rewritten_rows_appends_new_ones_and_keeps_time_order()
    {
        UsageEntry At(string key, DateTimeOffset ts, long output = 1) => new(key, ts, 1, output, 0, 0, 0);
        var rows = new[] { At("old", T0.AddDays(-36)), At("a", T0.AddHours(-2)), At("b", T0.AddHours(-1)) };
        var since = T0.AddDays(-35);

        UsageService.Merge(rows, [], since).Select(e => e.DedupKey).Should().Equal("a", "b");
        UsageService.Merge(rows, [At("b", T0.AddHours(-1), 9), At("c", T0)], since)
            .Select(e => (e.DedupKey, e.Output)).Should().Equal(("a", 1), ("b", 9), ("c", 1));
        UsageService.Merge(rows, [At("early", T0.AddHours(-3))], since)
            .Select(e => e.DedupKey).Should().Equal("early", "a", "b");
        UsageService.Merge(rows, [At("a", T0.AddHours(-2), 2), At("a", T0.AddHours(-2), 3)], since)
            .Single(e => e.DedupKey == "a").Output.Should().Be(3, "the last write wins");
    }

    [Theory]
    [InlineData(SessionState.Working, 600, true)]
    [InlineData(SessionState.Idle, 20, true)]
    [InlineData(SessionState.Idle, 31, false)]
    [InlineData(SessionState.WaitingInput, 120, false)]
    [InlineData(SessionState.Ended, 1, false)]
    public void Periodic_git_checks_only_for_working_or_recently_active_sessions(SessionState state, int minutesSinceEvent, bool expected)
    {
        var s = new SessionInfo("s", @"C:\src\a", "a", null, state, T0, T0.AddMinutes(-minutesSinceEvent), null, null, null, null, 0, null, null);
        InsightsService.NeedsPeriodicGitCheck(s, T0).Should().Be(expected);
    }

    [Fact]
    public void Clock_refresh_once_when_the_day_changes()
    {
        var utc = TimeZoneInfo.Utc;
        var lateEvening = new DateTimeOffset(2026, 10, 15, 23, 59, 50, TimeSpan.Zero);
        UsageService.NeedsClockRefresh(Snapshot(lateEvening, false), lateEvening.AddMinutes(1), lateEvening, utc).Should().BeTrue();
    }
}
