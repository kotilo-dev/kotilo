using Hub.Core.Adapters;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;

namespace Hub.Infrastructure.Usage;

/// <summary>Outcome of one scan pass. Line counts feed the parser health check (spec §18.6).</summary>
/// <param name="MalformedUsageLines">Assistant lines (other than API errors) without a usable usage object.</param>
public sealed record ScanResult(int FilesRead, int Entries, int RowsWritten, int InvalidLines, int MalformedUsageLines)
{
    public static ScanResult Empty { get; } = new(0, 0, 0, 0, 0);

    public int Lines { get; init; }

    public int AssistantLines { get; init; }

    /// <summary>API errors Claude Code wrote to transcripts (spec §18.5 fallback).</summary>
    public IReadOnlyList<TranscriptError> Errors { get; init; } = [];

    /// <summary>Claude Code version from the last line that carried one.</summary>
    public string? ClaudeVersion { get; init; }

    /// <summary>Newest plan limits read in this pass (Codex rollouts), if any.</summary>
    public PlanLimits? Limits { get; init; }

    public ScanResult Add(ScanResult other) => new(
        FilesRead + other.FilesRead,
        Entries + other.Entries,
        RowsWritten + other.RowsWritten,
        InvalidLines + other.InvalidLines,
        MalformedUsageLines + other.MalformedUsageLines)
    {
        Lines = Lines + other.Lines,
        AssistantLines = AssistantLines + other.AssistantLines,
        Errors = [.. Errors, .. other.Errors],
        ClaudeVersion = other.ClaudeVersion ?? ClaudeVersion,
        Limits = other.Limits is not null && (Limits is null || other.Limits.ReceivedAt >= Limits.ReceivedAt) ? other.Limits : Limits,
    };
}

/// <summary>
/// Incremental Claude Code transcript reader (spec §7.1), the Claude usage source: reads only bytes past the stored offset,
/// restarts a file that shrank, leaves a trailing half-written line for the next pass, and stores usage via
/// <see cref="UsageRepository"/>. Not thread-safe; callers serialize passes.
/// </summary>
public sealed class TranscriptScanner(
    string projectsDir, TranscriptOffsetStore offsets, UsageRepository usage, Func<PricingTable> pricing, ProjectRootResolver? roots = null,
    string agent = AgentIds.ClaudeCode) : IFileUsageSource
{
    public string Agent => agent;

    public IReadOnlyList<string> WatchDirs => [projectsDir];

    public string FilePattern => "*.jsonl";

    /// <summary>Claude transcript writes feed the "hooks silent" health check (spec §18.6).</summary>
    public bool ReportsActivity => true;

    public bool Owns(string path) => IsUnder(path, projectsDir);

    /// <summary>True when <paramref name="path"/> lies inside <paramref name="dir"/> (case-insensitive, separator-aware).</summary>
    internal static bool IsUnder(string path, string dir)
    {
        var root = dir.TrimEnd('\\', '/');
        return path.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            && (path.Length == root.Length || path[root.Length] is '\\' or '/');
    }

    private const int ChunkSize = 64 * 1024;

    private static readonly byte[] AssistantMarker = "\"type\":\"assistant\""u8.ToArray();
    private static readonly byte[] VersionMarker = "\"version\":\""u8.ToArray();

    /// <summary>Scans every transcript written since <paramref name="since"/> whose size or time changed.</summary>
    public ScanResult ScanAll(DateTime since)
    {
        if (!Directory.Exists(projectsDir))
        {
            return ScanResult.Empty;
        }

        var known = offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var path in Directory.EnumerateFiles(projectsDir, "*.jsonl", SearchOption.AllDirectories))
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

            if (info.LastWriteTimeUtc < since)
            {
                continue;
            }

            if (known.TryGetValue(path, out var stored) && stored.LastWriteUtc == info.LastWriteTimeUtc && stored.Offset == info.Length)
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

        var stored = offsets.Get(path);
        var start = stored?.Offset ?? 0;
        if (start > info.Length)
        {
            // Rotated or rewritten: start over. Dedup keys keep the totals right.
            start = 0;
        }

        var entries = new List<UsageEntry>();
        var errors = new List<TranscriptError>();
        int invalid = 0, malformed = 0, lines = 0, assistant = 0;
        string? version = null;
        long consumed;
        var fallbackSession = Path.GetFileNameWithoutExtension(path);

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, ChunkSize);
            stream.Seek(start, SeekOrigin.Begin);
            consumed = ReadLines(stream, line =>
            {
                lines++;
                var kind = TranscriptUsageParser.TryParse(line, fallbackSession, out var entry);
                var error = ErrorClassifier.FromTranscriptLine(line, fallbackSession, TimeZoneInfo.Local);
                if (error is not null)
                {
                    errors.Add(error);
                }

                if (line.IndexOf(AssistantMarker) >= 0 && error is null)
                {
                    assistant++;
                    if (kind is TranscriptLineKind.NoUsage or TranscriptLineKind.MalformedUsage)
                    {
                        malformed++;
                    }
                }

                if (VersionOf(line) is { } v)
                {
                    version = v;
                }

                switch (kind)
                {
                    case TranscriptLineKind.Usage:
                        entries.Add(entry!);
                        break;
                    case TranscriptLineKind.Invalid:
                        invalid++;
                        break;
                    default:
                        break;
                }
            });
        }
        catch (IOException)
        {
            return ScanResult.Empty;
        }
        catch (UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var table = pricing();
        var priced = entries.Select(e => e with { Agent = agent, CostUsd = table.Cost(e), ProjectRoot = roots?.Resolve(e.ProjectRoot) ?? e.ProjectRoot }).ToList();
        var written = usage.Upsert(priced);

        // Only fully read lines advance the offset; the stored write time is the one observed before reading,
        // so a write that races this pass is picked up by the next one.
        offsets.Set(path, new TranscriptOffset(start + consumed, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, invalid, malformed)
        {
            Lines = lines,
            AssistantLines = assistant,
            Errors = errors,
            ClaudeVersion = version,
        };
    }

    /// <summary>The top-level <c>"version":"…"</c> value, read without a second JSON parse.</summary>
    internal static string? VersionOf(ReadOnlySpan<byte> line)
    {
        var i = line.IndexOf(VersionMarker);
        if (i < 0)
        {
            return null;
        }

        var rest = line[(i + VersionMarker.Length)..];
        var end = rest.IndexOf((byte)'"');
        return end is > 0 and < 40 ? System.Text.Encoding.UTF8.GetString(rest[..end]) : null;
    }

    /// <summary>Calls <paramref name="onLine"/> for each newline-terminated line; returns the bytes consumed.</summary>
    internal static long ReadLines(Stream stream, Action<ReadOnlySpan<byte>> onLine)
    {
        var buffer = new byte[ChunkSize];
        var pending = new MemoryStream();
        long consumed = 0;
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
        {
            var span = buffer.AsSpan(0, read);
            int newline;
            while ((newline = span.IndexOf((byte)'\n')) >= 0)
            {
                var piece = span[..newline];
                if (pending.Length > 0)
                {
                    pending.Write(piece);
                    onLine(pending.GetBuffer().AsSpan(0, (int)pending.Length));
                    consumed += pending.Length + 1;
                    pending.SetLength(0);
                }
                else
                {
                    onLine(piece);
                    consumed += piece.Length + 1;
                }

                span = span[(newline + 1)..];
            }

            pending.Write(span);
        }

        // Trailing bytes without '\n' may be a line still being written: leave them for the next pass.
        return consumed;
    }
}
