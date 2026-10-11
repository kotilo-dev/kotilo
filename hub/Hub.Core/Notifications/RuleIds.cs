namespace Hub.Core.Notifications;

/// <summary>Notification rule ids (spec §11.1).</summary>
public static class RuleIds
{
    public const string WaitingPermission = "session.waiting_permission";
    public const string WaitingInput = "session.waiting_input";
    public const string Completed = "session.completed";
    public const string Stale = "session.stale";
    public const string WaitingReminder = "session.waiting_reminder";
    public const string TodoCompleted = "todo.completed";
    public const string ContextHigh = "session.context_high";
    public const string Error = "session.error";
}
