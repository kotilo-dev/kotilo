using System.Collections.Concurrent;
using Hub.Core.Projects;
using Hub.Core.Sessions;
using Hub.Infrastructure;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Project discovery and todo progress (spec §8). One background worker serializes all scans: rediscovery every 60 s,
/// per-project rescans 500 ms after a watcher event, and Claude task list reads for active sessions (spec §8.3).
/// Todo text is never logged; item states (with their text) go to <c>todo_snapshots</c> only when they change, for the
/// daily summary's "completed today" list (spec §18.7).
/// </summary>
public sealed class ProjectService : IAsyncDisposable
{
    public static readonly TimeSpan ActivityWindow = TimeSpan.FromDays(60);
    private static readonly TimeSpan SweepInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(500);
    private static readonly string TempDir = Path.GetFullPath(Path.GetTempPath());

    private readonly ProjectRepository _repository;
    private readonly TodoSnapshotRepository _snapshots;
    private readonly Dictionary<(string Root, string File), DateTimeOffset> _snapshotted = [];
    private readonly ProjectRootResolver _roots;
    private readonly ClaudeTaskReader _tasks;
    private readonly Func<IReadOnlyList<SessionInfo>> _sessions;
    private readonly TodoCompletionDetector _completions = new();
    private readonly ConcurrentDictionary<string, byte> _dirtyProjects = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, byte> _dirtySessions = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FileSystemWatcher> _todoWatchers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FileSystemWatcher> _taskWatchers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, TaskListProgress?> _lastTasks = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _wake = new(0);
    private readonly CancellationTokenSource _stop = new();
    private volatile GlobPattern _glob;
    private volatile bool _rediscover = true;
    private Dictionary<string, ProjectProgress> _projects = new(StringComparer.OrdinalIgnoreCase);
    private Task? _worker;

    public ProjectService(AppPaths paths, Database db, ProjectRootResolver roots, string? tasksGlob, Func<IReadOnlyList<SessionInfo>> sessions)
    {
        _repository = new ProjectRepository(db);
        _snapshots = new TodoSnapshotRepository(db);
        _roots = roots;
        _tasks = new ClaudeTaskReader(paths.ClaudeConfigDir);
        _sessions = sessions;
        _glob = GlobPattern.Parse(tasksGlob);
    }

    /// <summary>Raised on the worker thread with every known project, hidden ones included.</summary>
    public event Action<IReadOnlyList<ProjectProgress>>? ProjectsChanged;

    public event Action<TodoCompletion>? TodoCompleted;

    /// <summary>A session's Claude Code task counts changed (null: no list or unknown format).</summary>
    public event Action<string, TaskListProgress?>? SessionTasksChanged;

    public IReadOnlyList<ProjectProgress> Current { get; private set; } = [];

    public GlobPattern Glob => _glob;

    /// <summary>Roots never discovered automatically (Bip's buddy folder, spec §17.2).</summary>
    public Func<string, bool> IsExcludedRoot { get; set; } = static _ => false;

    public void Start() => _worker = Task.Run(WorkAsync);

    public void SetGlob(string? pattern)
    {
        var glob = GlobPattern.Parse(pattern);
        if (glob.Pattern == _glob.Pattern)
        {
            return;
        }

        _glob = glob;
        RequestRediscovery();
    }

    /// <summary>Adds a folder by hand (spec §8.1); it is normalized to its git root like discovered ones.</summary>
    public string AddFolder(string path)
    {
        var root = _roots.Resolve(path) ?? path;
        _repository.AddManual(root, DateTimeOffset.UtcNow);
        RequestRediscovery();
        return root;
    }

    public void SetHidden(string root, bool hidden)
    {
        _repository.SetHidden(root, hidden, DateTimeOffset.UtcNow);
        RequestRediscovery();
    }

    public void SetAlias(string root, string? alias)
    {
        _repository.SetAlias(root, alias, DateTimeOffset.UtcNow);
        RequestRediscovery();
    }

    public void RequestRediscovery()
    {
        _rediscover = true;
        _wake.Release();
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        if (_worker is not null)
        {
            await Task.WhenAny(_worker, Task.Delay(TimeSpan.FromSeconds(2)));
        }

        foreach (var w in _todoWatchers.Values.Concat(_taskWatchers.Values))
        {
            w.Dispose();
        }

        _stop.Dispose();
    }

