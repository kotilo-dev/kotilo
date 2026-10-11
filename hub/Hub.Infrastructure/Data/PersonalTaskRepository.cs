using System.Globalization;
using Hub.Core.Tasks;
using Dapper;

namespace Hub.Infrastructure.Data;

/// <summary><c>personal_tasks</c> (spec §21). Dates are "yyyy-MM-dd", times "HH:mm", instants Unix milliseconds.</summary>
public sealed class PersonalTaskRepository(Database db)
{
    private const string Columns =
        "id AS Id, text AS Text, project_root AS ProjectRoot, due_date AS DueDate, due_time AS DueTime, priority AS Priority, " +
        "created_at AS CreatedAt, updated_at AS UpdatedAt, completed_at AS CompletedAt, reminded_at AS RemindedAt";

    public IReadOnlyList<PersonalTask> LoadAll()
    {
        using var c = db.Open();
        return c.Query<Row>($"SELECT {Columns} FROM personal_tasks").Select(r => r.ToModel()).ToList();
    }

    public PersonalTask? Get(long id)
    {
        using var c = db.Open();
        return c.QueryFirstOrDefault<Row>($"SELECT {Columns} FROM personal_tasks WHERE id = @id", new { id })?.ToModel();
    }

    public PersonalTask Add(PersonalTask task, DateTimeOffset now)
    {
        using var c = db.Open();
        var id = c.ExecuteScalar<long>(
            """
            INSERT INTO personal_tasks (text, project_root, due_date, due_time, priority, created_at, updated_at)
            VALUES (@Text, @ProjectRoot, @DueDate, @DueTime, @Priority, @at, @at);
            SELECT last_insert_rowid();
            """,
            Parameters(task, now));
        return task with { Id = id, CreatedAt = now, UpdatedAt = now, CompletedAt = null, RemindedAt = null };
    }

    /// <summary>Saves text, project, deadline and priority. A changed deadline clears the reminder so it fires again.</summary>
    public void Update(PersonalTask task, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            """
            UPDATE personal_tasks SET
                reminded_at = CASE WHEN due_date IS @DueDate AND due_time IS @DueTime THEN reminded_at ELSE NULL END,
                text = @Text, project_root = @ProjectRoot, due_date = @DueDate, due_time = @DueTime, priority = @Priority,
                updated_at = @at
            WHERE id = @Id
            """,
            Parameters(task, now));
    }

    /// <summary>Marks done (or, with null, open again).</summary>
    public void SetCompleted(long id, DateTimeOffset? at, DateTimeOffset now)
    {
        using var c = db.Open();
        c.Execute(
            "UPDATE personal_tasks SET completed_at = @done, updated_at = @now WHERE id = @id",
            new { id, done = at?.ToUnixTimeMilliseconds(), now = now.ToUnixTimeMilliseconds() });
    }

    public void MarkReminded(long id, DateTimeOffset at)
    {
        using var c = db.Open();
        c.Execute("UPDATE personal_tasks SET reminded_at = @at WHERE id = @id", new { id, at = at.ToUnixTimeMilliseconds() });
    }

    public void Delete(long id)
    {
        using var c = db.Open();
        c.Execute("DELETE FROM personal_tasks WHERE id = @id", new { id });
    }

    private static object Parameters(PersonalTask t, DateTimeOffset now) => new
    {
        t.Id,
        Text = t.Text.Trim(),
        ProjectRoot = string.IsNullOrWhiteSpace(t.ProjectRoot) ? null : t.ProjectRoot,
        DueDate = t.DueDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DueTime = t.DueDate is null ? null : t.DueTime?.ToString("HH:mm", CultureInfo.InvariantCulture),
        Priority = (int)t.Priority,
        at = now.ToUnixTimeMilliseconds(),
    };

    private sealed class Row
    {
        public long Id { get; init; }

        public string Text { get; init; } = "";

        public string? ProjectRoot { get; init; }

        public string? DueDate { get; init; }

        public string? DueTime { get; init; }

        public long Priority { get; init; }

        public long CreatedAt { get; init; }

        public long UpdatedAt { get; init; }

        public long? CompletedAt { get; init; }

        public long? RemindedAt { get; init; }

        public PersonalTask ToModel() => new()
        {
            Id = Id,
            Text = Text,
            ProjectRoot = ProjectRoot,
            DueDate = DueDate is null ? null : DateOnly.ParseExact(DueDate, "yyyy-MM-dd", CultureInfo.InvariantCulture),
            DueTime = DueTime is null ? null : TimeOnly.ParseExact(DueTime, "HH:mm", CultureInfo.InvariantCulture),
            Priority = Enum.IsDefined((TaskPriority)Priority) ? (TaskPriority)Priority : TaskPriority.Normal,
            CreatedAt = DateTimeOffset.FromUnixTimeMilliseconds(CreatedAt),
            UpdatedAt = DateTimeOffset.FromUnixTimeMilliseconds(UpdatedAt),
            CompletedAt = CompletedAt is { } done ? DateTimeOffset.FromUnixTimeMilliseconds(done) : null,
            RemindedAt = RemindedAt is { } reminded ? DateTimeOffset.FromUnixTimeMilliseconds(reminded) : null,
        };
    }
}
