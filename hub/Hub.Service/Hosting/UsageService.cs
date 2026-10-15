using System.Collections.Concurrent;
using Hub.Core.Insights;
using Hub.Core.Notifications;
using Hub.Core.Usage;
using Hub.Infrastructure;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Usage;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>Everything the UI shows about usage, computed in one pass (spec §7.4).</summary>
public sealed record UsageSnapshot(
    DateTimeOffset At,
    ActiveBlockStatus? ActiveBlock,
    UsageTotals Today,
    UsageTotals Yesterday,
    UsageTotals Week,
    int TodaySessions,
    IReadOnlyList<DailyUsage> Daily,
    IReadOnlyList<UsageBlock> Blocks,
    IReadOnlyList<UsageEntry> Entries,
    bool BackfillDone)
{
    public static UsageSnapshot Empty { get; } = new(
        DateTimeOffset.MinValue, null, UsageTotals.Zero, UsageTotals.Zero, UsageTotals.Zero, 0, [], [], [], false);
}

/// <summary>
/// Usage ingestion and aggregation (spec §7). Each agent contributes <see cref="IUsageSource"/>s (Claude transcripts,
/// Codex rollouts, …) and protocol <c>usage</c> events arrive through <see cref="RecordReported"/>. One background worker
/// serializes all writes: 35-day backfill at start, then watcher-triggered file scans (1 s debounce), polling sources on
/// their interval and a 60 s full sweep.
/// </summary>
public sealed class UsageService : IAsyncDisposable
{
    public static readonly TimeSpan Backfill = TimeSpan.FromDays(35);
    private static readonly TimeSpan Retention = TimeSpan.FromDays(90);
    private static readonly TimeSpan FullSweepInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan OffsetPruneInterval = TimeSpan.FromHours(1);
    private static readonly TimeSpan Debounce = TimeSpan.FromSeconds(1);

    private readonly AppPaths _paths;
    private readonly UsageRepository _repository;
    private readonly NotificationLogStore _ruleState;
    private readonly PricingProvider _pricing;
    private readonly List<IUsageSource> _sources = [];
    private readonly Dictionary<IPollingUsageSource, DateTimeOffset> _lastPoll = [];
    private readonly ConcurrentQueue<UsageEntry> _reported = new();
    private readonly ConcurrentDictionary<string, byte> _dirty = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _wake = new(0);
    private readonly CancellationTokenSource _stop = new();
    private readonly List<FileSystemWatcher> _watchers = [];
    private FileSystemWatcher? _pricingWatcher;
    private volatile bool _pricingChanged;
    private Task? _worker;

    public UsageService(AppPaths paths, Database db, UsageRuleOptions ruleOptions, ProjectRootResolver roots)
    {
        _paths = paths;
        _repository = new UsageRepository(db);
        _ruleState = new NotificationLogStore(db);
        _pricing = new PricingProvider(paths.PricingPath);
        Context = new UsageSourceContext(new TranscriptOffsetStore(db), _repository, () => _pricing.Current, roots);
        Rules = new UsageRuleEngine(ruleOptions, _ruleState);
    }

    /// <summary>Shared storage for usage sources (offsets, usage table, prices, project roots).</summary>
    public UsageSourceContext Context { get; }

    public IReadOnlyList<IUsageSource> Sources => _sources;

    /// <summary>Registers agents' usage sources; call before <see cref="Start"/>.</summary>
    public void AddSources(IEnumerable<IUsageSource> sources)
    {
        if (_worker is not null)
        {
            throw new InvalidOperationException("Usage sources must be added before Start.");
        }

        _sources.AddRange(sources);
    }

    /// <summary>A protocol <c>usage</c> event (any thread): stored by the worker, priced unless the agent sent a cost.</summary>
    public void RecordReported(UsageEntry entry)
    {
        _reported.Enqueue(entry);
        _wake.Release();
    }

    /// <summary>Raised on the worker thread after each refresh.</summary>
    public event Action<UsageSnapshot>? SnapshotChanged;

    /// <summary>Raised on the worker thread for each usage notification.</summary>
    public event Action<UsageNotification>? NotificationRequested;

    public UsageSnapshot Current { get; private set; } = UsageSnapshot.Empty;

    public UsageRuleEngine Rules { get; }

    public PricingProvider Pricing => _pricing;

    public UsageRepository Repository => _repository;

    /// <summary>Parser health counters since start.</summary>
    public ScanResult Totals { get; private set; } = ScanResult.Empty;

    /// <summary>Raised on the worker thread after every scan pass (backfill included).</summary>
    public event Action<ScanResult>? Scanned;

    /// <summary>Transcripts that do not count as user activity for the hook health check (Bip's own runs).</summary>
    public Func<string, bool> IsIgnoredTranscript { get; set; } = static _ => false;

    /// <summary>Newest change to a non-ignored transcript seen by the watcher (spec §18.6 "hook'lar sessiz").</summary>
    public DateTimeOffset? LastTranscriptWriteAt { get; private set; }

