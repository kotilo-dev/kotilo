using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Gemini;

/// <summary>
/// The Gemini CLI usage source: chat recordings under <c>~/.gemini/tmp/&lt;slug&gt;/chats/</c> (<c>session-*.jsonl</c>, subagents
/// in <c>chats/&lt;parent&gt;/&lt;id&gt;.jsonl</c>; legacy <c>session-*.json</c> documents are re-read whole when they change).
/// The project is the slug folder's <c>.project_root</c> marker, else its entry in <c>~/.gemini/projects.json</c>; it is
/// never decoded from the folder name. Nothing else in <c>~/.gemini</c> is read. Not thread-safe; callers serialize passes.
/// </summary>
public sealed class GeminiChatScanner(string geminiDir, UsageSourceContext context, string? excludedRoot = null, string agent = AgentIds.Gemini) : IFileUsageSource
{
    private const string ChatsDir = "chats";

    public string Agent => agent;

    public string TmpDir => Path.Combine(geminiDir, "tmp");

    public IReadOnlyList<string> WatchDirs => [TmpDir];

    /// <summary>The watcher sees JSONL recordings; legacy <c>.json</c> files are picked up by the periodic sweep.</summary>
    public string FilePattern => "*.jsonl";

    public bool ReportsActivity => false;

    /// <summary>A <c>.jsonl</c> / <c>.json</c> file inside a <c>chats</c> folder of a project folder under <c>tmp</c>.</summary>
    public bool Owns(string path)
    {
        if (!TranscriptScanner.IsUnder(path, TmpDir) || !(IsJsonl(path) || IsLegacy(path)))
        {
            return false;
        }

        var parts = Path.GetRelativePath(TmpDir, path).Split('\\', '/');
        return parts.Length >= 3 && parts[1].Equals(ChatsDir, StringComparison.OrdinalIgnoreCase);
    }

    public ScanResult ScanAll(DateTime since)
    {
        if (!Directory.Exists(TmpDir))
        {
            return ScanResult.Empty;
        }

        var known = context.Offsets.GetAll();
        var total = ScanResult.Empty;
        foreach (var project in SafeEnumerate(() => Directory.EnumerateDirectories(TmpDir)))
        {
            var chats = Path.Combine(project, ChatsDir);
            if (!Directory.Exists(chats))
            {
                continue;
            }

            foreach (var path in SafeEnumerate(() => Directory.EnumerateFiles(chats, "*.json*", SearchOption.AllDirectories)))
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

                if (!Owns(path) || info.LastWriteTimeUtc < since
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

        var state = new GeminiChatState { Agent = agent, ProjectRoot = ProjectRootOf(path) };
        if (excludedRoot is not null && state.ProjectRoot is { } root && TranscriptScanner.IsUnder(root, excludedRoot))
        {
            // The hub's own headless AI runs (D-026) are not the user's usage.
            context.Offsets.Set(path, new TranscriptOffset(info.Length, info.LastWriteTimeUtc));
            return ScanResult.Empty;
        }

        try
        {
            return IsLegacy(path) ? ScanDocument(path, info, state) : ScanJsonl(path, info, state);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ScanResult.Empty;
        }
    }

    private ScanResult ScanJsonl(string path, FileInfo info, GeminiChatState state)
    {
        var start = context.Offsets.Get(path)?.Offset ?? 0;
        if (start > info.Length)
        {
            start = 0;
        }

        var entries = new List<UsageEntry>();
        var lines = 0;
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
        if (start > 0)
        {
            // The session id is in the header (first line), before the stored offset.
            GeminiChatParser.ParseLine(FirstLine(stream), state);
            stream.Seek(start, SeekOrigin.Begin);
        }

        var consumed = TranscriptScanner.ReadLines(stream, line =>
        {
            lines++;
            if (GeminiChatParser.ParseLine(line, state) is { } entry)
            {
                entries.Add(entry);
            }
        });

        var written = context.Store(entries, agent);
        context.Offsets.Set(path, new TranscriptOffset(start + consumed, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, 0, 0) { Lines = lines };
    }

    private ScanResult ScanDocument(string path, FileInfo info, GeminiChatState state)
    {
        var bytes = File.ReadAllBytes(path);
        var entries = GeminiChatParser.ParseDocument(bytes, state);
        var written = context.Store(entries, agent);
        context.Offsets.Set(path, new TranscriptOffset(bytes.Length, info.LastWriteTimeUtc));
        return new ScanResult(1, entries.Count, written, 0, 0);
    }

    /// <summary><c>tmp/&lt;slug&gt;/.project_root</c>, else the <c>projects.json</c> path whose slug is this folder's name.</summary>
    internal string? ProjectRootOf(string chatPath)
    {
        var parts = Path.GetRelativePath(TmpDir, chatPath).Split('\\', '/');
        if (parts.Length < 2)
        {
            return null;
        }

        var slug = parts[0];
        try
        {
            var marker = Path.Combine(TmpDir, slug, ".project_root");
            if (File.Exists(marker) && File.ReadAllText(marker).Trim() is { Length: > 0 } root)
            {
                return root;
            }

            var registry = Path.Combine(geminiDir, "projects.json");
            if (!File.Exists(registry))
            {
                return null;
            }

            using var doc = JsonDocument.Parse(File.ReadAllBytes(registry));
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("projects", out var projects) && projects.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in projects.EnumerateObject())
                {
                    if (p.Value.ValueKind == JsonValueKind.String && string.Equals(p.Value.GetString(), slug, StringComparison.OrdinalIgnoreCase))
                    {
                        return p.Name;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
        }

        return null;
    }

    private static byte[] FirstLine(Stream stream)
    {
        stream.Seek(0, SeekOrigin.Begin);
        using var line = new MemoryStream();
        int b;
        while ((b = stream.ReadByte()) >= 0 && b != '\n' && line.Length < 1024 * 1024)
        {
            line.WriteByte((byte)b);
        }

        return line.ToArray();
    }

    private static bool IsJsonl(string path) => path.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase);

    /// <summary>Pre-registry single-document recordings: <c>session-*.json</c>.</summary>
    private static bool IsLegacy(string path) =>
        path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
        && Path.GetFileName(path).StartsWith("session-", StringComparison.OrdinalIgnoreCase);

    private static List<string> SafeEnumerate(Func<IEnumerable<string>> list)
    {
        try
        {
            return list().ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }
}
