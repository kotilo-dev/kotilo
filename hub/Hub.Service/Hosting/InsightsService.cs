using System.Collections.Concurrent;
using Hub.Core.Hooks;
using Hub.Core.Insights;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Faz 6 data (spec §18): git status per project, customer labels, wait / cost reports and the daily summary.
/// Git checks run on one background worker: 2 s after a <c>Stop</c> / <c>PostToolUse</c> in a project, every 60 s for
/// projects with live sessions, and on request (Projects page) for the rest.
/// </summary>
public sealed class InsightsService : IAsyncDisposable
{
    public static readonly TimeSpan GitDebounce = TimeSpan.FromSeconds(2);
    public static readonly TimeSpan GitActiveInterval = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan SnapshotRetention = TimeSpan.FromDays(90);

    private readonly SessionRepository _sessions;
    private readonly UsageRepository _usage;
    private readonly GitRunner _git = new();
    private readonly GitStatusRepository _gitRepo;
    private readonly ConcurrentDictionary<string, DateTimeOffset> _gitDue = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, GitStatus> _gitStatus = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _wake = new(0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Func<IReadOnlyList<SessionInfo>> _live;
    private Task? _worker;

    public InsightsService(Database db, SessionRepository sessions, UsageRepository usage, Func<IReadOnlyList<SessionInfo>> live)
    {
        _sessions = sessions;
        _usage = usage;
        _live = live;
        _gitRepo = new GitStatusRepository(db);
        Customers = new CustomerRepository(db);
        TodoSnapshots = new TodoSnapshotRepository(db);
        Summaries = new DailySummaryRepository(db);
    }

    /// <summary>Raised on the worker thread when a project's git status changed.</summary>
    public event Action<string, GitStatus>? GitChanged;

    public event Action? CustomersChanged;

    public CustomerRepository Customers { get; }

    public TodoSnapshotRepository TodoSnapshots { get; }

    public DailySummaryRepository Summaries { get; }

    public bool GitAvailable => _git.IsAvailable;

    /// <summary>Settings switch (spec §18.8): when off, no git process is started.</summary>
    public bool GitEnabled { get; set; } = true;

    public GitRunner Git => _git;

    public IReadOnlyDictionary<string, GitStatus> GitStatuses => _gitStatus;

    /// <summary>Called after the database migration: loads the last known git states, then starts the worker.</summary>
    public void Start()
    {
        foreach (var (root, status) in _gitRepo.LoadAll())
        {
            _gitStatus[root] = status;
        }

        // Same retention as usage entries; each item keeps its latest row so its current state stays known.
        try
        {
            var pruned = TodoSnapshots.Prune(DateTimeOffset.UtcNow - SnapshotRetention);
            Log.Information("Todo snapshot retention removed {Rows} rows", pruned);
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            Log.Warning(ex, "Todo snapshot retention failed");
        }

        _worker = Task.Run(WorkAsync);
    }

    /// <summary>Hook events that may have changed the working tree schedule a check of that project.</summary>
    public void OnHook(HookEvent e)
    {
        if (e.Kind is HookEventKind.Stop or HookEventKind.Done or HookEventKind.PostToolUse && !string.IsNullOrEmpty(e.Cwd))
        {
            RequestGitCheck(e.Cwd, GitDebounce);
        }
    }

    public void RequestGitCheck(string root, TimeSpan delay)
    {
        _gitDue[root] = DateTimeOffset.UtcNow + delay;
        _wake.Release();
    }

    /// <summary>Checks every given project soon (Projects page opened).</summary>
    public void RequestGitChecks(IEnumerable<string> roots)
    {
        foreach (var root in roots)
        {
            _gitDue.TryAdd(root, DateTimeOffset.UtcNow);
        }

        _wake.Release();
    }

    /// <summary>Fresh status for the "completed" toast line (spec §18.3); null when git is off or unavailable.</summary>
    public async Task<GitStatus?> CheckGitNowAsync(string root)
    {
        if (!GitEnabled || !_git.IsAvailable)
        {
            return null;
        }

        var status = await _git.StatusAsync(root, DateTimeOffset.UtcNow);
        if (status is not null)
        {
            Store(root, status);
        }

        return status ?? _gitStatus.GetValueOrDefault(root);
    }

    // ---- Customers (spec §18.2) ----

    public Customer AddCustomer(string name, string color)
    {
        var c = Customers.Add(name, color);
        CustomersChanged?.Invoke();
        return c;
    }

    public void UpdateCustomer(Customer customer)
    {
        Customers.Update(customer);
        CustomersChanged?.Invoke();
    }

    public void DeleteCustomer(long id)
    {
        Customers.Delete(id);
        CustomersChanged?.Invoke();
    }

    public void AssignCustomer(string root, long? customerId)
    {
        Customers.Assign(root, customerId, DateTimeOffset.UtcNow);
        CustomersChanged?.Invoke();
    }

    /// <summary>Project root → customer, archived customers included (their history still belongs to them).</summary>
    public IReadOnlyDictionary<string, Customer> CustomerOfProject()
    {
        var byId = Customers.LoadAll().ToDictionary(c => c.Id);
        return Customers.Assignments()
            .Where(a => byId.ContainsKey(a.Value))
            .ToDictionary(a => a.Key, a => byId[a.Value], StringComparer.OrdinalIgnoreCase);
    }

    // ---- Reports ----

    /// <summary>Wait spans touching [from, to) (spec §18.1).</summary>
    public IReadOnlyList<WaitSpan> WaitSpans(DateTimeOffset from, DateTimeOffset to, DateTimeOffset now)
    {
        var transitions = _sessions.TransitionsAround(from, to);
        var roots = _sessions.ProjectRoots(transitions.Select(t => t.SessionId).Distinct(StringComparer.Ordinal).ToList());
        return WaitMetricsCalculator.Spans(
            transitions.Select(t => new StateTransition(t.SessionId, t.To, t.At, t.Detail)),
            id => roots.GetValueOrDefault(id, ""),
            now < to ? now : to);
    }

    public IReadOnlyDictionary<string, (TimeSpan Active, int Sessions)> Activity(DateTimeOffset from, DateTimeOffset to, DateTimeOffset now)
    {
        var transitions = _sessions.TransitionsAround(from, to);
        var roots = _sessions.ProjectRoots(transitions.Select(t => t.SessionId).Distinct(StringComparer.Ordinal).ToList());
        return ActivityCalculator.ByProject(
            transitions.Select(t => new StateTransition(t.SessionId, t.To, t.At, t.Detail)),
            id => roots.GetValueOrDefault(id, ""),
            from, to, now < to ? now : to);
    }

    public CostReport CostReport(DateOnly month, CostGrouping grouping, Func<string, bool> isBuddy, Func<string, string> projectName, TimeZoneInfo zone)
    {
        var from = WaitMetricsCalculator.StartOfDay(new DateOnly(month.Year, month.Month, 1), zone);
        var builder = new CostReportBuilder(CustomerOfProject(), isBuddy, projectName);
        return builder.Build(_usage.Load(from), month, grouping, zone);
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        if (_worker is not null)
        {
            await Task.WhenAny(_worker, Task.Delay(TimeSpan.FromSeconds(2)));
        }

        _stop.Dispose();
    }

    private async Task WorkAsync()
    {
        var ct = _stop.Token;
        var lastActive = DateTimeOffset.MinValue;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await _wake.WaitAsync(TimeSpan.FromSeconds(1), ct);
                if (!GitEnabled || !_git.IsAvailable)
                {
                    _gitDue.Clear();
                    continue;
                }

                var now = DateTimeOffset.UtcNow;
                if (now - lastActive >= GitActiveInterval)
                {
                    lastActive = now;
                    foreach (var s in _live().Where(s => s.State.IsLive() && !string.IsNullOrEmpty(s.ProjectRoot)))
                    {
                        _gitDue.TryAdd(s.ProjectRoot, now);
                    }
                }

                foreach (var (root, due) in _gitDue.ToArray())
                {
                    if (due > now || !_gitDue.TryRemove(new KeyValuePair<string, DateTimeOffset>(root, due)))
                    {
                        continue;
                    }

                    if (await _git.StatusAsync(root, DateTimeOffset.UtcNow, ct) is { } status)
                    {
                        Store(root, status);
                    }
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
            Log.Error(ex, "Insights worker stopped");
        }
    }

    private void Store(string root, GitStatus status)
    {
        var previous = _gitStatus.GetValueOrDefault(root);
        _gitStatus[root] = status;
        try
        {
            _gitRepo.Save(root, status);
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            Log.Warning(ex, "Could not store git status for {Root}", root);
        }

        if (previous is null || previous with { CheckedAt = status.CheckedAt } != status)
        {
            GitChanged?.Invoke(root, status);
        }
    }
}
