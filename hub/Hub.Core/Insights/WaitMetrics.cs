using System.Text.RegularExpressions;
using Hub.Core.Notifications;
using Hub.Core.Sessions;

namespace Hub.Core.Insights;

/// <summary>One recorded state transition, as stored in <c>session_transitions</c>.</summary>
public sealed record StateTransition(string SessionId, SessionState To, DateTimeOffset At, string? Detail);

public enum WaitKind
{
    Permission,
    Input,
}

/// <summary>A span during which a session waited for the user (spec §18.1).</summary>
/// <param name="Tool">For permission waits, the tool being asked about when known.</param>
/// <param name="IsOpen">Still waiting at <c>now</c>.</param>
public sealed record WaitSpan(string SessionId, string ProjectRoot, WaitKind Kind, DateTimeOffset Start, DateTimeOffset End, string? Tool, bool IsOpen)
{
    public TimeSpan Duration => End - Start;
}

/// <summary>Per-day totals for the stacked bar chart.</summary>
public sealed record WaitDay(DateOnly Date, TimeSpan Permission, TimeSpan Input)
{
    public TimeSpan Total => Permission + Input;
}

/// <summary>Wait metrics for one local-time range.</summary>
public sealed record WaitMetrics
{
    public TimeSpan Total { get; init; }

    /// <summary>Waits that started in the range.</summary>
    public int Count { get; init; }

    public TimeSpan Average { get; init; }

    public TimeSpan Median { get; init; }

    public WaitSpan? Longest { get; init; }

    public TimeSpan PermissionTotal { get; init; }

    public TimeSpan InputTotal { get; init; }

    /// <summary>Most frequent tool among permission waits; null when none is known.</summary>
    public string? TopPermissionTool { get; init; }

    /// <summary>Part of <see cref="Total"/> that fell in quiet hours (counted, but flagged; spec §18.1).</summary>
    public TimeSpan DuringQuietHours { get; init; }

    /// <summary>Wait time per local hour of day, index 0..23.</summary>
    public IReadOnlyList<TimeSpan> ByHour { get; init; } = [];

    /// <summary>Per project root, largest first.</summary>
    public IReadOnlyList<KeyValuePair<string, TimeSpan>> ByProject { get; init; } = [];

    public IReadOnlyList<WaitDay> ByDay { get; init; } = [];
}

/// <summary>
/// Turns state transitions into wait spans and aggregates them (spec §18.1). Pure; computed on request, never stored.
/// A wait starts on entering WaitingPermission / WaitingInput and ends on the next transition to any other state;
/// Ended / Stale close it like any other state. Switching directly between the two waiting states closes one wait and
/// opens the other. An idle prompt (Claude's "waiting for your input" a minute after a finished turn) only counts when the
/// user came back to it: idle waits that end with the session closing, going stale, or are still open are an abandoned
/// session, not time Claude was blocked on the user (decision D-081).
/// </summary>
public static partial class WaitMetricsCalculator
{
    public static IReadOnlyList<WaitSpan> Spans(
        IEnumerable<StateTransition> transitions, Func<string, string> projectOf, DateTimeOffset now)
    {
        var spans = new List<WaitSpan>();
        foreach (var session in transitions.GroupBy(t => t.SessionId, StringComparer.Ordinal))
        {
            (WaitKind Kind, DateTimeOffset Start, string? Tool, bool Idle)? open = null;
            foreach (var t in session.OrderBy(t => t.At))
            {
                if (open is { } o)
                {
                    if (!o.Idle || t.To is SessionState.Working or SessionState.WaitingPermission or SessionState.WaitingInput)
                    {
                        spans.Add(new WaitSpan(session.Key, projectOf(session.Key), o.Kind, o.Start, t.At, o.Tool, false));
                    }

                    open = null;
                }

                if (t.To is SessionState.WaitingPermission)
                {
                    open = (WaitKind.Permission, t.At, ToolFrom(t.Detail), false);
                }
                else if (t.To is SessionState.WaitingInput)
                {
                    open = (WaitKind.Input, t.At, null, IsIdlePrompt(t.Detail));
                }
            }

            if (open is { Idle: false } last && last.Start < now)
            {
                spans.Add(new WaitSpan(session.Key, projectOf(session.Key), last.Kind, last.Start, now, last.Tool, true));
            }
        }

        return spans;
    }

    /// <summary>Aggregates spans clipped to the local-time range [<paramref name="from"/>, <paramref name="to"/>).</summary>
    public static WaitMetrics Calculate(
        IReadOnlyList<WaitSpan> spans, DateTimeOffset from, DateTimeOffset to, TimeZoneInfo zone, QuietHours? quietHours = null)
    {
        var byHour = new TimeSpan[24];
        var byProject = new Dictionary<string, TimeSpan>(StringComparer.OrdinalIgnoreCase);
        var byDay = new SortedDictionary<DateOnly, (TimeSpan Perm, TimeSpan Input)>();
        TimeSpan total = TimeSpan.Zero, perm = TimeSpan.Zero, input = TimeSpan.Zero, quiet = TimeSpan.Zero;

        for (var day = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(from, zone).DateTime);
             StartOfDay(day, zone) < to;
             day = day.AddDays(1))
        {
            byDay[day] = (TimeSpan.Zero, TimeSpan.Zero);
        }

