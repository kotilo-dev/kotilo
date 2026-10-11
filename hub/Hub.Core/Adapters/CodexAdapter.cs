using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// Codex CLI hooks (openai/codex 0.160, <c>hooks/schema/generated</c>). Codex has no "waiting for input" hook: Stop
/// ends the turn (idle until the next prompt) and Interrupt is a cancelled turn. <c>last_assistant_message</c> on Stop
/// and the prompt text are never read beyond the prompt's length (AGENTS.md rule 5).
/// </summary>
public sealed class CodexAdapter : IAgentAdapter
{
    public string Id => AgentIds.Codex;

    public string DisplayName => "Codex CLI";

    public HookEvent? Map(HookEnvelope envelope) => AdapterMapping.Base(Id, envelope, Kind);

    private static HookEventKind Kind(string name) => name switch
    {
        "SessionStart" => HookEventKind.SessionStart,
        "SessionEnd" => HookEventKind.SessionEnd,
        "UserPromptSubmit" => HookEventKind.UserPromptSubmit,
        "PreToolUse" => HookEventKind.PreToolUse,
        "PostToolUse" => HookEventKind.PostToolUse,
        "PermissionRequest" => HookEventKind.PermissionRequest,
        "Stop" => HookEventKind.Stop,
        "Interrupt" => HookEventKind.Interrupt,
        "PostCompact" => HookEventKind.PostCompact,
        "SubagentStart" => HookEventKind.SubagentStart,
        "SubagentStop" => HookEventKind.SubagentStop,
        _ => HookEventKind.Other,
    };
}
