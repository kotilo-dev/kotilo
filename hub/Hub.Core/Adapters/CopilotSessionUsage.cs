using System.Text.Json;
using Hub.Core.Hooks;
using Hub.Core.Usage;

namespace Hub.Core.Adapters;

/// <summary>
/// Token usage of one Copilot CLI session from <c>~/.copilot/session-state/&lt;id&gt;/events.jsonl</c> (1.0.91,
/// <c>copilot-sdk/generated/session-events.d.ts</c>). Per-call usage (<c>assistant.usage</c>) is ephemeral and never written,
/// so the only durable figures are the per-model totals of <c>session.shutdown</c> (a clean <c>/exit</c>). Read lines:
/// <c>session.start</c> / <c>session.resume</c> / <c>session.context_changed</c> (session id, cwd) and <c>session.shutdown</c>;
/// message content is never parsed.
/// </summary>
/// <remarks>
/// Assumptions (UNVERIFIED until a real session is checked): <c>inputTokens</c> includes cache reads (OpenAI convention,
/// like Codex) and <c>outputTokens</c> includes reasoning; after a resume, the next shutdown repeats the session's running
/// totals (the SDK's <c>session.usage_checkpoint</c> exists to rebuild them), so each later shutdown counts only what grew.
/// A shutdown with smaller totals is taken as a fresh count. Copilot bills premium requests, not tokens: entries carry no
/// USD cost (<see cref="UsageEntry.CostReported"/> with a null cost, so the price table never assigns API prices).
/// </remarks>
public static class CopilotSessionUsage
{
    /// <summary>Lines worth parsing contain one of these.</summary>
    public static ReadOnlySpan<byte> ShutdownMarker => "\"session.shutdown\""u8;

    private static ReadOnlySpan<byte> StartMarker => "\"session.start\""u8;

    private static ReadOnlySpan<byte> ResumeMarker => "\"session.resume\""u8;

    private static ReadOnlySpan<byte> ContextMarker => "\"session.context_changed\""u8;

    /// <summary>Running state while a file is read line by line.</summary>
    public sealed class State
    {
        public string? SessionId { get; set; }

        public string? Cwd { get; set; }

        /// <summary>Totals of the previous shutdown, per model.</summary>
        public Dictionary<string, Totals> Previous { get; } = new(StringComparer.Ordinal);
    }

    public readonly record struct Totals(long Input, long Output, long CacheRead, long CacheWrite)
    {
        public bool CoversAll(Totals earlier) =>
            Input >= earlier.Input && Output >= earlier.Output && CacheRead >= earlier.CacheRead && CacheWrite >= earlier.CacheWrite;

        public Totals Minus(Totals earlier) =>
            new(Input - earlier.Input, Output - earlier.Output, CacheRead - earlier.CacheRead, CacheWrite - earlier.CacheWrite);

        public bool IsZero => Input == 0 && Output == 0 && CacheRead == 0 && CacheWrite == 0;
    }

    /// <summary>Usage entries from one line (only <c>session.shutdown</c> yields any); other lines update <paramref name="state"/>.</summary>
    public static IReadOnlyList<UsageEntry> ParseLine(ReadOnlySpan<byte> line, State state)
    {
        var shutdown = line.IndexOf(ShutdownMarker) >= 0;
        if (!shutdown && line.IndexOf(StartMarker) < 0 && line.IndexOf(ResumeMarker) < 0 && line.IndexOf(ContextMarker) < 0)
        {
            return [];
        }

        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (JsonFields.GetObject(root, "data") is not { } data)
            {
                return [];
            }

            switch (JsonFields.GetString(root, "type"))
            {
                case "session.start":
                case "session.resume":
                    state.SessionId = JsonFields.GetString(data, "sessionId") ?? state.SessionId;
                    state.Cwd = (JsonFields.GetObject(data, "context") is { } ctx ? JsonFields.GetString(ctx, "cwd") : null) ?? state.Cwd;
                    return [];

                case "session.context_changed":
                    state.Cwd = JsonFields.GetString(data, "cwd")
                        ?? (JsonFields.GetObject(data, "context") is { } changed ? JsonFields.GetString(changed, "cwd") : null)
                        ?? state.Cwd;
                    return [];

                case "session.shutdown":
                    return Shutdown(root, data, state);

                default:
                    return [];
            }
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static List<UsageEntry> Shutdown(JsonElement root, JsonElement data, State state)
    {
        var entries = new List<UsageEntry>();
        if (state.SessionId is not { } sessionId || JsonFields.GetObject(data, "modelMetrics") is not { } metrics
            || JsonFields.GetDate(root, "timestamp") is not { } at)
        {
            return entries;
        }

        var eventId = JsonFields.GetString(root, "id") ?? at.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        foreach (var model in metrics.EnumerateObject())
        {
            if (model.Value.ValueKind != JsonValueKind.Object || JsonFields.GetObject(model.Value, "usage") is not { } usage)
            {
                continue;
            }

            var totals = new Totals(
                Math.Max(0, JsonFields.GetLong(usage, "inputTokens") ?? 0),
                Math.Max(0, JsonFields.GetLong(usage, "outputTokens") ?? 0),
                Math.Max(0, JsonFields.GetLong(usage, "cacheReadTokens") ?? 0),
                Math.Max(0, JsonFields.GetLong(usage, "cacheWriteTokens") ?? 0));
            var delta = state.Previous.TryGetValue(model.Name, out var earlier) && totals.CoversAll(earlier) ? totals.Minus(earlier) : totals;
            state.Previous[model.Name] = totals;
            if (delta.IsZero)
            {
                continue;
            }

            entries.Add(new UsageEntry(
                $"{AgentIds.Copilot}:{sessionId}:{eventId}:{model.Name}",
                at,
                Input: Math.Max(0, delta.Input - delta.CacheRead),
                Output: delta.Output,
                CacheCreate5m: delta.CacheWrite,
                CacheCreate1h: 0,
                CacheRead: delta.CacheRead)
            {
                Agent = AgentIds.Copilot,
                SessionId = sessionId,
                ProjectRoot = state.Cwd,
                Model = model.Name,
                CostUsd = null,
                CostReported = true,
            });
        }

        return entries;
    }
}
