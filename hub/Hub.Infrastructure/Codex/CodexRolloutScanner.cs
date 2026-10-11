using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Codex;

/// <summary>
/// The Codex usage source: incremental reader of rollout files (<c>sessions/**/rollout-*.jsonl</c> and <c>archived_sessions</c>), sharing
/// offsets and usage storage with the Claude transcript scanner. Compressed <c>.jsonl.zst</c> files are skipped.
/// Not thread-safe; callers serialize passes.
/// </summary>
public sealed class CodexRolloutScanner(
    IReadOnlyList<string> roots, TranscriptOffsetStore offsets, UsageRepository usage, Func<PricingTable> pricing, ProjectRootResolver? projectRoots = null,
    string agent = AgentIds.Codex) : IFileUsageSource
{
    public const string FilePattern = "rollout-*.jsonl";

    public string Agent => agent;

    public IReadOnlyList<string> WatchDirs => roots;

    string IFileUsageSource.FilePattern => FilePattern;

    /// <summary>Codex activity must not count as Claude transcript activity in the hook health check.</summary>
    public bool ReportsActivity => false;

    public bool Owns(string path) => roots.Any(dir => TranscriptScanner.IsUnder(path, dir));

    /// <summary>Scans every rollout written since <paramref name="since"/> whose size or time changed.</summary>
    public ScanResult ScanAll(DateTime since)
    {
        var known = offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var root in roots.Where(Directory.Exists))
        {
            foreach (var path in Directory.EnumerateFiles(root, FilePattern, SearchOption.AllDirectories))
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

        var start = offsets.Get(path)?.Offset ?? 0;
        if (start > info.Length)
        {
            start = 0;
        }

        var state = new CodexRolloutState { SessionId = SessionIdFromFileName(path), Agent = agent };
        var entries = new List<UsageEntry>();
        PlanLimits? limits = null;
        int lines = 0;
        long consumed;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
            if (start > 0)
            {
                // Session id, cwd and model come from lines before the stored offset: replay just those.
                using var head = new BoundedStream(stream, start);
                TranscriptScanner.ReadLines(head, line =>
                {
                    if (line.IndexOf(CodexRolloutParser.MetaMarker) >= 0 || line.IndexOf(CodexRolloutParser.TurnContextMarker) >= 0)
                    {
                        CodexRolloutParser.ParseLine(line, state);
                    }
                });
                stream.Seek(start, SeekOrigin.Begin);
            }

            consumed = TranscriptScanner.ReadLines(stream, line =>
            {
                lines++;
                var (entry, l) = CodexRolloutParser.ParseLine(line, state);
                if (entry is not null)
                {
                    entries.Add(entry);
                }

                if (l is not null)
                {
                    limits = l;
                }
            });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }

        var table = pricing();
        var priced = entries.Select(e => e with { CostUsd = table.Cost(e), ProjectRoot = projectRoots?.Resolve(e.ProjectRoot) ?? e.ProjectRoot }).ToList();
        var written = usage.Upsert(priced);
        offsets.Set(path, new TranscriptOffset(start + consumed, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, 0, 0) { Lines = lines, Limits = limits };
    }

    /// <summary><c>rollout-2026-10-04T09-12-03-&lt;uuid&gt;.jsonl</c> → the uuid (a reverted thread adds <c>_&lt;rolloutId&gt;</c>).</summary>
    internal static string? SessionIdFromFileName(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path);
        var underscore = name.IndexOf('_', StringComparison.Ordinal);
        if (underscore > 0)
        {
            name = name[..underscore];
        }

        return name.Length >= 36 && Guid.TryParse(name[^36..], out _) ? name[^36..] : null;
    }

    /// <summary>Read-only view of the first <c>length</c> bytes of a stream; disposing it leaves the underlying stream open.</summary>
    private sealed class BoundedStream(Stream inner, long length) : Stream
    {
        private readonly long _length = length;
        private long _remaining = length;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => _length;

        public override long Position
        {
            get => _length - _remaining;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_remaining <= 0)
            {
                return 0;
            }

            var read = inner.Read(buffer, offset, (int)Math.Min(count, _remaining));
            _remaining -= read;
            return read;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