    private async Task WorkAsync()
    {
        var ct = _stop.Token;
        var lastSweep = DateTimeOffset.MinValue;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var now = DateTimeOffset.UtcNow;
                if (_rediscover || now - lastSweep >= SweepInterval)
                {
                    _rediscover = false;
                    lastSweep = now;
                    Rediscover(now);
                    RefreshTasks(_sessions().Select(s => s.SessionId));
                    AttachTaskWatchers();
                }
                else
                {
                    var changed = false;
                    foreach (var root in _dirtyProjects.Keys.ToList())
                    {
                        _dirtyProjects.TryRemove(root, out _);
                        changed |= Rescan(root);
                    }

                    if (changed)
                    {
                        Publish();
                    }

                    var sessions = _dirtySessions.Keys.ToList();
                    foreach (var id in sessions)
                    {
                        _dirtySessions.TryRemove(id, out _);
                    }

                    RefreshTasks(sessions);
                }

                await _wake.WaitAsync(TimeSpan.FromSeconds(5), ct);
                await Task.Delay(Debounce, ct);

                // One pass handles every event of a burst (the dirty sets hold them all).
                while (_wake.CurrentCount > 0)
                {
                    await _wake.WaitAsync(ct);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
#pragma warning disable CA1031 // Background failures are logged, never fatal (spec §14).
        catch (Exception ex)
#pragma warning restore CA1031
        {
            Log.Error(ex, "Project worker stopped");
        }
    }

    /// <summary>Rebuilds the project list from activity and the <c>projects</c> table, then rescans every project.</summary>
    private void Rediscover(DateTimeOffset now)
    {
        var started = DateTimeOffset.UtcNow;
        var activity = new Dictionary<string, DateTimeOffset>(StringComparer.OrdinalIgnoreCase);
        foreach (var (raw, at) in _repository.Activity(now - ActivityWindow))
        {
            // Throwaway folders under %TEMP% (scripted `claude -p` runs) are not projects; adding one by hand still works.
            if (_roots.Resolve(raw) is not { Length: > 0 } root || !Directory.Exists(root)
                || root.StartsWith(TempDir, StringComparison.OrdinalIgnoreCase) || IsExcludedRoot(root))
            {
                continue;
            }

            if (!activity.TryGetValue(root, out var known) || at > known)
            {
                activity[root] = at;
            }
        }

        _repository.EnsureDiscovered(activity.Keys, now);

        var glob = _glob;
        var next = new Dictionary<string, ProjectProgress>(StringComparer.OrdinalIgnoreCase);
        foreach (var record in _repository.LoadAll())
        {
            var last = activity.TryGetValue(record.Root, out var a) ? a : (DateTimeOffset?)null;
            if (last is null && !record.Manual)
            {
                continue;
            }

            var files = record.Hidden ? [] : TodoScanner.Scan(record.Root, glob);
            var project = new ProjectProgress(
                record.Root,
                string.IsNullOrWhiteSpace(record.Alias) ? SessionInfo.ProjectNameFrom(record.Root) : record.Alias,
                record.Manual,
                record.Hidden,
                last,
                files)
            {
                Alias = string.IsNullOrWhiteSpace(record.Alias) ? null : record.Alias,
            };
            next[record.Root] = project;
            Notify(project);
        }

        _projects = next;
        AttachTodoWatchers(glob);
        Publish();
        Log.Information(
            "Projects: {Count} known, {WithTodos} with todo files ({Ms} ms)",
            next.Count, next.Values.Count(p => p.HasTodos), (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds);
    }

    private bool Rescan(string root)
    {
        if (!_projects.TryGetValue(root, out var project) || project.Hidden)
        {
            return false;
        }

        var updated = project with { Files = TodoScanner.Scan(root, _glob) };
        _projects[root] = updated;
        Notify(updated);
        return true;
    }

    private void Notify(ProjectProgress project)
    {
        if (project.Hidden)
        {
            return;
        }

        RecordSnapshots(project);
        foreach (var done in _completions.Observe(project))
        {
            Log.Information("Todo file completed: {Project}/{File} ({Total} items)", done.ProjectName, done.RelativePath, done.Total);
            TodoCompleted?.Invoke(done);
        }
    }

    private void RecordSnapshots(ProjectProgress project)
    {
        foreach (var file in project.Files)
        {
            var key = (project.Root, file.RelativePath);
            if (_snapshotted.TryGetValue(key, out var seen) && seen == file.LastWriteUtc)
            {
                continue;
            }

            try
            {
                var items = file.Document.Groups.SelectMany(g => g.Items.Select(i => (
                    Hash: TodoSnapshotRepository.ItemHash(file.RelativePath + "\u001f" + g.Title, i.Text),
                    i.Text,
                    Done: i.State == TodoItemState.Done)));
                _snapshots.Record(project.Root, file.RelativePath, items.DistinctBy(i => i.Hash).ToList(), DateTimeOffset.UtcNow);
                _snapshotted[key] = file.LastWriteUtc;
            }
            catch (Microsoft.Data.Sqlite.SqliteException ex)
            {
                Log.Warning(ex, "Could not record todo snapshots for {Project}", project.Name);
            }
        }
    }

    private void Publish()
    {
        Current = _projects.Values.OrderByDescending(p => p.LastActivity ?? DateTimeOffset.MinValue).ToList();
        ProjectsChanged?.Invoke(Current);
    }

    private void RefreshTasks(IEnumerable<string> sessionIds)
    {
        foreach (var id in sessionIds.Distinct(StringComparer.Ordinal))
        {
            var progress = _tasks.Read(id);
            if (_lastTasks.TryGetValue(id, out var last) && last == progress)
            {
                continue;
            }

            _lastTasks[id] = progress;
            SessionTasksChanged?.Invoke(id, progress);
        }
    }

    /// <summary>One watcher per project on the glob's base folder (<c>tasks/</c>); folders created later are picked up by the sweep.</summary>
    private void AttachTodoWatchers(GlobPattern glob)
    {
        var wanted = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in _projects.Values.Where(p => !p.Hidden))
        {
            if (TodoScanner.WatchDirectory(p.Root, glob) is { } dir)
            {
                wanted[p.Root] = dir;
            }
        }

        foreach (var (root, watcher) in _todoWatchers.ToList())
        {
            if (!wanted.TryGetValue(root, out var dir) || !string.Equals(watcher.Path, dir, StringComparison.OrdinalIgnoreCase))
            {
                watcher.Dispose();
                _todoWatchers.Remove(root);
            }
        }

        foreach (var (root, dir) in wanted.Where(w => !_todoWatchers.ContainsKey(w.Key)))
        {
            _todoWatchers[root] = Watch(dir, _ => MarkProject(root));
        }
    }

    private void AttachTaskWatchers()
    {
        foreach (var dir in new[] { _tasks.TasksDir, _tasks.TodosDir })
        {
            if (!_taskWatchers.ContainsKey(dir) && Directory.Exists(dir))
            {
                _taskWatchers[dir] = Watch(dir, path =>
                {
                    if (_tasks.SessionIdFor(path) is { } id)
                    {
                        _dirtySessions[id] = 0;
                        _wake.Release();
                    }
                });
            }
        }
    }

    private void MarkProject(string root)
    {
        _dirtyProjects[root] = 0;
        _wake.Release();
    }

    private FileSystemWatcher Watch(string dir, Action<string> onChange)
    {
        var watcher = new FileSystemWatcher(dir)
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.DirectoryName,
        };
        watcher.Changed += (_, e) => onChange(e.FullPath);
        watcher.Created += (_, e) => onChange(e.FullPath);
        watcher.Deleted += (_, e) => onChange(e.FullPath);
        watcher.Renamed += (_, e) => onChange(e.FullPath);

        // Overflow or a deleted folder: the next sweep rebuilds everything.
        watcher.Error += (_, e) =>
        {
            Log.Warning(e.GetException(), "Watcher error on {Dir}", dir);
            RequestRediscovery();
        };
        try
        {
            watcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            Log.Warning(ex, "Cannot watch {Dir}; relying on periodic sweeps", dir);
        }

        return watcher;
    }
}
