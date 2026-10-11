using Hub.Core.Hooks;

namespace Hub.Core.Sessions;

/// <summary>
/// In-memory set of known sessions, keyed by agent + session id. Not thread-safe by design: the host feeds hook events and timer
/// ticks through a single sequential consumer (spec §10). <see cref="Snapshot"/> is safe to read from any thread.
/// </summary>
public sealed class SessionTracker(ISessionEnvironment environment, SessionOptions options)
{
    /// <summary>How long an Ended session stays in the active list (spec §6.3).</summary>
    public static readonly TimeSpan EndedVisibleFor = TimeSpan.FromMinutes(30);

    private readonly Dictionary<SessionKey, SessionInfo> _sessions = [];
    private volatile IReadOnlyList<SessionInfo> _snapshot = [];

    public IReadOnlyList<SessionInfo> Snapshot => _snapshot;

    public SessionInfo? Get(string agent, string sessionId) => _sessions.GetValueOrDefault(new SessionKey(agent, sessionId));

    /// <summary>Any agent's session with this id (ids are UUIDs, so in practice at most one).</summary>
    public SessionInfo? Get(string sessionId) => _sessions.Values.FirstOrDefault(s => s.SessionId == sessionId);

    /// <summary>Loads sessions persisted by a previous run.</summary>
    public void Restore(IEnumerable<SessionInfo> sessions)
    {
        foreach (var s in sessions)
        {
            _sessions[SessionKey.Of(s)] = s;
        }

        Publish();
    }

    /// <returns>The updated session and its transition, if any.</returns>
    public (SessionInfo Session, SessionStateChanged? Change) Apply(HookEvent e)
    {
        var key = new SessionKey(e.Agent, e.SessionId);
        var (session, change) = SessionStateMachine.Apply(_sessions.GetValueOrDefault(key), e);
        _sessions[key] = session;
        Publish();
        return (session, change);
    }

    /// <summary>Claude Code statusline snapshot: model, context % and session cost. Unknown sessions are ignored.</summary>
    /// <returns>True when a known session changed.</returns>
    public bool ApplyStatusLine(Usage.StatusLineSnapshot snapshot)
    {
        if (!_sessions.TryGetValue(new SessionKey(Adapters.AgentIds.ClaudeCode, snapshot.SessionId), out var s))
        {
            return false;
        }

        var next = s with
        {
            Model = snapshot.ModelId ?? s.Model,
            StatusLineContext = snapshot.ContextUsedPercent is { } pct ? new ContextSample(pct, snapshot.At) : s.StatusLineContext,
            CostUsdThisSession = snapshot.SessionCostUsd ?? s.CostUsdThisSession,
        };
        next = WithContext(next);
        if (next == s)
        {
            return false;
        }

        _sessions[SessionKey.Of(s)] = next;
        Publish();
        return true;
    }

    /// <summary>Per-session token totals from transcripts; fills the model when no hook reported it.</summary>
    /// <returns>True when any known session changed.</returns>
    public bool ApplyUsage(IReadOnlyDictionary<string, SessionUsage> usage)
    {
        var changed = false;
        foreach (var (id, u) in usage)
        {
            foreach (var s in ById(id))
            {
                var next = s with
                {
                    TokensThisSession = u.Tokens,
                    CostUsdThisSession = s.CostUsdThisSession ?? u.CostUsd,
                    Model = s.Model ?? u.LastModel,
                };
                if (next != s)
                {
                    _sessions[SessionKey.Of(s)] = next;
                    changed = true;
                }
            }
        }

        if (changed)
        {
            Publish();
        }

        return changed;
    }

    /// <summary>Transcript-based context fill (spec §18.4 fallback), keyed by session id.</summary>
    /// <returns>True when any known session changed.</returns>
    public bool ApplyTranscriptContext(IReadOnlyDictionary<string, ContextSample> samples)
    {
        var changed = false;
        foreach (var (id, sample) in samples)
        {
            foreach (var s in ById(id).Where(s => s.TranscriptContext != sample))
            {
                _sessions[SessionKey.Of(s)] = WithContext(s with { TranscriptContext = sample });
                changed = true;
            }
        }

        if (changed)
        {
            Publish();
        }

        return changed;
    }

