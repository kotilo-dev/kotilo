using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Qwen;

/// <summary>
/// The Qwen Code usage source: chat recordings <c>&lt;runtime dir&gt;/projects/&lt;sanitized cwd&gt;/chats/&lt;sessionId&gt;.jsonl</c>
/// (<see cref="AgentHomes.QwenRuntimeDir"/>), read incrementally from the stored offset. Every record carries its own
/// session id and cwd, so no earlier line has to be replayed. Not thread-safe; callers serialize passes.
/// </summary>
public sealed class QwenChatScanner(string runtimeDir, UsageSourceContext context, string? excludedRoot = null, string agent = AgentIds.Qwen) : IFileUsageSource
{
    private const string ChatsDir = "chats";

    public string Agent => agent;

    public string ProjectsDir => Path.Combine(runtimeDir, "projects");

    public IReadOnlyList<string> WatchDirs => [ProjectsDir];

    public string FilePattern => "*.jsonl";

    public bool ReportsActivity => false;

    /// <summary>A <c>.jsonl</c> file inside a project's <c>chats</c> folder.</summary>
    public bool Owns(string path)
    {
        if (!TranscriptScanner.IsUnder(path, ProjectsDir) || !path.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        var parts = Path.GetRelativePath(ProjectsDir, path).Split('\\', '/');
        return parts.Length >= 3 && parts[1].Equals(ChatsDir, StringComparison.OrdinalIgnoreCase);
    }

    public ScanResult ScanAll(DateTime since)
    {
        if (!Directory.Exists(ProjectsDir))
        {
            return ScanResult.Empty;
        }

        List<string> files;
        try
        {
            files = Directory.EnumerateFiles(ProjectsDir, "*.jsonl", SearchOption.AllDirectories).Where(Owns).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var known = context.Offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var path in files)
        {
            FileInfo info;
            try
            {
                info = new FileInfo(path);
            }
            catch (IOException)
            {
                continue;
            }

            if (info.LastWriteTimeUtc < since
                || (known.TryGetValue(path, out var stored) && stored.LastWriteUtc == info.LastWriteTimeUtc && stored.Offset == info.Length))
            {
                continue;
            }

            total = total.Add(ScanFile(path));
        }

        return total;
    }

    public ScanResult ScanFile(string path)
    {
        FileInfo info;
        try
        {
            info = new FileInfo(path);
            if (!info.Exists)
            {
                return ScanResult.Empty;
            }
        }
        catch (IOException)
        {
            return ScanResult.Empty;
        }

        var start = context.Offsets.Get(path)?.Offset ?? 0;
        if (start > info.Length)
        {
            start = 0;
        }

        var fallbackSession = Path.GetFileNameWithoutExtension(path);
        var entries = new List<UsageEntry>();
        var lines = 0;
        long consumed;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
            stream.Seek(start, SeekOrigin.Begin);
            consumed = TranscriptScanner.ReadLines(stream, line =>
            {
                lines++;
                // The hub's own headless AI runs (D-026) are not the user's usage.
                if (QwenChatParser.ParseLine(line, fallbackSession, agent) is { } entry
                    && (excludedRoot is null || entry.ProjectRoot is null || !TranscriptScanner.IsUnder(entry.ProjectRoot, excludedRoot)))
                {
                    entries.Add(entry);
                }
            });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var written = context.Store(entries, agent);
        context.Offsets.Set(path, new TranscriptOffset(start + consumed, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, 0, 0) { Lines = lines };
    }
}
