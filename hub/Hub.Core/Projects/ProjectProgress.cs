namespace Hub.Core.Projects;

/// <summary>One todo file of a project (spec §8.2). <see cref="RelativePath"/> uses forward slashes.</summary>
public sealed record TodoFile(string RelativePath, TodoDocument Document, DateTimeOffset LastWriteUtc)
{
    public int Done => Document.Done;

    public int InProgress => Document.InProgress;

    public int Total => Document.Total;

    public bool IsComplete => Total > 0 && Done == Total;
}

/// <summary>A known project with its todo progress (spec §8.1–8.2).</summary>
public sealed record ProjectProgress(
    string Root,
    string Name,
    bool Manual,
    bool Hidden,
    DateTimeOffset? LastActivity,
    IReadOnlyList<TodoFile> Files)
{
    /// <summary>The user's display name for the project; null when <see cref="Name"/> is the folder name.</summary>
    public string? Alias { get; init; }

    public int Done => Files.Sum(f => f.Done);

    public int InProgress => Files.Sum(f => f.InProgress);

    public int Total => Files.Sum(f => f.Total);

    public bool HasTodos => Total > 0;

    /// <summary>0–100, rounded down so a project is never shown 100 % with items left.</summary>
    public int Percent => Percentage(Done, Total);

    public DateTimeOffset? LastTodoChange => Files.Count == 0 ? null : Files.Max(f => f.LastWriteUtc);

    /// <summary>Next open item across files, in file order.</summary>
    public (TodoFile File, TodoItem Item, TodoGroup Group)? Next =>
        Files.Select(f => (File: f, Next: f.Document.Next))
            .Where(x => x.Next is not null)
            .Select(x => ((TodoFile, TodoItem, TodoGroup)?)(x.File, x.Next!.Value.Item, x.Next!.Value.Group))
            .FirstOrDefault();

    public static int Percentage(int done, int total) => total <= 0 ? 0 : (int)Math.Floor(done * 100.0 / total);
}

/// <summary>A todo file that just reached 100 % (rule <c>todo.completed</c>, spec §11.1).</summary>
public sealed record TodoCompletion(string ProjectRoot, string ProjectName, string RelativePath, int Total);

/// <summary>
/// Turns successive scans into <c>todo.completed</c> events. The first scan of a project only records a baseline, so files
/// that were already complete before the app started do not notify (decision D-050).
/// </summary>
public sealed class TodoCompletionDetector
{
    private readonly Dictionary<string, Dictionary<string, bool>> _known = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<TodoCompletion> Observe(ProjectProgress project)
    {
        var current = project.Files.ToDictionary(f => f.RelativePath, f => f.IsComplete, StringComparer.OrdinalIgnoreCase);
        if (!_known.TryGetValue(project.Root, out var previous))
        {
            _known[project.Root] = current;
            return [];
        }

        _known[project.Root] = current;
        return project.Files
            .Where(f => f.IsComplete && previous.TryGetValue(f.RelativePath, out var wasComplete) && !wasComplete)
            .Select(f => new TodoCompletion(project.Root, project.Name, f.RelativePath, f.Total))
            .ToList();
    }

    public void Forget(string root) => _known.Remove(root);
}
