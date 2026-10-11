using Hub.Core.Hooks;
using Hub.Core.Sessions;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests;

public class SessionStateMachineTests
{
    private static SessionInfo Run(params HookEvent[] events)
    {
        SessionInfo? s = null;
        foreach (var e in events)
        {
            s = SessionStateMachine.Apply(s, e).Session;
        }

        return s!;
    }

    [Fact]
    public void SessionStart_creates_idle_session_with_project_from_cwd()
    {
        var (s, change) = SessionStateMachine.Apply(null, Hook(HookEventKind.SessionStart, T0) with { Source = "startup", Model = "claude-opus-5-5" });

        s.State.Should().Be(SessionState.Idle);
        s.ProjectRoot.Should().Be(@"C:\src\alpha");
        s.ProjectName.Should().Be("alpha");
        s.Model.Should().Be("claude-opus-5-5");
        change.Should().NotBeNull();
        change!.From.Should().Be(SessionState.Unknown);
        change.To.Should().Be(SessionState.Idle);
        change.Detail.Should().Be("startup");
    }

    [Fact]
    public void UserPromptSubmit_goes_to_working_and_starts_turn()
    {
        var s = Run(Hook(HookEventKind.SessionStart, T0), Hook(HookEventKind.UserPromptSubmit, T0.AddSeconds(5)));

        s.State.Should().Be(SessionState.Working);
        s.TurnStartedAt.Should().Be(T0.AddSeconds(5));
    }

    [Fact]
    public void PreToolUse_sets_current_tool_and_PostToolUse_clears_it()
    {
        var s = Run(Hook(HookEventKind.SessionStart, T0), Hook(HookEventKind.PreToolUse, T0.AddSeconds(1), tool: "Bash"));
        s.State.Should().Be(SessionState.Working);
        s.CurrentTool.Should().Be("Bash");

        var (after, change) = SessionStateMachine.Apply(s, Hook(HookEventKind.PostToolUse, T0.AddSeconds(2), tool: "Bash"));
        after.CurrentTool.Should().BeNull();
        change.Should().BeNull("Working → Working is not a transition");
    }

    [Fact]
    public void PostToolUseFailure_behaves_like_PostToolUse()
    {
        var s = Run(Hook(HookEventKind.PreToolUse, T0, tool: "Edit"), Hook(HookEventKind.PostToolUseFailure, T0.AddSeconds(1)));
        s.State.Should().Be(SessionState.Working);
        s.CurrentTool.Should().BeNull();
    }

    [Fact]
    public void PermissionRequest_goes_to_waiting_permission()
    {
        var (s, change) = SessionStateMachine.Apply(
            Run(Hook(HookEventKind.UserPromptSubmit, T0)),
            Hook(HookEventKind.PermissionRequest, T0.AddSeconds(3), tool: "Bash"));

        s.State.Should().Be(SessionState.WaitingPermission);
        change!.Detail.Should().Be("Bash");
    }

    [Theory]
    [InlineData("permission_prompt", null, SessionState.WaitingPermission)]
    [InlineData("idle_prompt", null, SessionState.WaitingInput)]
    [InlineData("elicitation_dialog", null, SessionState.WaitingInput)]
    [InlineData(null, "Claude needs your permission to use Bash", SessionState.WaitingPermission)]
    [InlineData(null, "Claude is waiting for your input", SessionState.WaitingInput)]
    public void Notification_attention_types_change_state(string? type, string? message, SessionState expected)
    {
        var s = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Hook(HookEventKind.Notification, T0.AddSeconds(1), notificationType: type, message: message));

