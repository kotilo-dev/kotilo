using System.Collections.Concurrent;

namespace Hub.Infrastructure.Projects;

/// <summary>
/// Normalizes a working directory to its project root (spec §8.1): the enclosing git repository root when
/// there is one, otherwise the directory itself. Claude's <c>cwd</c> follows <c>cd</c> commands, so without
/// this one project shows up as many subfolders. Results are cached per directory.
/// </summary>
public sealed class ProjectRootResolver
{
    private readonly ConcurrentDictionary<string, string> _cache = new(StringComparer.OrdinalIgnoreCase);
    private volatile string[] _fixedRoots = [];

    /// <summary>
    /// A folder that is always its own root, even inside a git repository: Bip's buddy folder must never be folded into
    /// an enclosing project (spec §17.2, decision D-073).
    /// </summary>
    public void AddFixedRoot(string root)
    {
        _fixedRoots = [.. _fixedRoots, Path.TrimEndingDirectorySeparator(Path.GetFullPath(root))];
        _cache.Clear();
    }

    public string? Resolve(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            return cwd;
        }

        foreach (var root in _fixedRoots)
        {
            var normalized = cwd.Replace('/', '\\').TrimEnd('\\');
            if (normalized.Equals(root, StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase))
            {
                return root;
            }
        }

        return _cache.GetOrAdd(cwd, static dir =>
        {
            try
            {
                var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dir));
                for (var current = new DirectoryInfo(full); current is not null; current = current.Parent)
                {
                    // ".git" is a directory in a normal clone and a file in worktrees / submodules.
                    var git = Path.Combine(current.FullName, ".git");
                    if (Directory.Exists(git) || File.Exists(git))
                    {
                        return Path.TrimEndingDirectorySeparator(current.FullName);
                    }
                }

                return full;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return dir;
            }
        });
    }
}
