namespace Hub.Core.Notifications;

/// <summary>Daily quiet period in local time, e.g. 23:00–08:00 (spec §11.2). Start == End means the whole day.</summary>
public sealed record QuietHours
{
    public bool Enabled { get; init; }

    public TimeOnly Start { get; init; } = new(23, 0);

    public TimeOnly End { get; init; } = new(8, 0);

    public bool Contains(TimeOnly time) =>
        Start == End || (Start < End ? time >= Start && time < End : time >= Start || time < End);
}

/// <summary>
/// Global suppression for every toast (spec §11.2): "Rahatsız etme" until a moment, and quiet hours.
/// Suppressed notifications are dropped, not delayed.
/// </summary>
public static class NotificationGate
{
    public static bool IsSuppressed(DateTimeOffset now, TimeZoneInfo zone, DateTimeOffset? doNotDisturbUntil, QuietHours quietHours)
    {
        if (doNotDisturbUntil is { } until && now < until)
        {
            return true;
        }

        return quietHours.Enabled && quietHours.Contains(TimeOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime));
    }

    /// <summary>"Yarına kadar": the next morning in local time, i.e. the end of quiet hours (or 08:00 when they are off).</summary>
    public static DateTimeOffset UntilTomorrow(DateTimeOffset now, TimeZoneInfo zone, QuietHours quietHours)
    {
        var local = TimeZoneInfo.ConvertTime(now, zone);
        var morning = quietHours.Enabled ? quietHours.End : new TimeOnly(8, 0);
        var date = DateOnly.FromDateTime(local.DateTime);

        // Before this morning's wake-up time, "tomorrow" still means today's morning.
        var target = TimeOnly.FromDateTime(local.DateTime) < morning ? date : date.AddDays(1);
        var wall = target.ToDateTime(morning);
        return new DateTimeOffset(wall, zone.GetUtcOffset(wall));
    }
}
