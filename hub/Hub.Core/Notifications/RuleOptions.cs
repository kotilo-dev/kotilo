namespace Hub.Core.Notifications;

public sealed record RuleOptions
{
    public bool WaitingPermissionEnabled { get; init; } = true;

    public bool WaitingInputEnabled { get; init; } = true;

    public bool CompletedEnabled { get; init; } = true;

    public bool StaleEnabled { get; init; } = true;

    public bool WaitingReminderEnabled { get; init; } = true;

    public bool TodoCompletedEnabled { get; init; } = true;

    public bool ContextHighEnabled { get; init; } = true;

    /// <summary>Context fill (%) that triggers <see cref="RuleIds.ContextHigh"/> once (spec §18.4).</summary>
    public double ContextThresholdPercent { get; init; } = 80;

    /// <summary>The context warning re-arms only after the fill drops below this (hysteresis).</summary>
    public double ContextRearmPercent { get; init; } = 70;

    public bool ErrorEnabled { get; init; } = true;

    /// <summary>Same error sub-type for the same session at most once per this period (spec §18.5).</summary>
    public TimeSpan ErrorDebounce { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>Only turns at least this long produce a "completed" toast.</summary>
    public TimeSpan MinTurnForCompleted { get; init; } = TimeSpan.FromSeconds(60);

    public TimeSpan ReminderAfter { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>One reminder per finished turn the user has not looked at (off by default).</summary>
    public bool UnseenReminderEnabled { get; init; }

    /// <summary>How long a finished turn stays unseen before <see cref="RuleIds.UnseenReminder"/> fires.</summary>
    public TimeSpan UnseenReminderAfter { get; init; } = TimeSpan.FromMinutes(30);

    /// <summary>Per (session, rule) quiet period after a toast (spec §11.2).</summary>
    public TimeSpan Debounce { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>A candidate fires only if the session is still in the target state after this delay (decision D-022).</summary>
    public TimeSpan Settle { get; init; } = TimeSpan.FromSeconds(1);

    public bool IsEnabled(string ruleId) => ruleId switch
    {
        RuleIds.WaitingPermission => WaitingPermissionEnabled,
        RuleIds.WaitingInput => WaitingInputEnabled,
        RuleIds.Completed => CompletedEnabled,
        RuleIds.Stale => StaleEnabled,
        RuleIds.WaitingReminder => WaitingReminderEnabled,
        RuleIds.TodoCompleted => TodoCompletedEnabled,
        RuleIds.ContextHigh => ContextHighEnabled,
        RuleIds.Error => ErrorEnabled,
        RuleIds.UnseenReminder => UnseenReminderEnabled,
        _ => false,
    };
}