        foreach (var span in spans)
        {
            var start = span.Start > from ? span.Start : from;
            var end = span.End < to ? span.End : to;
            if (end <= start)
            {
                continue;
            }

            // Walk the clipped span in pieces that never cross a local hour boundary.
            for (var cursor = start; cursor < end;)
            {
                var local = TimeZoneInfo.ConvertTime(cursor, zone);
                var hourStart = new DateTimeOffset(local.Year, local.Month, local.Day, local.Hour, 0, 0, local.Offset);
                var next = hourStart.AddHours(1);
                if (next > end)
                {
                    next = end;
                }

                var piece = next - cursor;
                byHour[local.Hour] += piece;
                var date = DateOnly.FromDateTime(local.DateTime);
                var d = byDay.GetValueOrDefault(date);
                byDay[date] = span.Kind == WaitKind.Permission ? (d.Perm + piece, d.Input) : (d.Perm, d.Input + piece);
                if (quietHours is { Enabled: true } q)
                {
                    quiet += QuietOverlap(local, piece, q);
                }

                cursor = next;
            }

            var length = end - start;
            total += length;
            if (span.Kind == WaitKind.Permission)
            {
                perm += length;
            }
            else
            {
                input += length;
            }

            byProject[span.ProjectRoot] = byProject.GetValueOrDefault(span.ProjectRoot) + length;
        }

        var started = spans.Where(s => s.Start >= from && s.Start < to).ToList();
        var durations = started.Select(s => s.Duration).Order().ToList();
        return new WaitMetrics
        {
            Total = total,
            Count = started.Count,
            Average = durations.Count == 0 ? TimeSpan.Zero : TimeSpan.FromTicks((long)durations.Average(d => d.Ticks)),
            Median = Median(durations),
            Longest = started.MaxBy(s => s.Duration),
            PermissionTotal = perm,
            InputTotal = input,
            TopPermissionTool = started
                .Where(s => s.Kind == WaitKind.Permission && s.Tool is not null)
                .GroupBy(s => s.Tool!, StringComparer.Ordinal)
                .OrderByDescending(g => g.Count())
                .ThenBy(g => g.Key, StringComparer.Ordinal)
                .Select(g => g.Key)
                .FirstOrDefault(),
            DuringQuietHours = quiet,
            ByHour = byHour,
            ByProject = byProject.OrderByDescending(p => p.Value).ToList(),
            ByDay = byDay.Select(p => new WaitDay(p.Key, p.Value.Perm, p.Value.Input)).ToList(),
        };
    }

    public static DateTimeOffset StartOfDay(DateOnly day, TimeZoneInfo zone)
    {
        var wall = day.ToDateTime(TimeOnly.MinValue);
        return new DateTimeOffset(wall, zone.GetUtcOffset(wall));
    }

    /// <summary>
    /// PermissionRequest stores the bare tool name; a permission Notification stores Claude's message, e.g.
    /// "Claude needs your permission to use Bash".
    /// </summary>
    internal static string? ToolFrom(string? detail)
    {
        if (string.IsNullOrWhiteSpace(detail))
        {
            return null;
        }

        if (!detail.Contains(' ', StringComparison.Ordinal))
        {
            return detail;
        }

        var m = PermissionMessage().Match(detail);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>Claude Code's idle notification text ("Claude is waiting for your input").</summary>
    internal static bool IsIdlePrompt(string? detail) =>
        detail is not null && detail.Contains("waiting for your input", StringComparison.OrdinalIgnoreCase);

    private static TimeSpan QuietOverlap(DateTimeOffset localStart, TimeSpan piece, QuietHours q)
    {
        // Quiet hours have minute resolution; a piece is at most one hour, so minute steps are cheap.
        var overlap = TimeSpan.Zero;
        for (var t = TimeSpan.Zero; t < piece; t += TimeSpan.FromMinutes(1))
        {
            var step = piece - t < TimeSpan.FromMinutes(1) ? piece - t : TimeSpan.FromMinutes(1);
            if (q.Contains(TimeOnly.FromDateTime((localStart + t).DateTime)))
            {
                overlap += step;
            }
        }

        return overlap;
    }

    private static TimeSpan Median(List<TimeSpan> sorted) =>
        sorted.Count == 0 ? TimeSpan.Zero
        : sorted.Count % 2 == 1 ? sorted[sorted.Count / 2]
        : TimeSpan.FromTicks((sorted[(sorted.Count / 2) - 1].Ticks + sorted[sorted.Count / 2].Ticks) / 2);

    [GeneratedRegex(@"permission to use ([A-Za-z0-9_:\-]+)", RegexOptions.CultureInvariant)]
    private static partial Regex PermissionMessage();
}
