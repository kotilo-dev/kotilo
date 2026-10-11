using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Hooks;

namespace Hub.Core.Usage;

/// <summary>What a Codex rollout file has said so far that later lines depend on.</summary>
public sealed class CodexRolloutState
{
    public string? SessionId { get; set; }

    public string? Cwd { get; set; }

    public string? Model { get; set; }

    /// <summary>Adapter id stamped on entries and limits; the usage source sets it.</summary>
    public string Agent { get; set; } = AgentIds.Codex;
}

/// <summary>
/// Codex CLI rollout lines (<c>$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl</c>, openai/codex 0.160): each line is
/// <c>{timestamp, type, payload}</c>. Only metadata is read: <c>session_meta</c> (id, cwd), <c>turn_context</c> (model)
/// and <c>event_msg</c> <c>token_count</c> (token usage, plan rate limits). Message content is never touched.
/// </summary>
public static class CodexRolloutParser
{
    /// <summary>Byte markers that let a scanner skip lines without parsing them.</summary>
    public static ReadOnlySpan<byte> MetaMarker => "\"session_meta\""u8;

    public static ReadOnlySpan<byte> TurnContextMarker => "\"turn_context\""u8;

    public static ReadOnlySpan<byte> TokenCountMarker => "\"token_count\""u8;

    /// <summary>Updates <paramref name="state"/> from one line; returns usage and limits when it is a token_count line.</summary>
    public static (UsageEntry? Usage, PlanLimits? Limits) ParseLine(ReadOnlySpan<byte> line, CodexRolloutState state)
    {
        if (line.IndexOf(MetaMarker) < 0 && line.IndexOf(TurnContextMarker) < 0 && line.IndexOf(TokenCountMarker) < 0)
        {
            return (null, null);
        }

        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            var payload = JsonFields.GetObject(root, "payload");
            if (payload is not { } p)
            {
                return (null, null);
            }

            switch (JsonFields.GetString(root, "type"))
            {
                case "session_meta":
                    // Newer files carry session_id; older ones only id (the reader in Codex falls back the same way).
                    state.SessionId = JsonFields.GetString(p, "session_id") ?? JsonFields.GetString(p, "id") ?? state.SessionId;
                    state.Cwd = JsonFields.GetString(p, "cwd") ?? state.Cwd;
                    return (null, null);

                case "turn_context":
                    state.Model = JsonFields.GetString(p, "model") ?? state.Model;
                    state.Cwd ??= JsonFields.GetString(p, "cwd");
                    return (null, null);

                case "event_msg" when JsonFields.GetString(p, "type") == "token_count":
                    var at = JsonFields.GetDate(root, "timestamp");
                    if (at is null)
                    {
                        return (null, null);
                    }

                    return (Usage(p, at.Value, state), Limits(p, at.Value, state.Agent));

                default:
                    return (null, null);
            }
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    /// <summary>
    /// <c>last_token_usage</c> is this response's usage. The dedup key is the session's cumulative total, so a repeated
    /// token_count (Codex re-emits it when only rate limits change) never counts twice.
    /// </summary>
    private static UsageEntry? Usage(JsonElement payload, DateTimeOffset at, CodexRolloutState state)
    {
        if (JsonFields.GetObject(payload, "info") is not { } info
            || JsonFields.GetObject(info, "last_token_usage") is not { } last
            || state.SessionId is null)
        {
            return null;
        }

        var total = JsonFields.GetObject(info, "total_token_usage") is { } t ? JsonFields.GetLong(t, "total_tokens") : null;
        var input = JsonFields.GetLong(last, "input_tokens") ?? 0;
        var cached = JsonFields.GetLong(last, "cached_input_tokens") ?? 0;
        var output = JsonFields.GetLong(last, "output_tokens") ?? 0;
        if (input + output == 0)
        {
            return null;
        }

        // OpenAI's input_tokens includes the cached part; reasoning tokens are part of output_tokens.
        return new UsageEntry(
            $"codex:{state.SessionId}:{total?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? at.ToUnixTimeMilliseconds().ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            at,
            Input: Math.Max(0, input - cached),
            Output: output,
            CacheCreate5m: 0,
            CacheCreate1h: 0,
            CacheRead: cached)
        {
            Agent = state.Agent,
            SessionId = state.SessionId,
            ProjectRoot = state.Cwd,
            Model = state.Model,
        };
    }

    /// <summary>Plan windows by length: 300 minutes is the 5-hour window, 10080 the weekly one; others are ignored.</summary>
    private static PlanLimits? Limits(JsonElement payload, DateTimeOffset at, string agent)
    {
        if (JsonFields.GetObject(payload, "rate_limits") is not { } limits)
        {
            return null;
        }

        LimitWindow? fiveHour = null, weekly = null;
        foreach (var name in (string[])["primary", "secondary"])
        {
            if (JsonFields.GetObject(limits, name) is not { } w || Window(w, at) is not { } window)
            {
                continue;
            }

            switch (JsonFields.GetLong(w, "window_minutes"))
            {
                case 300:
                    fiveHour = window;
                    break;
                case 10080:
                    weekly = window;
                    break;
                default:
                    break;
            }
        }

        var parsed = new PlanLimits(at) { Agent = agent, FiveHour = fiveHour, SevenDay = weekly };
        return parsed.IsEmpty ? null : parsed;
    }

    /// <summary><c>resets_at</c> is Unix seconds; older rollouts may have <c>resets_in_seconds</c> relative to the line.</summary>
    private static LimitWindow? Window(JsonElement w, DateTimeOffset at)
    {
        if (JsonFields.GetDouble(w, "used_percent") is not { } used)
        {
            return null;
        }

        try
        {
            if (JsonFields.GetLong(w, "resets_at") is { } epoch)
            {
                return new LimitWindow(Math.Max(0, used), DateTimeOffset.FromUnixTimeSeconds(epoch));
            }

            if (JsonFields.GetLong(w, "resets_in_seconds") is { } inSeconds)
            {
                return new LimitWindow(Math.Max(0, used), at.AddSeconds(inSeconds));
            }
        }
        catch (ArgumentOutOfRangeException)
        {
        }

        return null;
    }
}
