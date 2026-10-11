using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// Gemini CLI hooks (google-gemini/gemini-cli 0.62, <c>packages/core/src/hooks/types.ts</c>; docs/research/agents-gemini-qwen.md §1).
/// BeforeAgent starts a turn, BeforeTool / AfterTool are tool activity, AfterAgent ends the turn and a
/// <c>ToolPermission</c> Notification is the permission prompt (command / file path from its <c>details</c>).
/// Gemini sends nothing when a permission is denied and has no error event: every following BeforeAgent / BeforeTool /
/// AfterTool / AfterAgent moves the session out of WaitingPermission; until one comes the card stays (known gap).
/// The prompt, <c>prompt_response</c> and file content in <c>details</c> are removed by agenthub-hook (AGENTS.md rule 5).
/// </summary>
public sealed class GeminiAdapter : IAgentAdapter
{
    /// <summary>The only Notification type Gemini sends (<c>NotificationType.ToolPermission</c>).</summary>
    public const string ToolPermission = "ToolPermission";

    public string Id => AgentIds.Gemini;

    public string DisplayName => "Gemini CLI";

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

        if (e.Kind != HookEventKind.Notification)
        {
            return e;
        }

        if (e.NotificationType != ToolPermission)
        {
            return e with { Kind = HookEventKind.Other };
        }

        // details: exec {command, rootCommand} | edit {fileName, filePath, …} | mcp {serverName, toolName} | info {urls}.
        var details = JsonFields.GetObject(p, "details");
        var command = details is { } d1 ? JsonFields.GetString(d1, "command") : null;
        return e with
        {
            Kind = HookEventKind.PermissionRequest,
            ToolName = details is { } d2 ? JsonFields.GetString(d2, "toolName") : null,
            ToolCommand = command is { Length: > AdapterMapping.MaxCommandLength } ? command[..AdapterMapping.MaxCommandLength] : command,
            ToolPath = details is { } d3 ? JsonFields.GetString(d3, "filePath") ?? JsonFields.GetString(d3, "fileName") : null,
        };
    }

    private static HookEventKind Kind(string name) => name switch
    {
        "SessionStart" => HookEventKind.SessionStart,
        "SessionEnd" => HookEventKind.SessionEnd,
        "BeforeAgent" => HookEventKind.UserPromptSubmit,
        "BeforeTool" => HookEventKind.PreToolUse,
        "AfterTool" => HookEventKind.PostToolUse,
        "AfterAgent" => HookEventKind.Stop,
        "Notification" => HookEventKind.Notification,
        _ => HookEventKind.Other,
    };
}
