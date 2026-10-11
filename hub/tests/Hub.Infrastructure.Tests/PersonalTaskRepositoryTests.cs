using Hub.Core.Tasks;
using Hub.Infrastructure.Data;

namespace Hub.Infrastructure.Tests;

public sealed class PersonalTaskRepositoryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private PersonalTaskRepository Repo()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        return new PersonalTaskRepository(db);
    }

    [Fact]
    public void Round_trips_all_fields_and_toggles_completion()
    {
        var repo = Repo();
        var added = repo.Add(
            new PersonalTask
            {
                Text = "  Sipariş onayı\nKargo tarafı  ",
                ProjectRoot = @"C:\src\alpha",
                DueDate = new DateOnly(2026, 10, 6),
                DueTime = new TimeOnly(17, 30),
                Priority = TaskPriority.High,
            },
            T0);

        var loaded = repo.Get(added.Id)!;
        loaded.Text.Should().Be("Sipariş onayı\nKargo tarafı");
        loaded.ProjectRoot.Should().Be(@"C:\src\alpha");
        loaded.DueDate.Should().Be(new DateOnly(2026, 10, 6));
        loaded.DueTime.Should().Be(new TimeOnly(17, 30));
        loaded.Priority.Should().Be(TaskPriority.High);
        loaded.CreatedAt.Should().Be(T0);
        loaded.IsCompleted.Should().BeFalse();

        repo.SetCompleted(added.Id, T0.AddHours(1), T0.AddHours(1));
        repo.Get(added.Id)!.CompletedAt.Should().Be(T0.AddHours(1));
        repo.SetCompleted(added.Id, null, T0.AddHours(2));
        repo.Get(added.Id)!.IsCompleted.Should().BeFalse();

        repo.Delete(added.Id);
        repo.LoadAll().Should().BeEmpty();
    }

    [Fact]
    public void General_note_without_deadline_keeps_nulls_and_time_needs_a_date()
    {
        var repo = Repo();
        var added = repo.Add(new PersonalTask { Text = "genel", ProjectRoot = " ", DueTime = new TimeOnly(9, 0) }, T0);

        var loaded = repo.Get(added.Id)!;
        loaded.ProjectRoot.Should().BeNull();
        loaded.DueDate.Should().BeNull();
        loaded.DueTime.Should().BeNull();
        loaded.Priority.Should().Be(TaskPriority.Normal);
    }

    [Fact]
    public void Changing_the_deadline_clears_the_reminder_but_other_edits_keep_it()
    {
        var repo = Repo();
        var task = repo.Add(new PersonalTask { Text = "a", DueDate = new DateOnly(2026, 10, 4) }, T0);
        repo.MarkReminded(task.Id, T0);

        repo.Update(task with { Text = "b" }, T0.AddMinutes(1));
        repo.Get(task.Id)!.RemindedAt.Should().Be(T0);

        repo.Update(task with { Text = "b", DueDate = new DateOnly(2026, 10, 5) }, T0.AddMinutes(2));
        repo.Get(task.Id)!.RemindedAt.Should().BeNull();
    }
}
