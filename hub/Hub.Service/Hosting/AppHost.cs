using System.Text.Json;
using Hub.Core.Adapters;
using Hub.Core.Insights;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Infrastructure;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Dictation;
using Hub.Infrastructure.Hooks;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Sessions;
using Hub.Infrastructure.Usage;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>Composition root and startup sequence (spec §14).</summary>
public sealed class AppHost : IAsyncDisposable
{
    private AppHost(AppPaths paths, AppSettings settings, Hub.Core.Ai.ISecretStore secrets)
    {
        Paths = paths;
        Settings = settings;
        var db = new Database(paths.DatabasePath);
        Database = db;
        Repository = new SessionRepository(db);
        Tracker = new SessionTracker(new SessionEnvironment(), new SessionOptions());
        Rules = new RuleEngine(settings.Rules, new NotificationLogStore(db));
        var roots = new ProjectRootResolver();
        roots.AddFixedRoot(paths.BuddyDir);
        Pipeline = new EventPipeline(Tracker, Rules, Repository, TimeProvider.System, roots, () => Adapters?.Registry ?? AdapterRegistry.Empty);
        Usage = new UsageService(paths, db, settings.UsageRules, roots);
        Projects = new ProjectService(paths, db, roots, settings.TasksGlob, () => Tracker.Snapshot);
        AiProviders = new Hub.Infrastructure.Ai.AiProviderFactory(BuddyService.ScratchDirOf(paths), secrets, AiHttp);
        Ai = new Hub.Core.Ai.AiProviderResolver(() => Settings.Ai, AiProviders.Create);
        Ai.Completed += r => Log.Information(
            "AI run {Provider} ({Feature}): {Kind} in {Ms} ms, {In} chars in, {Out} chars out", r.ProviderId, r.Feature, r.ErrorKind, (long)r.Elapsed.TotalMilliseconds, r.InputChars, r.OutputChars);
        Buddy = new BuddyService(paths, db, Ai);
        PersonalTasks = new PersonalTaskRepository(db);
        Pipeline.IsHiddenCwd = cwd => !Settings.Buddy.ShowBuddySessions && Buddy.Filter.IsBuddy(cwd);
        Projects.IsExcludedRoot = Buddy.Filter.IsBuddy;
        Ingest = new IngestServer(Pipeline, () => Tracker.Snapshot, () => Usage.Current);
        ToolsDir = InstallTools(paths);
        var integrations = BuiltInAdapters.Create(paths, HookExePath, Usage.Context);
        HookMerger = integrations.Select(i => i.Installer).OfType<ClaudeSettingsMerger>().Single();
        Adapters = new AdapterCatalog(integrations, paths.BuiltInAdaptersDir, paths.UserAdaptersDir);
        Usage.AddSources(integrations.SelectMany(i => i.UsageSources));
        Pipeline.UsageReported += Usage.RecordReported;
        Ingest.Modules.Add(app => Api.AdapterEndpoints.Map(app, Adapters));
        Usage.SnapshotChanged += _ => PushSessionUsage();
        Projects.SessionTasksChanged += (id, tasks) => Pipeline.Post((tracker, _) => tracker.ApplyTasks(id, tasks));
        Insights = new InsightsService(db, Repository, Usage.Repository, () => Tracker.Snapshot) { GitEnabled = settings.Insights.GitEnabled };
        DailySummaries = new DailySummaryService(
            Insights, Usage.Repository, Buddy, () => Projects.Current, () => Tracker.Snapshot, () => Settings.Insights, () => SummaryLabels(), () => Settings.Language);
        Health = new HealthMonitor(this);
        Ingest.Health = () => Health.Current;
        Models = new ModelContextProvider(paths.ModelsPath);
        Pipeline.HookObserved += Insights.OnHook;
        Usage.IsIgnoredTranscript = Buddy.Filter.IsBuddyTranscript;
        Usage.Scanned += result => Pipeline.EnqueueTranscriptErrors(result.Errors);
        PlanLimits = new PlanLimitStores(paths.PlanLimitsPathFor, [AgentIds.ClaudeCode, AgentIds.Codex]);
        Usage.Scanned += result =>
        {
            if (result.Limits is { } scanned && PlanLimits.Apply(scanned))
            {
                PlanLimitsChanged?.Invoke();
            }
        };
        Pipeline.PlanLimitsReported += limits =>
        {
            if (PlanLimits.Apply(limits))
            {
                PlanLimitsChanged?.Invoke();
            }
        };

        var modelStore = new WhisperModelStore(paths.WhisperModelsDir, ModelHttp);
        DictationModels = new Api.DictationModelService(modelStore);
        Dictation = new DictationService(
            new WhisperTranscriber(), modelStore.IsInstalled, modelStore.PathOf, new DictationRepository(db),
            (message, system, timeout, ct) => Buddy.GenerateAsync(Hub.Core.Ai.AiFeature.DictationCleanup, message, system, timeout, ct),
            () => Settings.Dictation,
            TimeProvider.System);
        Stream = new Api.StreamHub(
        [
            ("sessions", () => Api.UsageEndpoints.Sessions(this, includeEnded: false)),
            ("usage", () => Api.UsageCurrentDto.From(Usage.Current)),
            ("limits", () => Api.UsageEndpoints.Limits(this)),
            ("health", () => Api.HealthDto.From(Health.Current, _startedAt)),
            ("tasks", () => Api.WorkEndpoints.TaskCounts(this, DateTimeOffset.UtcNow)),
        ],
        [
            ("activity", () => Pipeline.Activity.DrainChanges().Select(d => (object)Api.ActivityFrameDto.From(d)).ToList()),
        ]);
        Ingest.Stream = Stream;
        Ingest.SessionsProvider = includeEnded => Api.UsageEndpoints.Sessions(this, includeEnded);
        Ingest.Modules.Add(app => Api.UsageEndpoints.Map(app, this));
        Ingest.Modules.Add(app => Api.ReportEndpoints.Map(app, this));
        Ingest.Modules.Add(app => Api.WorkEndpoints.Map(app, this, DictationModels));
        Ingest.Modules.Add(app => Api.DictationEndpoints.Map(app, Dictation));
        Ingest.Modules.Add(app => Api.SettingsEndpoints.Map(app, this));
        Ingest.Modules.Add(app => Api.AiEndpoints.Map(app, this));
        Pipeline.SessionsChanged += _ => Stream.MarkDirty("sessions");
        Pipeline.ActivityChanged += () => Stream.MarkDirty("activity");
        Usage.SnapshotChanged += _ => Stream.MarkDirty("usage");
        PlanLimitsChanged += () => Stream.MarkDirty("limits");
        Health.Changed += _ => Stream.MarkDirty("health");
        // Due states move with the clock (a task becomes "today" at midnight, "overdue" at its time).
        _taskCountsTimer = new Timer(_ => RefreshTaskCounts(), null, TaskCountsInterval, TaskCountsInterval);
        Pipeline.NotificationRequested += r => Notify(Api.NotificationFeed.From(r, Tracker.Get(r.SessionId), Settings.Language));
        Usage.NotificationRequested += n => Notify(Api.NotificationFeed.From(n, Settings.Language));
        Projects.TodoCompleted += c =>
        {
            if (Settings.Rules.TodoCompletedEnabled)
            {
                Notify(Api.NotificationFeed.From(c, DateTimeOffset.UtcNow, Settings.Language));
            }
        };
    }

