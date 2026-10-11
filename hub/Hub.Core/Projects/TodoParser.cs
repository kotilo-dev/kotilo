namespace Hub.Core.Projects;

public enum TodoItemState
{
    Open,

    /// <summary><c>[~]</c> or <c>[-]</c>: shown separately, counted as not done (spec §8.2).</summary>
    InProgress,

    Done,
}

/// <param name="Line">1-based line number in the file.</param>
public sealed record TodoItem(string Text, TodoItemState State, int Line);

/// <summary>Checkboxes under one heading. <see cref="Title"/> is null for items before the first heading.</summary>
public sealed record TodoGroup(string? Title, int Level, IReadOnlyList<TodoItem> Items)
{
    public int Done => Items.Count(i => i.State == TodoItemState.Done);

    public int InProgress => Items.Count(i => i.State == TodoItemState.InProgress);

    public int Total => Items.Count;
}

/// <summary>Parsed checklist of one markdown file.</summary>
public sealed record TodoDocument(IReadOnlyList<TodoGroup> Groups)
{
    public static TodoDocument Empty { get; } = new([]);

    public int Done => Groups.Sum(g => g.Done);

    public int InProgress => Groups.Sum(g => g.InProgress);

    public int Total => Groups.Sum(g => g.Total);

    /// <summary>First item that is not done ("sıradaki"), with the heading it sits under.</summary>
    public (TodoItem Item, TodoGroup Group)? Next =>
        Groups.SelectMany(g => g.Items.Select(i => (Item: i, Group: g)))
            .Where(x => x.Item.State != TodoItemState.Done)
            .Select(x => ((TodoItem, TodoGroup)?)x)
            .FirstOrDefault();
}

/// <summary>
/// Markdown checkbox parser (spec §8.2). Recognizes <c>- [ ]</c>, <c>* [ ]</c>, <c>+ [ ]</c> and <c>1. [ ]</c> / <c>1) [ ]</c>,
/// indented or not; <c>[x]</c>/<c>[X]</c> done, <c>[~]</c>/<c>[-]</c> in progress. Fenced code blocks are skipped.
/// Items are grouped under the nearest <c>#</c>–<c>###</c> heading; groups without items are dropped.
/// </summary>
public static class TodoParser
{
    public const int MaxGroupingLevel = 3;

    public static TodoDocument Parse(string text)
    {
        var groups = new List<TodoGroup>();
        string? title = null;
        var level = 0;
        var items = new List<TodoItem>();
        string? fence = null;
        var lineNumber = 0;

        foreach (var raw in text.AsSpan().EnumerateLines())
        {
            lineNumber++;
            var line = raw.TrimStart();

            if (fence is not null)
            {
                if (line.StartsWith(fence, StringComparison.Ordinal))
                {
                    fence = null;
                }

                continue;
            }

            if (line.StartsWith("```", StringComparison.Ordinal) || line.StartsWith("~~~", StringComparison.Ordinal))
            {
                fence = line[..3].ToString();
                continue;
            }

            if (raw.Length > 0 && raw[0] == '#' && TryHeading(line, out var headingLevel, out var headingText))
            {
                if (headingLevel <= MaxGroupingLevel)
                {
                    Flush();
                    title = headingText;
                    level = headingLevel;
                }

                continue;
            }

            if (TryCheckbox(line, out var state, out var itemText))
            {
                items.Add(new TodoItem(itemText, state, lineNumber));
            }
        }

        Flush();
        return new TodoDocument(groups);

        void Flush()
        {
            if (items.Count > 0)
            {
                groups.Add(new TodoGroup(title, level, items));
                items = [];
            }
        }
    }

    private static bool TryHeading(ReadOnlySpan<char> line, out int level, out string text)
    {
        level = 0;
        while (level < line.Length && line[level] == '#')
        {
            level++;
        }

        text = "";
        if (level is 0 or > 6 || (level < line.Length && line[level] != ' ' && line[level] != '\t'))
        {
            return false;
        }

        text = line[level..].Trim().TrimEnd('#').Trim().ToString();
        return true;
    }

    private static bool TryCheckbox(ReadOnlySpan<char> line, out TodoItemState state, out string text)
    {
        state = TodoItemState.Open;
        text = "";

        // Bullet ("-", "*", "+") or ordered marker ("1.", "12)").
        int i;
        if (line.Length > 0 && line[0] is '-' or '*' or '+')
        {
            i = 1;
        }
        else
        {
            i = 0;
            while (i < line.Length && char.IsAsciiDigit(line[i]))
            {
                i++;
            }

            if (i == 0 || i >= line.Length || line[i] is not ('.' or ')'))
            {
                return false;
            }

            i++;
        }

        // At least one space, then "[c]", then a space or end of line.
        if (i >= line.Length || line[i] != ' ')
        {
            return false;
        }

        while (i < line.Length && line[i] == ' ')
        {
            i++;
        }

        if (i + 2 >= line.Length || line[i] != '[' || line[i + 2] != ']')
        {
            return false;
        }

        switch (line[i + 1])
        {
            case ' ':
                state = TodoItemState.Open;
                break;
            case 'x' or 'X':
                state = TodoItemState.Done;
                break;
            case '~' or '-':
                state = TodoItemState.InProgress;
                break;
            default:
                return false;
        }

        var rest = line[(i + 3)..];
        if (rest.Length > 0 && rest[0] != ' ' && rest[0] != '\t')
        {
            return false;
        }

        text = rest.Trim().ToString();
        return true;
    }
}