    /// <summary>
    /// API error found in a transcript (fallback when no StopFailure hook arrived, spec §18.5). Applies only when the
    /// error is newer than everything the hooks reported, so a later prompt is never overridden.
    /// </summary>
    public SessionStateChanged? ApplyTranscriptError(TranscriptError error)
    {
        if (!_sessions.TryGetValue(new SessionKey(Adapters.AgentIds.ClaudeCode, error.SessionId), out var s) || error.At < s.LastEventAt || s.State is SessionState.Ended)
        {
            return null;
        }

        if (s.State == SessionState.Error)
        {
            // Same failure already known from the hook: only fill in a reset time it lacked.
            if (s.Error is { ResetsAt: null } known && error.Error.ResetsAt is not null && known.Kind == error.Error.Kind)
            {
                _sessions[SessionKey.Of(s)] = s with { Error = known with { ResetsAt = error.Error.ResetsAt } };
                Publish();
            }

            return null;
        }

        var failed = s with { Error = error.Error, LastEventAt = error.At, CurrentTool = null, TurnStartedAt = null, PendingPermission = null };
        var next = failed with { State = SessionState.Error, StateSince = error.At };
        _sessions[SessionKey.Of(s)] = next;
        Publish();
        return new SessionStateChanged(s.SessionId, s.State, SessionState.Error, error.At, error.Error.Kind.ToString(), TransitionTrigger.Transcript, next);
    }

    /// <summary>Claude Code task list counts for one session; null clears them.</summary>
    /// <returns>True when a known session changed.</returns>
    public bool ApplyTasks(string sessionId, Projects.TaskListProgress? tasks)
    {
        if (Get(Adapters.AgentIds.ClaudeCode, sessionId) is not { } s || s.Tasks == tasks)
        {
            return false;
        }

        _sessions[SessionKey.Of(s)] = s with { Tasks = tasks };
        Publish();
        return true;
    }

    /// <summary>The user looked at one session's finished work.</summary>
    /// <returns>Known: the tracker has the session; Changed: its new value when it had unseen finished work.</returns>
    public (bool Known, SessionInfo? Changed) MarkSeen(string agent, string sessionId, DateTimeOffset at)
    {
        if (Get(agent, sessionId) is not { } s)
        {
            return (false, null);
        }

        if (SessionStateMachine.MarkSeen(s, at) is not { } next)
        {
            return (true, null);
        }

        _sessions[SessionKey.Of(s)] = next;
        Publish();
        return (true, next);
    }

    /// <summary>"Mark all as seen": every session that shows unseen finished work.</summary>
    /// <returns>The sessions that changed.</returns>
    public IReadOnlyList<SessionInfo> MarkAllSeen(DateTimeOffset at)
    {
        var changed = new List<SessionInfo>();
        foreach (var s in _sessions.Values.Where(s => s.IsUnseen).ToList())
        {
            if (SessionStateMachine.MarkSeen(s, at) is { } next)
            {
                _sessions[SessionKey.Of(s)] = next;
                changed.Add(next);
            }
        }

        if (changed.Count > 0)
        {
            Publish();
        }

        return changed;
    }

    /// <summary>Runs stale / process-exit checks and drops Ended sessions past their visibility window.</summary>
    public IReadOnlyList<SessionStateChanged> Tick(DateTimeOffset now)
    {
        var changes = new List<SessionStateChanged>();
        foreach (var s in _sessions.Values.ToList())
        {
            if (s.State == SessionState.Ended && now - (s.EndedAt ?? s.StateSince) > EndedVisibleFor)
            {
                _sessions.Remove(SessionKey.Of(s));
                continue;
            }

            var (next, change) = SessionStateMachine.Evaluate(s, now, environment, options);
            if (change is not null)
            {
                _sessions[SessionKey.Of(s)] = next;
                changes.Add(change);
            }
        }

        Publish();
        return changes;
    }

    private List<SessionInfo> ById(string sessionId) =>
        _sessions.Values.Where(s => s.SessionId == sessionId).ToList();

    private static SessionInfo WithContext(SessionInfo s) =>
        s with { ContextUsedPercent = ContextUsageResolver.Resolve(s.StatusLineContext, s.TranscriptContext, s.ContextResetAt) };

    private void Publish() =>
        _snapshot = _sessions.Values
            .OrderBy(s => SortRank(s.State))
            .ThenByDescending(s => s.LastEventAt)
            .ToArray();

    private readonly record struct SessionKey(string Agent, string SessionId)
    {
        public static SessionKey Of(SessionInfo s) => new(s.Agent, s.SessionId);
    }

    private static int SortRank(SessionState state) => state switch
    {
        SessionState.WaitingPermission => 0,
        SessionState.Error => 1,
        SessionState.WaitingInput => 2,
        SessionState.Working => 3,
        SessionState.Idle => 4,
        SessionState.Stale => 5,
        SessionState.Unknown => 6,
        _ => 7,
    };
}
