using System.Globalization;
using System.Text;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Usage;

internal static class UsageTestData
{
    public static readonly DateTimeOffset T0 = new(2026, 9, 30, 18, 0, 0, TimeSpan.Zero);

    /// <summary>A transcript assistant line shaped like Claude Code 2.1.x output, with content removed.</summary>
    public static string AssistantLine(
        string messageId = "msg_1",
        string? requestId = "req_1",
        DateTimeOffset? at = null,
        long input = 10,
        long output = 20,
        long cacheCreate = 300,
        long cacheRead = 4000,
        long? cache5m = null,
        long? cache1h = null,
        string model = "claude-opus-5-5",
        bool sidechain = false,
        string speed = "standard",
        string sessionId = "s1",
        string cwd = @"C:\\src\\alpha")
    {
        var ts = (at ?? T0).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        var breakdown = cache5m is null && cache1h is null
            ? ""
            : $$""","cache_creation":{"ephemeral_5m_input_tokens":{{cache5m ?? 0}},"ephemeral_1h_input_tokens":{{cache1h ?? 0}}}""";
        var req = requestId is null ? "" : $$""","requestId":"{{requestId}}" """;
        return $$$$"""{"parentUuid":"p","isSidechain":{{{{(sidechain ? "true" : "false")}}}},"type":"assistant","uuid":"u","timestamp":"{{{{ts}}}}","sessionId":"{{{{sessionId}}}}","cwd":"{{{{cwd}}}}","version":"2.1.286"{{{{req}}}},"message":{"id":"{{{{messageId}}}}","type":"message","role":"assistant","model":"{{{{model}}}}","content":[{"type":"text","text":"<redacted>"}],"usage":{"input_tokens":{{{{input}}}},"output_tokens":{{{{output}}}},"cache_creation_input_tokens":{{{{cacheCreate}}}},"cache_read_input_tokens":{{{{cacheRead}}}},"speed":"{{{{speed}}}}","future_field":{"x":1}{{{{breakdown}}}}}}}""";
    }

    public static UsageEntry? Parse(string line, out TranscriptLineKind kind)
    {
        kind = TranscriptUsageParser.TryParse(Encoding.UTF8.GetBytes(line), "fallback", out var entry);
        return entry;
    }

    /// <summary>Entry with only output tokens set, for block / aggregation math.</summary>
    public static UsageEntry Entry(DateTimeOffset at, long tokens, decimal? cost = 1m, string session = "s1", string project = "p", string model = "claude-opus-5-5") =>
        new($"k-{at.UtcTicks}-{session}-{tokens}", at, 0, tokens, 0, 0, 0)
        {
            SessionId = session,
            ProjectRoot = project,
            Model = model,
            CostUsd = cost,
        };
}
