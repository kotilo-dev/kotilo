using System.Text.Json;

namespace Hub.Core.Buddy;

/// <summary>One meaningful line of <c>claude -p --output-format stream-json --verbose --include-partial-messages</c>.</summary>
public abstract record BuddyStreamEvent
{
    /// <summary><c>{"type":"system","subtype":"init",...}</c>: the Claude session id to resume and the resolved model.</summary>
    public sealed record Init(string SessionId, string? Model, int ToolCount) : BuddyStreamEvent;

    /// <summary>A streamed piece of answer text.</summary>
    public sealed record TextDelta(string Text) : BuddyStreamEvent;

    /// <summary>The complete text of one assistant message (only used when no deltas were streamed).</summary>
    public sealed record AssistantText(string Text) : BuddyStreamEvent;

    /// <summary>Final event: error flag, final text, token usage and cost.</summary>
    public sealed record Result(string? SessionId, bool IsError, string? Text, long InputTokens, long OutputTokens, decimal? CostUsd)
        : BuddyStreamEvent;
}

/// <summary>
/// Tolerant parser for Claude Code's stream-json output (schema measured on CLI 2.1.286, decision D-070). Unknown event
/// types, thinking blocks and malformed lines are ignored (null).
/// </summary>
public static class ClaudeCliStreamParser
{
    public static BuddyStreamEvent? ParseLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line) || line[0] != '{')
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            return Str(root, "type") switch
            {
                "system" when Str(root, "subtype") == "init" && Str(root, "session_id") is { } id =>
                    new BuddyStreamEvent.Init(
                        id,
                        Str(root, "model"),
                        root.TryGetProperty("tools", out var tools) && tools.ValueKind == JsonValueKind.Array ? tools.GetArrayLength() : 0),
                "stream_event" => Delta(root),
                "assistant" => Assistant(root),
                "result" => Result(root),
                _ => null,
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static BuddyStreamEvent.TextDelta? Delta(JsonElement root)
    {
        if (!root.TryGetProperty("event", out var ev) || Str(ev, "type") != "content_block_delta"
            || !ev.TryGetProperty("delta", out var delta) || Str(delta, "type") != "text_delta")
        {
            return null;
        }

        return Str(delta, "text") is { Length: > 0 } text ? new BuddyStreamEvent.TextDelta(text) : null;
    }

    private static BuddyStreamEvent.AssistantText? Assistant(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var message)
            || !message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var text = string.Concat(content.EnumerateArray()
            .Where(b => Str(b, "type") == "text")
            .Select(b => Str(b, "text") ?? ""));
        return text.Length > 0 ? new BuddyStreamEvent.AssistantText(text) : null;
    }

    private static BuddyStreamEvent.Result Result(JsonElement root)
    {
        long input = 0, output = 0;
        if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
        {
            input = Long(usage, "input_tokens") + Long(usage, "cache_creation_input_tokens") + Long(usage, "cache_read_input_tokens");
            output = Long(usage, "output_tokens");
        }

        decimal? cost = root.TryGetProperty("total_cost_usd", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetDecimal() : null;
        var isError = root.TryGetProperty("is_error", out var e) && e.ValueKind == JsonValueKind.True;
        return new BuddyStreamEvent.Result(Str(root, "session_id"), isError, Str(root, "result"), input, output, cost);
    }

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long Long(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}

/// <summary>
/// Builds the visible answer from parser events: deltas append; a complete assistant message is used only if no delta
/// arrived for it (older CLIs or partial messages off). An error result replaces nothing already shown.
/// </summary>
public sealed class BuddyResponseAssembler
{
    private readonly System.Text.StringBuilder _text = new();
    private bool _sawDelta;

    public string Text => _text.ToString();

    public string? SessionId { get; private set; }

    public string? Model { get; private set; }

    public BuddyStreamEvent.Result? Result { get; private set; }

    /// <returns>True when the visible text changed.</returns>
    public bool Apply(BuddyStreamEvent e)
    {
        switch (e)
        {
            case BuddyStreamEvent.Init init:
                SessionId = init.SessionId;
                Model = init.Model;
                return false;
            case BuddyStreamEvent.TextDelta d:
                _sawDelta = true;
                _text.Append(d.Text);
                return true;
            case BuddyStreamEvent.AssistantText a when !_sawDelta:
                if (_text.Length > 0)
                {
                    _text.Append("\n\n");
                }

                _text.Append(a.Text);
                return true;
            case BuddyStreamEvent.Result r:
                Result = r;
                SessionId ??= r.SessionId;
                if (_text.Length == 0 && !r.IsError && !string.IsNullOrEmpty(r.Text))
                {
                    _text.Append(r.Text);
                    return true;
                }

                return false;
            default:
                return false;
        }
    }
}
