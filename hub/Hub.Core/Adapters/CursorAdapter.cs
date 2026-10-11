using System.Text.Json;
using Hub.Core.Hooks;

namespace Hub.Core.Adapters;

/// <summary>
/// Cursor CLI hooks (cursor.com/docs/hooks, CLI 2026.10.01; docs/research/agents-droid-cursor.md §2.2). The session key is
/// <c>conversation_id</c> (<c>generation_id</c> is inconsistent in the CLI). Kotilo registers only observational events
/// (D-025): <c>sessionStart</c>, <c>sessionEnd</c>, <c>postToolUse</c>, <c>afterShellExecution</c>, <c>afterFileEdit</c>,
/// <c>stop</c>. Cursor has no hook for a waiting prompt; the desktop's screen rule reports it.
/// </summary>
/// <remarks>
/// The Windows CLI was reported to fire hooks twice (forum 157184). An event whose session, name and payload equal one seen
/// less than <see cref="DuplicateWindow"/> earlier maps to <see cref="HookEventKind.Other"/>: it still counts as activity but
/// moves no state. The state machine would absorb most repeats anyway (a transition needs a state change).
/// </remarks>
public sealed class CursorAdapter : IAgentAdapter
{
    public static readonly TimeSpan DuplicateWindow = TimeSpan.FromSeconds(2);

    private const int MaxRemembered = 512;

    private readonly Lock _gate = new();
    private readonly Dictionary<string, DateTimeOffset> _recent = new(StringComparer.Ordinal);

    public string Id => AgentIds.Cursor;

    public string DisplayName => "Cursor CLI";

    public HookEvent? Map(HookEnvelope envelope)
    {
        var p = envelope.Payload;
        var sessionId = JsonFields.GetString(p, "conversation_id") ?? JsonFields.GetString(p, "session_id");
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        var name = envelope.Event;
        var kind = IsDuplicate(sessionId, envelope) ? HookEventKind.Other : Kind(name, JsonFields.GetString(p, "status"));
        var toolInput = JsonFields.GetObject(p, "tool_input");
        var errorText = JsonFields.GetString(p, "error_message");
        var e = new HookEvent(sessionId, kind, name, envelope.ReceivedAt)
        {
            Agent = Id,
            PaneId = envelope.PaneId,
            WorkspaceId = envelope.WorkspaceId,
            TranscriptPath = JsonFields.GetString(p, "transcript_path"),
            Cwd = WindowsPath(JsonFields.GetString(p, "cwd") ?? FirstWorkspaceRoot(p)),
            Model = JsonFields.GetString(p, "model"),
            ToolName = JsonFields.GetString(p, "tool_name") ?? name switch
            {
                "afterShellExecution" => "Shell",
                "afterFileEdit" => "Edit",
                _ => null,
            },
            ToolCommand = Clip(
                (toolInput is { } ti ? JsonFields.GetString(ti, "command") : null) ?? JsonFields.GetString(p, "command"),
                AdapterMapping.MaxCommandLength),
            ToolPath = Clip(
                (toolInput is { } tp ? JsonFields.GetString(tp, "file_path") ?? JsonFields.GetString(tp, "path") : null)
                    ?? JsonFields.GetString(p, "file_path"),
                AdapterMapping.MaxCommandLength),
            Reason = JsonFields.GetString(p, "reason"),
            ErrorType = kind == HookEventKind.Error ? "api" : null,
            ErrorDetails = kind == HookEventKind.Error ? AdapterMapping.Truncate(errorText) : null,
            PromptLength = JsonFields.GetInt(p, "prompt_length"),
            ToolUseId = JsonFields.GetString(p, "tool_use_id"),
            ToolDurationMs = JsonFields.GetLong(p, "duration"),
            HookPid = envelope.HookPid,
            ParentPid = envelope.ParentPid,
            ProcessChain = envelope.ProcessChain,
        };
        return AdapterMapping.WithToolInput(e, toolInput);
    }

    /// <param name="status"><c>stop.status</c>: <c>completed</c> | <c>aborted</c> | <c>error</c>.</param>
    private static HookEventKind Kind(string name, string? status) => name switch
    {
        "sessionStart" => HookEventKind.SessionStart,
        "sessionEnd" => HookEventKind.SessionEnd,
        "stop" => status switch
        {
            "aborted" => HookEventKind.Interrupt,
            "error" => HookEventKind.Error,
            _ => HookEventKind.Stop,
        },
        "postToolUse" or "afterShellExecution" or "afterFileEdit" or "afterMCPExecution" => HookEventKind.PostToolUse,
        "postToolUseFailure" => HookEventKind.PostToolUseFailure,

        // Not registered by Kotilo (prompt-submit is a deciding hook; D-025), mapped in case a user adds them.
        "beforeSubmitPrompt" => HookEventKind.UserPromptSubmit,
        "preCompact" => HookEventKind.PostCompact,
        _ => HookEventKind.Other,
    };

    private bool IsDuplicate(string sessionId, HookEnvelope envelope)
    {
        var key = string.Concat(sessionId, "\n", envelope.Event, "\n", envelope.Payload.GetRawText());
        var at = envelope.ReceivedAt;
        lock (_gate)
        {
            if (_recent.Count >= MaxRemembered)
            {
                foreach (var old in _recent.Where(kv => (at - kv.Value).Duration() >= DuplicateWindow).Select(kv => kv.Key).ToList())
                {
                    _recent.Remove(old);
                }

                if (_recent.Count >= MaxRemembered)
                {
                    _recent.Clear();
                }
            }

            var duplicate = _recent.TryGetValue(key, out var seen) && (at - seen).Duration() < DuplicateWindow;
            _recent[key] = at;
            return duplicate;
        }
    }

    private static string? FirstWorkspaceRoot(JsonElement p) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty("workspace_roots", out var roots) && roots.ValueKind == JsonValueKind.Array
            ? roots.EnumerateArray().Where(r => r.ValueKind == JsonValueKind.String).Select(r => r.GetString()).FirstOrDefault()
            : null;

    /// <summary>
    /// <c>C:/Users/dev/src/demo</c> → <c>C:\Users\dev\src\demo</c>, so a Cursor session lands on the same project as other
    /// agents' sessions in that folder (Cursor's Windows path style is UNVERIFIED; both forms are accepted). Other paths stay.
    /// </summary>
    internal static string? WindowsPath(string? path) =>
        path is { Length: >= 3 } && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] is '/' or '\\'
            ? path.Replace('/', '\\')
            : path;

    private static string? Clip(string? s, int max) => s is null || s.Length <= max ? s : s[..max];
}
