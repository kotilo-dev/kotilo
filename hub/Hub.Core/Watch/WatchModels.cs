using System.Text.Json.Serialization;

namespace Hub.Core.Watch;

/// <summary>
/// A watch rule (docs: watch rules). Fields of one rule must all match; a list matches when any item does. A rule needs at
/// least one match field. Rules never block anything: a match only shows a label, a timeline mark and a notification.
/// </summary>
public sealed record WatchRule(
    string Id,
    string Name,
    bool Enabled = true,
    bool Notify = true,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Tools = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Command = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Paths = null);

/// <summary>
/// A rule that matched a tool call. <see cref="Name"/> of a built-in rule is its English fallback. <see cref="Notify"/> is
/// bookkeeping for the notification and is not part of the wire shape. In memory only (AGENTS.md rule 5).
/// </summary>
public sealed record WatchHit(string Id, string Name)
{
    public bool Notify { get; init; } = true;
}

/// <summary><c>settings.watch</c>. Old settings files without it load as these defaults.</summary>
public sealed record WatchSettings
{
    public bool Enabled { get; init; } = true;

    /// <summary>Built-in rule ids switched off.</summary>
    public IReadOnlyList<string> DisabledBuiltins { get; init; } = [];

    /// <summary>Built-in rule ids whose notification the user turned off (label and mark only).</summary>
    public IReadOnlyList<string> NotifyOffBuiltins { get; init; } = [];

    /// <summary>User rules, ids <c>user.&lt;slug&gt;</c>.</summary>
    public IReadOnlyList<WatchRule> Rules { get; init; } = [];

    /// <summary>Project roots whose <c>.kotilo/watch.json</c> is used.</summary>
    public IReadOnlyList<string> TrustedProjects { get; init; } = [];

    /// <summary>Replaces nulls a hand-edited or foreign file may carry with empty lists.</summary>
    public WatchSettings Normalized() => this with
    {
        DisabledBuiltins = DisabledBuiltins ?? [],
        NotifyOffBuiltins = NotifyOffBuiltins ?? [],
        Rules = (Rules ?? []).Where(r => r is not null).ToList(),
        TrustedProjects = TrustedProjects ?? [],
    };
}

/// <summary>What a rule looks at: one tool call. In memory only.</summary>
public sealed record WatchInput(string? Tool, string? Command, string? Path, IReadOnlyList<string>? Paths, string? Root);

/// <summary>A problem with a rule (<paramref name="RuleId"/>) or a project file (<paramref name="Line"/> when the JSON parser gave one).</summary>
public sealed record WatchProblem(string? RuleId, string Message, int? Line = null);

/// <summary>The rules found in one project's <c>.kotilo/watch.json</c>, already validated; <paramref name="Problems"/> lists what was skipped.</summary>
public sealed record ProjectWatchFile(string Root, IReadOnlyList<WatchRule> Rules, IReadOnlyList<WatchProblem> Problems);

/// <summary>Limits for rules from files and the settings API.</summary>
public static class WatchLimits
{
    public const int MaxFileBytes = 64 * 1024;
    public const int MaxProjectRules = 50;
    public const int MaxUserRules = 100;
    public const int MaxRegexLength = 500;
    public const int MaxNameLength = 60;
    public const int MaxListItems = 20;
    public const int MaxItemLength = 200;
    public const int MaxIdLength = 64;

    /// <summary>Per-rule regex time limit; a rule that exceeds it is disabled for the session.</summary>
    public static readonly TimeSpan RegexTimeout = TimeSpan.FromMilliseconds(50);
}
