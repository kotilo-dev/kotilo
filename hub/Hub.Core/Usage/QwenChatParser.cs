using System.Globalization;
using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Hooks;

namespace Hub.Core.Usage;

/// <summary>
/// Qwen Code chat recordings (qwen-code 0.25 <c>chatRecordingService.ts</c>; docs/research/agents-gemini-qwen.md §2.5):
/// <c>~/.qwen/projects/&lt;sanitized cwd&gt;/chats/&lt;sessionId&gt;.jsonl</c>, append-only <c>ChatRecord</c> lines. Usage comes only
/// from <c>assistant</c> records' <c>usageMetadata</c> (one per API response); <c>system</c> / <c>ui_telemetry</c> records
/// replay the same numbers and are ignored. Every record carries <c>sessionId</c> and <c>cwd</c>, so lines are independent.
/// Only ids, times, cwd, the model and token counts are read, never <c>message</c>.
/// </summary>
public static class QwenChatParser
{
    /// <summary>Byte marker that lets a scanner skip lines without parsing them.</summary>
    public static ReadOnlySpan<byte> UsageMarker => "\"usageMetadata\""u8;

    /// <param name="fallbackSessionId">The file name's session id, for a record without <c>sessionId</c>.</param>
    /// <param name="agent">Adapter id stamped on the entry.</param>
    public static UsageEntry? ParseLine(ReadOnlySpan<byte> line, string? fallbackSessionId, string agent = AgentIds.Qwen)
    {
        if (line.IndexOf(UsageMarker) < 0)
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object
                || JsonFields.GetString(r, "type") != "assistant"
                || JsonFields.GetObject(r, "usageMetadata") is not { } usage
                || JsonFields.GetString(r, "uuid") is not { Length: > 0 } uuid
                || JsonFields.GetDate(r, "timestamp") is not { } at
                || (JsonFields.GetString(r, "sessionId") ?? fallbackSessionId) is not { Length: > 0 } sessionId)
            {
                return null;
            }

            // GenAI semantics (also what Qwen's OpenAI converter produces): promptTokenCount includes the cached part,
            // thoughts are billed as output.
            var prompt = Math.Max(0, JsonFields.GetLong(usage, "promptTokenCount") ?? 0);
            var cached = Math.Max(0, JsonFields.GetLong(usage, "cachedContentTokenCount") ?? 0);
            var output = Math.Max(0, JsonFields.GetLong(usage, "candidatesTokenCount") ?? 0)
                + Math.Max(0, JsonFields.GetLong(usage, "thoughtsTokenCount") ?? 0);
            var input = Math.Max(0, prompt - cached);
            if (input + output + cached == 0)
            {
                return null;
            }

            return new UsageEntry(
                string.Create(CultureInfo.InvariantCulture, $"{agent}:{sessionId}:{uuid}"),
                at,
                Input: input,
                Output: output,
                CacheCreate5m: 0,
                CacheCreate1h: 0,
                CacheRead: cached)
            {
                Agent = agent,
                SessionId = sessionId,
                ProjectRoot = JsonFields.GetString(r, "cwd"),
                Model = JsonFields.GetString(r, "model"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
