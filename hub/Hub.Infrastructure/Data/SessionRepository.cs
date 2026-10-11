using Hub.Core.Sessions;
using Dapper;

namespace Hub.Infrastructure.Data;

public interface ISessionRepository
{
    void Upsert(SessionInfo s);

    void AddTransition(SessionStateChanged change);

    /// <summary>Sessions that are live, or ended within <paramref name="endedWithin"/>.</summary>
    IReadOnlyList<SessionInfo> LoadRecent(DateTimeOffset now, TimeSpan endedWithin);

    IReadOnlyList<SessionTransitionRecord> GetTransitions(string sessionId);

    /// <summary>Retention (spec §13): transitions older than <paramref name="olderThan"/> are deleted.</summary>
    int PruneTransitions(DateTimeOffset olderThan);
}

public sealed record SessionTransitionRecord(string SessionId, SessionState From, SessionState To, DateTimeOffset At, string? Detail);

public sealed class SessionRepository(Database db) : ISessionRepository
{
    public void Upsert(SessionInfo s)
    {
        using var c = db.Open();
        c.Execute(
            """
            INSERT INTO sessions (session_id, agent, pane_id, project_root, transcript_path, state, state_since, last_event_at,
                                  current_tool, last_notification, model, parent_pid, turn_started_at,
                                  last_completed_at, seen_at, ended_at, end_reason, error_kind, error_resets_at, context_reset_at)
            VALUES (@SessionId, @Agent, @PaneId, @ProjectRoot, @TranscriptPath, @State, @StateSince, @LastEventAt,
                    @CurrentTool, @LastNotification, @Model, @ParentPid, @TurnStartedAt,
                    @LastCompletedAt, @SeenAt, @EndedAt, @EndReason, @ErrorKind, @ErrorResetsAt, @ContextResetAt)
            ON CONFLICT(session_id) DO UPDATE SET
                agent = excluded.agent, pane_id = excluded.pane_id, project_root = excluded.project_root, transcript_path = excluded.transcript_path,
                state = excluded.state, state_since = excluded.state_since, last_event_at = excluded.last_event_at,
                current_tool = excluded.current_tool, last_notification = excluded.last_notification,
                model = excluded.model, parent_pid = excluded.parent_pid, turn_started_at = excluded.turn_started_at,
                last_completed_at = excluded.last_completed_at, seen_at = excluded.seen_at, ended_at = excluded.ended_at, end_reason = excluded.end_reason,
                error_kind = excluded.error_kind, error_resets_at = excluded.error_resets_at, context_reset_at = excluded.context_reset_at
            """,
            new
            {
                s.SessionId,
                s.Agent,
                s.PaneId,
                s.ProjectRoot,
                s.TranscriptPath,
                State = s.State.ToString(),
                StateSince = Ms(s.StateSince),
                LastEventAt = Ms(s.LastEventAt),
                s.CurrentTool,
                s.LastNotification,
                s.Model,
                s.ParentPid,
                TurnStartedAt = Ms(s.TurnStartedAt),
                LastCompletedAt = Ms(s.LastCompletedAt),
                SeenAt = Ms(s.SeenAt),
                EndedAt = Ms(s.EndedAt),
                s.EndReason,
                ErrorKind = s.Error?.Kind.ToString(),
                ErrorResetsAt = Ms(s.Error?.ResetsAt),
                ContextResetAt = Ms(s.ContextResetAt),
            });
    }

    public void AddTransition(SessionStateChanged change)
    {
        using var c = db.Open();
        c.Execute(
            "INSERT INTO session_transitions (session_id, agent, from_state, to_state, at, detail) VALUES (@SessionId, @Agent, @From, @To, @At, @Detail)",
            new
            {
                change.SessionId,
                change.Session.Agent,
                From = change.From.ToString(),
                To = change.To.ToString(),
                At = Ms(change.At),
                change.Detail,
            });
    }

