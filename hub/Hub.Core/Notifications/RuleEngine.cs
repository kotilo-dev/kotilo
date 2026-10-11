using Hub.Core.Sessions;

namespace Hub.Core.Notifications;

/// <summary>
/// Session notification rules (spec §11.1, Faz 1 subset). Fed with transitions, polled with the clock.
/// Like <see cref="SessionTracker"/>, it is driven from the single sequential consumer.
/// </summary>
public sealed class RuleEngine(RuleOptions options, IRuleStateStore? state = null)
{
    private readonly List<Candidate> _pending = [];
    private readonly Dictionary<(string SessionId, string RuleKey), DateTimeOffset> _lastFired = [];
    private readonly Dictionary<string, DateTimeOffset> _mutedProjects = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Attention episodes (session + StateSince) that already got their reminder.</summary>
    private readonly HashSet<(string SessionId, DateTimeOffset Since)> _reminded = [];

    /// <summary>Finished turns (session + LastCompletedAt) that already got their unseen reminder.</summary>
    private readonly HashSet<(string SessionId, DateTimeOffset CompletedAt)> _unseenReminded = [];

    /// <summary>Sessions whose context warning fired, with the compact / clear marker it fired under.</summary>
    private readonly Dictionary<string, DateTimeOffset?> _contextWarned = new(StringComparer.Ordinal);

    /// <summary>"Bu session için sustur": (session, rule) pairs that stay silent for the session's lifetime.</summary>
    private readonly HashSet<(string SessionId, string RuleId)> _mutedSessionRules = [];

    public RuleOptions Options { get; set; } = options;

    public void MuteProject(string projectRoot, DateTimeOffset until) => _mutedProjects[projectRoot] = until;

    public void MuteSessionRule(string sessionId, string ruleId) => _mutedSessionRules.Add((sessionId, ruleId));

    public void OnStateChanged(SessionStateChanged c)
    {
        var ruleId = c.To switch
        {
            SessionState.WaitingPermission => RuleIds.WaitingPermission,
            SessionState.WaitingInput => RuleIds.WaitingInput,
            SessionState.Stale => RuleIds.Stale,
            SessionState.Error => RuleIds.Error,
            SessionState.Idle when c.From == SessionState.Working
                && c.TurnDuration is { } d && d >= Options.MinTurnForCompleted => RuleIds.Completed,
            _ => null,
        };

        // A newer transition supersedes whatever was still settling for this session.
        _pending.RemoveAll(p => p.SessionId == c.SessionId);

        if (ruleId is not null && Options.IsEnabled(ruleId))
        {
            var duration = ruleId switch
            {
                RuleIds.Completed => c.TurnDuration,
                RuleIds.Stale => c.At - c.Session.LastEventAt,
                _ => null,
            };
            _pending.Add(new Candidate(ruleId, c.SessionId, c.To, c.At + Options.Settle, duration));
        }
    }

    /// <param name="sessions">Current sessions, used to confirm candidates and to find reminders.</param>
    public IReadOnlyList<NotificationRequest> Poll(DateTimeOffset now, IReadOnlyList<SessionInfo> sessions)
    {
        var byId = sessions.ToDictionary(s => s.SessionId, StringComparer.Ordinal);
        var result = new List<NotificationRequest>();

        foreach (var p in _pending.Where(p => p.DueAt <= now).ToList())
        {
            _pending.Remove(p);
            if (byId.TryGetValue(p.SessionId, out var s) && s.State == p.State)
            {
                TryFire(p.RuleId, s, now, p.Duration, result);
            }
        }

        if (Options.WaitingReminderEnabled)
        {
            foreach (var s in sessions)
            {
                if (s.State.NeedsAttention()
                    && now - s.StateSince >= Options.ReminderAfter
                    && _reminded.Add((s.SessionId, s.StateSince))
                    && !AlreadyFired(RuleIds.WaitingReminder, s.SessionId, s.StateSince, now))
                {
                    TryFire(RuleIds.WaitingReminder, s, now, now - s.StateSince, result);
                }
            }
        }

        if (Options.UnseenReminderEnabled)
        {
            foreach (var s in sessions)
            {
                if (s.IsUnseen
                    && s.LastCompletedAt is { } done
                    && now - done >= Options.UnseenReminderAfter
                    && _unseenReminded.Add((s.SessionId, done))
                    && !AlreadyFired(RuleIds.UnseenReminder, s.SessionId, done, now))
                {
                    TryFire(RuleIds.UnseenReminder, s, now, now - done, result);
                }
            }
        }

        if (Options.ContextHighEnabled)
        {
            PollContext(sessions, now, result);
        }

        _reminded.RemoveWhere(r => !byId.TryGetValue(r.SessionId, out var s) || s.StateSince != r.Since);
        _unseenReminded.RemoveWhere(r => !byId.TryGetValue(r.SessionId, out var s) || s.LastCompletedAt != r.CompletedAt);
        foreach (var gone in _contextWarned.Keys.Where(id => !byId.ContainsKey(id)).ToList())
        {
            _contextWarned.Remove(gone);
        }

        _mutedSessionRules.RemoveWhere(m => !byId.ContainsKey(m.SessionId));
        return result;
    }

