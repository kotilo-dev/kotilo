using Hub.Core.Tasks;

namespace Hub.Core.Tests.Tasks;

public sealed class PersonalTaskTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.CreateCustomTimeZone("TRT", TimeSpan.FromHours(3), "TRT", "TRT");

    /// <summary>2026-10-04 14:00 local.</summary>
    private static readonly DateTimeOffset Now = new(2026, 10, 4, 11, 0, 0, TimeSpan.Zero);

    private static PersonalTask Task(string text = "x", DateOnly? due = null, TimeOnly? time = null) =>
        new() { Text = text, DueDate = due, DueTime = time, CreatedAt = Now.AddDays(-1) };

    [Fact]
    public void Title_is_the_first_non_empty_line_and_the_rest_is_details()
    {
        var task = Task("\n\n  Sipariş onayı  \r\nKargo tarafını kontrol et\n\n- örnek\n");

        task.Title.Should().Be("Sipariş onayı");
        task.Details.Should().Be("Kargo tarafını kontrol et\n\n- örnek");
        Task("tek satır").Details.Should().BeNull();

        // WinUI TextBox line breaks are a bare \r.
        var fromTextBox = Task("Başlık\rikinci satır\rüçüncü");
        fromTextBox.Title.Should().Be("Başlık");
        fromTextBox.Details.Should().Be("ikinci satır\nüçüncü");
    }

    [Theory]
    [InlineData(null, null, TaskDueState.None)]
    [InlineData("2026-10-05", null, TaskDueState.Upcoming)]
    [InlineData("2026-10-04", null, TaskDueState.Today)]
    [InlineData("2026-10-04", "13:59", TaskDueState.Overdue)]
    [InlineData("2026-10-04", "14:30", TaskDueState.Today)]
    [InlineData("2026-10-03", null, TaskDueState.Overdue)]
    public void Due_state_follows_the_local_deadline(string? date, string? time, TaskDueState expected)
    {
        var task = Task(due: date is null ? null : DateOnly.Parse(date, System.Globalization.CultureInfo.InvariantCulture),
            time: time is null ? null : TimeOnly.Parse(time, System.Globalization.CultureInfo.InvariantCulture));

        task.DueState(Now, Istanbul).Should().Be(expected);
        (task with { CompletedAt = Now }).DueState(Now, Istanbul).Should().Be(TaskDueState.None);
    }

    [Fact]
    public void Date_only_deadlines_remind_at_nine_local()
    {
        Task(due: new DateOnly(2026, 10, 4)).ReminderAt(Istanbul)
            .Should().Be(new DateTimeOffset(2026, 10, 4, 9, 0, 0, TimeSpan.FromHours(3)));
    }

    [Fact]
    public void Reminders_fire_once_and_skip_long_missed_ones()
    {
        var due = Task("due", new DateOnly(2026, 10, 4), new TimeOnly(13, 30)) with { Id = 1 };
        var later = Task("later", new DateOnly(2026, 10, 4), new TimeOnly(15, 0)) with { Id = 2 };
        var reminded = due with { Id = 3, RemindedAt = Now.AddMinutes(-20) };
        var done = due with { Id = 4, CompletedAt = Now.AddHours(-1) };
        var stale = Task("old", new DateOnly(2026, 10, 2)) with { Id = 5 };

        PersonalTasks.DueForReminder([due, later, reminded, done, stale], Now, Istanbul)
            .Select(t => t.Id).Should().Equal(1);
    }

    [Fact]
    public void Sort_puts_open_tasks_by_deadline_then_priority_and_completed_last()
    {
        var noDate = Task("no date") with { Id = 1 };
        var tomorrow = Task("tomorrow", new DateOnly(2026, 10, 5)) with { Id = 2 };
        var overdue = Task("overdue", new DateOnly(2026, 10, 1)) with { Id = 3 };
        var high = Task("high") with { Id = 4, Priority = TaskPriority.High };
        var done = Task("done", new DateOnly(2026, 9, 1)) with { Id = 5, CompletedAt = Now };

        PersonalTasks.Sort([noDate, done, tomorrow, high, overdue], Istanbul)
            .Select(t => t.Id).Should().Equal(3, 2, 4, 1, 5);
    }
}
