using Hub.Core;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure;

/// <summary>File locations (spec §4, §13). <c>AGENTHUB_DATA_DIR</c> overrides the data folder for tests.</summary>
public sealed class AppPaths
{
    /// <summary>Overrides the hub data folder (tests, side-by-side runs). A protocol name: it stays under any brand.</summary>
    public const string DataDirVariable = "AGENTHUB_DATA_DIR";

    public static string DefaultInstanceMutexName => InstanceMutexNameFor(Brand.Current.Slug);

    public static string HookExeName => Executable.Name(Brand.Current.HookMarker);

    public static string StatusLineExeName => StatusLineExeNameFor(Brand.Current.ExePrefix);

    /// <summary>The status line exe under the current name and the legacy ones (a renamed build still recognises its entry).</summary>
    public static IReadOnlyList<string> OwnedStatusLineExeNames =>
        [StatusLineExeName, .. Brand.Current.LegacyExePrefixes.Select(StatusLineExeNameFor)];

    public static string InstanceMutexNameFor(string slug) => $@"Local\{slug}.hub";

    private static string StatusLineExeNameFor(string exePrefix) => Executable.Name(exePrefix + "-statusline");

    /// <summary>Single-instance mutex, also probed by agenthub-hook. <c>AGENTHUB_INSTANCE_MUTEX</c> overrides it for side-by-side test runs.</summary>
    public static string InstanceMutexName =>
        Environment.GetEnvironmentVariable("AGENTHUB_INSTANCE_MUTEX") is { Length: > 0 } name ? name : DefaultInstanceMutexName;

    public AppPaths(string dataDir, string claudeConfigDir, string? codexHome = null)
    {
        DataDir = dataDir;
        ClaudeConfigDir = claudeConfigDir;
        var home = Path.GetDirectoryName(claudeConfigDir) ?? claudeConfigDir;
        CodexHome = codexHome ?? Path.Combine(home, ".codex");
        Agents = new AgentHomes(home, AgentHomes.NoEnvironment);
        UserAdaptersDir = Path.Combine(dataDir, "adapters");
        BuiltInAdaptersDir = FindBuiltInAdapters(AppContext.BaseDirectory);
    }

    /// <summary>Other agents' folders. The constructor uses the Claude folder's parent as home and no environment overrides.</summary>
    public AgentHomes Agents { get; init; }

    /// <summary>
    /// User-defined adapters, <c>&lt;dir&gt;\&lt;id&gt;\adapter.json</c>: <c>%APPDATA%\kotilo\adapters</c>, or
    /// <c>AGENTHUB_USER_ADAPTERS_DIR</c>. The constructor puts it in the data folder (tests).
    /// </summary>
    public string UserAdaptersDir { get; init; }

    /// <summary>
    /// Built-in adapter definitions: <c>AGENTHUB_ADAPTERS_DIR</c> (set by the desktop supervisor to its bundled resources),
    /// else the nearest <c>adapters</c> folder at or above the hub's own folder (the repo's, in a debug build). Null when none.
    /// </summary>
    public string? BuiltInAdaptersDir { get; init; }

    public string DataDir { get; }

    /// <summary><c>%USERPROFILE%\.claude</c>, or <c>CLAUDE_CONFIG_DIR</c> when set.</summary>
    public string ClaudeConfigDir { get; }

    /// <summary><c>%USERPROFILE%.codex</c>, or <c>CODEX_HOME</c> when set.</summary>
    public string CodexHome { get; }

    public string CodexHooksPath => Path.Combine(CodexHome, "hooks.json");

    public string CodexConfigPath => Path.Combine(CodexHome, "config.toml");

    /// <summary>Rollout folders: live sessions and archived ones.</summary>
    public IReadOnlyList<string> CodexRolloutDirs => [Path.Combine(CodexHome, "sessions"), Path.Combine(CodexHome, "archived_sessions")];

