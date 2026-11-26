using Hub.Core.Hooks;
using Hub.Core.Watch;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Watch rules at runtime: the <see cref="WatchEngine"/> plus the IO around it, which is the <c>.kotilo/watch.json</c> files
/// of known projects. The files are re-checked on the service's own timer (never per event, never on the event pipeline) and cached by modified
/// time and size. Nothing a rule looks at is logged; only rule ids are.
/// </summary>
public sealed class WatchService : IDisposable
{
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(5);

    private Timer? _timer;
    private int _refreshing;

    public const string ProjectFileName = "watch.json";
    public const string ProjectFolder = ".kotilo";

    private readonly Lock _gate = new();
    private readonly Dictionary<string, CachedFile> _cache = new(StringComparer.Ordinal);
    private string _signature = string.Empty;

    public WatchService(WatchEngine? engine = null)
    {
        Engine = engine ?? new WatchEngine();
        Engine.RuleTimedOut += id => Log.Warning("Watch rule {RuleId} timed out and is switched off for the session", id);
    }

    public WatchEngine Engine { get; }

    /// <summary>Starts the background refresh of the project files. <paramref name="knownRoots"/> lists the roots of the known sessions.</summary>
    public void Start(Func<IEnumerable<string>> knownRoots)
    {
        _timer ??= new Timer(_ => RefreshSafely(knownRoots), null, TimeSpan.Zero, RefreshInterval);
    }

    public void Dispose() => _timer?.Dispose();

    private void RefreshSafely(Func<IEnumerable<string>> knownRoots)
    {
        if (Interlocked.Exchange(ref _refreshing, 1) == 1)
        {
            return;
        }

        try
        {
            Refresh(knownRoots());
        }
#pragma warning disable CA1031 // A failed refresh keeps the previous rules; only the exception type is logged.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            Log.Warning("Watch project refresh failed ({Type})", ex.GetType().Name);
        }
        finally
        {
            Volatile.Write(ref _refreshing, 0);
        }
    }

    /// <summary>Applies new settings. Project files are re-read on the next <see cref="Refresh"/>.</summary>
    public void Configure(WatchSettings settings) => Engine.Configure(settings);

    /// <summary>Rules that match this tool call, or none. Never throws.</summary>
    public IReadOnlyList<WatchHit> Evaluate(HookEvent e, string? projectRoot)
    {
        if (e.ToolName is null && e.ToolCommand is null && e.ToolPath is null && e.ToolPaths is null)
        {
            return [];
        }

        try
        {
            return Engine.Evaluate(new WatchInput(e.ToolName, e.ToolCommand, e.ToolPath, e.ToolPaths, projectRoot), $"{e.Agent}/{e.SessionId}");
        }
#pragma warning disable CA1031 // A broken rule must not stop events; only the exception type is logged (its message may carry the command).
        catch (Exception ex)
#pragma warning restore CA1031
        {
            Log.Warning("Watch evaluation failed ({Type})", ex.GetType().Name);
            return [];
        }
    }

    /// <summary>
    /// Re-checks <c>.kotilo/watch.json</c> under <paramref name="knownRoots"/> and the trusted projects. Reads a file only
    /// when its size or time changed; the engine is updated only when something did.
    /// </summary>
    public void Refresh(IEnumerable<string> knownRoots)
    {
        lock (_gate)
        {
            var roots = knownRoots.Concat(Engine.Settings.TrustedProjects)
                .Where(r => !string.IsNullOrWhiteSpace(r))
                .GroupBy(WatchEngine.RootKey, StringComparer.Ordinal)
                .Select(g => g.First())
                .ToList();

            var files = new List<ProjectWatchFile>();
            var signature = new System.Text.StringBuilder();
            foreach (var root in roots)
            {
                var key = WatchEngine.RootKey(root);
                var result = Read(root, key);
                if (result is null)
                {
                    _cache.Remove(key);
                    continue;
                }

                files.Add(result.File);
                signature.Append(key).Append('|').Append(result.Stamp).Append(';');
            }

            foreach (var stale in _cache.Keys.Where(k => !roots.Any(r => WatchEngine.RootKey(r) == k)).ToList())
            {
                _cache.Remove(stale);
            }

            var text = signature.ToString();
            if (text != _signature)
            {
                _signature = text;
                Engine.SetProjectFiles(files);
            }
        }
    }

    private CachedFile? Read(string root, string key)
    {
        try
        {
            var folder = Path.Combine(root, ProjectFolder);
            var path = Path.Combine(folder, ProjectFileName);
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                return null;
            }

            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint) || new DirectoryInfo(folder).Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                return Problem(root, key, "reparse", "The file is a link and is not read.");
            }

            var stamp = $"{info.Length}:{info.LastWriteTimeUtc.Ticks}";
            if (_cache.TryGetValue(key, out var cached) && cached.Stamp == stamp)
            {
                return cached;
            }

            if (info.Length > WatchLimits.MaxFileBytes)
            {
                return Problem(root, key, stamp, $"The file is larger than {WatchLimits.MaxFileBytes / 1024} KB and is not read.");
            }

            string text;
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buffer = new byte[WatchLimits.MaxFileBytes + 1];
                var read = 0;
                int n;
                while (read < buffer.Length && (n = stream.Read(buffer, read, buffer.Length - read)) > 0)
                {
                    read += n;
                }

                if (read > WatchLimits.MaxFileBytes)
                {
                    return Problem(root, key, stamp, $"The file is larger than {WatchLimits.MaxFileBytes / 1024} KB and is not read.");
                }

                text = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
            }

            var file = WatchProjectFileParser.Parse(root, text, WatchLimits.RegexTimeout);
            return _cache[key] = new CachedFile(stamp, file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return Problem(root, key, "error", "The file could not be read.");
        }
    }

    private CachedFile Problem(string root, string key, string stamp, string message) =>
        _cache[key] = new CachedFile(stamp, new ProjectWatchFile(root, [], [new WatchProblem(null, message)]));

    private sealed record CachedFile(string Stamp, ProjectWatchFile File);
}
