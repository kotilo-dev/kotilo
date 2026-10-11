using Hub.Core.Adapters;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Copilot;

/// <summary>
/// The Copilot CLI usage source: <c>session-state/&lt;id&gt;/events.jsonl</c> files (<see cref="CopilotSessionUsage"/>). The
/// files grow with every event, but only <c>session.shutdown</c> carries tokens: a pass reads just the new bytes, and only
/// when they hold a shutdown is the whole file replayed (session id, cwd and earlier shutdowns come before it). Sessions
/// whose cwd is under <paramref name="ignoredDir"/> (the hub's own AI runs, D-026) are skipped. Not thread-safe.
/// </summary>
public sealed class CopilotSessionScanner(string sessionStateDir, UsageSourceContext context, string? ignoredDir = null) : IFileUsageSource
{
    public const string FileName = "events.jsonl";

    public string Agent => AgentIds.Copilot;

    public IReadOnlyList<string> WatchDirs => [sessionStateDir];

    public string FilePattern => FileName;

    public bool ReportsActivity => false;

    public bool Owns(string path) =>
        TranscriptScanner.IsUnder(path, sessionStateDir) && string.Equals(Path.GetFileName(path), FileName, StringComparison.OrdinalIgnoreCase);

    public ScanResult ScanAll(DateTime since)
    {
        if (!Directory.Exists(sessionStateDir))
        {
            return ScanResult.Empty;
        }

        var known = context.Offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var path in Directory.EnumerateFiles(sessionStateDir, FileName, SearchOption.AllDirectories))
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

        var entries = new List<Core.Usage.UsageEntry>();
        var lines = 0;
        long consumed;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
            stream.Seek(start, SeekOrigin.Begin);
            var shutdown = false;
            consumed = TranscriptScanner.ReadLines(stream, line =>
            {
                lines++;
                shutdown |= line.IndexOf(CopilotSessionUsage.ShutdownMarker) >= 0;
            });

            if (shutdown)
            {
                // Replay the file up to the same point: the dedup keys make re-reading earlier shutdowns harmless.
                stream.Seek(0, SeekOrigin.Begin);
                var state = new CopilotSessionUsage.State { SessionId = Path.GetFileName(Path.GetDirectoryName(path)) };
                var end = start + consumed;
                long position = 0;
                TranscriptScanner.ReadLines(stream, line =>
                {
                    position += line.Length + 1;
                    if (position <= end)
                    {
                        entries.AddRange(CopilotSessionUsage.ParseLine(line, state));
                    }
                });

                if (ignoredDir is not null && state.Cwd is { } cwd && TranscriptScanner.IsUnder(cwd, ignoredDir))
                {
                    entries.Clear();
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var written = context.Store(entries, Agent);
        context.Offsets.Set(path, new TranscriptOffset(start + consumed, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, 0, 0) { Lines = lines };
    }
}
