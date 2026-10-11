namespace Hub.Core.Insights;

public enum HealthSeverity
{
    Info,
    Warning,
    Error,
}

public enum HealthCheck
{
    HooksSilent,
    HooksBroken,
    ParserMismatch,
    ClaudeUpdated,
    PortUnavailable,
    HotkeyUnavailable,
    DatabaseUnwritable,
}

/// <param name="Detail">Check-specific values for the message: percentages, versions, the hotkey text.</param>
public sealed record HealthIssue(HealthCheck Check, HealthSeverity Severity, IReadOnlyList<string> Detail);

public enum HookSetup
{
    Ok,
    Missing,
    WrongPath,
}

/// <summary>Hook setup of an agent other than Claude Code (only installed integrations are checked).</summary>
public sealed record AgentHookSetup(string Agent, HookSetup Setup);

/// <summary>Transcript line counts over a recent window (feeds the parser check).</summary>
public sealed record ParserStats(int Lines, int InvalidLines, int AssistantLines, int MalformedUsageLines)
{
    public static ParserStats Empty { get; } = new(0, 0, 0, 0);
}

/// <summary>Everything the health checks look at (spec §18.6). Gathered by the host every 30 s.</summary>
public sealed record HealthInputs(DateTimeOffset Now)
{
    public DateTimeOffset? LastHookAt { get; init; }

    /// <summary>Newest write to a non-Bip transcript.</summary>
    public DateTimeOffset? LastTranscriptWriteAt { get; init; }

    /// <summary>Claude Code's hooks (missing counts: Claude is the primary agent).</summary>
    public HookSetup HookInstall { get; init; } = HookSetup.Ok;

    /// <summary>Other hook-based agents whose installed entries are broken; detail is <c>[setup, agent]</c>.</summary>
    public IReadOnlyList<AgentHookSetup> AgentHooks { get; init; } = [];

    /// <summary>Last hour.</summary>
    public ParserStats Parser { get; init; } = ParserStats.Empty;

    public string? ClaudeVersion { get; init; }

    public string? PreviousClaudeVersion { get; init; }

    /// <summary>When <see cref="ClaudeVersion"/> was first seen to differ from <see cref="PreviousClaudeVersion"/>.</summary>
    public DateTimeOffset? VersionChangedAt { get; init; }

    public bool PortOk { get; init; } = true;

    /// <summary>Null when the hotkey is not in use.</summary>
    public string? FailedHotkey { get; init; }

    public bool DatabaseOk { get; init; } = true;
}

/// <summary>Pure health checks (spec §18.6). The host shows the worst issue as an InfoBar.</summary>
public static class HealthEvaluator
{
    public static readonly TimeSpan SilentWindow = TimeSpan.FromMinutes(3);

    /// <summary>A transcript write and its hook arrive close together; give the hook this long before suspecting it.</summary>
    public static readonly TimeSpan HookGrace = TimeSpan.FromSeconds(20);

    public static readonly TimeSpan VersionNoticeFor = TimeSpan.FromHours(24);

    /// <summary>Below this many lines an hour the parser rates are noise.</summary>
    public const int MinParserSample = 50;

    public const double ParserThreshold = 0.02;

    public static IReadOnlyList<HealthIssue> Evaluate(HealthInputs i)
    {
        var issues = new List<HealthIssue>();

        if (!i.DatabaseOk)
        {
            issues.Add(new(HealthCheck.DatabaseUnwritable, HealthSeverity.Error, []));
        }

        if (!i.PortOk)
        {
            issues.Add(new(HealthCheck.PortUnavailable, HealthSeverity.Error, []));
        }

        if (i.FailedHotkey is { } hotkey)
        {
            issues.Add(new(HealthCheck.HotkeyUnavailable, HealthSeverity.Error, [hotkey]));
        }

        if (i.HookInstall != HookSetup.Ok)
        {
            issues.Add(new(HealthCheck.HooksBroken, HealthSeverity.Error, [i.HookInstall.ToString()]));
        }
        else if (i.LastTranscriptWriteAt is { } write
                 && write >= i.Now - SilentWindow && write <= i.Now - HookGrace
                 && (i.LastHookAt is not { } hook || hook < i.Now - SilentWindow))
        {
            issues.Add(new(HealthCheck.HooksSilent, HealthSeverity.Warning, []));
        }

        foreach (var agent in i.AgentHooks.Where(a => a.Setup != HookSetup.Ok))
        {
            issues.Add(new(HealthCheck.HooksBroken, HealthSeverity.Error, [agent.Setup.ToString(), agent.Agent]));
        }

        var parser = ParserRates(i.Parser);
        var versionChanged = i.ClaudeVersion is not null && i.PreviousClaudeVersion is not null
            && i.ClaudeVersion != i.PreviousClaudeVersion
            && i.VersionChangedAt is { } changed && i.Now - changed < VersionNoticeFor;

        if (parser is { } rate)
        {
            // The design merges the two: "Claude Code güncellendi" + the unrecognized-line rate.
            issues.Add(new(HealthCheck.ParserMismatch, HealthSeverity.Warning,
                versionChanged ? [Percent(rate), i.PreviousClaudeVersion!, i.ClaudeVersion!] : [Percent(rate)]));
        }
        else if (versionChanged)
        {
            issues.Add(new(HealthCheck.ClaudeUpdated, HealthSeverity.Info, [i.PreviousClaudeVersion!, i.ClaudeVersion!]));
        }

        return issues.OrderByDescending(x => x.Severity).ThenBy(x => x.Check).ToList();
    }

    /// <summary>The worse of the unrecognized-line and missing-usage rates, when either exceeds 2 %.</summary>
    public static double? ParserRates(ParserStats s)
    {
        var invalid = s.Lines >= MinParserSample ? (double)s.InvalidLines / s.Lines : 0;
        var malformed = s.AssistantLines >= MinParserSample ? (double)s.MalformedUsageLines / s.AssistantLines : 0;
        var worst = Math.Max(invalid, malformed);
        return worst > ParserThreshold ? worst : null;
    }

    private static string Percent(double rate) => Math.Round(rate * 100).ToString(System.Globalization.CultureInfo.InvariantCulture);
}
