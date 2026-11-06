using System.Text;
using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests.Sessions;

/// <summary>Claude Code <c>Stop.background_tasks</c>: a turn that paused for background work stays Working (D-060).</summary>
public sealed class BackgroundTasksTests
{
    private static HookEvent ParseFixture(string name)
    {
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(Fixtures.Read(name)), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static HookEvent Stop(DateTimeOffset at, params string[] background) =>
        Hook(HookEventKind.Stop, at) with { BackgroundTasks = background };

    private static (SessionInfo Session, List<SessionStateChanged> Changes) Run(params HookEvent[] events)
    {
        SessionInfo? s = null;
        var changes = new List<SessionStateChanged>();
        foreach (var e in events)
        {
            var (next, change) = SessionStateMachine.Apply(s, e);
            s = next;
            if (change is not null)
            {
                changes.Add(change);
            }
        }

        return (s!, changes);
    }

    [Fact]
    public void Stop_payload_background_tasks_become_short_labels()
    {
        var e = ParseFixture("hooks/stop_background.json");

        e.Kind.Should().Be(HookEventKind.Stop);
        e.BackgroundTasks.Should().Equal("backend-expert", "npm run dev watching", "monitor", "task", "workflow");
    }

    [Fact]
    public void Labels_are_clipped_and_capped()
    {
        var many = string.Join(",", Enumerable.Range(0, 15).Select(i => $$$"""{"description":"{{{new string('x', 100)}}}{{{i}}}"}"""));
        var e = HookEventParser.Parse(
            Encoding.UTF8.GetBytes($$$"""{"payload":{"session_id":"s","hook_event_name":"Stop","background_tasks":[{{{many}}}]}}"""),
            TestAdapters.BuiltIn, out _)!;

        e.BackgroundTasks.Should().HaveCount(10).And.OnlyContain(l => l.Length == 60);
    }

    [Fact]
    public void Missing_field_is_null_and_empty_array_is_empty()
    {
        HookEvent Parse(string extra) => HookEventParser.Parse(
            Encoding.UTF8.GetBytes($$$"""{"payload":{"session_id":"s","hook_event_name":"Stop"{{{extra}}}}}"""), TestAdapters.BuiltIn, out _)!;

        Parse("").BackgroundTasks.Should().BeNull();
        Parse(""","background_tasks":[]""").BackgroundTasks.Should().BeEmpty();
        Parse(",\"background_tasks\":\"x\"").BackgroundTasks.Should().BeNull();
        ParseFixture("hooks/user_prompt_submit.json").BackgroundTasks.Should().BeNull("only Stop/SubagentStop carry it");
    }

    [Fact]
    public void Stop_with_background_work_stays_working_without_completion()
    {
        var (s, changes) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(2), "backend-expert"));

