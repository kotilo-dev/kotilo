using System.Text;
using Hub.Core.Projects;

namespace Hub.Infrastructure.Projects;

/// <summary>
/// Finds and parses a project's todo files (spec §8.2): files under the glob's base folder, at most
/// <see cref="MaxDepth"/> folders deep, that match the glob. Large files and tool folders are skipped.
/// </summary>
public static class TodoScanner
{
    public const int MaxDepth = 3;
    private const long MaxFileBytes = 2 * 1024 * 1024;
    private static readonly HashSet<string> SkippedFolders = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", ".vs", ".idea",
    };

    /// <summary>The folder a watcher should observe for this project, or null when it does not exist.</summary>
    public static string? WatchDirectory(string root, GlobPattern glob)
    {
        var dir = glob.BaseDirectory.Length == 0 ? root : Path.Combine(root, glob.BaseDirectory);
        return Directory.Exists(dir) ? dir : null;
    }

    /// <summary>
    /// Every matching file, parsed. A file of <paramref name="previous"/> whose write time is unchanged is reused instead
    /// of read again (the 60 s project sweep would otherwise re-read every todo file of every project).
    /// </summary>
    public static IReadOnlyList<TodoFile> Scan(string root, GlobPattern glob, IReadOnlyList<TodoFile>? previous = null)
    {
        var start = WatchDirectory(root, glob);
        if (start is null)
        {
            return [];
        }

        var known = previous?.ToDictionary(f => f.RelativePath, StringComparer.Ordinal) ?? [];
        var files = new List<TodoFile>();
        Walk(start, 0);
        return files.OrderBy(f => f.RelativePath, StringComparer.OrdinalIgnoreCase).ToList();

        void Walk(string dir, int depth)
        {
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFiles(dir).ToList();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return;
            }

            foreach (var path in entries)
            {
                var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
                if (!glob.IsMatch(relative))
                {
                    continue;
                }

                if (known.TryGetValue(relative, out var same) && same.LastWriteUtc == LastWriteUtc(path))
                {
                    files.Add(same);
                }
                else if (Read(path, relative) is { } file)
                {
                    files.Add(file);
                }
            }

            if (depth >= MaxDepth)
            {
                return;
            }

            try
            {
                foreach (var sub in Directory.EnumerateDirectories(dir).ToList())
                {
                    var name = Path.GetFileName(sub);
                    if (!SkippedFolders.Contains(name) && !name.StartsWith('.'))
                    {
                        Walk(sub, depth + 1);
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private static DateTimeOffset? LastWriteUtc(string path)
    {
        try
        {
            return new DateTimeOffset(File.GetLastWriteTimeUtc(path), TimeSpan.Zero);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Parses one file; null when it vanished, is locked or too large.</summary>
    public static TodoFile? Read(string path, string relativePath)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxFileBytes)
            {
                return null;
            }

            // Editors often save by replace; share everything so we never block them.
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            return new TodoFile(relativePath, TodoParser.Parse(reader.ReadToEnd()), new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
