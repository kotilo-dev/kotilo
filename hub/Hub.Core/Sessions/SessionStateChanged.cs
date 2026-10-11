namespace Hub.Core.Sessions;

/// <summary>Domain event emitted for every state transition (spec §6.3).</summary>
/// <param name="Session">Session snapshot after the transition.</param>
/// <param name="Detail">Free-form detail: notification message, end reason, tool name.</param>
/// <param name="Trigger">What caused the transition.</param>
/// <param name="TurnDuration">Set when a turn completed (Stop).</param>
public sealed record SessionStateChanged(
    string SessionId,
    SessionState From,
    SessionState To,
    DateTimeOffset At,
    string? Detail,
    TransitionTrigger Trigger,
    SessionInfo Session,
    TimeSpan? TurnDuration = null);

public enum TransitionTrigger
{
    HookEvent,
    StaleTimer,
    ProcessExited,

    /// <summary>An API error line in the transcript (spec §18.5 fallback).</summary>
    Transcript,
}