        s.State.Should().Be(SessionState.Working);
        s.BackgroundTasks.Should().Equal("backend-expert");
        s.LastCompletedAt.Should().BeNull();
        s.IsUnseen.Should().BeFalse();
        s.TurnStartedAt.Should().Be(T0, "the turn is still open");
        changes.Should().ContainSingle(c => c.To == SessionState.Working, "no completed transition");
    }

    [Fact]
    public void Later_stop_without_background_work_finishes_the_turn()
    {
        var (s, changes) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(2), "backend-expert"),
            Hook(HookEventKind.PreToolUse, T0.AddMinutes(5), tool: "Read"),
            Stop(T0.AddMinutes(6)));

        s.State.Should().Be(SessionState.Idle);
        s.BackgroundTasks.Should().BeEmpty();
        s.LastCompletedAt.Should().Be(T0.AddMinutes(6));
        s.IsUnseen.Should().BeTrue();
        changes.Last().TurnDuration.Should().Be(TimeSpan.FromMinutes(6));
    }

    [Fact]
    public void Subagent_stop_with_empty_background_tasks_finishes_a_waiting_session()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(2), "backend-expert", "shell"),
            Hook(HookEventKind.SubagentStop, T0.AddMinutes(3)) with { BackgroundTasks = ["shell"] });
        s.State.Should().Be(SessionState.Working);
        s.BackgroundTasks.Should().Equal("shell");

        var (done, change) = SessionStateMachine.Apply(s, ParseFixture("hooks/subagent_stop_no_background.json") with { SessionId = "s1" });

        done.State.Should().Be(SessionState.Idle);
        done.BackgroundTasks.Should().BeEmpty();
        done.LastCompletedAt.Should().NotBeNull();
        change!.TurnDuration.Should().NotBeNull();
    }

    [Fact]
    public void Subagent_stop_during_a_normal_turn_does_not_end_it()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Hook(HookEventKind.SubagentStart, T0.AddSeconds(1)),
            Hook(HookEventKind.SubagentStop, T0.AddSeconds(30)) with { BackgroundTasks = [] });

        s.State.Should().Be(SessionState.Working);
        s.LastCompletedAt.Should().BeNull();
    }

    [Fact]
    public void Idle_prompt_means_the_background_work_is_over()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(2), "backend-expert"),
            Hook(HookEventKind.Notification, T0.AddMinutes(9), message: "Claude is waiting for your input", notificationType: "idle_prompt"));

        s.State.Should().Be(SessionState.Idle);
        s.BackgroundTasks.Should().BeEmpty();
        s.LastCompletedAt.Should().Be(T0.AddMinutes(9));
    }

    private static HookEvent ShellStop(DateTimeOffset at) => Stop(at, "NF-1 benchmark") with { BackgroundShell = true };

    private static HookEvent IdlePrompt(DateTimeOffset at) =>
        Hook(HookEventKind.Notification, at, message: "Claude is waiting for your input", notificationType: "idle_prompt");

    [Fact]
    public void Stop_payload_reports_a_background_shell()
    {
        ParseFixture("hooks/stop_background.json").BackgroundShell.Should().BeTrue();
        ParseFixture("hooks/subagent_stop_no_background.json").BackgroundShell.Should().BeFalse();
    }

    [Fact]
    public void Idle_prompt_does_not_finish_a_running_shell()
    {
        var (s, changes) = Run(Hook(HookEventKind.UserPromptSubmit, T0), ShellStop(T0.AddMinutes(1)), IdlePrompt(T0.AddMinutes(2)));

        s.State.Should().Be(SessionState.Working);
        s.BackgroundTasks.Should().Equal("NF-1 benchmark");
        s.LastCompletedAt.Should().BeNull();
        changes.Should().ContainSingle();
    }

    [Fact]
    public void The_wake_up_turn_after_a_shell_finishes_the_session()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            ShellStop(T0.AddMinutes(1)),
            IdlePrompt(T0.AddMinutes(2)),
            Hook(HookEventKind.PreToolUse, T0.AddMinutes(30), tool: "Read"),
            Stop(T0.AddMinutes(31)));

        s.State.Should().Be(SessionState.Idle);
        s.LastCompletedAt.Should().Be(T0.AddMinutes(31));
    }

    [Fact]
    public void Subagent_left_after_the_shell_ended_finishes_on_idle_prompt()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            ShellStop(T0.AddMinutes(1)),
            Hook(HookEventKind.SubagentStop, T0.AddMinutes(2)) with { BackgroundTasks = ["backend-expert"], BackgroundShell = false },
            IdlePrompt(T0.AddMinutes(3)));

        s.State.Should().Be(SessionState.Idle);
    }

    [Fact]
    public void Background_work_never_goes_stale()
    {
        var (s, _) = Run(Hook(HookEventKind.UserPromptSubmit, T0), ShellStop(T0.AddMinutes(1)));

        var (_, change) = SessionStateMachine.Evaluate(s, T0.AddHours(2), new FakeEnvironment(), new SessionOptions());

        change.Should().BeNull();
    }

    [Fact]
    public void New_prompt_clears_the_labels()
    {
        var (s, _) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(2), "backend-expert"),
            Hook(HookEventKind.UserPromptSubmit, T0.AddMinutes(3)));

        s.State.Should().Be(SessionState.Working);
        s.BackgroundTasks.Should().BeEmpty();
    }

    [Fact]
    public void Paused_turn_sends_no_completed_toast()
    {
        var engine = new RuleEngine(new RuleOptions());
        var (s, changes) = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Stop(T0.AddMinutes(5), "backend-expert"));
        changes.ForEach(engine.OnStateChanged);

        engine.Poll(T0.AddMinutes(10), [s]).Should().NotContain(n => n.RuleId == RuleIds.Completed);
    }
}
