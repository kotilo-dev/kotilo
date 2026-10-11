namespace Hub.Infrastructure.Hooks;

/// <summary>Reads hook envelopes buffered by agenthub-hook while the app was down (spec §5.2/7).</summary>
public static class SpoolReader
{
    /// <summary>Returns spooled envelopes oldest first and deletes them. Unreadable files are deleted too.</summary>
    public static IReadOnlyList<byte[]> Drain(string spoolDir)
    {
        if (!Directory.Exists(spoolDir))
        {
            return [];
        }

        var result = new List<byte[]>();

        // File names start with the zero-padded UTC ticks, so ordinal order is chronological.
        foreach (var file in Directory.EnumerateFiles(spoolDir, "*.json").Order(StringComparer.Ordinal))
        {
            try
            {
                result.Add(File.ReadAllBytes(file));
            }
            catch (IOException)
            {
                // Still being written by a hook; leave it for the next start.
                continue;
            }

            TryDelete(file);
        }

        foreach (var stale in Directory.EnumerateFiles(spoolDir, "*.tmp"))
        {
            if (File.GetLastWriteTimeUtc(stale) < DateTime.UtcNow.AddMinutes(-5))
            {
                TryDelete(stale);
            }
        }

        return result;
    }

    private static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
