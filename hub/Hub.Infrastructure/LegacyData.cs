using Hub.Core;

namespace Hub.Infrastructure;

public enum LegacyMoveState
{
    /// <summary>No legacy names, a data folder override, the brand's folder exists already, or no legacy folder.</summary>
    NotNeeded,

    Moved,

    /// <summary>The move failed (the hub starts on an empty folder; the legacy one is left as it was).</summary>
    Failed,

    /// <summary>A hub under a legacy name still runs and holds its folder: try again later.</summary>
    LegacyHubRunning,
}

public sealed record LegacyMove(LegacyMoveState State, string? From = null, string? Error = null)
{
    public static readonly LegacyMove NotNeeded = new(LegacyMoveState.NotNeeded);
}

/// <summary>
/// After a rename, the hub takes over its legacy-named data folder (<c>%LOCALAPPDATA%\&lt;legacy slug&gt;\hub</c>) once, when its
/// own folder doesn't exist yet. The hub owns this folder; the desktop app moves its own folders (<c>brand.rs</c>). Runs
/// only while this process holds the instance mutex and no legacy hub holds its own.
/// </summary>
public static class LegacyData
{
    public static LegacyMove MigrateHubDataDir(AppPaths paths, Brand brand)
    {
        if (brand.LegacySlugs.Count == 0 || Environment.GetEnvironmentVariable(AppPaths.DataDirVariable) is { Length: > 0 })
        {
            return LegacyMove.NotNeeded;
        }

        var legacy = brand.LegacySlugs.Where(s => s != brand.Slug).ToList();
        if (legacy.Any(IsHubRunning))
        {
            return Directory.Exists(paths.DataDir) ? LegacyMove.NotNeeded : new LegacyMove(LegacyMoveState.LegacyHubRunning);
        }

        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return MoveIfMissing(paths.DataDir, legacy.Select(s => Path.Combine(local, s, "hub")));
    }

    /// <summary>Moves the first existing <paramref name="legacyDirs"/> entry to <paramref name="target"/> when that is missing. Never merges.</summary>
    public static LegacyMove MoveIfMissing(string target, IEnumerable<string> legacyDirs)
    {
        if (Directory.Exists(target) || File.Exists(target))
        {
            return LegacyMove.NotNeeded;
        }

        if (legacyDirs.FirstOrDefault(Directory.Exists) is not { } from)
        {
            return LegacyMove.NotNeeded;
        }

        try
        {
            if (Path.GetDirectoryName(Path.GetFullPath(target)) is { } parent)
            {
                Directory.CreateDirectory(parent);
            }

            Directory.Move(from, target);
            return new LegacyMove(LegacyMoveState.Moved, from);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new LegacyMove(LegacyMoveState.Failed, from, ex.Message);
        }
    }

    private static bool IsHubRunning(string legacySlug)
    {
        if (!Mutex.TryOpenExisting(AppPaths.InstanceMutexNameFor(legacySlug), out var mutex))
        {
            return false;
        }

        mutex.Dispose();
        return true;
    }
}