    private static readonly TimeSpan TaskCountsInterval = TimeSpan.FromMinutes(1);
    private readonly Timer _taskCountsTimer;
    private Api.TaskCountsDto? _lastTaskCounts;

    private void RefreshTaskCounts()
    {
        try
        {
            var counts = Api.WorkEndpoints.TaskCounts(this, DateTimeOffset.UtcNow);
            if (counts != _lastTaskCounts)
            {
                _lastTaskCounts = counts;
                Stream.MarkDirty("tasks");
            }
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "Task counts could not be refreshed");
        }
    }

    private static readonly HttpClient ModelHttp = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;

    /// <summary><c>/v1/stream</c>: snapshots and notifications for the desktop app.</summary>
    public Api.StreamHub Stream { get; }

    /// <summary>Whisper model files and downloads for the Dictation screen.</summary>
    public Api.DictationModelService DictationModels { get; }

    /// <summary>Transcription, cleanup, file output and history for live dictation (M2b).</summary>
    public DictationService Dictation { get; }

    /// <summary>Raised on the pipeline thread when the merged plan limits change.</summary>
    public event Action? PlanLimitsChanged;

    public InsightsService Insights { get; }

    public DailySummaryService DailySummaries { get; }

    public HealthMonitor Health { get; }

    /// <summary>Model context windows for the transcript-based context reading (spec §18.4).</summary>
    public ModelContextProvider Models { get; }

    /// <summary>Localized template labels for the AI-free daily summary; set by the UI.</summary>
    public Func<SummaryLabels> SummaryLabels { get; set; } = static () => throw new InvalidOperationException("Summary labels not set");

    /// <summary>Plan limits per agent: Claude from the statusLine (D-074), Codex from rollout <c>rate_limits</c>, …</summary>
    public PlanLimitStores PlanLimits { get; }

    /// <summary>Built-in and user adapters (definitions, event mapping, hook installers); reloadable.</summary>
    public AdapterCatalog Adapters { get; }

    private IReadOnlyList<string> _toolFailures = [];

    public AppPaths Paths { get; }

    public AppSettings Settings { get; private set; }

    public Database Database { get; }

    public SessionRepository Repository { get; }

    public SessionTracker Tracker { get; }

    public RuleEngine Rules { get; }

    public EventPipeline Pipeline { get; }

    public UsageService Usage { get; }

    public ProjectService Projects { get; }

    public BuddyService Buddy { get; }

    /// <summary>AI providers per feature (M3): agent CLIs and OpenAI-compatible endpoints.</summary>
    public Hub.Core.Ai.AiProviderResolver Ai { get; }

    public Hub.Infrastructure.Ai.AiProviderFactory AiProviders { get; }

    private static readonly HttpClient AiHttp = new() { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>Görevlerim (spec §21).</summary>
    public PersonalTaskRepository PersonalTasks { get; }

    public IngestServer Ingest { get; }

    public ClaudeSettingsMerger HookMerger { get; }

    /// <summary>Hook exe referenced from Claude's settings.json: the stable copy, or the build output if copying failed.</summary>
    public string HookExePath => Path.Combine(ToolsDir, AppPaths.HookExeName);

    public string StatusLineExePath => Path.Combine(ToolsDir, AppPaths.StatusLineExeName);

    /// <summary><see cref="AppPaths.BinDir"/> after a successful sync (D-061), otherwise the app folder.</summary>
    public string ToolsDir { get; }

    /// <summary>Loads paths and settings; called before any UI so the language can be applied.</summary>
    public static AppHost Create()
    {
        var paths = AppPaths.FromEnvironment();
        paths.EnsureCreated();
        return new AppHost(paths, AppSettings.Load(paths.SettingsPath), Hub.Infrastructure.Platform.SecretStores.ForCurrentPlatform());
    }

    /// <summary>For tests: a host on explicit paths (temp folders) with an in-memory secret store (never the real vault).</summary>
    internal static AppHost Create(AppPaths paths, Hub.Core.Ai.ISecretStore? secrets = null)
    {
        paths.EnsureCreated();
        return new AppHost(paths, AppSettings.Load(paths.SettingsPath), secrets ?? new Hub.Infrastructure.Ai.InMemorySecretStore());
    }

    /// <summary>Startup order (spec §14): DB → ingest → spool → transcript backfill (background) → watchers.</summary>
    public async Task StartAsync(CancellationToken ct)
    {
        var version = Database.Migrate();
        Log.Information("Database ready (schema v{Version}) at {Path}", version, Paths.DatabasePath);
        Log.Information("Hook tools at {Dir}", ToolsDir);
        foreach (var failure in _toolFailures)
        {
            Log.Warning("Could not update tool copy: {Failure}", failure);
        }

        Tracker.Restore(Repository.LoadRecent(DateTimeOffset.UtcNow, SessionTracker.EndedVisibleFor));
        Pipeline.Start();

        await Ingest.StartAsync(Paths.PortFile, ct);

        var spooled = SpoolReader.Drain(Paths.SpoolDir);
        foreach (var envelope in spooled)
        {
            Pipeline.EnqueueHook(envelope, replayed: true);
        }

        if (spooled.Count > 0)
        {
            Log.Information("Replayed {Count} spooled hook events", spooled.Count);
        }

        WriteStatusLineConfig(Settings.StatusLineWrappedCommand);
        Models.Load();
        Usage.Start();
        Projects.Start();
        Insights.Start();
    }

    public void UpdateSettings(AppSettings settings)
    {
        Settings = settings;
        settings.Save(Paths.SettingsPath);
        Usage.Rules.Options = settings.UsageRules;
        Usage.RequestRefresh();
        Projects.SetGlob(settings.TasksGlob);
        Insights.GitEnabled = settings.Insights.GitEnabled;
        Pipeline.Post((_, rules) =>
        {
            rules.Options = settings.Rules;
            return false;
        });
    }

    public void MuteProject(string projectRoot, TimeSpan duration) =>
        Pipeline.Post((_, rules) =>
        {
            rules.MuteProject(projectRoot, DateTimeOffset.UtcNow + duration);
            return false;
        });

    /// <summary>Installs the hub's statusLine, keeping the user's previous command as the wrapped one (spec §9).</summary>
    public string? InstallStatusLine()
    {
        var (backup, previous) = HookMerger.InstallStatusLine(StatusLineExePath);
        if (previous is not null)
        {
            UpdateSettings(Settings with { StatusLineWrappedCommand = previous });
            WriteStatusLineConfig(previous);
        }

        return backup;
    }

    public string? UninstallStatusLine()
    {
        var backup = HookMerger.UninstallStatusLine(Settings.StatusLineWrappedCommand);
        UpdateSettings(Settings with { StatusLineWrappedCommand = null });
        WriteStatusLineConfig(null);
        return backup;
    }

    /// <summary>Runs before logging is configured, so the outcome is logged later from <see cref="StartAsync"/>.</summary>
    private string InstallTools(AppPaths paths)
    {
        if (ToolInstaller.Sync(ToolsSource(), paths.BinDir, out var failures))
        {
            return paths.BinDir;
        }

        _toolFailures = failures;
        return File.Exists(Path.Combine(paths.BinDir, AppPaths.HookExeName)) ? paths.BinDir : AppContext.BaseDirectory;
    }

    /// <summary>
    /// Where agenthub-hook comes from: <c>AGENTHUB_TOOLS_DIR</c> (set by the desktop supervisor to the app's own folder)
    /// when it has the hook exe, else the hub's folder.
    /// </summary>
    private static string ToolsSource() =>
        Environment.GetEnvironmentVariable("AGENTHUB_TOOLS_DIR") is { Length: > 0 } dir && File.Exists(Path.Combine(dir, AppPaths.HookExeName))
            ? dir
            : AppContext.BaseDirectory;

    /// <summary>Global quiet hours and "do not disturb" drop notifications here (spec §11.2); the desktop adds pane-visibility suppression.</summary>
    private void Notify(Api.NotificationDto notification)
    {
        if (NotificationGate.IsSuppressed(DateTimeOffset.UtcNow, TimeZoneInfo.Local, Settings.DoNotDisturbUntil, Settings.QuietHours))
        {
            return;
        }

        Log.Information("Notification {Rule} for {Session}", notification.RuleId, notification.SessionId);
        Stream.Publish("notification", notification);
    }

    public async ValueTask DisposeAsync()
    {
        await _taskCountsTimer.DisposeAsync();
        DailySummaries.Dispose();
        Dictation.Dispose();
        await DictationModels.DisposeAsync();
        await Insights.DisposeAsync();
        await Projects.DisposeAsync();
        await Usage.DisposeAsync();
        await Ingest.DisposeAsync();
        await Pipeline.DisposeAsync();
        try
        {
            File.Delete(Paths.PortFile);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>Session cards show transcript token totals; the query runs on the usage worker thread.</summary>
    private void PushSessionUsage()
    {
        var ids = Tracker.Snapshot.Select(s => s.SessionId).ToList();
        var totals = Usage.Repository.SessionTotals(ids);
        if (totals.Count > 0)
        {
            Pipeline.Post((tracker, _) => tracker.ApplyUsage(totals));
        }

        // Transcript-based context fill for sessions without a statusLine reading (spec §18.4).
        var table = Models.Current;
        var samples = Usage.Repository.LastContext(ids)
            .Select(kv => (kv.Key, Percent: ContextUsageResolver.FromTokens(kv.Value.Tokens, kv.Value.Model, table), kv.Value.At))
            .Where(x => x.Percent is not null)
            .ToDictionary(x => x.Key, x => new ContextSample(x.Percent!.Value, x.At), StringComparer.Ordinal);
        if (samples.Count > 0)
        {
            Pipeline.Post((tracker, _) => tracker.ApplyTranscriptContext(samples));
        }
    }

    /// <summary><c>statusline.json</c> is read by kotilo-statusline on every render.</summary>
    private void WriteStatusLineConfig(string? wrappedCommand)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(wrappedCommand))
            {
                File.Delete(Paths.StatusLineConfigPath);
                return;
            }

            File.WriteAllText(Paths.StatusLineConfigPath, JsonSerializer.Serialize(new { wrappedCommand }));
        }
        catch (IOException ex)
        {
            Log.Warning(ex, "Could not write statusline.json");
        }
    }
}