    public IReadOnlyList<SessionInfo> LoadRecent(DateTimeOffset now, TimeSpan endedWithin)
    {
        using var c = db.Open();
        return c.Query<SessionRow>(
                """
                SELECT session_id AS SessionId, agent AS Agent, pane_id AS PaneId, project_root AS ProjectRoot, transcript_path AS TranscriptPath,
                       state AS State, state_since AS StateSince, last_event_at AS LastEventAt,
                       current_tool AS CurrentTool, last_notification AS LastNotification, model AS Model,
                       parent_pid AS ParentPid, turn_started_at AS TurnStartedAt,
                       last_completed_at AS LastCompletedAt, seen_at AS SeenAt, ended_at AS EndedAt, end_reason AS EndReason,
                       error_kind AS ErrorKind, error_resets_at AS ErrorResetsAt, context_reset_at AS ContextResetAt
                FROM sessions
                WHERE state <> 'Ended' OR COALESCE(ended_at, state_since) >= @cutoff
                """,
                new { cutoff = Ms(now - endedWithin) })
            .Select(r => r.ToModel())
            .ToList();
    }

    /// <summary>Sessions active since <paramref name="since"/>, newest first (Session'lar → Geçmiş, spec §12.2).</summary>
    public IReadOnlyList<SessionInfo> LoadHistory(DateTimeOffset since, int limit)
    {
        using var c = db.Open();
        return c.Query<SessionRow>(
                """
                SELECT session_id AS SessionId, agent AS Agent, pane_id AS PaneId, project_root AS ProjectRoot, transcript_path AS TranscriptPath,
                       state AS State, state_since AS StateSince, last_event_at AS LastEventAt,
                       current_tool AS CurrentTool, last_notification AS LastNotification, model AS Model,
                       parent_pid AS ParentPid, turn_started_at AS TurnStartedAt,
                       last_completed_at AS LastCompletedAt, seen_at AS SeenAt, ended_at AS EndedAt, end_reason AS EndReason,
                       error_kind AS ErrorKind, error_resets_at AS ErrorResetsAt, context_reset_at AS ContextResetAt
                FROM sessions
                WHERE last_event_at >= @since
                ORDER BY last_event_at DESC
                LIMIT @limit
                """,
                new { since = Ms(since), limit })
            .Select(r => r.ToModel())
            .ToList();
    }

    /// <summary>First recorded transition per session: the best available "started at".</summary>
    public IReadOnlyDictionary<string, DateTimeOffset> FirstSeen(IReadOnlyCollection<string> sessionIds)
    {
        if (sessionIds.Count == 0)
        {
            return new Dictionary<string, DateTimeOffset>();
        }

        using var c = db.Open();
        return c.Query<(string SessionId, long At)>(
                "SELECT session_id, MIN(at) FROM session_transitions WHERE session_id IN @sessionIds GROUP BY session_id",
                new { sessionIds })
            .ToDictionary(r => r.SessionId, r => FromMs(r.At), StringComparer.Ordinal);
    }

    public IReadOnlyList<SessionTransitionRecord> GetTransitions(string sessionId)
    {
        using var c = db.Open();
        return c.Query<(string SessionId, string From, string To, long At, string? Detail)>(
                "SELECT session_id, from_state, to_state, at, detail FROM session_transitions WHERE session_id = @sessionId ORDER BY at, id",
                new { sessionId })
            .Select(r => new SessionTransitionRecord(r.SessionId, ParseState(r.From), ParseState(r.To), FromMs(r.At), r.Detail))
            .ToList();
    }

