using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hub.Core.Sessions;

/// <summary>Sub-type of <see cref="SessionState.Error"/> (spec §18.5).</summary>
public enum SessionErrorKind
{
    ApiError,
    UsageLimit,
    RateLimited,
    Overloaded,
    AuthError,
}

/// <param name="ResetsAt">When a usage limit opens again, if the message says so.</param>
public sealed record SessionError(SessionErrorKind Kind, DateTimeOffset? ResetsAt);

/// <summary>An API error found in a transcript line (fallback when no StopFailure hook arrived).</summary>
public sealed record TranscriptError(string SessionId, DateTimeOffset At, SessionError Error);

/// <summary>
/// All error-recognition patterns in one place (spec §18.5, decision D-080). The StopFailure hook's documented
/// <c>error</c> field is the primary source; transcript lines flagged <c>isApiErrorMessage</c> are the fallback.
/// Only lines Claude Code itself marks as API errors are considered, so a user typing "rate limit" never matches.
/// Message text is read to classify and is not kept.
/// </summary>
public static partial class ErrorClassifier
{
    private static readonly byte[] ApiErrorMarker = "\"isApiErrorMessage\""u8.ToArray();

    /// <summary>
    /// Maps the StopFailure <c>error</c> value. Returns null for values that are not an attention state
    /// (<c>max_output_tokens</c> just ends the turn).
    /// </summary>
    public static SessionError? FromStopFailure(string? error, string? details, DateTimeOffset at, TimeZoneInfo zone)
    {
        var resets = ParseResetsAt(details, at, zone);
        SessionErrorKind? kind = error switch
        {
            "rate_limit" => LooksLikeUsageLimit(details) || resets is not null ? SessionErrorKind.UsageLimit : SessionErrorKind.RateLimited,
            "overloaded" => SessionErrorKind.Overloaded,
            "authentication_failed" or "oauth_org_not_allowed" or "account_on_hold" or "cloud_credential_error" => SessionErrorKind.AuthError,
            "billing_error" => SessionErrorKind.UsageLimit,
            "max_output_tokens" => null,
            null or "" => details is null ? SessionErrorKind.ApiError : FromText(details),
            _ => SessionErrorKind.ApiError,
        };
        return kind is { } k ? new SessionError(k, k == SessionErrorKind.UsageLimit ? resets : null) : null;
    }

    /// <summary>Classifies a transcript line; null unless Claude Code flagged it as an API error.</summary>
    public static TranscriptError? FromTranscriptLine(ReadOnlySpan<byte> line, string? fallbackSessionId, TimeZoneInfo zone)
    {
        if (line.IndexOf(ApiErrorMarker) < 0)
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("isApiErrorMessage", out var flag) || flag.ValueKind != JsonValueKind.True
                || !root.TryGetProperty("timestamp", out var ts) || ts.ValueKind != JsonValueKind.String
                || !ts.TryGetDateTimeOffset(out var at))
            {
                return null;
            }

            var sessionId = root.TryGetProperty("sessionId", out var sid) && sid.ValueKind == JsonValueKind.String
                ? sid.GetString() : fallbackSessionId;
            if (string.IsNullOrEmpty(sessionId))
            {
                return null;
            }

            var text = MessageText(root);
            var errorType = root.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
            SessionError? error;
            if (errorType is not null)
            {
                error = FromStopFailure(errorType, text, at, zone);
            }
            else
            {
                var kind = FromText(text);
                error = new SessionError(kind, kind == SessionErrorKind.UsageLimit ? ParseResetsAt(text, at, zone) : null);
            }

            return error is null ? null : new TranscriptError(sessionId, at, error);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static SessionErrorKind FromText(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return SessionErrorKind.ApiError;
        }

        if (LooksLikeUsageLimit(text))
        {
            return SessionErrorKind.UsageLimit;
        }

        if (Contains(text, "rate limit") || Contains(text, "rate_limit") || Contains(text, "429"))
        {
            return SessionErrorKind.RateLimited;
        }

        if (Contains(text, "overloaded") || Contains(text, "529"))
        {
            return SessionErrorKind.Overloaded;
        }