    /// <summary>Codex plan limits from rollout <c>rate_limits</c>, kept apart from Claude's.</summary>
    public string CodexPlanLimitsPath => PlanLimitsPathFor(Hub.Core.Adapters.AgentIds.Codex);

    public string DatabasePath => Path.Combine(DataDir, "hub.db");

    public string SettingsPath => Path.Combine(DataDir, "settings.json");

    public string PortFile => Path.Combine(DataDir, "port.json");

    public string PricingPath => Path.Combine(DataDir, "pricing.json");

    /// <summary>Read by kotilo-statusline: the user's original statusLine command to chain (spec §9).</summary>
    public string StatusLineConfigPath => Path.Combine(DataDir, "statusline.json");

    /// <summary>Model id prefix → context window (spec §18.4).</summary>
    public string ModelsPath => Path.Combine(DataDir, "models.json");

    /// <summary>Last known plan limits (D-074), so the Usage page has them right after a restart.</summary>
    public string PlanLimitsPath => Path.Combine(DataDir, "plan-limits.json");

    /// <summary>Plan limits per agent: Claude's keep <see cref="PlanLimitsPath"/>, others <c>plan-limits-&lt;agent&gt;.json</c>.</summary>
    public string PlanLimitsPathFor(string agent) =>
        agent == Hub.Core.Adapters.AgentIds.ClaudeCode ? PlanLimitsPath : Path.Combine(DataDir, $"plan-limits-{agent}.json");

    public string SpoolDir => Path.Combine(DataDir, "spool");

    /// <summary>Whisper models for dictation (ARCHITECTURE §4).</summary>
    public string WhisperModelsDir => Path.Combine(DataDir, "models");

    public string LogsDir => Path.Combine(DataDir, "logs");

    /// <summary>Stable home of agenthub-hook / kotilo-statusline referenced from Claude's settings.json (D-061).</summary>
    public string BinDir => Path.Combine(DataDir, "bin");

    /// <summary>Working folder of Bip's Claude runs; sessions with this cwd are filtered out (spec §17.2).</summary>
    public string BuddyDir => Path.Combine(DataDir, "buddy");

    public string ClaudeSettingsPath => Path.Combine(ClaudeConfigDir, "settings.json");

    public string ClaudeProjectsDir => Path.Combine(ClaudeConfigDir, "projects");

    public static AppPaths FromEnvironment()
    {
        var data = Environment.GetEnvironmentVariable(DataDirVariable);
        if (string.IsNullOrWhiteSpace(data))
        {
            data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Brand.Current.Slug, "hub");
        }

        var claude = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
        if (string.IsNullOrWhiteSpace(claude))
        {
            claude = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");
        }

        var codex = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrWhiteSpace(codex))
        {
            codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        }

        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return new AppPaths(data, claude, codex)
        {
            Agents = new AgentHomes(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Environment.GetEnvironmentVariable),
            UserAdaptersDir = Environment.GetEnvironmentVariable("AGENTHUB_USER_ADAPTERS_DIR") is { Length: > 0 } user
                ? user
                : Path.Combine(appData, Brand.Current.Slug, "adapters"),
            BuiltInAdaptersDir = Environment.GetEnvironmentVariable("AGENTHUB_ADAPTERS_DIR") is { Length: > 0 } builtIn
                ? builtIn
                : FindBuiltInAdapters(AppContext.BaseDirectory),
        };
    }

    /// <summary>The nearest <c>adapters</c> folder holding at least one <c>&lt;id&gt;/adapter.json</c>, from <paramref name="start"/> up.</summary>
    public static string? FindBuiltInAdapters(string start)
    {
        for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "adapters");
            try
            {
                if (Directory.Exists(candidate) && Directory.EnumerateFiles(candidate, "adapter.json", SearchOption.AllDirectories).Any())
                {
                    return candidate;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }

        return null;
    }

    public void EnsureCreated()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(SpoolDir);
        Directory.CreateDirectory(LogsDir);
    }
}
