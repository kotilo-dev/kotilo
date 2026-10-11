using Hub.Core.Sessions;

namespace Hub.Core.Notifications;

/// <summary>A notification the host should show. Text is formatted by the UI layer from these fields.</summary>
/// <param name="Duration">Turn duration (completed), silence (stale) or wait time (reminder).</param>
public sealed record NotificationRequest(
    string RuleId,
    string SessionId,
    string ProjectName,
    string ProjectRoot,
    SessionState State,
    string? Message,
    TimeSpan? Duration,
    DateTimeOffset At)
{
    /// <summary>Context fill for <see cref="RuleIds.ContextHigh"/>.</summary>
    public double? ContextPercent { get; init; }

    /// <summary>The failure for <see cref="RuleIds.Error"/>.</summary>
    public SessionError? Error { get; init; }
}