    /// <summary>
    /// One warning per crossing of the threshold (spec §18.4): re-armed when the fill drops below the re-arm level or
    /// after a compact / clear.
    /// </summary>
    private void PollContext(IReadOnlyList<SessionInfo> sessions, DateTimeOffset now, List<NotificationRequest> result)
    {
        foreach (var s in sessions)
        {
            if (_contextWarned.TryGetValue(s.SessionId, out var marker)
                && (marker != s.ContextResetAt || s.ContextUsedPercent is not { } p0 || p0 < Options.ContextRearmPercent))
            {
                _contextWarned.Remove(s.SessionId);
            }

            if (s.State.IsLive() && s.State != SessionState.Stale
                && s.ContextUsedPercent is { } pct && pct >= Options.ContextThresholdPercent
                && !_contextWarned.ContainsKey(s.SessionId))
            {
                _contextWarned[s.SessionId] = s.ContextResetAt;
                TryFire(RuleIds.ContextHigh, s, now, null, result);
            }
        }
    }

    /// <summary>
    /// Reminder episodes are persisted (key: session + episode start: the waiting state's start, or the finished turn's
    /// end), so a restart during a long wait does not remind again. Marks the episode as handled on first sight.
    /// </summary>
    private bool AlreadyFired(string ruleId, string sessionId, DateTimeOffset episode, DateTimeOffset now)
    {
        if (state is null)
        {
            return false;
        }

        var key = sessionId + "|" + episode.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (state.HasFired(ruleId, key))
        {
            return true;
        }

        state.MarkFired(ruleId, key, now);
        return false;
    }

    private void TryFire(string ruleId, SessionInfo s, DateTimeOffset now, TimeSpan? duration, List<NotificationRequest> sink)
    {
        if (_mutedProjects.TryGetValue(s.ProjectRoot, out var until))
        {
            if (now < until)
            {
                return;
            }

            _mutedProjects.Remove(s.ProjectRoot);
        }

        if (_mutedSessionRules.Contains((s.SessionId, ruleId)))
        {
            return;
        }

        // Errors debounce per sub-type over a longer period (spec §18.5).
        var debounceKey = ruleId == RuleIds.Error && s.Error is { } err ? ruleId + "|" + err.Kind : ruleId;
        var debounce = ruleId == RuleIds.Error ? Options.ErrorDebounce : Options.Debounce;
        var key = (s.SessionId, debounceKey);
        if (_lastFired.TryGetValue(key, out var last) && now - last < debounce)
        {
            return;
        }

        _lastFired[key] = now;
        sink.Add(new NotificationRequest(ruleId, s.SessionId, s.ProjectName, s.ProjectRoot, s.State, s.LastNotification, duration, now)
        {
            ContextPercent = ruleId == RuleIds.ContextHigh ? s.ContextUsedPercent : null,
            Error = ruleId == RuleIds.Error ? s.Error : null,
        });
    }

    private sealed record Candidate(string RuleId, string SessionId, SessionState State, DateTimeOffset DueAt, TimeSpan? Duration);
}
