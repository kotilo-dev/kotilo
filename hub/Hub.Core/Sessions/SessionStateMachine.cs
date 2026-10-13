using Hub.Core.Hooks;

namespace Hub.Core.Sessions;

/// <summary>Pure transition function for one session (spec §6.2, decision D-020).</summary>
public static class SessionStateMachine
{
    public const string ProcessExitedReason = "process_exited";

    /// <summary>Applies a hook event. Returns the updated session and, if the state changed, the transition.</summary>
    /// <param name="zone">Local zone for reset times in error messages without one; defaults to the machine's.</param>
    public static (SessionInfo Session, SessionStateChanged? Change) Apply(SessionInfo? current, HookEvent e, TimeZoneInfo? zone = null)
    {
        var at = e.ReceivedAt;
        var s = current ?? NewSession(e);

        // Out-of-order event (e.g. replayed from spool after newer live events): metadata only.
        if (current is not null && at < current.LastEventAt)
        {
            return (s, null);
        }

        s = s with
        {
            LastEventAt = at,
            TranscriptPath = e.TranscriptPath ?? s.TranscriptPath,
            ProjectRoot = string.IsNullOrEmpty(s.ProjectRoot) && e.Cwd is { } cwd ? cwd : s.ProjectRoot,
            ProjectName = string.IsNullOrEmpty(s.ProjectRoot) && e.Cwd is { } cwd2 ? SessionInfo.ProjectNameFrom(cwd2) : s.ProjectName,
            Model = e.Model ?? s.Model,
            ParentPid = AgentProcessResolver.Resolve(e) ?? s.ParentPid,
            PaneId = e.PaneId ?? s.PaneId,
        };

        if (e.ContextPercent is { } reported)
        {
            // An agent's own reading ranks like Claude's statusLine (spec §18.4).
            s = s with { StatusLineContext = new ContextSample(reported, at) };
            s = s with { ContextUsedPercent = ContextUsageResolver.Resolve(s.StatusLineContext, s.TranscriptContext, s.ContextResetAt) };
        }

        SessionState? target = null;
        string? detail = null;
        TimeSpan? turnDuration = null;

        switch (e.Kind)
        {
            case HookEventKind.SessionStart:
                target = SessionState.Idle;
                detail = e.Source;
                s = s with { CurrentTool = null, TurnStartedAt = null, EndedAt = null, EndReason = null, ActiveSubagents = 0 };
                if (e.Source is "compact" or "clear")
                {
                    // Older context readings describe the conversation before the compaction (spec §18.4).
                    s = s with { ContextResetAt = at };
                    s = s with { ContextUsedPercent = ContextUsageResolver.Resolve(s.StatusLineContext, s.TranscriptContext, at) };
                }

                break;

            case HookEventKind.UserPromptSubmit:
                target = SessionState.Working;
                s = s with { TurnStartedAt = at, CurrentTool = null, LastNotification = null };
                break;

            case HookEventKind.PreToolUse:
                target = SessionState.Working;
                detail = e.ToolName;
                s = s with { CurrentTool = e.ToolName, TurnStartedAt = s.TurnStartedAt ?? at };
                break;

            case HookEventKind.PostToolUse:
            case HookEventKind.PostToolUseFailure:
                target = SessionState.Working;
                s = s with { CurrentTool = null, TurnStartedAt = s.TurnStartedAt ?? at };
                break;

            case HookEventKind.Working:
                target = SessionState.Working;
                detail = e.ToolName;
                s = s with { CurrentTool = e.ToolName, TurnStartedAt = s.TurnStartedAt ?? at, LastNotification = null };
                break;

            case HookEventKind.WaitingInput:
                target = SessionState.WaitingInput;
                break;

            case HookEventKind.Done:
                target = SessionState.Idle;
                s = EndTurn(s, at, ref turnDuration) with { Error = null };
                break;

            case HookEventKind.Error:
                var protocolError = ProtocolError(e.ErrorType, e.ErrorDetails, at, zone ?? TimeZoneInfo.Local);
                target = SessionState.Error;
                detail = protocolError.Kind.ToString();
                s = EndTurn(s, at, ref turnDuration) with { Error = protocolError };
                break;

            case HookEventKind.PermissionRequest:
                var requested = e.ToolName ?? s.CurrentTool;
                detail = e.ToolName;
                if (IsQuestionTool(requested))
                {
                    // A question with its own answer menu, not a yes/no: it is answered in the terminal.
                    target = SessionState.WaitingInput;
                    s = s with { CurrentTool = requested };
                    break;
                }

                target = SessionState.WaitingPermission;
                s = s with { CurrentTool = requested, PendingPermission = PendingFrom(e, requested, at) };
                break;

            case HookEventKind.Notification:
                var kind = NotificationClassifier.Classify(e.NotificationType, e.Message);
                if (kind == NotificationKind.Permission && IsQuestionTool(s.CurrentTool))
                {
                    kind = NotificationKind.Input;
                }

                if (kind == NotificationKind.Input && IsIdleReminder(s, e))
                {
                    // Claude Code (and Droid/Qwen) send idle_prompt ~60 s after a turn that already ended normally:
                    // a reminder, not a question. The session stays Idle; the "completed" toast already fired (D-054).
                    break;
                }

                if (kind != NotificationKind.Other)
                {
                    target = kind == NotificationKind.Permission ? SessionState.WaitingPermission : SessionState.WaitingInput;
                    detail = e.Message;
                    s = s with { LastNotification = e.Message };
                    if (kind == NotificationKind.Permission && s.PendingPermission is null)
                    {
                        // Claude's permission Notification carries no tool input; PermissionRequest (if it came) already set it.
                        s = s with { PendingPermission = new PermissionPrompt(s.CurrentTool, null, null, null, at) };
                    }
                }

                break;

            case HookEventKind.Stop:
            case HookEventKind.StopFailure:
                var error = e.Kind == HookEventKind.StopFailure
                    ? ErrorClassifier.FromStopFailure(e.ErrorType, e.ErrorDetails, at, zone ?? TimeZoneInfo.Local)
                    : null;
                target = error is null ? SessionState.Idle : SessionState.Error;
                detail = error?.Kind.ToString() ?? (e.Kind == HookEventKind.StopFailure ? "stop_failure" : null);
                s = s with { Error = error };
                if (s.TurnStartedAt is { } started)
                {
                    turnDuration = at - started;
                }

                s = s with { CurrentTool = null, TurnStartedAt = null, LastCompletedAt = at, ActiveSubagents = 0 };
                break;

            case HookEventKind.SubagentStart:
                s = s with { ActiveSubagents = s.ActiveSubagents + 1 };
                break;

            case HookEventKind.SubagentStop:
                s = s with { ActiveSubagents = Math.Max(0, s.ActiveSubagents - 1) };
                break;

            case HookEventKind.Interrupt:
                // A cancelled turn: back to the prompt, nothing finished.
                target = SessionState.Idle;
                detail = "interrupt";
                s = s with { CurrentTool = null, TurnStartedAt = null, ActiveSubagents = 0 };
                break;

            case HookEventKind.PostCompact:
                // Compaction can happen mid-turn: only the context reading resets, the state does not change.
                s = s with { ContextResetAt = at };
                s = s with { ContextUsedPercent = ContextUsageResolver.Resolve(s.StatusLineContext, s.TranscriptContext, at) };
                break;

            case HookEventKind.SessionEnd:
                target = SessionState.Ended;
                detail = e.Reason;
                s = s with { CurrentTool = null, EndedAt = at, EndReason = e.Reason };
                break;

            default:
                break;
        }

        return target is { } to ? Transition(s, to, at, detail, TransitionTrigger.HookEvent, turnDuration) : (s, null);
    }

