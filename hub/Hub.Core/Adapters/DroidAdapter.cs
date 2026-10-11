using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Adapters;

/// <summary>
/// Factory Droid hooks (docs.factory.com/harness/hooks, CLI 0.234; docs/research/agents-droid-cursor.md §1.2). The events
/// and payloads are Claude-like: <c>session_id</c>, <c>transcript_path</c>, <c>cwd</c> on every event, no model field.
/// <c>Notification</c> carries <c>notification_type</c>: <c>permission_prompt</c> is the permission prompt,
/// <c>idle_prompt</c> waits for input (it also ends a cancelled turn, which gets no <c>Stop</c>). <c>PreCompact</c> resets the
/// context reading like Codex's <c>PostCompact</c>. Droid has no <c>SubagentStart</c>, so <c>SubagentStop</c> never moves the
/// subagent count.
/// </summary>
/// <remarks>
/// The permission Notification names no tool, so the adapter remembers each session's last <c>PreToolUse</c> (tool name,
/// command, path; in memory only) and puts it on the permission event; the card then shows the command and its risk.
/// That a permission prompt follows its tool's <c>PreToolUse</c> is UNVERIFIED (Claude Code does it in this order).
/// </remarks>
public sealed class DroidAdapter : IAgentAdapter
{
    /// <summary>More open sessions than this means stale entries (sessions that never ended): start over.</summary>
    private const int MaxRememberedSessions = 256;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, (string? Tool, string? Command, string? Path)> _lastTool = new(StringComparer.Ordinal);

    public string Id => AgentIds.Droid;

    public string DisplayName => "Factory Droid";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var e = AdapterMapping.Base(Id, envelope, Kind);
        if (e is null)
        {
            return null;
        }

        var p = envelope.Payload;
        e = e with
        {
            Message = AdapterMapping.Truncate(JsonFields.GetString(p, "message")),
            NotificationType = JsonFields.GetString(p, "notification_type"),
            Reason = JsonFields.GetString(p, "reason"),
        };
        return WithPermissionTool(e);
    }

    private HookEvent WithPermissionTool(HookEvent e)
    {
        lock (_gate)
        {
            switch (e.Kind)
            {
                case HookEventKind.PreToolUse:
                    if (_lastTool.Count >= MaxRememberedSessions && !_lastTool.ContainsKey(e.SessionId))
                    {
                        _lastTool.Clear();
                    }

                    _lastTool[e.SessionId] = (e.ToolName, e.ToolCommand, e.ToolPath);
                    return e;

                case HookEventKind.Notification
                    when NotificationClassifier.Classify(e.NotificationType, e.Message) == NotificationKind.Permission:
                    // A permission request: the state machine keeps the tool's command for the card and the risk.
                    var last = _lastTool.GetValueOrDefault(e.SessionId);
                    return e with
                    {
                        Kind = HookEventKind.PermissionRequest,
                        ToolName = e.ToolName ?? last.Tool,
                        ToolCommand = e.ToolCommand ?? last.Command,
                        ToolPath = e.ToolPath ?? last.Path,
                    };

                case HookEventKind.PostToolUse or HookEventKind.UserPromptSubmit or HookEventKind.Stop
                    or HookEventKind.SessionStart or HookEventKind.SessionEnd:
                    _lastTool.Remove(e.SessionId);
                    return e;

                default:
                    return e;
            }
        }
    }

    private static HookEventKind Kind(string name) => name switch
    {
        "SessionStart" => HookEventKind.SessionStart,
        "SessionEnd" => HookEventKind.SessionEnd,
        "UserPromptSubmit" => HookEventKind.UserPromptSubmit,
        "PreToolUse" => HookEventKind.PreToolUse,
        "PostToolUse" => HookEventKind.PostToolUse,
        "Notification" => HookEventKind.Notification,
        "Stop" => HookEventKind.Stop,
        "SubagentStop" => HookEventKind.SubagentStop,
        "PreCompact" => HookEventKind.PostCompact,
        _ => HookEventKind.Other,
    };
}