    /// <summary>
    /// All transitions of sessions with any transition in [<paramref name="from"/>, <paramref name="to"/>), plus each
    /// such session's last transition before the range so a wait that started earlier is still seen (spec §18.1).
    /// </summary>
    public IReadOnlyList<SessionTransitionRecord> TransitionsAround(DateTimeOffset from, DateTimeOffset to)
    {
        using var c = db.Open();
        return c.Query<(string SessionId, string From, string To, long At, string? Detail)>(
                """
                SELECT t.session_id, t.from_state, t.to_state, t.at, t.detail FROM session_transitions t
                WHERE t.at < @to AND (t.at >= @from OR t.id = (
                    SELECT p.id FROM session_transitions p WHERE p.session_id = t.session_id AND p.at < @from ORDER BY p.at DESC, p.id DESC LIMIT 1))
                ORDER BY t.session_id, t.at, t.id
                """,
                new { from = Ms(from), to = Ms(to) })
            .Select(r => new SessionTransitionRecord(r.SessionId, ParseState(r.From), ParseState(r.To), FromMs(r.At), r.Detail))
            .ToList();
    }

    /// <summary>Project root per session id (for attributing transitions).</summary>
    public IReadOnlyDictionary<string, string> ProjectRoots(IReadOnlyCollection<string> sessionIds)
    {
        if (sessionIds.Count == 0)
        {
            return new Dictionary<string, string>();
        }

        using var c = db.Open();
        return c.Query<(string SessionId, string Root)>(
                "SELECT session_id, project_root FROM sessions WHERE session_id IN @sessionIds", new { sessionIds })
            .ToDictionary(r => r.SessionId, r => r.Root, StringComparer.Ordinal);
    }

    public int PruneTransitions(DateTimeOffset olderThan)
    {
        using var c = db.Open();
        return c.Execute("DELETE FROM session_transitions WHERE at < @cutoff", new { cutoff = Ms(olderThan) });
    }

    private static long Ms(DateTimeOffset value) => value.ToUnixTimeMilliseconds();

    private static long? Ms(DateTimeOffset? value) => value?.ToUnixTimeMilliseconds();

    private static DateTimeOffset FromMs(long value) => DateTimeOffset.FromUnixTimeMilliseconds(value);

    private static SessionState ParseState(string value) =>
        Enum.TryParse<SessionState>(value, out var state) ? state : SessionState.Unknown;

    private sealed class SessionRow
    {
        public string SessionId { get; set; } = "";

        public string Agent { get; set; } = Hub.Core.Hooks.HookEnvelope.DefaultAgent;

        public string? PaneId { get; set; }

        public string ProjectRoot { get; set; } = "";

        public string? TranscriptPath { get; set; }

        public string State { get; set; } = "";

        public long StateSince { get; set; }

        public long LastEventAt { get; set; }

        public string? CurrentTool { get; set; }

        public string? LastNotification { get; set; }

        public string? Model { get; set; }

        public long? ParentPid { get; set; }

        public long? TurnStartedAt { get; set; }

        public long? LastCompletedAt { get; set; }

        public long? SeenAt { get; set; }

        public long? EndedAt { get; set; }

        public string? EndReason { get; set; }

        public string? ErrorKind { get; set; }

        public long? ErrorResetsAt { get; set; }

        public long? ContextResetAt { get; set; }

        public SessionInfo ToModel() =>
            new(SessionId, ProjectRoot, SessionInfo.ProjectNameFrom(ProjectRoot), TranscriptPath, ParseState(State),
                FromMs(StateSince), FromMs(LastEventAt), CurrentTool, LastNotification, Model,
                ParentPid is { } pid ? (int)pid : null, 0, null, null)
            {
                Agent = Agent,
                PaneId = PaneId,
                TurnStartedAt = TurnStartedAt is { } t ? FromMs(t) : null,
                LastCompletedAt = LastCompletedAt is { } l ? FromMs(l) : null,
                SeenAt = SeenAt is { } seen ? FromMs(seen) : null,
                EndedAt = EndedAt is { } e ? FromMs(e) : null,
                EndReason = EndReason,
                Error = ErrorKind is not null && Enum.TryParse<SessionErrorKind>(ErrorKind, out var kind)
                    ? new SessionError(kind, ErrorResetsAt is { } r ? FromMs(r) : null)
                    : null,
                ContextResetAt = ContextResetAt is { } cr ? FromMs(cr) : null,
            };
    }
}
