using System.Globalization;
using Hub.Core.Projects;
using Hub.Core.Tasks;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

public sealed record GitDto(string? Branch, bool IsDetached, bool HasUpstream, int Ahead, int Behind, int Changed, DateTimeOffset? LastCommitAt, string? LastCommitSubject, DateTimeOffset CheckedAt);

public sealed record NextItemDto(string File, string Text, string? Group);

public sealed record ProjectDto(
    string Root, string Name, bool Manual, bool Hidden, DateTimeOffset? LastActivity, int Done, int InProgress, int Total, int Percent,
    int Files, NextItemDto? Next, GitDto? Git, long? CustomerId, string? Alias);

public sealed record TodoItemDto(string Text, TodoItemState State, int Line);

public sealed record TodoGroupDto(string? Title, int Level, int Done, int Total, IReadOnlyList<TodoItemDto> Items);

public sealed record TodoFileDto(string RelativePath, int Done, int InProgress, int Total, DateTimeOffset LastWriteUtc, IReadOnlyList<TodoGroupDto> Groups);

public sealed record FolderBody(string? Path);

public sealed record AliasBody(string? Root, string? Alias);

public sealed record HiddenBody(string? Root, bool? Hidden);

public sealed record ProjectCustomerBody(string? Root, long? CustomerId);

public sealed record PersonalTaskDto(
    long Id, string Text, string Title, string? Details, string? ProjectRoot, string? ProjectName, DateOnly? DueDate, string? DueTime,
    TaskPriority Priority, TaskDueState DueState, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, DateTimeOffset? CompletedAt);

public sealed record TaskBody(string? Text, string? ProjectRoot, DateOnly? DueDate, string? DueTime, TaskPriority? Priority);

public sealed record CompleteBody(bool? Completed);

/// <summary>Stream <c>tasks</c>: open personal tasks due today or overdue (nav badge).</summary>
public sealed record TaskCountsDto(int Today, int Overdue);

public sealed record DictationDto(long Id, DateTimeOffset CreatedAt, double DurationSeconds, string RawText, string FinalText, bool Cleaned, string? Mode, string? Model, string? Language, string? Outputs);

/// <summary>Projects, personal tasks and dictation (docs/hub-api.md).</summary>
internal static class WorkEndpoints
{
    public const int MaxTaskLength = 10_000;

    public static void Map(IEndpointRouteBuilder app, AppHost host, DictationModelService models)
    {
        MapProjects(app, host);
        MapTasks(app, host);
        MapDictation(app, host, models);
    }

    /// <summary>Open tasks due today / overdue at <paramref name="now"/>, in the local time zone.</summary>
    public static TaskCountsDto TaskCounts(AppHost host, DateTimeOffset now)
    {
        var states = host.PersonalTasks.LoadAll().Select(t => t.DueState(now, TimeZoneInfo.Local)).ToList();
        return new TaskCountsDto(states.Count(s => s == TaskDueState.Today), states.Count(s => s == TaskDueState.Overdue));
    }

    private static void MapProjects(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/projects", (bool? includeHidden) =>
        {
            var git = host.Insights.GitStatuses;
            var customers = host.Insights.Customers.Assignments();
            return ApiJson.Ok(host.Projects.Current
                .Where(p => includeHidden == true || !p.Hidden)
                .Select(p => new ProjectDto(
                    p.Root, p.Name, p.Manual, p.Hidden, p.LastActivity, p.Done, p.InProgress, p.Total, p.Percent, p.Files.Count,
                    p.Next is { } n ? new NextItemDto(n.File.RelativePath, n.Item.Text, n.Group.Title) : null,
                    git.TryGetValue(p.Root, out var g)
                        ? new GitDto(g.Branch, g.IsDetached, g.HasUpstream, g.Ahead, g.Behind, g.Changed, g.LastCommitAt, g.LastCommitSubject, g.CheckedAt)
                        : null,
                    customers.TryGetValue(p.Root, out var c) ? c : null,
                    p.Alias))
                .ToList());
        });

        app.MapGet("/v1/projects/files", (string? root) =>
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                return ApiJson.BadRequest("'root' is required.", new Dictionary<string, string[]> { ["root"] = ["required"] });
            }

            if (host.Projects.Current.FirstOrDefault(p => string.Equals(p.Root, root, StringComparison.OrdinalIgnoreCase)) is not { } project)
            {
                return ApiJson.NotFound($"No project at {root}.");
            }

