namespace Hub.Core.Tasks;

public enum TaskPriority
{
    Low = 0,
    Normal = 1,
    High = 2,
}

/// <summary>Where an open task stands against its deadline (spec §21.2).</summary>
public enum TaskDueState
{
    None,
    Upcoming,
    Today,
    Overdue,
}

/// <summary>
/// A note to self (spec §21): free text with an optional deadline and project. Stored in <c>personal_tasks</c>, never in
/// the project's todo files, so it does not count towards project progress.
/// </summary>
public sealed record PersonalTask
{
    /// <summary>Date-only deadlines remind at this local time (spec §21.3).</summary>
    public static readonly TimeOnly DefaultReminderTime = new(9, 0);

    public long Id { get; init; }

    public required string Text { get; init; }

    /// <summary>Null: "Genel notlar".</summary>
    public string? ProjectRoot { get; init; }

    public DateOnly? DueDate { get; init; }

    /// <summary>Only meaningful with <see cref="DueDate"/>.</summary>
    public TimeOnly? DueTime { get; init; }

    public TaskPriority Priority { get; init; } = TaskPriority.Normal;

    public DateTimeOffset CreatedAt { get; init; }

    public DateTimeOffset UpdatedAt { get; init; }

    public DateTimeOffset? CompletedAt { get; init; }

    /// <summary>When the deadline toast was shown; reset when the deadline changes.</summary>
    public DateTimeOffset? RemindedAt { get; init; }

    public bool IsCompleted => CompletedAt is not null;

    /// <summary>"\r\n" and the bare "\r" a WinUI TextBox uses become "\n".</summary>
    public static string NormalizeLines(string text) =>
        text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    /// <summary>The first non-empty line.</summary>
    public string Title => SplitText().Title;

    /// <summary>Everything after the first non-empty line, or null.</summary>
    public string? Details => SplitText().Details;

    /// <summary>Deadline as an instant: the date at <see cref="DueTime"/>, or at <see cref="DefaultReminderTime"/>.</summary>
    public DateTimeOffset? ReminderAt(TimeZoneInfo zone)
    {
        if (DueDate is not { } date)
        {
            return null;
        }

        var local = date.ToDateTime(DueTime ?? DefaultReminderTime);
        return new DateTimeOffset(local, zone.GetUtcOffset(local));
    }

    /// <summary>
    /// Overdue once the deadline passed: a time deadline at that minute, a date-only one from the next day.
    /// Completed tasks and tasks without a deadline are <see cref="TaskDueState.None"/>.
    /// </summary>
    public TaskDueState DueState(DateTimeOffset now, TimeZoneInfo zone)
    {
        if (IsCompleted || DueDate is not { } date)
        {
            return TaskDueState.None;
        }

        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        if (date < today || (DueTime is not null && ReminderAt(zone) <= now))
        {
            return TaskDueState.Overdue;
        }

        return date == today ? TaskDueState.Today : TaskDueState.Upcoming;
    }

    private (string Title, string? Details) SplitText()
    {
        var lines = NormalizeLines(Text).Split('\n');
        var first = Array.FindIndex(lines, l => l.Trim().Length > 0);
        if (first < 0)
        {
            return ("", null);
        }

        var details = string.Join('\n', lines[(first + 1)..]).Trim();
        return (lines[first].Trim(), details.Length == 0 ? null : details);
    }
}

/// <summary>Ordering and reminders for <see cref="PersonalTask"/> (spec §21.2–21.3).</summary>
public static class PersonalTasks
{
    /// <summary>A reminder missed for longer than this (app closed) is skipped instead of shown late.</summary>
    public static readonly TimeSpan MaxReminderDelay = TimeSpan.FromHours(24);

    /// <summary>
    /// Open tasks first: overdue, then by deadline (none last), priority, newest. Completed tasks follow, newest
    /// completion first.
    /// </summary>
    public static IReadOnlyList<PersonalTask> Sort(IEnumerable<PersonalTask> tasks, TimeZoneInfo zone) =>
        tasks.OrderBy(t => t.IsCompleted)
            .ThenByDescending(t => t.CompletedAt)
            .ThenBy(t => t.ReminderAt(zone) ?? DateTimeOffset.MaxValue)
            .ThenByDescending(t => t.Priority)
            .ThenByDescending(t => t.CreatedAt)
            .ToList();

    /// <summary>Open tasks whose deadline arrived within <see cref="MaxReminderDelay"/> and that were not reminded yet.</summary>
    public static IReadOnlyList<PersonalTask> DueForReminder(IEnumerable<PersonalTask> tasks, DateTimeOffset now, TimeZoneInfo zone) =>
        tasks.Where(t => !t.IsCompleted && t.RemindedAt is null && t.ReminderAt(zone) is { } at && at <= now && now - at <= MaxReminderDelay)
            .ToList();
}
