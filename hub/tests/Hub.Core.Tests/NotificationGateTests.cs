using Hub.Core.Notifications;

namespace Hub.Core.Tests;

public class NotificationGateTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");
    private static readonly QuietHours Night = new() { Enabled = true, Start = new TimeOnly(23, 0), End = new TimeOnly(8, 0) };

    /// <summary>Istanbul is UTC+3 all year.</summary>
    private static DateTimeOffset Local(int day, int hour, int minute = 0) => new(2026, 10, day, hour, minute, 0, TimeSpan.FromHours(3));

    [Theory]
    [InlineData(22, 59, false)]
    [InlineData(23, 0, true)]
    [InlineData(2, 30, true)]
    [InlineData(7, 59, true)]
    [InlineData(8, 0, false)]
    [InlineData(14, 0, false)]
    public void Quiet_hours_span_midnight(int hour, int minute, bool suppressed) =>
        NotificationGate.IsSuppressed(Local(1, hour, minute).ToUniversalTime(), Istanbul, null, Night).Should().Be(suppressed);

    [Fact]
    public void Daytime_range_and_disabled_hours()
    {
        var lunch = new QuietHours { Enabled = true, Start = new TimeOnly(12, 0), End = new TimeOnly(13, 0) };
        NotificationGate.IsSuppressed(Local(1, 12, 30), Istanbul, null, lunch).Should().BeTrue();
        NotificationGate.IsSuppressed(Local(1, 13, 0), Istanbul, null, lunch).Should().BeFalse();
        NotificationGate.IsSuppressed(Local(1, 2, 0), Istanbul, null, Night with { Enabled = false }).Should().BeFalse();
    }

    [Fact]
    public void Do_not_disturb_ends_at_its_deadline()
    {
        var until = Local(1, 15, 0);
        NotificationGate.IsSuppressed(Local(1, 14, 59), Istanbul, until, Night with { Enabled = false }).Should().BeTrue();
        NotificationGate.IsSuppressed(Local(1, 15, 0), Istanbul, until, Night with { Enabled = false }).Should().BeFalse();
    }

    [Fact]
    public void Until_tomorrow_is_next_morning()
    {
        NotificationGate.UntilTomorrow(Local(1, 21, 0), Istanbul, Night).Should().Be(Local(2, 8, 0));
        NotificationGate.UntilTomorrow(Local(2, 1, 30), Istanbul, Night).Should().Be(Local(2, 8, 0), "after midnight, 'tomorrow' is this morning");
        NotificationGate.UntilTomorrow(Local(1, 21, 0), Istanbul, new QuietHours { End = new TimeOnly(9, 30) }).Should().Be(Local(2, 8, 0), "quiet hours off → 08:00");
    }
}