            return ApiJson.Ok(project.Files.Select(f => new TodoFileDto(
                f.RelativePath, f.Done, f.InProgress, f.Total, f.LastWriteUtc,
                f.Document.Groups.Select(g => new TodoGroupDto(g.Title, g.Level, g.Done, g.Total, g.Items.Select(i => new TodoItemDto(i.Text, i.State, i.Line)).ToList())).ToList()))
                .ToList());
        });

        app.MapPost("/v1/projects/folders", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<FolderBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(body!.Path) || !Directory.Exists(body.Path))
            {
                return ApiJson.BadRequest("'path' must be an existing folder.", new Dictionary<string, string[]> { ["path"] = ["existing folder"] });
            }

            return ApiJson.Created(new { root = host.Projects.AddFolder(body.Path) });
        });

        app.MapPut("/v1/projects/alias", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<AliasBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(body!.Root))
            {
                return ApiJson.BadRequest("'root' is required.", new Dictionary<string, string[]> { ["root"] = ["required"] });
            }

            host.Projects.SetAlias(body.Root, string.IsNullOrWhiteSpace(body.Alias) ? null : body.Alias.Trim());
            return Results.NoContent();
        });

        app.MapPut("/v1/projects/hidden", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<HiddenBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(body!.Root) || body.Hidden is null)
            {
                return ApiJson.BadRequest("'root' and 'hidden' are required.", new Dictionary<string, string[]> { ["root"] = ["required"], ["hidden"] = ["required"] });
            }

            host.Projects.SetHidden(body.Root, body.Hidden.Value);
            return Results.NoContent();
        });

        app.MapPut("/v1/projects/customer", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<ProjectCustomerBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(body!.Root))
            {
                return ApiJson.BadRequest("'root' is required.", new Dictionary<string, string[]> { ["root"] = ["required"] });
            }

            if (body.CustomerId is { } id && !host.Insights.Customers.LoadAll().Any(c => c.Id == id))
            {
                return ApiJson.NotFound($"No customer {id}.");
            }

            host.Insights.AssignCustomer(body.Root, body.CustomerId);
            return Results.NoContent();
        });
    }

    private static void MapTasks(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/tasks", (string? filter, string? q) =>
        {
            if (filter is not (null or "open" or "done" or "all"))
            {
                return ApiJson.BadRequest("'filter' must be open, done or all.", new Dictionary<string, string[]> { ["filter"] = ["open | done | all"] });
            }

            var names = UsageEndpoints.ProjectNames(host);
            var tasks = host.PersonalTasks.LoadAll().Where(t => (filter ?? "open") switch
            {
                "open" => !t.IsCompleted,
                "done" => t.IsCompleted,
                _ => true,
            });
            if (!string.IsNullOrWhiteSpace(q))
            {
                tasks = tasks.Where(t => t.Text.Contains(q, StringComparison.CurrentCultureIgnoreCase)
                    || (t.ProjectRoot is { } r && names(r).Contains(q, StringComparison.CurrentCultureIgnoreCase)));
            }

            return ApiJson.Ok(PersonalTasks.Sort(tasks, TimeZoneInfo.Local).Select(t => Task(t, names)).ToList());
        });

        app.MapPost("/v1/tasks", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<TaskBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (Validate(body!) is { } invalid)
            {
                return invalid;
            }

            var now = DateTimeOffset.UtcNow;
            var created = host.PersonalTasks.Add(Apply(new PersonalTask { Text = "" }, body!), now);
            host.Stream.MarkDirty("tasks");
            return ApiJson.Created(Task(created, UsageEndpoints.ProjectNames(host)));
        });

        app.MapPut("/v1/tasks/{id:long}", async (long id, HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<TaskBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (host.PersonalTasks.Get(id) is not { } existing)
            {
                return ApiJson.NotFound($"No task {id}.");
            }

            if (Validate(body!) is { } invalid)
            {
                return invalid;
            }

            var updated = Apply(existing, body!);
            host.PersonalTasks.Update(updated, DateTimeOffset.UtcNow);
            host.Stream.MarkDirty("tasks");
            return ApiJson.Ok(Task(host.PersonalTasks.Get(id)!, UsageEndpoints.ProjectNames(host)));
        });

        app.MapPost("/v1/tasks/{id:long}/complete", async (long id, HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<CompleteBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (host.PersonalTasks.Get(id) is null)
            {
                return ApiJson.NotFound($"No task {id}.");
            }

            var now = DateTimeOffset.UtcNow;
            host.PersonalTasks.SetCompleted(id, body!.Completed == false ? null : now, now);
            host.Stream.MarkDirty("tasks");
            return ApiJson.Ok(Task(host.PersonalTasks.Get(id)!, UsageEndpoints.ProjectNames(host)));
        });

        app.MapDelete("/v1/tasks/{id:long}", (long id) =>
        {
            if (host.PersonalTasks.Get(id) is null)
            {
                return ApiJson.NotFound($"No task {id}.");
            }

            host.PersonalTasks.Delete(id);
            host.Stream.MarkDirty("tasks");
            return Results.NoContent();
        });
    }

    private static void MapDictation(IEndpointRouteBuilder app, AppHost host, DictationModelService models)
    {
        var dictations = new Hub.Infrastructure.Data.DictationRepository(host.Database);

        app.MapGet("/v1/dictations", (int? limit) =>
            ApiJson.Ok(dictations.List(Math.Clamp(limit ?? 100, 1, Hub.Infrastructure.Data.DictationRepository.MaxRows))
                .Select(d => new DictationDto(d.Id, d.CreatedAt, d.Duration.TotalSeconds, d.RawText, d.FinalText, d.Cleaned, d.Mode, d.Model, d.Language, d.Outputs))
                .ToList()));

        app.MapDelete("/v1/dictations/{id:long}", (long id) =>
        {
            if (!dictations.List().Any(d => d.Id == id))
            {
                return ApiJson.NotFound($"No dictation {id}.");
            }

            dictations.Delete(id);
            return Results.NoContent();
        });

        app.MapDelete("/v1/dictations", () =>
        {
            dictations.Clear();
            return Results.NoContent();
        });

        app.MapGet("/v1/dictation/models", () => ApiJson.Ok(models.Status(host.Settings.Dictation.Model)));

        app.MapPost("/v1/dictation/models/{id}/download", (string id) =>
            models.Start(id) ? ApiJson.Ok(models.Status(host.Settings.Dictation.Model)) : ApiJson.NotFound($"No model '{id}'."));

        app.MapPost("/v1/dictation/models/{id}/cancel", (string id) =>
            models.Cancel(id) ? ApiJson.Ok(models.Status(host.Settings.Dictation.Model)) : ApiJson.NotFound($"No model '{id}'."));

        app.MapDelete("/v1/dictation/models/{id}", (string id) =>
            models.Delete(id) ? Results.NoContent() : ApiJson.NotFound($"No model '{id}'."));
    }

    private static IResult? Validate(TaskBody body)
    {
        var fields = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(body.Text))
        {
            fields["text"] = ["required"];
        }
        else if (body.Text.Length > MaxTaskLength)
        {
            fields["text"] = [string.Create(CultureInfo.InvariantCulture, $"at most {MaxTaskLength} characters")];
        }

        if (body.DueTime is not null)
        {
            if (body.DueDate is null)
            {
                fields["dueTime"] = ["needs dueDate"];
            }
            else if (!TimeOnly.TryParseExact(body.DueTime, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                fields["dueTime"] = ["HH:mm"];
            }
        }

        return fields.Count == 0 ? null : ApiJson.BadRequest("The task is not valid.", fields);
    }

    private static PersonalTask Apply(PersonalTask task, TaskBody body) => task with
    {
        Text = PersonalTask.NormalizeLines(body.Text!.Trim()),
        ProjectRoot = string.IsNullOrWhiteSpace(body.ProjectRoot) ? null : body.ProjectRoot,
        DueDate = body.DueDate,
        DueTime = body.DueTime is { } t ? TimeOnly.ParseExact(t, "HH:mm", CultureInfo.InvariantCulture) : null,
        Priority = body.Priority ?? task.Priority,
        // A changed deadline is reminded again (spec §21.3).
        RemindedAt = task.DueDate == body.DueDate && task.DueTime?.ToString("HH:mm", CultureInfo.InvariantCulture) == body.DueTime ? task.RemindedAt : null,
    };

    private static PersonalTaskDto Task(PersonalTask t, Func<string, string> names) => new(
        t.Id, t.Text, t.Title, t.Details, t.ProjectRoot, t.ProjectRoot is { } r ? names(r) : null, t.DueDate,
        t.DueTime?.ToString("HH:mm", CultureInfo.InvariantCulture), t.Priority, t.DueState(DateTimeOffset.UtcNow, TimeZoneInfo.Local),
        t.CreatedAt, t.UpdatedAt, t.CompletedAt);
}
