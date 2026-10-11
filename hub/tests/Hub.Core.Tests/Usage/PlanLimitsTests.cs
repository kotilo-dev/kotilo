using System.Globalization;
using System.Text;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

public sealed class PlanLimitsTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset FiveHourReset = Now.AddHours(2);
    private static readonly DateTimeOffset WeekReset = Now.AddDays(3);

    /// <summary>R5H / R7D in the JSON become the reset epochs (raw interpolation cannot end in that many braces).</summary>
    private static StatusLineSnapshot? Parse(string json) => StatusLineSnapshot.Parse(
        Encoding.UTF8.GetBytes(json
            .Replace("R5H", FiveHourReset.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("R7D", WeekReset.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)),
        Now);

    [Fact]
    public void Documented_rate_limits_are_parsed()
    {
        var snapshot = Parse("""
            {"session_id":"s1","rate_limits":{
              "five_hour":{"used_percentage":23.5,"resets_at":R5H},
              "seven_day":{"used_percentage":41.2,"resets_at":R7D}}}
            """);

        var limits = snapshot!.Limits!;
        limits.FiveHour.Should().Be(new LimitWindow(23.5, FiveHourReset));
        limits.SevenDay.Should().Be(new LimitWindow(41.2, WeekReset));
        limits.SpendLimit.Should().BeNull();
        limits.ReceivedAt.Should().Be(Now);
    }

    [Theory]
    [InlineData("""{"session_id":"s1"}""")]
    [InlineData("""{"session_id":"s1","rate_limits":{}}""")]
    [InlineData("""{"session_id":"s1","rate_limits":{"five_hour":{"used_percentage":"x","resets_at":1}}}""")]
    [InlineData("""{"session_id":"s1","rate_limits":{"five_hour":{"used_percentage":5}}}""")]
    public void Missing_or_malformed_limits_are_null(string json) => Parse(json)!.Limits.Should().BeNull();

    [Fact]
    public void Spend_limit_may_exceed_100()
    {
        var limits = Parse("""{"session_id":"s1","rate_limits":{"spend_limit":{"used_percentage":112.5,"resets_at":R7D}}}""")!.Limits!;
        limits.SpendLimit!.UsedPercent.Should().Be(112.5);
    }

    [Fact]
    public void Expired_windows_are_dropped()
    {
        var limits = new PlanLimits(Now) { FiveHour = new(90, Now.AddMinutes(-1)), SevenDay = new(40, WeekReset) };

        var current = limits.Current(Now);

        current.FiveHour.Should().BeNull();
        current.SevenDay.Should().NotBeNull();
    }

    [Fact]
    public void Same_window_keeps_the_higher_percentage()
    {
        var known = new PlanLimits(Now) { FiveHour = new(60, FiveHourReset) };
        var staleRender = new PlanLimits(Now.AddMinutes(1)) { FiveHour = new(45, FiveHourReset.AddSeconds(30)) };

        var merged = PlanLimits.Merge(known, staleRender);

        merged.FiveHour!.UsedPercent.Should().Be(60);
        merged.ReceivedAt.Should().Be(Now.AddMinutes(1));
    }

    [Fact]
    public void Later_window_replaces_and_earlier_window_is_ignored()
    {
        var known = new PlanLimits(Now) { FiveHour = new(80, FiveHourReset) };

        PlanLimits.Merge(known, new PlanLimits(Now) { FiveHour = new(3, FiveHourReset.AddHours(5)) })
            .FiveHour!.UsedPercent.Should().Be(3);
        PlanLimits.Merge(known, new PlanLimits(Now) { FiveHour = new(99, FiveHourReset.AddHours(-5)) })
            .FiveHour!.UsedPercent.Should().Be(80);
    }

    [Fact]
    public void Window_missing_from_a_report_is_kept()
    {
        var known = new PlanLimits(Now) { FiveHour = new(10, FiveHourReset), SevenDay = new(40, WeekReset) };

        var merged = PlanLimits.Merge(known, new PlanLimits(Now) { FiveHour = new(12, FiveHourReset) });

        merged.SevenDay.Should().Be(known.SevenDay);
        merged.FiveHour!.UsedPercent.Should().Be(12);
    }
}
