using Hub.Core.Sessions;
using Hub.Infrastructure.Data;
using Dapper;

namespace Hub.Infrastructure.Tests;

public sealed class SessionRepositoryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 30, 18, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly Database _db;
    private readonly SessionRepository _repo;

    public SessionRepositoryTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate();
        _repo = new SessionRepository(_db);
    }

    public void Dispose() => _dir.Dispose();

    private static SessionInfo Session(string id, SessionState state, DateTimeOffset since) =>
        new(id, @"C:\src\alpha", "alpha", @"C:\t\x.jsonl", state, since, since, "Bash", "msg", "claude-opus-5-5", 42, 0, null, null)
        {
            TurnStartedAt = since.AddSeconds(-5),
            EndedAt = state == SessionState.Ended ? since : null,
            EndReason = state == SessionState.Ended ? "other" : null,
        };

    [Fact]
    public void Migrate_creates_all_tables_and_is_repeatable()
    {
        _db.Migrate().Should().Be(10);

        using var c = _db.Open();
        var tables = c.Query<string>("SELECT name FROM sqlite_master WHERE type = 'table'").ToList();
        tables.Should().Contain(["sessions", "session_transitions", "usage_entries", "transcript_offsets", "projects", "notification_log", "schema_version", "personal_tasks", "dictations"]);
        c.ExecuteScalar<long>("SELECT COUNT(*) FROM schema_version").Should().Be(10);
    }

    [Fact]
    public void Upsert_roundtrips_session()
    {
        var s = Session("a", SessionState.Working, T0);
        _repo.Upsert(s);
        _repo.Upsert(s with { State = SessionState.WaitingPermission, StateSince = T0.AddSeconds(3) });

        var loaded = _repo.LoadRecent(T0, TimeSpan.FromMinutes(30)).Should().ContainSingle().Subject;
        loaded.State.Should().Be(SessionState.WaitingPermission);
        loaded.StateSince.Should().Be(T0.AddSeconds(3));
        loaded.ProjectName.Should().Be("alpha");
        loaded.ParentPid.Should().Be(42);
        loaded.TurnStartedAt.Should().Be(T0.AddSeconds(-5));
        loaded.Model.Should().Be("claude-opus-5-5");
    }

    [Fact]
    public void Agent_and_pane_round_trip()
    {
        _repo.Upsert(Session("a", SessionState.Working, T0) with { Agent = "codex", PaneId = "pane-7" });

        var loaded = _repo.LoadRecent(T0, TimeSpan.FromMinutes(30)).Should().ContainSingle().Subject;
        loaded.Agent.Should().Be("codex");
        loaded.PaneId.Should().Be("pane-7");
    }

    [Fact]
    public void LoadRecent_skips_long_ended_sessions()
    {
        _repo.Upsert(Session("live", SessionState.Idle, T0));
        _repo.Upsert(Session("recent", SessionState.Ended, T0.AddMinutes(-10)));
        _repo.Upsert(Session("old", SessionState.Ended, T0.AddHours(-2)));

        _repo.LoadRecent(T0, TimeSpan.FromMinutes(30)).Select(s => s.SessionId).Should().BeEquivalentTo(["live", "recent"]);
    }

    [Fact]
    public void Transitions_are_stored_and_pruned()
    {
        var s = Session("a", SessionState.Working, T0);
        _repo.AddTransition(new SessionStateChanged("a", SessionState.Idle, SessionState.Working, T0.AddDays(-40), null, TransitionTrigger.HookEvent, s));
        _repo.AddTransition(new SessionStateChanged("a", SessionState.Working, SessionState.WaitingPermission, T0, "Bash", TransitionTrigger.HookEvent, s));

        _repo.GetTransitions("a").Should().HaveCount(2);
        _repo.PruneTransitions(T0.AddDays(-30)).Should().Be(1);

        var remaining = _repo.GetTransitions("a").Should().ContainSingle().Subject;
        remaining.To.Should().Be(SessionState.WaitingPermission);
        remaining.Detail.Should().Be("Bash");
    }

    [Fact]
    public void History_is_newest_first_within_window_and_first_seen_uses_transitions()
    {
        _repo.Upsert(Session("old", SessionState.Ended, T0.AddDays(-40)));
        _repo.Upsert(Session("a", SessionState.Ended, T0.AddHours(-3)));
        _repo.Upsert(Session("b", SessionState.Idle, T0.AddHours(-1)));

        _repo.LoadHistory(T0.AddDays(-30), 10).Select(s => s.SessionId).Should().Equal("b", "a");
        _repo.LoadHistory(T0.AddDays(-30), 1).Should().ContainSingle();

        var s = Session("a", SessionState.Working, T0);
        _repo.AddTransition(new SessionStateChanged("a", SessionState.Unknown, SessionState.Idle, T0.AddHours(-4), null, TransitionTrigger.HookEvent, s));
        _repo.AddTransition(new SessionStateChanged("a", SessionState.Idle, SessionState.Working, T0.AddHours(-3), null, TransitionTrigger.HookEvent, s));
        _repo.FirstSeen(["a", "b"]).Should().ContainSingle().Which.Value.Should().Be(T0.AddHours(-4));
        _repo.FirstSeen([]).Should().BeEmpty();
    }
}
