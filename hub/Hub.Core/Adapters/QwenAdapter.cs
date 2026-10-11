using System.Text.Json;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// Qwen Code hooks (QwenLM/qwen-code 0.25, Claude Code compatible names; docs/research/agents-gemini-qwen.md §2).
/// UserPromptSubmit also fires for tool-result continuations: only a payload the hook marked <c>has_submitted_prompt</c>
/// starts a turn, any other one is plain <see cref="HookEventKind.Working"/>. Notification <c>permission_prompt</c> /
/// <c>idle_prompt</c> are classified like Claude's; Stop carries the context fill (<c>context_usage</c>, a ratio), and
/// StopFailure the error kind. PermissionRequest is never registered (Qwen awaits it and acts on its output), but maps
/// like Claude's if it arrives. Prompt, <c>last_assistant_message</c>, tool output and cron prompts are removed by
/// agenthub-hook (AGENTS.md rule 5).
/// </summary>
public sealed class QwenAdapter : IAgentAdapter
{
    public string Id => AgentIds.Qwen;

    public string DisplayName => "Qwen Code";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var p = envelope.Payload;
        var e = AdapterMapping.Base(Id, envelope, name => Kind(name, p));
        if (e is null)
        {
            return null;
        }

        return e with
        {
            Message = AdapterMapping.Truncate(JsonFields.GetString(p, "message")),
            NotificationType = JsonFields.GetString(p, "notification_type"),
            Reason = JsonFields.GetString(p, "reason"),
            ErrorType = e.Kind == HookEventKind.StopFailure ? JsonFields.GetString(p, "error") : null,
            ErrorDetails = e.Kind == HookEventKind.StopFailure ? AdapterMapping.Truncate(JsonFields.GetString(p, "error_details")) : null,
            ContextPercent = e.Kind == HookEventKind.Stop ? ContextPercent(p) : null,
        };
    }

    /// <summary>
    /// <c>context_usage</c> is the used share of the window (may exceed 1); without it, <c>input_tokens / context_limit</c>.
    /// Clamped to 0..100; null when the payload has neither.
    /// </summary>
    internal static double? ContextPercent(JsonElement p)
    {
        var ratio = JsonFields.GetDouble(p, "context_usage");
        if (ratio is null && JsonFields.GetLong(p, "context_limit") is { } limit && limit > 0 && JsonFields.GetLong(p, "input_tokens") is { } input)
        {
            ratio = (double)input / limit;
        }

        return ratio is { } r && r >= 0 && double.IsFinite(r) ? Math.Min(100, r * 100) : null;
    }

    private static HookEventKind Kind(string name, JsonElement p) => name switch
    {
        "SessionStart" => HookEventKind.SessionStart,
        "SessionEnd" => HookEventKind.SessionEnd,
        "UserPromptSubmit" => IsSubmit(p) ? HookEventKind.UserPromptSubmit : HookEventKind.Working,
        "PreToolUse" => HookEventKind.PreToolUse,
        "PostToolUse" => HookEventKind.PostToolUse,
        "PostToolUseFailure" => HookEventKind.PostToolUseFailure,
        "PermissionRequest" => HookEventKind.PermissionRequest,
        "Notification" => HookEventKind.Notification,
        "Stop" => HookEventKind.Stop,
        "StopFailure" => HookEventKind.StopFailure,
        "SubagentStart" => HookEventKind.SubagentStart,
        "SubagentStop" => HookEventKind.SubagentStop,
        _ => HookEventKind.Other,
    };

    /// <summary>agenthub-hook turns Qwen's <c>submitted_prompt</c> (set only for real user submissions) into this flag.</summary>
    private static bool IsSubmit(JsonElement p) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty("has_submitted_prompt", out var v) && v.ValueKind == JsonValueKind.True;
}
