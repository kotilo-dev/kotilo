namespace Hub.Core.Sessions;

public enum NotificationKind
{
    Other,
    Permission,
    Input,
}

/// <summary>
/// Maps a Claude Code Notification hook to a session state (spec §6.2, decision D-020).
/// <c>notification_type</c> wins; message keywords are the fallback for older Claude Code versions.
/// Keep all matching rules in this one class.
/// </summary>
public static class NotificationClassifier
{
    private static readonly HashSet<string> PermissionTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "permission_prompt",
    };

    private static readonly HashSet<string> InputTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "idle_prompt",
        "elicitation_dialog",
        "elicitation_url_dialog",
        "agent_needs_input",
    };

    private static readonly string[] PermissionKeywords =
    [
        "needs your permission",
        "permission to use",
        "requesting permission",
        "permission",
    ];

    private static readonly string[] InputKeywords =
    [
        "waiting for your input",
        "waiting for input",
        "is waiting for you",
        "needs your input",
        "awaiting your",
    ];

    public static NotificationKind Classify(string? notificationType, string? message)
    {
        if (!string.IsNullOrWhiteSpace(notificationType))
        {
            if (PermissionTypes.Contains(notificationType))
            {
                return NotificationKind.Permission;
            }

            if (InputTypes.Contains(notificationType))
            {
                return NotificationKind.Input;
            }

            // A known-but-unrelated type (auth_success, quota_*, ...) must not fall back to keywords.
            return NotificationKind.Other;
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            return NotificationKind.Other;
        }

        // Input phrases first: "waiting for your input" must not be read as a permission request.
        if (InputKeywords.Any(k => message.Contains(k, StringComparison.OrdinalIgnoreCase)))
        {
            return NotificationKind.Input;
        }

        return PermissionKeywords.Any(k => message.Contains(k, StringComparison.OrdinalIgnoreCase))
            ? NotificationKind.Permission
            : NotificationKind.Other;
    }
}