        s.State.Should().Be(expected);
        s.LastNotification.Should().Be(message);
    }

    [Theory]
    [InlineData("idle_prompt", "Claude is waiting for your input")]
    [InlineData(null, "Claude is waiting for your input")]
    public void Idle_reminder_after_a_finished_turn_keeps_the_session_idle(string? type, string message)
    {
        var (s, change) = SessionStateMachine.Apply(
            Run(Hook(HookEventKind.UserPromptSubmit, T0), Hook(HookEventKind.Stop, T0.AddSeconds(5))),
            Hook(HookEventKind.Notification, T0.AddSeconds(65), notificationType: type, message: message));

        s.State.Should().Be(SessionState.Idle);
        change.Should().BeNull();
    }

    [Fact]
    public void A_question_after_a_finished_turn_still_waits_for_input()
    {
        var s = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Hook(HookEventKind.Stop, T0.AddSeconds(5)),
            Hook(HookEventKind.Notification, T0.AddSeconds(6), notificationType: "elicitation_dialog", message: "Pick one"));

        s.State.Should().Be(SessionState.WaitingInput);
    }

    [Theory]
    [InlineData("auth_success", "Signed in")]
    [InlineData(null, "Something unrelated happened")]
    public void Other_notifications_do_not_change_state(string? type, string message)
    {
        var (s, change) = SessionStateMachine.Apply(
            Run(Hook(HookEventKind.UserPromptSubmit, T0)),
            Hook(HookEventKind.Notification, T0.AddSeconds(1), notificationType: type, message: message));

        s.State.Should().Be(SessionState.Working);
        s.LastEventAt.Should().Be(T0.AddSeconds(1));
        change.Should().BeNull();
    }

    [Fact]
    public void Stop_goes_idle_and_reports_turn_duration()
    {
        var working = Run(Hook(HookEventKind.UserPromptSubmit, T0), Hook(HookEventKind.PreToolUse, T0.AddSeconds(10), tool: "Read"));

        var (s, change) = SessionStateMachine.Apply(working, Hook(HookEventKind.Stop, T0.AddSeconds(90)));

        s.State.Should().Be(SessionState.Idle);
        s.LastCompletedAt.Should().Be(T0.AddSeconds(90));
        s.TurnStartedAt.Should().BeNull();
        s.CurrentTool.Should().BeNull();
        change!.From.Should().Be(SessionState.Working);
        change.TurnDuration.Should().Be(TimeSpan.FromSeconds(90));
    }

    [Fact]
    public void Turn_duration_spans_permission_waits()
    {
        var (_, change) = SessionStateMachine.Apply(
            Run(
                Hook(HookEventKind.UserPromptSubmit, T0),
                Hook(HookEventKind.PermissionRequest, T0.AddSeconds(5), tool: "Bash"),
                Hook(HookEventKind.PostToolUse, T0.AddSeconds(50))),
            Hook(HookEventKind.Stop, T0.AddSeconds(70)));

        change!.TurnDuration.Should().Be(TimeSpan.FromSeconds(70));
    }

    [Fact]
    public void StopFailure_ends_turn_as_error_and_max_output_tokens_as_idle()
    {
        // Spec §18.5 replaced the Faz 1 behavior (StopFailure → Idle).
        var s = Run(Hook(HookEventKind.UserPromptSubmit, T0), Hook(HookEventKind.StopFailure, T0.AddSeconds(3)));
        s.State.Should().Be(SessionState.Error);
        s.Error!.Kind.Should().Be(SessionErrorKind.ApiError);
        s.TurnStartedAt.Should().BeNull();

        var truncated = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Hook(HookEventKind.StopFailure, T0.AddSeconds(3)) with { ErrorType = "max_output_tokens" });
        truncated.State.Should().Be(SessionState.Idle);
    }

    [Fact]
    public void Subagent_events_track_count_without_state_change()
    {
        var s = Run(
            Hook(HookEventKind.UserPromptSubmit, T0),
            Hook(HookEventKind.SubagentStart, T0.AddSeconds(1)),
            Hook(HookEventKind.SubagentStart, T0.AddSeconds(2)),
            Hook(HookEventKind.SubagentStop, T0.AddSeconds(3)));

        s.State.Should().Be(SessionState.Working);
        s.ActiveSubagents.Should().Be(1);

        Run(Hook(HookEventKind.SubagentStop, T0)).ActiveSubagents.Should().Be(0);
    }

    [Fact]
    public void SessionEnd_goes_ended_with_reason()
    {
        var (s, change) = SessionStateMachine.Apply(
            Run(Hook(HookEventKind.SessionStart, T0)),
            Hook(HookEventKind.SessionEnd, T0.AddMinutes(1), reason: "prompt_input_exit"));

        s.State.Should().Be(SessionState.Ended);
        s.EndReason.Should().Be("prompt_input_exit");
        s.EndedAt.Should().Be(T0.AddMinutes(1));
        change!.Detail.Should().Be("prompt_input_exit");
    }

    [Fact]
    public void Any_event_revives_stale_session()
    {
        var stale = Session(SessionState.Stale, T0);
        var (s, change) = SessionStateMachine.Apply(stale, Hook(HookEventKind.PreToolUse, T0.AddMinutes(1), tool: "Bash"));

        s.State.Should().Be(SessionState.Working);
        change!.From.Should().Be(SessionState.Stale);
    }

    [Fact]
    public void Out_of_order_event_does_not_change_state()
    {
        var s = Run(Hook(HookEventKind.SessionStart, T0), Hook(HookEventKind.Stop, T0.AddSeconds(30)));

        var (after, change) = SessionStateMachine.Apply(s, Hook(HookEventKind.UserPromptSubmit, T0.AddSeconds(10)));

        after.State.Should().Be(SessionState.Idle);
        change.Should().BeNull();
    }

    [Fact]
    public void Claude_pid_skips_shell_parents()
    {
        var e = Hook(HookEventKind.SessionStart, T0, parentPid: 1200) with
        {
            HookPid = 1300,
            ProcessChain = [new ProcessRef(1200, "bash.exe"), new ProcessRef(1100, "cmd.exe"), new ProcessRef(900, "claude.exe")],
        };

        SessionStateMachine.Apply(null, e).Session.ParentPid.Should().Be(900);
    }

    [Fact]
    public void Claude_pid_falls_back_to_parent_pid_without_chain()
    {
        SessionStateMachine.Apply(null, Hook(HookEventKind.SessionStart, T0, parentPid: 77)).Session.ParentPid.Should().Be(77);
    }

    [Fact]
    public void Project_root_is_filled_from_later_event_when_first_had_no_cwd()
    {
        var s = Run(Hook(HookEventKind.Stop, T0, cwd: null), Hook(HookEventKind.UserPromptSubmit, T0.AddSeconds(1), cwd: @"C:\src\beta\"));
        s.ProjectRoot.Should().Be(@"C:\src\beta\");
        s.ProjectName.Should().Be("beta");
    }

    public class Timer
    {
        private readonly FakeEnvironment _env = new();
        private readonly SessionOptions _options = new();

        [Fact]
        public void Working_with_no_events_and_no_transcript_writes_becomes_stale()
        {
            _env.TranscriptLastWrite = T0;
            var (s, change) = SessionStateMachine.Evaluate(Session(SessionState.Working, T0), T0.AddMinutes(11), _env, _options);

            s.State.Should().Be(SessionState.Stale);
            change!.Trigger.Should().Be(TransitionTrigger.StaleTimer);
        }

        [Fact]
        public void Recent_transcript_write_prevents_stale()
        {
            _env.TranscriptLastWrite = T0.AddMinutes(9);
            SessionStateMachine.Evaluate(Session(SessionState.Working, T0), T0.AddMinutes(11), _env, _options)
                .Change.Should().BeNull();
        }

        [Fact]
        public void Within_stale_window_nothing_happens()
        {
            SessionStateMachine.Evaluate(Session(SessionState.Working, T0), T0.AddMinutes(9), _env, _options)
                .Change.Should().BeNull();
        }

        [Theory]
        [InlineData(SessionState.Idle)]
        [InlineData(SessionState.WaitingInput)]
        [InlineData(SessionState.WaitingPermission)]
        public void Only_working_sessions_go_stale(SessionState state)
        {
            SessionStateMachine.Evaluate(Session(state, T0), T0.AddHours(2), _env, _options).Change.Should().BeNull();
        }

        [Theory]
        [InlineData(SessionState.Idle)]
        [InlineData(SessionState.Working)]
        [InlineData(SessionState.WaitingPermission)]
        [InlineData(SessionState.Stale)]
        public void Dead_process_ends_session(SessionState state)
        {
            _env.DeadPids.Add(100);
            var (s, change) = SessionStateMachine.Evaluate(Session(state, T0), T0.AddSeconds(30), _env, _options);

            s.State.Should().Be(SessionState.Ended);
            s.EndReason.Should().Be(SessionStateMachine.ProcessExitedReason);
            change!.Trigger.Should().Be(TransitionTrigger.ProcessExited);
        }

        [Fact]
        public void Ended_session_is_not_evaluated_again()
        {
            _env.DeadPids.Add(100);
            SessionStateMachine.Evaluate(Session(SessionState.Ended, T0), T0.AddHours(1), _env, _options).Change.Should().BeNull();
        }
    }
}
