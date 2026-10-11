using System.Threading.Channels;
using Hub.Core.Activity;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Single sequential consumer for hook events, timer ticks and commands (spec §10). All mutation of
/// <see cref="SessionTracker"/> and <see cref="RuleEngine"/> happens on this consumer.
/// </summary>
public sealed class EventPipeline : IAsyncDisposable
{
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan SessionCheckInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan TransitionRetention = TimeSpan.FromDays(30);

    private readonly Channel<Item> _channel = Channel.CreateBounded<Item>(
        new BoundedChannelOptions(10_000) { SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest });

    private readonly SessionTracker _tracker;
    private readonly RuleEngine _rules;
    private readonly ISessionRepository _repository;
    private readonly TimeProvider _time;
    private readonly CancellationTokenSource _stop = new();
    private Task? _consumer;
    private ITimer? _timer;
    private DateTimeOffset _lastSessionCheck;
    private DateTimeOffset _lastPrune;

    private readonly ProjectRootResolver _roots;
    private readonly Func<AdapterRegistry> _adapters;

    /// <param name="adapters">The live adapter registry (it changes when adapter definitions are reloaded).</param>
    public EventPipeline(
        SessionTracker tracker, RuleEngine rules, ISessionRepository repository, TimeProvider time, ProjectRootResolver roots, Func<AdapterRegistry> adapters)
    {
        _roots = roots;
        _adapters = adapters;
        _tracker = tracker;
        _rules = rules;
        _repository = repository;
        _time = time;
    }

    /// <summary>Raised on the consumer thread after any session change.</summary>
    public event Action<IReadOnlyList<SessionInfo>>? SessionsChanged;

    /// <summary>Raised on the consumer thread for each notification to show.</summary>
    public event Action<NotificationRequest>? NotificationRequested;

    /// <summary>Raised on the consumer thread when a statusLine render carries plan limits (D-074).</summary>
    public event Action<PlanLimits>? PlanLimitsReported;

    public DateTimeOffset? LastHookAt { get; private set; }

    /// <summary>Raised on the consumer thread for every accepted hook event (after the root is normalized).</summary>
    public event Action<HookEvent>? HookObserved;

    /// <summary>Raised on the consumer thread for a protocol <c>usage</c> event, as a usage row to store.</summary>
    public event Action<UsageEntry>? UsageReported;

    /// <summary>Per-session tool timeline (memory only); mutated on the consumer, read from any thread.</summary>
    public ActivityTracker Activity { get; } = new();

    /// <summary>Raised on the consumer thread when a session's timeline changed (drain it with <see cref="ActivityTracker.DrainChanges"/>).</summary>
    public event Action? ActivityChanged;

    /// <summary>Hook events from these working directories are dropped (Bip's own runs, spec §17.2).</summary>
    public Func<string?, bool> IsHiddenCwd { get; set; } = static _ => false;

    public void Start()
    {
        _consumer = Task.Run(ConsumeAsync);
        _timer = _time.CreateTimer(_ => _channel.Writer.TryWrite(new TickItem()), null, TickInterval, TickInterval);
    }

    /// <param name="replayed">Spooled while the hub was down: it updates sessions but raises no notifications, because its
    /// transitions are old (the next tick judges the final state).</param>
    public bool EnqueueHook(byte[] envelope, bool replayed = false) => _channel.Writer.TryWrite(new HookItem(envelope, replayed));

    /// <summary>Runs <paramref name="action"/> on the consumer, serialized with events. Return true if sessions changed.</summary>
    public void Post(Func<SessionTracker, RuleEngine, bool> action) => _channel.Writer.TryWrite(new CommandItem(action));

    public bool EnqueueStatusLine(byte[] json) => _channel.Writer.TryWrite(new StatusLineItem(json));

    /// <summary>API errors found by the transcript scanner (spec §18.5 fallback to the StopFailure hook).</summary>
    public void EnqueueTranscriptErrors(IReadOnlyList<TranscriptError> errors)
    {
        if (errors.Count > 0)
        {
            _channel.Writer.TryWrite(new TranscriptErrorsItem(errors));
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_timer is not null)
        {
            await _timer.DisposeAsync();
        }

        // Drain what is already queued (spec §14: max 2 s), then stop.
        _channel.Writer.TryComplete();
        if (_consumer is not null)
        {
            await Task.WhenAny(_consumer, Task.Delay(TimeSpan.FromSeconds(2)));
        }

        await _stop.CancelAsync();
        _stop.Dispose();
    }

