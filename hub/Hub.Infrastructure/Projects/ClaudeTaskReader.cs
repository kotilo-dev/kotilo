using Hub.Core.Projects;

namespace Hub.Infrastructure.Projects;

/// <summary>
/// Reads a session's Claude Code task list (spec §8.3) from <c>&lt;claude&gt;/tasks/&lt;session&gt;/*.json</c> (current format)
/// or <c>&lt;claude&gt;/todos/&lt;session&gt;*.json</c> (older format). Returns null when there is no list or any file has an
/// unknown shape, so the feature quietly disappears instead of showing wrong numbers (decision D-051).
/// </summary>
public sealed class ClaudeTaskReader(string claudeConfigDir)
{
    private const long MaxFileBytes = 256 * 1024;

    public string TasksDir { get; } = Path.Combine(claudeConfigDir, "tasks");

    public string TodosDir { get; } = Path.Combine(claudeConfigDir, "todos");

    /// <summary>The session a changed file belongs to, or null for unrelated paths.</summary>
    public string? SessionIdFor(string path)
    {
        var full = Path.GetFullPath(path);
        if (IsUnder(full, TasksDir))
        {
            var relative = Path.GetRelativePath(TasksDir, full).Split(Path.DirectorySeparatorChar);
            return relative.Length >= 1 && relative[0].Length > 0 ? relative[0] : null;
        }

        if (IsUnder(full, TodosDir))
        {
            // "<session>-agent-<session>.json" in the older format.
            var name = Path.GetFileNameWithoutExtension(full);
            var cut = name.IndexOf("-agent-", StringComparison.OrdinalIgnoreCase);
            return cut > 0 ? name[..cut] : name;
        }

        return null;
    }

    public TaskListProgress? Read(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || sessionId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            return null;
        }

        var files = new List<string>();
        var taskDir = Path.Combine(TasksDir, sessionId);
        try
        {
            if (Directory.Exists(taskDir))
            {
                files.AddRange(Directory.EnumerateFiles(taskDir, "*.json"));
            }

            if (Directory.Exists(TodosDir))
            {
                files.AddRange(Directory.EnumerateFiles(TodosDir, sessionId + "*.json"));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (files.Count == 0)
        {
            return null;
        }

        var total = TaskListProgress.Empty;
        foreach (var file in files)
        {
            byte[] bytes;
            try
            {
                if (new FileInfo(file).Length > MaxFileBytes)
                {
                    return null;
                }

                using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                bytes = memory.ToArray();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Being rewritten right now; the next change event reads it again.
                continue;
            }

            if (ClaudeTaskParser.Parse(bytes) is not { } progress)
            {
                return null;
            }

            total = total.Add(progress);
        }

        return total.Total == 0 ? null : total;
    }

    private static bool IsUnder(string path, string dir) =>
        path.StartsWith(Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir)) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
}