    /// <summary>Claude Code version from the newest transcript line read.</summary>
    public string? ClaudeVersion { get; private set; }

    /// <summary>Line counts of incremental scans in the last hour (backfill excluded: old lines say nothing about today).</summary>
    public ParserStats RecentParserStats(DateTimeOffset now)
    {
        while (_recent.TryPeek(out var head) && head.At < now - TimeSpan.FromHours(1))
        {
            _recent.TryDequeue(out _);
        }

        var items = _recent.ToArray();
        return new ParserStats(
            items.Sum(i => i.Result.Lines),
            items.Sum(i => i.Result.InvalidLines),
            items.Sum(i => i.Result.AssistantLines),
            items.Sum(i => i.Result.MalformedUsageLines));
    }

    private readonly ConcurrentQueue<(DateTimeOffset At, ScanResult Result)> _recent = new();
    private volatile bool _backfillDone;

    public void Start()
    {
        _pricing.Load();
        if (_pricing.Error is { } error)
        {
            Log.Warning("pricing.json invalid, using defaults: {Error}", error);
        }

        _worker = Task.Run(WorkAsync);
        StartWatchers();
    }

    public void RequestRefresh() => _wake.Release();

    public async ValueTask DisposeAsync()
    {
        _watchers.ForEach(w => w.Dispose());
        _pricingWatcher?.Dispose();
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
        try
        {
            var started = DateTimeOffset.UtcNow;
            var backfill = ScanAll(DateTime.UtcNow - Backfill);
            Log.Information(
                "Usage backfill: {Files} files, {Entries} entries, {Rows} rows in {Ms} ms",
                backfill.FilesRead, backfill.Entries, backfill.RowsWritten, (int)(DateTimeOffset.UtcNow - started).TotalMilliseconds);
            _backfillDone = true;
            Refresh(backfillDone: true);
            var pruned = _repository.Prune(DateTimeOffset.UtcNow - Retention);
            _ruleState.Prune(DateTimeOffset.UtcNow - TimeSpan.FromDays(30));
            Log.Information("Usage retention removed {Rows} rows", pruned);
            PruneOffsets();

            var lastSweep = DateTimeOffset.UtcNow;
            var lastOffsetPrune = DateTimeOffset.UtcNow;
            var lastRefresh = DateTimeOffset.UtcNow;
            while (!ct.IsCancellationRequested)
            {
                await _wake.WaitAsync(TimeSpan.FromSeconds(5), ct);
                await Task.Delay(Debounce, ct);

                // One pass handles every event of a burst: without draining, each watcher event would cost a pass.
                while (_wake.CurrentCount > 0)
                {
                    await _wake.WaitAsync(ct);
                }

                var changed = false;
                if (_pricingChanged)
                {
                    _pricingChanged = false;
                    if (_pricing.Load())
                    {
                        Log.Information("pricing.json reloaded; repriced {Rows} entries", _repository.Reprice(_pricing.Current));
                        changed = true;
                    }
                    else
                    {
                        Log.Warning("pricing.json invalid, keeping previous table: {Error}", _pricing.Error);
                    }
                }

                changed |= StoreReported() > 0;

                foreach (var path in _dirty.Keys.ToList())
                {
                    _dirty.TryRemove(path, out _);
                    if (_sources.OfType<IFileUsageSource>().FirstOrDefault(s => s.Owns(path)) is { } owner)
                    {
                        changed |= Run(() => owner.ScanFile(path)).RowsWritten > 0;
                    }
                }

                var now = DateTimeOffset.UtcNow;
                if (now - lastSweep >= FullSweepInterval)
                {
                    lastSweep = now;
                    changed |= ScanAll(DateTime.UtcNow - Backfill).RowsWritten > 0;
                    if (now - lastOffsetPrune >= OffsetPruneInterval)
                    {
                        lastOffsetPrune = now;
                        PruneOffsets();
                    }
                }

                foreach (var source in _sources.OfType<IPollingUsageSource>())
                {
                    if (now - _lastPoll.GetValueOrDefault(source) >= source.PollInterval)
                    {
                        _lastPoll[source] = now;
                        changed |= Run(() => source.ScanAll(DateTime.UtcNow - Backfill)).RowsWritten > 0;
                    }
                }

                if (changed || NeedsClockRefresh(Current, now, lastRefresh, TimeZoneInfo.Local))
                {
                    lastRefresh = now;
                    Refresh(backfillDone: true);
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
            Log.Error(ex, "Usage worker stopped");
        }
    }

    /// <summary>
    /// Refresh without new data (it reloads 35 days of rows): only while a block is active, whose remaining time and burn
    /// rate move with the clock (the refresh after its end clears it), and once when the local day changes.
    /// </summary>
    internal static bool NeedsClockRefresh(UsageSnapshot current, DateTimeOffset now, DateTimeOffset lastRefresh, TimeZoneInfo zone) =>
        now - lastRefresh >= RefreshInterval
        && (current.ActiveBlock is not null || UsageAggregator.LocalDate(current.At, zone) != UsageAggregator.LocalDate(now, zone));

    /// <summary>Every source in turn; they share offsets and usage rows. Each pass is reported on its own (limits are per agent).</summary>
    private ScanResult ScanAll(DateTime since)
    {
        var total = ScanResult.Empty;
        foreach (var source in _sources)
        {
            total = total.Add(Run(() => source.ScanAll(since)));
            if (source is IPollingUsageSource polling)
            {
                _lastPoll[polling] = DateTimeOffset.UtcNow;
            }
        }

        return total;
    }

    /// <summary>Read offsets of deleted transcripts would otherwise stay forever.</summary>
    private void PruneOffsets()
    {
        if (Context.Offsets.PruneMissing() is var removed and > 0)
        {
            Log.Information("Removed {Rows} read offsets of deleted files", removed);
        }
    }

    /// <summary>Writes queued protocol usage; returns the rows written.</summary>
    private int StoreReported()
    {
        var batch = new List<UsageEntry>();
        while (_reported.TryDequeue(out var entry))
        {
            batch.Add(entry);
        }

        return batch.GroupBy(e => e.Agent, StringComparer.Ordinal).Sum(g => Context.Store(g, g.Key));
    }

    private ScanResult Run(Func<ScanResult> scan)
    {
        var result = scan();
        Totals = Totals.Add(result);
        if (result.ClaudeVersion is { } version)
        {
            ClaudeVersion = version;
        }

        if (_backfillDone && result.Lines > 0)
        {
            _recent.Enqueue((DateTimeOffset.UtcNow, result));
        }

        Scanned?.Invoke(result);
        if (result.InvalidLines + result.MalformedUsageLines > 0)
        {
            Log.Debug("Transcript scan skipped {Invalid} invalid and {Malformed} malformed lines", result.InvalidLines, result.MalformedUsageLines);
        }

        return result;
    }

    private void Refresh(bool backfillDone)
    {
        var now = DateTimeOffset.UtcNow;
        var zone = TimeZoneInfo.Local;
        var entries = _repository.Load(now - Backfill);
        var today = UsageAggregator.LocalDate(now, zone);
        var active = BlockCalculator.Active(entries, now);
        var todayTotals = UsageAggregator.Day(entries, zone, today);

        var snapshot = new UsageSnapshot(
            now,
            active,
            todayTotals,
            UsageAggregator.Day(entries, zone, today.AddDays(-1)),
            UsageAggregator.WeekToDate(entries, zone, today),
            entries.Where(e => UsageAggregator.LocalDate(e.Timestamp, zone) == today).Select(e => e.SessionId).Distinct().Count(),
            UsageAggregator.Daily(entries, zone, today.AddDays(-29), today),
            BlockCalculator.Identify(entries),
            entries,
            backfillDone);
        Current = snapshot;

        foreach (var n in Rules.Evaluate(active, todayTotals, today, now))
        {
            Log.Information("Usage notification {Rule}: {Tokens} / {Threshold}", n.RuleId, n.Tokens, n.ThresholdTokens);
            NotificationRequested?.Invoke(n);
        }

        SnapshotChanged?.Invoke(snapshot);
    }

    private void StartWatchers()
    {
        try
        {
            foreach (var source in _sources.OfType<IFileUsageSource>())
            {
                foreach (var dir in source.WatchDirs.Where(Directory.Exists))
                {
                    var watcher = new FileSystemWatcher(dir, source.FilePattern)
                    {
                        IncludeSubdirectories = true,
                        NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
                        InternalBufferSize = 64 * 1024,
                    };

                    // Only sources that report activity feed the "hooks silent" check (Claude transcripts, spec §18.6).
                    Action<string> onChange = source.ReportsActivity ? MarkDirty : Enqueue;
                    watcher.Changed += (_, e) => onChange(e.FullPath);
                    watcher.Created += (_, e) => onChange(e.FullPath);
                    if (source.ReportsActivity)
                    {
                        watcher.Renamed += (_, e) => onChange(e.FullPath);
                    }

                    // Missed events are covered by the 60 s sweep (spec §7.1).
                    var agent = source.Agent;
                    watcher.Error += (_, e) => Log.Warning(e.GetException(), "Usage watcher overflow ({Agent})", agent);
                    watcher.EnableRaisingEvents = true;
                    _watchers.Add(watcher);
                }
            }

            _pricingWatcher = new FileSystemWatcher(_paths.DataDir, Path.GetFileName(_paths.PricingPath))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size,
            };
            _pricingWatcher.Changed += (_, _) =>
            {
                _pricingChanged = true;
                _wake.Release();
            };
            _pricingWatcher.EnableRaisingEvents = true;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            Log.Warning(ex, "File watchers unavailable; relying on periodic sweeps");
        }
    }

    private void MarkDirty(string path)
    {
        if (!IsIgnoredTranscript(path))
        {
            LastTranscriptWriteAt = DateTimeOffset.UtcNow;
        }

        Enqueue(path);
    }

    private void Enqueue(string path)
    {
        _dirty[path] = 0;
        _wake.Release();
    }
}