    private async Task ConsumeAsync()
    {
        try
        {
            await foreach (var item in _channel.Reader.ReadAllAsync(_stop.Token))
            {
                try
                {
                    Process(item);
                }
#pragma warning disable CA1031 // One bad event must not stop the pipeline (spec §14).
                catch (Exception ex)
#pragma warning restore CA1031
                {
                    Log.Error(ex, "Pipeline item {Item} failed", item.GetType().Name);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void Process(Item item)
    {
        var now = _time.GetUtcNow();
        var changed = false;

        switch (item)
        {
            case HookItem hook:
                changed = ApplyHook(hook.Envelope, notify: !hook.Replayed);
                break;

            case TickItem:
                if (now - _lastSessionCheck >= SessionCheckInterval)
                {
                    _lastSessionCheck = now;
                    var before = _tracker.Snapshot.Count;
                    var ticked = _tracker.Tick(now);
                    foreach (var change in ticked)
                    {
                        Record(change);
                    }

                    // A process exit (→ Ended) or a stale turn keeps the count; clients still need the new state.
                    changed = ticked.Count > 0 || _tracker.Snapshot.Count != before || changed;
                    var pruned = Activity.Prune(now, (agent, id) => _tracker.Get(agent, id) is { } s ? s.EndedAt : DateTimeOffset.MinValue);
                    if (pruned > 0)
                    {
                        Log.Debug("Activity timeline: dropped {Count} sessions, {Left} left", pruned, Activity.SessionCount);
                    }
                }

                if (now - _lastPrune > TimeSpan.FromHours(6))
                {
                    _lastPrune = now;
                    var removed = _repository.PruneTransitions(now - TransitionRetention);
                    Log.Debug("Pruned {Count} old transitions", removed);
                }

                break;

            case CommandItem command:
                changed = command.Action(_tracker, _rules);
                break;

            case TranscriptErrorsItem errors:
                foreach (var error in errors.Errors.OrderBy(x => x.At))
                {
                    if (_tracker.ApplyTranscriptError(error) is { } change)
                    {
                        _repository.Upsert(change.Session);
                        Record(change);
                        changed = true;
                    }
                }

                break;

            case StatusLineItem statusLine:
                if (StatusLineSnapshot.Parse(statusLine.Json, now) is { } snapshot)
                {
                    changed = _tracker.ApplyStatusLine(snapshot);
                    if (snapshot.Limits is { } limits)
                    {
                        PlanLimitsReported?.Invoke(limits);
                    }
                }

                break;
        }

        IReadOnlyList<NotificationRequest> polled = item is HookItem { Replayed: true } ? [] : _rules.Poll(now, _tracker.Snapshot);
        foreach (var request in polled)
        {
            Log.Information("Notification {Rule} for {Session} ({Project})", request.RuleId, request.SessionId, request.ProjectName);
            NotificationRequested?.Invoke(request);
        }

        if (changed)
        {
            SessionsChanged?.Invoke(_tracker.Snapshot);
        }
    }

    private bool ApplyHook(byte[] envelope, bool notify)
    {
        var e = HookEventParser.Parse(envelope, _adapters(), out var error);
        if (e is null)
        {
            Log.Warning("Rejected hook event: {Error}", error);
            return false;
        }

        // Sessions are keyed to the project (git) root, not the folder Claude happens to be in (spec §8.1).
        e = e with { Cwd = _roots.Resolve(e.Cwd) };
        if (IsHiddenCwd(e.Cwd))
        {
            return false;
        }

        LastHookAt = e.ReceivedAt;
        if (e.Kind == HookEventKind.Usage)
        {
            return ApplyUsage(e);
        }

        var (session, change) = _tracker.Apply(e);
        _repository.Upsert(session);
        if (change is not null)
        {
            Record(change, notify);
        }

        if (Activity.Observe(e, session.ProjectRoot))
        {
            ActivityChanged?.Invoke();
        }

        HookObserved?.Invoke(e);
        return true;
    }

    /// <summary>
    /// A usage report becomes a usage row (project from the session when the event has no cwd). It updates a known session's
    /// metadata but never creates a session on its own.
    /// </summary>
    private bool ApplyUsage(HookEvent e)
    {
        var known = _tracker.Get(e.Agent, e.SessionId);
        if (ReportedUsageEntry.From(e, known?.ProjectRoot) is { } entry)
        {
            UsageReported?.Invoke(entry);
        }

        if (known is null)
        {
            return false;
        }

        var (session, _) = _tracker.Apply(e);
        _repository.Upsert(session);
        HookObserved?.Invoke(e);
        return true;
    }

    private void Record(SessionStateChanged change, bool notify = true)
    {
        Log.Information(
            "Session {Session} ({Project}) {From} -> {To} [{Trigger}]",
            change.SessionId, change.Session.ProjectName, change.From, change.To, change.Trigger);
        _repository.Upsert(change.Session);
        _repository.AddTransition(change);
        if (notify)
        {
            _rules.OnStateChanged(change);
        }
    }

    private abstract record Item;

    private sealed record HookItem(byte[] Envelope, bool Replayed) : Item;

    private sealed record TickItem : Item;

    private sealed record CommandItem(Func<SessionTracker, RuleEngine, bool> Action) : Item;

    private sealed record StatusLineItem(byte[] Json) : Item;

    private sealed record TranscriptErrorsItem(IReadOnlyList<TranscriptError> Errors) : Item;
}
