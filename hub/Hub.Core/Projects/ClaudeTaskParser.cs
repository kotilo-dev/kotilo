using System.Text.Json;

namespace Hub.Core.Projects;

/// <summary>Counts from a session's Claude Code task list (spec §8.3). Only statuses are read, never task text.</summary>
public sealed record TaskListProgress(int Completed, int InProgress, int Total)
{
    public static TaskListProgress Empty { get; } = new(0, 0, 0);

    public TaskListProgress Add(TaskListProgress other) =>
        new(Completed + other.Completed, InProgress + other.InProgress, Total + other.Total);
}

/// <summary>
/// Tolerant reader for Claude Code task files: a single task object (<c>tasks/&lt;session&gt;/&lt;n&gt;.json</c>) or an array of
/// todo objects (<c>todos/&lt;session&gt;-*.json</c>), each with <c>status: pending | in_progress | completed</c>.
/// Anything else yields null so the feature silently switches off when the format changes (decision D-051).
/// </summary>
public static class ClaudeTaskParser
{
    public static TaskListProgress? Parse(ReadOnlySpan<byte> json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            return doc.RootElement.ValueKind switch
            {
                JsonValueKind.Object => FromItem(doc.RootElement),
                JsonValueKind.Array => FromArray(doc.RootElement),
                _ => null,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static TaskListProgress? FromArray(JsonElement array)
    {
        var total = TaskListProgress.Empty;
        foreach (var item in array.EnumerateArray())
        {
            if (FromItem(item) is not { } one)
            {
                return null;
            }

            total = total.Add(one);
        }

        return total;
    }

    private static TaskListProgress? FromItem(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object
            || !item.TryGetProperty("status", out var status)
            || status.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return status.GetString() switch
        {
            "completed" => new TaskListProgress(1, 0, 1),
            "in_progress" => new TaskListProgress(0, 1, 1),
            "pending" => new TaskListProgress(0, 0, 1),

            // Deleted tasks are not part of the list.
            "deleted" => TaskListProgress.Empty,
            _ => null,
        };
    }
}