    /// <summary>Periodic check: process exit → Ended, long silence while Working → Stale.</summary>
    public static (SessionInfo Session, SessionStateChanged? Change) Evaluate(
        SessionInfo s, DateTimeOffset now, ISessionEnvironment env, SessionOptions options)
    {
        if (s.State is SessionState.Ended or SessionState.Unknown)
        {
            return (s, null);
        }

        if (s.ParentPid is { } pid && !env.IsProcessAlive(pid))
        {
            var ended = s with { CurrentTool = null, EndedAt = now, EndReason = ProcessExitedReason };
            return Transition(ended, SessionState.Ended, now, ProcessExitedReason, TransitionTrigger.ProcessExited, null);
        }

        if (s.State == SessionState.Working && now - s.LastEventAt > options.StaleAfter)
        {
            var lastWrite = env.GetTranscriptLastWrite(s.TranscriptPath);
            if (lastWrite is null || now - lastWrite.Value > options.StaleAfter)
            {
                return Transition(s, SessionState.Stale, now, null, TransitionTrigger.StaleTimer, null);
            }
        }

        return (s, null);
    }

    /// <summary>The user looked at the session. Returns null when there was no finished work left to see.</summary>
    public static SessionInfo? MarkSeen(SessionInfo s, DateTimeOffset at) =>
        s.HasUnseenCompletion ? s with { SeenAt = at > s.LastCompletedAt!.Value ? at : s.LastCompletedAt.Value } : null;

