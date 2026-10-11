using System.Globalization;
using Hub.Core.Notifications;
using Hub.Core.Projects;
using Hub.Core.Sessions;

namespace Hub.Service.Api;

/// <summary>
/// <c>notification</c> stream message. The hub's rules decide; the desktop app shows the toast (single owner) and may
/// suppress it when the agent's pane is visible. <c>title</c>/<c>body</c> are ready to show in the hub's language;
/// the structured fields let a client format its own text.
/// </summary>
public sealed record NotificationDto(
    string RuleId,
    string? Agent,
    string? SessionId,
    string? PaneId,
    string? ProjectName,
    string? ProjectRoot,
    string? State,
    string Title,
    string Body,
    NotificationSeverity Severity,
    DateTimeOffset At);

public enum NotificationSeverity
{
    Info,
    Warning,
    Attention,
}

/// <summary>Formats rule results as <see cref="NotificationDto"/>s (DESIGN_SYSTEM §7.11: "&lt;project&gt;: &lt;state&gt;", no emoji).</summary>
public static class NotificationFeed
{
    public static NotificationDto From(NotificationRequest r, SessionInfo? session, string language)
    {
        var tr = IsTurkish(language);
        var (state, severity) = r.RuleId switch
        {
            RuleIds.WaitingPermission => (tr ? "İzin bekliyor" : "Needs permission", NotificationSeverity.Attention),
            RuleIds.WaitingInput => (tr ? "Cevap bekliyor" : "Waiting for input", NotificationSeverity.Attention),
            RuleIds.WaitingReminder => (tr ? "Hâlâ bekliyor" : "Still waiting", NotificationSeverity.Attention),
            RuleIds.Error => (tr ? "Hata" : "Error", NotificationSeverity.Attention),
            RuleIds.Completed => (tr ? "Bitti" : "Done", NotificationSeverity.Info),
            RuleIds.UnseenReminder => (tr ? "Bakmadığın bitmiş iş var" : "Finished work waiting for you", NotificationSeverity.Info),
            RuleIds.Stale => (tr ? "Sessiz" : "Silent", NotificationSeverity.Warning),
            RuleIds.ContextHigh => ("Context", NotificationSeverity.Warning),
            _ => (r.RuleId, NotificationSeverity.Info),
        };

        var body = r.RuleId switch
        {
            RuleIds.WaitingPermission or RuleIds.WaitingInput => r.Message ?? session?.CurrentTool ?? "",
            RuleIds.WaitingReminder => r.Duration is { } w ? (tr ? $"{Duration(w, tr)} oldu" : $"for {Duration(w, tr)}") : "",
            RuleIds.Completed => r.Duration is { } d ? (tr ? $"Tur {Duration(d, tr)} sürdü" : $"Turn took {Duration(d, tr)}") : "",
            RuleIds.UnseenReminder => r.Duration is { } u ? (tr ? $"{Duration(u, tr)} önce bitti" : $"Finished {Duration(u, tr)} ago") : "",
            RuleIds.Stale => r.Duration is { } s ? (tr ? $"{Duration(s, tr)} hareket yok" : $"No activity for {Duration(s, tr)}") : "",
            RuleIds.ContextHigh => r.ContextPercent is { } p ? (tr ? $"Context %{p:0} dolu" : $"Context {p:0}% full") : "",
            RuleIds.Error => ErrorText(r.Error, tr),
            _ => r.Message ?? "",
        };

        return new NotificationDto(
            r.RuleId, session?.Agent, r.SessionId, session?.PaneId, r.ProjectName, r.ProjectRoot, r.State.ToString(),
            $"{r.ProjectName}: {state}", body, severity, r.At);
    }

    public static NotificationDto From(TodoCompletion c, DateTimeOffset at, string language)
    {
        var tr = IsTurkish(language);
        return new NotificationDto(
            RuleIds.TodoCompleted, null, null, null, c.ProjectName, c.ProjectRoot, null,
            tr ? $"{c.ProjectName}: Todo tamamlandı" : $"{c.ProjectName}: Todo complete",
            tr ? $"{c.RelativePath} ({c.Total}/{c.Total})" : $"{c.RelativePath} ({c.Total}/{c.Total})",
            NotificationSeverity.Info, at);
    }

    public static NotificationDto From(UsageNotification n, string language)
    {
        var tr = IsTurkish(language);
        var inv = CultureInfo.InvariantCulture;
        var body = n.RuleId switch
        {
            UsageRuleEngine.BlockThreshold => tr
                ? $"Aktif blok {Tokens(n.Tokens)} token (eşik {Tokens(n.ThresholdTokens)})"
                : $"Active block at {Tokens(n.Tokens)} tokens (threshold {Tokens(n.ThresholdTokens)})",
            UsageRuleEngine.DailyCost => tr
                ? $"Bugün ${n.CostUsd?.ToString("0.00", inv)} (eşik ${n.ThresholdUsd?.ToString("0.00", inv)})"
                : $"Today ${n.CostUsd?.ToString("0.00", inv)} (threshold ${n.ThresholdUsd?.ToString("0.00", inv)})",
            UsageRuleEngine.BurnProjection => n.TimeToThreshold is { } t
                ? (tr ? $"Bu hızla eşiğe {Duration(t, tr)} içinde varılır" : $"At this rate the threshold is reached in {Duration(t, tr)}")
                : "",
            _ => "",
        };
        return new NotificationDto(
            n.RuleId, null, null, null, null, null, null, tr ? "Kullanım" : "Usage", body, NotificationSeverity.Warning, n.At);
    }

    public static bool IsTurkish(string language) => language.StartsWith("tr", StringComparison.OrdinalIgnoreCase);

    /// <summary>DESIGN_SYSTEM §10 style: <c>2m 14s</c>, <c>1h 5m</c>.</summary>
    public static string Duration(TimeSpan t, bool tr)
    {
        var (h, m, s) = (tr ? "sa" : "h", tr ? "dk" : "m", tr ? "sn" : "s");
        var sep = tr ? " " : "";
        if (t.TotalHours >= 1)
        {
            return $"{(int)t.TotalHours}{sep}{h} {t.Minutes}{sep}{m}";
        }

        return t.TotalMinutes >= 1 ? $"{t.Minutes}{sep}{m} {t.Seconds}{sep}{s}" : $"{Math.Max(0, t.Seconds)}{sep}{s}";
    }

    private static string Tokens(long? n) => n is { } v ? v.ToString("N0", CultureInfo.InvariantCulture) : "?";

    private static string ErrorText(SessionError? e, bool tr)
    {
        if (e is null)
        {
            return "";
        }

        var kind = e.Kind switch
        {
            SessionErrorKind.UsageLimit => tr ? "Kullanım limiti doldu" : "Usage limit reached",
            SessionErrorKind.RateLimited => tr ? "Hız limiti" : "Rate limited",
            SessionErrorKind.Overloaded => tr ? "Servis yoğun" : "Service overloaded",
            SessionErrorKind.AuthError => tr ? "Oturum açma hatası" : "Authentication error",
            _ => tr ? "API hatası" : "API error",
        };
        return e.ResetsAt is { } at
            ? kind + (tr ? $" · {at.ToLocalTime():HH:mm} sıfırlanır" : $" · resets {at.ToLocalTime():HH:mm}")
            : kind;
    }
}
