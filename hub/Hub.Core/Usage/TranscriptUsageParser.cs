using System.Security.Cryptography;
using System.Text.Json;

namespace Hub.Core.Usage;

public enum TranscriptLineKind
{
    /// <summary>A usage entry was extracted.</summary>
    Usage,

    /// <summary>Valid JSON without usage (user, system, attachment, ...).</summary>
    NoUsage,

    /// <summary>Not parseable JSON (corrupt, or a half-written last line).</summary>
    Invalid,

    /// <summary>An assistant line whose usage object lacks the required fields.</summary>
    MalformedUsage,
}

/// <summary>
/// Extracts token usage from one Claude Code transcript line (spec §7.2, decision D-010).
/// Rules follow the ccusage algorithm description in D-010; the implementation is independent.
/// </summary>
public static class TranscriptUsageParser
{
    private static readonly byte[] UsageMarker = "\"usage\""u8.ToArray();

    public static TranscriptLineKind TryParse(ReadOnlySpan<byte> line, string? fallbackSessionId, out UsageEntry? entry)
    {
        entry = null;
        line = line.Trim(" \t\r\n"u8);
        if (line.IsEmpty)
        {
            return TranscriptLineKind.NoUsage;
        }

        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(line.ToArray());
        }
        catch (JsonException)
        {
            return TranscriptLineKind.Invalid;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return TranscriptLineKind.Invalid;
            }

            // Cheap pre-filter, then the spec's type check.
            if (line.IndexOf(UsageMarker) < 0)
            {
                return TranscriptLineKind.NoUsage;
            }

            if (Str(root, "type") is { } type && type != "assistant")
            {
                return TranscriptLineKind.NoUsage;
            }

            if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object
                || !message.TryGetProperty("usage", out var usage) || usage.ValueKind != JsonValueKind.Object)
            {
                return TranscriptLineKind.NoUsage;
            }

            var input = Long(usage, "input_tokens");
            var output = Long(usage, "output_tokens");
            var timestamp = root.TryGetProperty("timestamp", out var ts) && ts.ValueKind == JsonValueKind.String
                && ts.TryGetDateTimeOffset(out var parsed) ? parsed : (DateTimeOffset?)null;
            if (input is null || output is null || timestamp is null)
            {
                return TranscriptLineKind.MalformedUsage;
            }

            long cache5m, cache1h;
            if (usage.TryGetProperty("cache_creation", out var cc) && cc.ValueKind == JsonValueKind.Object)
            {
                // The breakdown replaces cache_creation_input_tokens rather than adding to it.
                cache5m = Long(cc, "ephemeral_5m_input_tokens") ?? 0;
                cache1h = Long(cc, "ephemeral_1h_input_tokens") ?? 0;
            }
            else
            {
                cache5m = Long(usage, "cache_creation_input_tokens") ?? 0;
                cache1h = 0;
            }

            var sessionId = NonEmpty(Str(root, "sessionId")) ?? fallbackSessionId;
            var messageId = NonEmpty(Str(message, "id"));
            var requestId = NonEmpty(Str(root, "requestId"));

            entry = new UsageEntry(
                DedupKey(messageId, requestId, sessionId, timestamp.Value, line),
                timestamp.Value,
                input.Value,
                output.Value,
                cache5m,
                cache1h,
                Long(usage, "cache_read_input_tokens") ?? 0)
            {
                SessionId = sessionId,
                ProjectRoot = NonEmpty(Str(root, "cwd")),
                Model = NonEmpty(Str(message, "model")),
                IsSidechain = root.TryGetProperty("isSidechain", out var sc) && sc.ValueKind == JsonValueKind.True,
                IsFast = Str(usage, "speed") == "fast",
            };
            return TranscriptLineKind.Usage;
        }
    }

    /// <summary>Decision D-010 key table.</summary>
    public static string DedupKey(string? messageId, string? requestId, string? sessionId, DateTimeOffset timestamp, ReadOnlySpan<byte> line)
    {
        if (messageId is not null && requestId is not null)
        {
            return $"msg:{messageId}|req:{requestId}";
        }

        if (messageId is not null)
        {
            return $"msg:{messageId}|sid:{sessionId}|ts:{timestamp.ToUnixTimeMilliseconds()}";
        }

        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(line, hash);
        return "line:" + Convert.ToHexStringLower(hash[..16]);
    }

    /// <summary>
    /// "Larger wins" replacement rule for duplicates (D-010): a non-sidechain copy beats a sidechain one;
    /// with equal sidechain status a strictly larger total wins.
    /// </summary>
    public static bool ShouldReplace(UsageEntry existing, UsageEntry candidate) =>
        (existing.IsSidechain && !candidate.IsSidechain)
        || (existing.IsSidechain == candidate.IsSidechain && candidate.TotalTokens > existing.TotalTokens);

    private static string? Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long? Long(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var l) && l >= 0 ? l : null;

    private static string? NonEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;
}