    private static (SessionInfo, SessionStateChanged?) Transition(
        SessionInfo s, SessionState to, DateTimeOffset at, string? detail, TransitionTrigger trigger, TimeSpan? turnDuration)
    {
        if (s.State == to)
        {
            return (s, null);
        }

        var from = s.State;
        var next = s with
        {
            State = to,
            StateSince = at,
            Error = to == SessionState.Error ? s.Error : null,
            PendingPermission = to == SessionState.WaitingPermission ? s.PendingPermission : null,

            // New work started: the user is at the session, so whatever finished before has been seen.
            // (SeenAt moves to that finish, not to `at`, so a turn ending within the same millisecond still counts as new.)
            SeenAt = to == SessionState.Working && s.HasUnseenCompletion ? s.LastCompletedAt : s.SeenAt,
        };
        return (next, new SessionStateChanged(s.SessionId, from, to, at, detail, trigger, next, turnDuration));
    }

    /// <summary>
    /// An idle reminder (<c>idle_prompt</c>, or an untyped "waiting for your input" message) for a session whose last
    /// turn ended normally and that has been idle since. Questions asked during a turn (elicitation) and a cancelled
    /// turn that never got a Stop (Droid: state still Working) keep moving the session to WaitingInput.
    /// </summary>
    private static bool IsIdleReminder(SessionInfo s, HookEvent e) =>
        s.State == SessionState.Idle
        && s.LastCompletedAt is not null
        && (e.NotificationType is null || string.Equals(e.NotificationType, "idle_prompt", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Tools that show a multiple-choice question through the agent's permission dialog (Claude Code's
    /// <c>AskUserQuestion</c> and its plan approval <c>ExitPlanMode</c>). Allow/deny keys would pick or cancel
    /// an answer with a different meaning, so they count as WaitingInput.
    /// </summary>
    private static bool IsQuestionTool(string? tool) => tool is "AskUserQuestion" or "ExitPlanMode";

    private static PermissionPrompt PendingFrom(HookEvent e, string? tool, DateTimeOffset at) =>
        new(tool, e.ToolCommand, e.ToolPath, e.Risk ?? PermissionRiskClassifier.Classify(e.ToolCommand), at);

    /// <summary>Clears the turn's bookkeeping; <paramref name="turnDuration"/> gets the turn's length if it had a start.</summary>
    private static SessionInfo EndTurn(SessionInfo s, DateTimeOffset at, ref TimeSpan? turnDuration)
    {
        if (s.TurnStartedAt is { } started)
        {
            turnDuration = at - started;
        }

        return s with { CurrentTool = null, TurnStartedAt = null, LastCompletedAt = at, ActiveSubagents = 0 };
    }

    /// <summary>
    /// Protocol <c>error {kind, message?}</c>: <c>usageLimit</c>, <c>rateLimit</c>, <c>overloaded</c>, <c>auth</c>, anything
    /// else is a plain API error. The message is read only for a usage limit's reset time.
    /// </summary>
    internal static SessionError ProtocolError(string? kind, string? message, DateTimeOffset at, TimeZoneInfo zone) => kind switch
    {
        "usageLimit" => new SessionError(SessionErrorKind.UsageLimit, ErrorClassifier.ParseResetsAt(message, at, zone)),
        "rateLimit" => new SessionError(SessionErrorKind.RateLimited, null),
        "overloaded" => new SessionError(SessionErrorKind.Overloaded, null),
        "auth" => new SessionError(SessionErrorKind.AuthError, null),
        _ => new SessionError(SessionErrorKind.ApiError, null),
    };

    private static SessionInfo NewSession(HookEvent e)
    {
        var root = e.Cwd ?? string.Empty;
        return new SessionInfo(
            SessionId: e.SessionId,
            ProjectRoot: root,
            ProjectName: SessionInfo.ProjectNameFrom(root),
            TranscriptPath: e.TranscriptPath,
            State: SessionState.Unknown,
            StateSince: e.ReceivedAt,
            LastEventAt: e.ReceivedAt,
            CurrentTool: null,
            LastNotification: null,
            Model: e.Model,
            ParentPid: null,
            TokensThisSession: 0,
            CostUsdThisSession: null,
            ContextUsedPercent: null)
        {
            Agent = e.Agent,
            PaneId = e.PaneId,
        };
    }
}
