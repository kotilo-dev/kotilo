using Hub.Core.Hooks;
using Hub.Core.Sessions;
using Hub.Core.Tray;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests;

public class SessionTrackerTests
{
    private readonly FakeEnvironment _env = new();
    private readonly SessionTracker _tracker;

    public SessionTrackerTests() => _tracker = new SessionTracker(_env, new SessionOptions());

    [Fact]
    public void Snapshot_orders_attention_first()
    {
        _tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0, sessionId: "working"));
        _tracker.Apply(Hook(HookEventKind.SessionStart, T0, sessionId: "idle"));
        _tracker.Apply(Hook(HookEventKind.PermissionRequest, T0, sessionId: "perm"));
        _tracker.Apply(Hook(HookEventKind.Notification, T0, sessionId: "input", notificationType: "idle_prompt"));

        _tracker.Snapshot.Select(s => s.SessionId).Should().Equal("perm", "input", "working", "idle");
    }

    [Fact]
    public void ApplyTasks_sets_and_clears_task_progress_for_known_sessions()
    {
        _tracker.Apply(Hook(HookEventKind.SessionStart, T0));
        var progress = new Hub.Core.Projects.TaskListProgress(1, 1, 3);

        _tracker.ApplyTasks("s1", progress).Should().BeTrue();
        _tracker.ApplyTasks("s1", progress).Should().BeFalse();
        _tracker.Snapshot[0].Tasks.Should().Be(progress);

        _tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0.AddSeconds(1)));
        _tracker.Get("s1")!.Tasks.Should().Be(progress, "hook events keep the task counts");

        _tracker.ApplyTasks("s1", null).Should().BeTrue();
        _tracker.ApplyTasks("unknown", progress).Should().BeFalse();
    }

    [Fact]
    public void Tick_reports_process_exit()
    {
        _tracker.Apply(Hook(HookEventKind.SessionStart, T0, parentPid: 42));
        _env.DeadPids.Add(42);

        var changes = _tracker.Tick(T0.AddSeconds(30));

        changes.Should().ContainSingle().Which.To.Should().Be(SessionState.Ended);
        _tracker.Get("s1")!.State.Should().Be(SessionState.Ended);
    }

    [Fact]
    public void Ended_sessions_drop_out_after_thirty_minutes()
    {
        _tracker.Apply(Hook(HookEventKind.SessionStart, T0));
        _tracker.Apply(Hook(HookEventKind.SessionEnd, T0.AddMinutes(1), reason: "other"));

        _tracker.Tick(T0.AddMinutes(30));
        _tracker.Snapshot.Should().HaveCount(1);

        _tracker.Tick(T0.AddMinutes(32));
        _tracker.Snapshot.Should().BeEmpty();
    }

    [Fact]
    public void Restore_loads_previous_sessions()
    {
        _tracker.Restore([Session(SessionState.Working, T0, id: "a"), Session(SessionState.Idle, T0, id: "b")]);
        _tracker.Snapshot.Should().HaveCount(2);
    }
}

public class TraySummaryTests
{
    [Theory]
    [InlineData(new[] { SessionState.Idle, SessionState.Working, SessionState.WaitingInput, SessionState.WaitingPermission }, TrayLevel.WaitingPermission)]
    [InlineData(new[] { SessionState.Idle, SessionState.Working, SessionState.WaitingInput }, TrayLevel.WaitingInput)]
    [InlineData(new[] { SessionState.Idle, SessionState.Working, SessionState.Stale }, TrayLevel.Working)]
    [InlineData(new[] { SessionState.Idle, SessionState.Ended, SessionState.Stale }, TrayLevel.Idle)]
    [InlineData(new SessionState[0], TrayLevel.Idle)]
    public void Level_is_most_critical_state(SessionState[] states, TrayLevel expected)
    {
        var sessions = states.Select((s, i) => Session(s, T0, id: $"s{i}"));
        TraySummary.From(sessions).Level.Should().Be(expected);
    }

    [Fact]
    public void Counts_are_split_by_state()
    {
        var summary = TraySummary.From(
        [
            Session(SessionState.Working, T0, id: "a"),
            Session(SessionState.Working, T0, id: "b"),
            Session(SessionState.WaitingInput, T0, id: "c"),
            Session(SessionState.WaitingPermission, T0, id: "d"),
        ]);

        summary.Working.Should().Be(2);
        summary.Waiting.Should().Be(2);
    }
}
