using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Hooks;

namespace Hub.Core.Usage;

/// <summary>Running token totals of one Droid session (<c>tokenUsage</c> in <c>&lt;id&gt;.settings.json</c>).</summary>
/// <param name="Thinking">
/// Kept for the delta bookkeeping only: whether <c>outputTokens</c> already includes it is UNVERIFIED, and counting it twice
/// would overstate cost, so it is not added to <see cref="UsageEntry.Output"/>.
/// </param>
public sealed record DroidTokenTotals(long Input, long Output, long CacheCreation, long CacheRead, long Thinking)
{
    /// <summary>The <c>tokenUsage</c> field names, in the order of <see cref="ToArray"/>.</summary>
    public static readonly IReadOnlyList<string> FieldNames = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "thinkingTokens"];

    public long Sum => Input + Output + CacheCreation + CacheRead + Thinking;

    public long[] ToArray() => [Input, Output, CacheCreation, CacheRead, Thinking];

    public static DroidTokenTotals FromArray(IReadOnlyList<long> v) => new(v[0], v[1], v[2], v[3], v[4]);
}

/// <summary>
/// Factory Droid token usage (docs/research/agents-droid-cursor.md §1.4; layout from third-party parsers verified against
/// Droid 0.174): <c>~/.factory/sessions/&lt;project-key&gt;/&lt;id&gt;.settings.json</c> holds <c>model</c> and
/// <c>tokenUsage</c> as running totals, rewritten after each successful turn. One usage entry is the difference to the
/// totals seen last time. The sibling <c>&lt;id&gt;.jsonl</c> starts with a <c>session_start</c> record whose <c>cwd</c> is the
/// project (the Windows project-key folder naming is UNVERIFIED, so it is never decoded). Only these fields are read.
/// </summary>
public static class DroidSessionUsage
{
    public const string SettingsSuffix = ".settings.json";

    public const string DedupPrefix = "droid:";

    /// <summary><c>model</c> and <c>tokenUsage</c>, or null when the file has no usable <c>tokenUsage</c>.</summary>
    public static (string? Model, DroidTokenTotals Totals)? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (JsonFields.GetObject(root, "tokenUsage") is not { } usage)
            {
                return null;
            }

            var values = DroidTokenTotals.FieldNames.Select(f => Math.Max(0, JsonFields.GetLong(usage, f) ?? 0)).ToArray();
            return (JsonFields.GetString(root, "model"), DroidTokenTotals.FromArray(values));
        }
        catch (JsonException)
        {
            // Caught mid-rewrite or damaged: the next change reads it again.
            return null;
        }
    }

    /// <summary>
    /// What was added since <paramref name="previous"/>; null when nothing was. A total that went down means the counters
    /// were reset (a new file under the same name), so everything in <paramref name="current"/> is new.
    /// </summary>
    public static DroidTokenTotals? Delta(DroidTokenTotals? previous, DroidTokenTotals current)
    {
        if (previous is null)
        {
            return current.Sum > 0 ? current : null;
        }

        var p = previous.ToArray();
        var c = current.ToArray();
        if (c.Where((v, i) => v < p[i]).Any())
        {
            return current.Sum > 0 ? current : null;
        }

        var delta = DroidTokenTotals.FromArray(c.Select((v, i) => v - p[i]).ToArray());
        return delta.Sum > 0 ? delta : null;
    }

    /// <summary>
    /// One entry for <paramref name="delta"/>. The dedup key carries the running total it ends at, so re-reading the same
    /// file state (after a crash before the totals were saved) writes the same row again.
    /// </summary>
    public static UsageEntry Entry(string sessionId, string? model, DroidTokenTotals delta, DroidTokenTotals current, DateTimeOffset at, string? projectRoot) =>
        new($"{DedupPrefix}{sessionId}:{current.Sum}", at, delta.Input, delta.Output, delta.CacheCreation, 0, delta.CacheRead)
        {
            Agent = AgentIds.Droid,
            SessionId = sessionId,
            Model = model,
            ProjectRoot = projectRoot,
        };

    /// <summary><c>…\7f3c….settings.json</c> → <c>7f3c…</c>; null for any other file name.</summary>
    public static string? SessionIdFromFileName(string path)
    {
        var name = path[(path.LastIndexOfAny(['\\', '/']) + 1)..];
        return name.EndsWith(SettingsSuffix, StringComparison.OrdinalIgnoreCase) && name.Length > SettingsSuffix.Length
            ? name[..^SettingsSuffix.Length]
            : null;
    }

    /// <summary>The <c>cwd</c> of a <c>{"type":"session_start",…}</c> line; null for anything else. Nothing else is read.</summary>
    public static string? CwdFromSessionStart(string firstLine)
    {
        try
        {
            using var doc = JsonDocument.Parse(firstLine);
            return JsonFields.GetString(doc.RootElement, "type") == "session_start" ? JsonFields.GetString(doc.RootElement, "cwd") : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