        if (Contains(text, "authentication") || Contains(text, "oauth") || Contains(text, "/login")
            || Contains(text, "invalid api key") || Contains(text, "401"))
        {
            return SessionErrorKind.AuthError;
        }

        return SessionErrorKind.ApiError;
    }

    /// <summary>
    /// Reads a reset time from known usage-limit messages: the old "…limit reached|&lt;epoch&gt;" form and the
    /// "resets 7pm (Europe/Istanbul)" / "reset at 19:00" forms. A clock time without a date is the next occurrence
    /// after <paramref name="at"/> in the named zone (or <paramref name="zone"/>).
    /// </summary>
    public static DateTimeOffset? ParseResetsAt(string? text, DateTimeOffset at, TimeZoneInfo zone)
    {
        if (string.IsNullOrEmpty(text))
        {
            return null;
        }

        var epoch = EpochForm().Match(text);
        if (epoch.Success && long.TryParse(epoch.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds))
        {
            return DateTimeOffset.FromUnixTimeSeconds(seconds);
        }

        var m = ClockForm().Match(text);
        if (!m.Success)
        {
            return null;
        }

        var hour = int.Parse(m.Groups["h"].Value, CultureInfo.InvariantCulture);
        var minute = m.Groups["m"].Success ? int.Parse(m.Groups["m"].Value, CultureInfo.InvariantCulture) : 0;
        var ampm = m.Groups["ap"].Value.ToLowerInvariant();
        if (ampm == "pm" && hour < 12)
        {
            hour += 12;
        }
        else if (ampm == "am" && hour == 12)
        {
            hour = 0;
        }

        if (hour > 23 || minute > 59)
        {
            return null;
        }

        var tz = zone;
        if (m.Groups["tz"].Success)
        {
            try
            {
                tz = TimeZoneInfo.FindSystemTimeZoneById(m.Groups["tz"].Value);
            }
            catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
            {
            }
        }

        var local = TimeZoneInfo.ConvertTime(at, tz);
        var date = DateOnly.FromDateTime(local.DateTime);
        if (m.Groups["mon"].Success
            && DateTime.TryParseExact(m.Groups["mon"].Value + " " + m.Groups["d"].Value, "MMM d", CultureInfo.InvariantCulture, DateTimeStyles.None, out var md))
        {
            date = new DateOnly(local.Year, md.Month, md.Day);
            if (date < DateOnly.FromDateTime(local.DateTime).AddDays(-1))
            {
                date = date.AddYears(1);
            }
        }
        else if (new TimeOnly(hour, minute) <= TimeOnly.FromDateTime(local.DateTime))
        {
            date = date.AddDays(1);
        }

        var wall = date.ToDateTime(new TimeOnly(hour, minute));
        return new DateTimeOffset(wall, tz.GetUtcOffset(wall));
    }

    private static bool LooksLikeUsageLimit(string? text) =>
        text is not null
        && (Contains(text, "usage limit") || Contains(text, "limit reached") || Contains(text, "hit your")
            || Contains(text, "session limit") || Contains(text, "weekly limit") || Contains(text, "out of extra usage")
            || EpochForm().IsMatch(text));

    private static bool Contains(string text, string value) => text.Contains(value, StringComparison.OrdinalIgnoreCase);

    private static string? MessageText(JsonElement root)
    {
        if (!root.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object
            || !message.TryGetProperty("content", out var content))
        {
            return null;
        }

        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString();
        }

        if (content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (block.ValueKind == JsonValueKind.Object && block.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    return t.GetString();
                }
            }
        }

        return null;
    }

    [GeneratedRegex(@"limit reached\|(\d{9,11})", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EpochForm();

    [GeneratedRegex(
        @"reset(?:s)?(?:\s+at)?\s+(?:(?<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(?<d>\d{1,2}),?\s+(?:at\s+)?)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)?(?:\s*\((?<tz>[A-Za-z_]+(?:/[A-Za-z_\-+0-9]+)*)\))?",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ClockForm();
}
