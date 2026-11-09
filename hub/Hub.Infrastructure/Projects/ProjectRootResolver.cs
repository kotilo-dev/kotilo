using System.Collections.Concurrent;

namespace Hub.Infrastructure.Projects;

/// <summary>Where a working directory belongs: its project root, and the linked git worktree it sits in (null otherwise).</summary>
public sealed record ProjectLocation(string? Root, string? Worktree);

/// <summary>
/// Normalizes a working directory to its project root (spec §8.1): the enclosing git repository root when
/// there is one, otherwise the directory itself. Claude's <c>cwd</c> follows <c>cd</c> commands, so without
/// this one project shows up as many subfolders. A linked worktree (0.6) belongs to its main repository's project.
/// Results are cached per directory.
/// </summary>
public sealed class ProjectRootResolver
{
    private const string GitDirPrefix = "gitdir:";
    private const string HeadRefPrefix = "ref: refs/heads/";

    private readonly ConcurrentDictionary<string, ProjectLocation> _cache = new(StringComparer.OrdinalIgnoreCase);
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

    public string? Resolve(string? cwd) => ResolveLocation(cwd).Root;

    /// <summary>Project root plus the linked worktree root when <paramref name="cwd"/> is inside one.</summary>
    public ProjectLocation ResolveLocation(string? cwd)
    {
        if (string.IsNullOrWhiteSpace(cwd))
        {
            return new ProjectLocation(cwd, null);
        }

        foreach (var root in _fixedRoots)
        {
            var normalized = cwd.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar).TrimEnd(Path.DirectorySeparatorChar);
            if (normalized.Equals(root, StringComparison.OrdinalIgnoreCase)
                || normalized.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                return new ProjectLocation(root, null);
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
                    var folder = Path.TrimEndingDirectorySeparator(current.FullName);
                    var git = Path.Combine(folder, ".git");
                    if (Directory.Exists(git))
                    {
                        return new ProjectLocation(folder, null);
                    }

                    if (File.Exists(git))
                    {
                        return MainRepoOf(folder, git) is { } main ? new ProjectLocation(main, folder) : new ProjectLocation(folder, null);
                    }
                }

                return new ProjectLocation(full, null);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return new ProjectLocation(dir, null);
            }
        });
    }

    /// <summary>
    /// Branch checked out in a linked worktree (<c>HEAD</c> of its private git dir); null when detached or unreadable.
    /// Not cached: the agent may switch branches.
    /// </summary>
    public static string? WorktreeBranch(string worktreeRoot)
    {
        try
        {
            if (GitDirOf(worktreeRoot, Path.Combine(worktreeRoot, ".git")) is not { } gitDir)
            {
                return null;
            }

            var head = Path.Combine(gitDir, "HEAD");
            if (!File.Exists(head))
            {
                return null;
            }

            var line = File.ReadLines(head).FirstOrDefault()?.Trim();
            return line is not null && line.StartsWith(HeadRefPrefix, StringComparison.Ordinal) && line.Length > HeadRefPrefix.Length
                ? line[HeadRefPrefix.Length..]
                : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>
    /// Main repository root of a linked worktree: <c>.git</c> file → <c>gitdir:</c> → its <c>commondir</c> → the common git dir,
    /// whose parent is the main checkout when it is named <c>.git</c>. Null for submodules (no <c>commondir</c>) and bare repos.
    /// </summary>
    private static string? MainRepoOf(string folder, string gitFile)
    {
        if (GitDirOf(folder, gitFile) is not { } gitDir)
        {
            return null;
        }

        var commonFile = Path.Combine(gitDir, "commondir");
        if (!File.Exists(commonFile))
        {
            return null;
        }

        var common = File.ReadLines(commonFile).FirstOrDefault()?.Trim();
        if (string.IsNullOrEmpty(common))
        {
            return null;
        }

        var commonDir = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(gitDir, common)));
        if (!Path.GetFileName(commonDir).Equals(".git", StringComparison.OrdinalIgnoreCase) || !Directory.Exists(commonDir))
        {
            return null;
        }

        return Path.GetDirectoryName(commonDir) is { Length: > 0 } main ? Path.TrimEndingDirectorySeparator(main) : null;
    }

    /// <summary>The directory a <c>.git</c> file points to (<c>gitdir: &lt;path&gt;</c>, relative to the file's folder); null if malformed or missing.</summary>
    private static string? GitDirOf(string folder, string gitFile)
    {
        if (!File.Exists(gitFile))
        {
            return null;
        }

        var line = File.ReadLines(gitFile).FirstOrDefault()?.Trim();
        if (line is null || !line.StartsWith(GitDirPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var target = line[GitDirPrefix.Length..].Trim();
        if (target.Length == 0)
        {
            return null;
        }

        var gitDir = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(folder, target)));
        return Directory.Exists(gitDir) ? gitDir : null;
    }
}
