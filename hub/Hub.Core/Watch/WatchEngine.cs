using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Hub.Core.Watch;

/// <summary>One project that has a <c>.kotilo/watch.json</c>, for <c>GET /v1/watch</c>.</summary>
public sealed record WatchProjectInfo(string Root, bool Trusted, int RuleCount, IReadOnlyList<WatchProblem> Problems);

/// <summary>Effective rules and problems (<c>GET /v1/watch</c>).</summary>
public sealed record WatchOverview(
    IReadOnlyList<WatchRule> Builtins, IReadOnlyList<WatchRule> User, IReadOnlyList<WatchProjectInfo> Projects, IReadOnlyList<WatchProblem> Problems);

/// <summary>
/// Matches tool calls against the layered watch rules: built-ins, the user's rules, and the rules of a trusted project's
/// file. Thread-safe (the pipeline evaluates; the API describes and tests). Nothing it sees is stored or logged: a rule
/// that exceeds the regex time limit is disabled for that session and only its id is reported through
/// <see cref="RuleTimedOut"/> (<see cref="RegexMatchTimeoutException"/> carries the input, so it is caught here).
/// </summary>
public sealed class WatchEngine
{
    private const int MaxDisabled = 1000;

    private readonly TimeSpan _timeout;
    private readonly ConcurrentDictionary<(string Session, string Rule), byte> _disabled = new();
    private readonly Lock _gate = new();
    private volatile BaseState _base = null!;
    private volatile ProjectState _projects = new(new Dictionary<string, ProjectEntry>());

    private readonly IReadOnlyList<CompiledWatchRule> _extra;

    public WatchEngine(TimeSpan? regexTimeout = null)
        : this(regexTimeout, [])
    {
    }

    /// <summary>Test seam: <paramref name="extra"/> rules run after the configured ones (e.g. one that times out).</summary>
    internal WatchEngine(TimeSpan? regexTimeout, IReadOnlyList<CompiledWatchRule> extra)
    {
        _extra = extra;
        _timeout = regexTimeout ?? WatchLimits.RegexTimeout;
        Configure(new WatchSettings());
    }

    /// <summary>Raised with a rule id when that rule timed out (once per session).</summary>
    public event Action<string>? RuleTimedOut;

    public WatchSettings Settings => _base.Settings;

    /// <summary>Applies new settings: recompiles built-ins and user rules; invalid user rules are skipped and reported.</summary>
    public void Configure(WatchSettings settings)
    {
        settings = settings.Normalized();
        var rules = new List<CompiledWatchRule>();
        var problems = new List<WatchProblem>();
        var disabled = settings.DisabledBuiltins.ToHashSet(StringComparer.Ordinal);
        var notifyOff = settings.NotifyOffBuiltins.ToHashSet(StringComparer.Ordinal);

        foreach (var b in WatchBuiltins.All)
        {
            if (!disabled.Contains(b.Id))
            {
                var notify = b.Notify && !notifyOff.Contains(b.Id);
                rules.Add(new CompiledWatchRule(b.Id, b.Name, notify, b.Matches));
            }
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rule in settings.Rules)
        {
            var errors = WatchRuleCompiler.Compile(rule, UserIdPrefix, _timeout, out var compiled);
            if (errors.Count > 0)
            {
                problems.Add(new WatchProblem(rule.Id, string.Join("; ", errors.Select(e => $"{e.Field}: {e.Message}"))));
            }
            else if (!seen.Add(rule.Id))
            {
                problems.Add(new WatchProblem(rule.Id, "Duplicate rule id."));
            }
            else if (rule.Enabled)
            {
                rules.Add(compiled!);
            }
        }

        rules.AddRange(_extra);

        lock (_gate)
        {
            _base = new BaseState(settings, rules, problems, settings.TrustedProjects.Select(RootKey).ToHashSet(StringComparer.Ordinal));
        }
    }

    public const string UserIdPrefix = "user.";

