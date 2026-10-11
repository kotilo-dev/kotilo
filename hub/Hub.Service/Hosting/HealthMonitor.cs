using Hub.Core.Adapters;
using Hub.Core.Insights;
using Hub.Infrastructure.Claude;
using Dapper;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Gathers the health inputs every 30 s and evaluates them (spec §18.6). Issue changes are logged; the UI shows the
/// worst one as an InfoBar.
/// </summary>
public sealed class HealthMonitor(AppHost host)
{
    private IReadOnlyList<HealthIssue> _current = [];

    /// <summary>The hotkey text when Bip's global shortcut could not be registered; set by the UI.</summary>
    public string? FailedHotkey { get; set; }

    public IReadOnlyList<HealthIssue> Current => _current;

    /// <summary>Raised from <see cref="Check"/> when the issue list changed.</summary>
    public event Action<IReadOnlyList<HealthIssue>>? Changed;

    /// <summary>Runs every check; returns true when the issue list changed. Safe to call off the UI thread.</summary>
    public bool Check(DateTimeOffset now)
    {
        var insights = host.Settings.Insights;
        TrackVersion(now);
        insights = host.Settings.Insights;

        var inputs = new HealthInputs(now)
        {
            LastHookAt = host.Pipeline.LastHookAt,
            LastTranscriptWriteAt = host.Usage.LastTranscriptWriteAt,
            HookInstall = HookSetupState(),
            AgentHooks = OtherAgentHooks(),
            Parser = host.Usage.RecentParserStats(now),
            ClaudeVersion = insights.ClaudeVersion,
            PreviousClaudeVersion = insights.PreviousClaudeVersion,
            VersionChangedAt = insights.ClaudeVersionChangedAt,
            PortOk = host.Ingest.Port is not null,
            FailedHotkey = FailedHotkey,
            DatabaseOk = DatabaseWritable(),
        };

        var issues = HealthEvaluator.Evaluate(inputs);
        var changed = !issues.Select(Key).SequenceEqual(_current.Select(Key));
        if (changed)
        {
            foreach (var issue in issues.Where(i => !_current.Any(c => Key(c) == Key(i))))
            {
                Log.Warning("Health: {Check} ({Severity}) {Detail}", issue.Check, issue.Severity, string.Join(", ", issue.Detail));
            }

            foreach (var gone in _current.Where(c => !issues.Any(i => Key(i) == Key(c))))
            {
                Log.Information("Health: {Check} resolved", gone.Check);
            }
        }

        _current = issues;
        if (changed)
        {
            Changed?.Invoke(issues);
        }

        return changed;
    }

    private static string Key(HealthIssue i) => i.Check + ":" + i.Severity + ":" + string.Join("|", i.Detail);

    /// <summary>Missing Kotilo entries, or entries pointing at an exe that no longer exists.</summary>
    private HookSetup HookSetupState()
    {
        try
        {
            if (host.HookMerger.GetState() == HookInstallState.Missing)
            {
                return HookSetup.Missing;
            }

            return host.HookMerger.ReferencedHookExes().All(File.Exists) ? HookSetup.Ok : HookSetup.WrongPath;
        }
#pragma warning disable CA1031 // An unreadable settings.json is itself reported by the merger UI; health stays quiet.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            Log.Debug(ex, "Health: could not read Claude settings");
            return HookSetup.Ok;
        }
    }

    /// <summary>
    /// Every other hook-based adapter: only an installed integration whose entries point at a hook exe that no longer
    /// exists is reported (an agent the user never connected is not a problem).
    /// </summary>
    private List<AgentHookSetup> OtherAgentHooks()
    {
        var result = new List<AgentHookSetup>();
        foreach (var entry in host.Adapters.Entries)
        {
            if (entry.Installer is not { } installer || entry.Id == AgentIds.ClaudeCode)
            {
                continue;
            }

            try
            {
                if (installer.GetStatus().State is HookInstallState.Missing or HookInstallState.InvalidConfig or HookInstallState.Unsupported)
                {
                    continue;
                }

                if (!installer.ReferencedHookExes().All(File.Exists))
                {
                    result.Add(new AgentHookSetup(entry.Id, HookSetup.WrongPath));
                }
            }
#pragma warning disable CA1031 // An unreadable agent config is reported by the integration card; health stays quiet.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                Log.Debug(ex, "Health: could not read the {Agent} hook config", entry.Id);
            }
        }

        return result;
    }

    private bool DatabaseWritable()
    {
        try
        {
            using var c = host.Database.Open();
            using var tx = c.BeginTransaction(deferred: false);
            c.Execute("CREATE TEMP TABLE IF NOT EXISTS health_probe (x INTEGER)", transaction: tx);
            tx.Rollback();
            return true;
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            Log.Warning(ex, "Health: database not writable");
            return false;
        }
    }

    /// <summary>Records a Claude Code version change (from transcripts) once, keeping the previous version for 24 h.</summary>
    private void TrackVersion(DateTimeOffset now)
    {
        var seen = host.Usage.ClaudeVersion;
        var s = host.Settings.Insights;
        if (seen is null || seen == s.ClaudeVersion)
        {
            return;
        }

        // Two installs (CLI and an IDE extension) can write different versions; only an upgrade is news.
        if (s.ClaudeVersion is not null && Version.TryParse(seen, out var next) && Version.TryParse(s.ClaudeVersion, out var known) && next < known)
        {
            return;
        }

        host.UpdateSettings(host.Settings with
        {
            Insights = s with
            {
                ClaudeVersion = seen,
                PreviousClaudeVersion = s.ClaudeVersion,
                ClaudeVersionChangedAt = s.ClaudeVersion is null ? null : now,
            },
        });
        Log.Information("Claude Code version {Previous} -> {Current}", s.ClaudeVersion ?? "?", seen);
    }
}
