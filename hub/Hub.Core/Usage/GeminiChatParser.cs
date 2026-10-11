using System.Globalization;
using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Hooks;

namespace Hub.Core.Usage;

/// <summary>What a Gemini chat file has said so far that later lines depend on.</summary>
public sealed class GeminiChatState
{
    public string? SessionId { get; set; }

    /// <summary>Project folder of the chat (from <c>tmp/&lt;slug&gt;/.project_root</c>); the scanner sets it.</summary>
    public string? ProjectRoot { get; set; }

    /// <summary>Header <c>kind: "subagent"</c>: the usage is a subagent's.</summary>
    public bool Subagent { get; set; }

    public string Agent { get; set; } = AgentIds.Gemini;
}

/// <summary>
/// Gemini CLI chat recordings (gemini-cli 0.62 <c>chatRecordingTypes.ts</c>; docs/research/agents-gemini-qwen.md §1.5):
/// <c>~/.gemini/tmp/&lt;slug&gt;/chats/session-*.jsonl</c>, append-only. The first line is the header
/// <c>{sessionId, projectHash, startTime, kind}</c>; message lines are <c>{id, timestamp, type, …}</c>, and a <c>gemini</c>
/// message gets <c>model</c> and <c>tokens {input, output, cached, thoughts, tool, total}</c>. A message is re-appended with
/// the same id once its tokens arrive, so the dedup key is the message id (the usage table keeps the larger row).
/// Rewound messages still count: their tokens were spent. Older installs wrote one JSON document per session
/// (<c>{sessionId, kind, messages: […]}</c>); <see cref="ParseDocument"/> reads those. Only ids, times, the model and
/// token counts are read; content, thoughts and tool calls never are.
/// </summary>
public static class GeminiChatParser
{
    /// <summary>Byte markers that let a scanner skip lines without parsing them.</summary>
    public static ReadOnlySpan<byte> TokensMarker => "\"tokens\""u8;

    public static ReadOnlySpan<byte> HeaderMarker => "\"projectHash\""u8;

    /// <summary>Updates <paramref name="state"/> from a header line; returns usage for a <c>gemini</c> message with tokens.</summary>
    public static UsageEntry? ParseLine(ReadOnlySpan<byte> line, GeminiChatState state)
    {
        var header = line.IndexOf(HeaderMarker) >= 0;
        if (!header && line.IndexOf(TokensMarker) < 0)
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (header && JsonFields.GetString(root, "type") is null)
            {
                ReadHeader(root, state);
                return null;
            }

            return FromMessage(root, state);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A legacy single-document chat file (<c>session-*.json</c>): header fields plus a <c>messages</c> array.</summary>
    public static IReadOnlyList<UsageEntry> ParseDocument(ReadOnlySpan<byte> json, GeminiChatState state)
    {
        try
        {
            using var doc = JsonDocument.Parse(json.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return [];
            }

            ReadHeader(root, state);
            if (!root.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var entries = new Dictionary<string, UsageEntry>(StringComparer.Ordinal);
            foreach (var message in messages.EnumerateArray())
            {
                if (message.ValueKind == JsonValueKind.Object && FromMessage(message, state) is { } entry)
                {
                    entries[entry.DedupKey] = entry;
                }
            }

            return entries.Values.ToList();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static void ReadHeader(JsonElement root, GeminiChatState state)
    {
        state.SessionId = JsonFields.GetString(root, "sessionId") ?? state.SessionId;
        state.Subagent = JsonFields.GetString(root, "kind") == "subagent";
    }

    /// <summary>
    /// Gemini API semantics: <c>input</c> (promptTokenCount) includes <c>cached</c>, <c>thoughts</c> are billed as output and
    /// <c>tool</c> (toolUsePromptTokenCount) is extra prompt input. Stored: input without the cache, output plus thoughts,
    /// cached as cache read.
    /// </summary>
    private static UsageEntry? FromMessage(JsonElement m, GeminiChatState state)
    {
        if (JsonFields.GetString(m, "type") != "gemini"
            || JsonFields.GetObject(m, "tokens") is not { } tokens
            || JsonFields.GetString(m, "id") is not { Length: > 0 } id
            || JsonFields.GetDate(m, "timestamp") is not { } at
            || state.SessionId is null)
        {
            return null;
        }

        var input = Math.Max(0, JsonFields.GetLong(tokens, "input") ?? 0);
        var cached = Math.Max(0, JsonFields.GetLong(tokens, "cached") ?? 0);
        var output = Math.Max(0, JsonFields.GetLong(tokens, "output") ?? 0) + Math.Max(0, JsonFields.GetLong(tokens, "thoughts") ?? 0);
        var tool = Math.Max(0, JsonFields.GetLong(tokens, "tool") ?? 0);
        var fresh = Math.Max(0, input - cached) + tool;
        if (fresh + output + cached == 0)
        {
            return null;
        }

        return new UsageEntry(
            string.Create(CultureInfo.InvariantCulture, $"{state.Agent}:{state.SessionId}:{id}"),
            at,
            Input: fresh,
            Output: output,
            CacheCreate5m: 0,
            CacheCreate1h: 0,
            CacheRead: cached)
        {
            Agent = state.Agent,
            SessionId = state.SessionId,
            ProjectRoot = state.ProjectRoot,
            Model = JsonFields.GetString(m, "model"),
            IsSidechain = state.Subagent,
        };
    }
}