    /// <summary>Replaces the known project files (trusted or not); only trusted projects' rules are applied.</summary>
    public void SetProjectFiles(IReadOnlyList<ProjectWatchFile> files)
    {
        var entries = new Dictionary<string, ProjectEntry>(StringComparer.Ordinal);
        foreach (var file in files)
        {
            var compiled = new List<CompiledWatchRule>();
            var problems = file.Problems.ToList();
            foreach (var rule in file.Rules)
            {
                var errors = WatchRuleCompiler.Compile(rule, WatchProjectFileParser.ProjectIdPrefix, _timeout, out var c);
                if (errors.Count > 0)
                {
                    problems.Add(new WatchProblem(rule.Id, string.Join("; ", errors.Select(e => $"{e.Field}: {e.Message}"))));
                }
                else if (rule.Enabled)
                {
                    compiled.Add(c!);
                }
            }

            entries[RootKey(file.Root)] = new ProjectEntry(file.Root, compiled, problems, file.Rules.Count);
        }

        lock (_gate)
        {
            _projects = new ProjectState(entries);
        }
    }

    /// <summary>Rules that match <paramref name="input"/>, in layer order. <paramref name="sessionKey"/>: null for a one-off test.</summary>
    public IReadOnlyList<WatchHit> Evaluate(WatchInput input, string? sessionKey)
    {
        var state = _base;
        if (!state.Settings.Enabled)
        {
            return [];
        }

        var hits = new List<WatchHit>();
        foreach (var rule in state.Rules)
        {
            Try(rule, input, sessionKey, hits);
        }

        if (!string.IsNullOrEmpty(input.Root))
        {
            var key = RootKey(input.Root);
            if (state.Trusted.Contains(key) && _projects.Entries.TryGetValue(key, out var entry))
            {
                foreach (var rule in entry.Rules)
                {
                    Try(rule, input, sessionKey, hits);
                }
            }
        }

        return hits;
    }

    /// <summary>The first hit with a notification, else the first hit: the one an event, card and timeline row carry.</summary>
    public static WatchHit? Primary(IReadOnlyList<WatchHit> hits)
    {
        foreach (var hit in hits)
        {
            if (hit.Notify)
            {
                return hit;
            }
        }

        return hits.Count > 0 ? hits[0] : null;
    }

    /// <summary>Built-in, user and project rules as the API shows them.</summary>
    public WatchOverview Describe()
    {
        var state = _base;
        var disabled = state.Settings.DisabledBuiltins.ToHashSet(StringComparer.Ordinal);
        var notifyOff = state.Settings.NotifyOffBuiltins.ToHashSet(StringComparer.Ordinal);
        var builtins = WatchBuiltins.All
            .Select(b => new WatchRule(b.Id, b.Name, !disabled.Contains(b.Id), b.Notify && !notifyOff.Contains(b.Id)))
            .ToList();

        var projects = _projects.Entries.Values
            .Select(p => new WatchProjectInfo(p.Root, state.Trusted.Contains(RootKey(p.Root)), p.RuleCount, p.Problems))
            .OrderBy(p => p.Root, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return new WatchOverview(builtins, state.Settings.Rules, projects, state.Problems);
    }

    /// <summary>Case-insensitive for drive paths (Windows), separators unified, no trailing separator.</summary>
    public static string RootKey(string root)
    {
        var n = root.Replace('\\', '/').TrimEnd('/');
        return n.Length >= 2 && char.IsAsciiLetter(n[0]) && n[1] == ':' ? n.ToLowerInvariant() : n;
    }

    private void Try(CompiledWatchRule rule, WatchInput input, string? sessionKey, List<WatchHit> hits)
    {
        if (sessionKey is not null && _disabled.ContainsKey((sessionKey, rule.Id)))
        {
            return;
        }

        try
        {
            if (rule.Matches(input))
            {
                hits.Add(new WatchHit(rule.Id, rule.Name) { Notify = rule.Notify });
            }
        }
        catch (RegexMatchTimeoutException)
        {
            // Never log or rethrow the exception: its Input property holds the command.
            if (sessionKey is not null)
            {
                if (_disabled.Count >= MaxDisabled)
                {
                    _disabled.Clear();
                }

                if (_disabled.TryAdd((sessionKey, rule.Id), 0))
                {
                    RuleTimedOut?.Invoke(rule.Id);
                }
            }
        }
    }

    private sealed record BaseState(WatchSettings Settings, IReadOnlyList<CompiledWatchRule> Rules, IReadOnlyList<WatchProblem> Problems, HashSet<string> Trusted);

    private sealed record ProjectEntry(string Root, IReadOnlyList<CompiledWatchRule> Rules, IReadOnlyList<WatchProblem> Problems, int RuleCount);

    private sealed record ProjectState(IReadOnlyDictionary<string, ProjectEntry> Entries);
}
