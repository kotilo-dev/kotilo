using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Codex;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

/// <summary>The usage-source abstraction: file sources, the DB polling base, shared storage, per-agent limits and homes.</summary>
public sealed class UsageSourceTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 6, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly Database _db;
    private readonly UsageSourceContext _context;
    private PricingTable _pricing = PricingTable.Parse(PricingProvider.DefaultJson());

    public UsageSourceTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate();
        _context = new UsageSourceContext(new TranscriptOffsetStore(_db), new UsageRepository(_db), () => _pricing, null);
    }

    public void Dispose() => _dir.Dispose();

    private static UsageEntry Entry(string key, int minute, string model = "claude-sonnet-4-6") =>
        new(key, T0.AddMinutes(minute), 1000, 100, 0, 0, 0) { SessionId = "s", Model = model };

    [Fact]
    public void File_sources_say_which_files_are_theirs()
    {
        var claude = new TranscriptScanner(@"C:\h\.claude\projects", _context.Offsets, _context.Repository, () => _pricing);
        var codex = new CodexRolloutScanner([@"C:\h\.codex\sessions", @"C:\h\.codex\archived_sessions"], _context.Offsets, _context.Repository, () => _pricing);

        IFileUsageSource[] sources = [claude, codex];

        sources.Select(s => (s.Agent, s.FilePattern, s.ReportsActivity)).Should().Equal(
            (AgentIds.ClaudeCode, "*.jsonl", true), (AgentIds.Codex, "rollout-*.jsonl", false));
        claude.Owns(@"C:\h\.claude\projects\C--src\a.jsonl").Should().BeTrue();
        claude.Owns(@"C:\h\.claude\projects-old\a.jsonl").Should().BeFalse("a sibling folder with the same prefix is not inside");
        codex.Owns(@"C:\h\.codex\archived_sessions\rollout-x.jsonl").Should().BeTrue();
        codex.Owns(@"C:\h\.claude\projects\a.jsonl").Should().BeFalse();
    }

    [Fact]
    public void Store_stamps_the_agent_and_keeps_a_reported_cost()
    {
        var written = _context.Store(
            [Entry("a", 0), Entry("b", 1) with { CostUsd = 0.42m, CostReported = true }, Entry("c", 2) with { CostUsd = 99m }],
            "my-agent");

        written.Should().Be(3);
        var rows = _context.Repository.Load(T0.AddHours(-1)).ToDictionary(e => e.DedupKey);
        rows.Values.Should().OnlyContain(e => e.Agent == "my-agent");
        rows["a"].CostUsd.Should().BeGreaterThan(0, "priced from the table");
        rows["b"].CostUsd.Should().Be(0.42m);
        rows["b"].CostReported.Should().BeTrue();
        rows["c"].CostUsd.Should().Be(rows["a"].CostUsd, "a cost that was not reported is the table's");
    }

    [Fact]
    public void Repricing_keeps_costs_the_agent_reported()
    {
        _context.Store([Entry("table", 0), Entry("reported", 1) with { CostUsd = 0.42m, CostReported = true }], "my-agent");

        _context.Repository.Reprice(PricingTable.Parse("""{ "models": {} }"""));

        var rows = _context.Repository.Load(T0.AddHours(-1)).ToDictionary(e => e.DedupKey);
        rows["table"].CostUsd.Should().BeNull("the model has no price any more");
        rows["reported"].CostUsd.Should().Be(0.42m);
    }

    [Fact]
    public void A_db_source_reads_from_its_cursor_and_skips_an_unchanged_db()
    {
        var dbPath = _dir.File("agent.db");
        File.WriteAllText(dbPath, "x");
        var source = new FakeDbSource(dbPath, _context);
        source.Rows.Add((T0.ToUnixTimeMilliseconds(), Entry("r1", 0)));

        source.ScanAll(DateTime.MinValue).RowsWritten.Should().Be(1);
        source.Cursors.Should().Equal(0L);

        source.ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty, "the file did not change");

        source.Rows.Add((T0.AddMinutes(5).ToUnixTimeMilliseconds(), Entry("r2", 5)));
        File.SetLastWriteTimeUtc(dbPath, DateTime.UtcNow.AddMinutes(1));
        source.ScanAll(DateTime.MinValue).Entries.Should().Be(1, "only rows after the stored cursor are read");
        source.Cursors.Should().Equal(0L, T0.ToUnixTimeMilliseconds());
        _context.Repository.Load(T0.AddHours(-1)).Should().OnlyContain(e => e.Agent == "fake-db");
    }

    [Fact]
    public void A_missing_db_is_no_data()
    {
        new FakeDbSource(_dir.File("absent.db"), _context).ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty);
    }

    [Fact]
    public void Plan_limits_are_kept_per_agent_in_a_stable_order()
    {
        var stores = new PlanLimitStores(agent => _dir.File($"limits-{agent}.json"), [AgentIds.ClaudeCode, AgentIds.Codex]);

        stores.Apply(new PlanLimits(T0) { Agent = "gemini", FiveHour = new(10, T0.AddHours(1)) }).Should().BeTrue();
        stores.Apply(new PlanLimits(T0) { Agent = AgentIds.Codex, SevenDay = new(30, T0.AddDays(2)) }).Should().BeTrue();

        stores.All.Select(s => s.Agent).Should().Equal(AgentIds.ClaudeCode, AgentIds.Codex, "gemini");
        stores.All[0].Limits.Should().BeNull();
        File.Exists(_dir.File("limits-gemini.json")).Should().BeTrue();
        new PlanLimitStores(agent => _dir.File($"limits-{agent}.json"), ["gemini"]).All.Single().Limits!.Agent.Should().Be("gemini");
    }

    [Fact]
    public void Plan_limit_files_keep_their_legacy_names()
    {
        var paths = new AppPaths(_dir.File("data"), _dir.File("claude"));

        paths.PlanLimitsPathFor(AgentIds.ClaudeCode).Should().Be(paths.PlanLimitsPath);
        Path.GetFileName(paths.PlanLimitsPathFor(AgentIds.Codex)).Should().Be("plan-limits-codex.json");
        paths.CodexPlanLimitsPath.Should().Be(paths.PlanLimitsPathFor(AgentIds.Codex));
    }

    [Fact]
    public void Agent_homes_default_to_the_user_folder_and_honour_overrides()
    {
        var home = _dir.Path;
        var defaults = new AgentHomes(home, AgentHomes.NoEnvironment);
        var env = new Dictionary<string, string>
        {
            ["COPILOT_HOME"] = @"D:\copilot",
            ["GEMINI_CLI_HOME"] = @"D:\g",
            ["QWEN_HOME"] = @"D:\qwen",
            ["QWEN_RUNTIME_DIR"] = @"D:\qwen-runtime",
            ["XDG_CONFIG_HOME"] = @"D:\cfg",
            ["XDG_DATA_HOME"] = @"D:\data",
            ["OPENCODE_DB"] = @"D:\oc.db",
        };
        var overridden = new AgentHomes(home, name => env.GetValueOrDefault(name));

        defaults.CopilotHooksDir.Should().Be(Path.Combine(home, ".copilot", "hooks"));
        defaults.GeminiSettingsPath.Should().Be(Path.Combine(home, ".gemini", "settings.json"));
        defaults.QwenRuntimeDir.Should().Be(Path.Combine(home, ".qwen"));
        defaults.DroidHome.Should().Be(Path.Combine(home, ".factory"));
        defaults.CursorHooksPath.Should().Be(Path.Combine(home, ".cursor", "hooks.json"));
        defaults.OpenCodeConfigDir.Should().Be(Path.Combine(home, ".config", "opencode"));
        defaults.OpenCodeDatabasePath.Should().Be(Path.Combine(home, ".local", "share", "opencode", "opencode.db"));

        overridden.CopilotHome.Should().Be(@"D:\copilot");
        overridden.GeminiDir.Should().Be(Path.Combine(@"D:\g", ".gemini"), "GEMINI_CLI_HOME replaces the home folder");
        overridden.QwenSettingsPath.Should().Be(Path.Combine(@"D:\qwen", "settings.json"));
        overridden.QwenRuntimeDir.Should().Be(@"D:\qwen-runtime");
        overridden.OpenCodeConfigDir.Should().Be(Path.Combine(@"D:\cfg", "opencode"));
        overridden.OpenCodeDataDir.Should().Be(Path.Combine(@"D:\data", "opencode"));
        overridden.OpenCodeDatabasePath.Should().Be(@"D:\oc.db");
    }

    [Fact]
    public void Test_paths_never_point_at_the_real_home()
    {
        var paths = new AppPaths(_dir.File("data"), Path.Combine(_dir.Path, ".claude"));

        paths.Agents.UserHome.Should().Be(_dir.Path);
        paths.UserAdaptersDir.Should().StartWith(_dir.Path);
    }

    /// <summary>Rows with a "time_updated" cursor, as an OpenCode-style reader would select them.</summary>
    private sealed class FakeDbSource(string path, UsageSourceContext context)
        : DbPollingUsageSource("fake-db", path, context, TimeSpan.FromSeconds(30))
    {
        public List<(long Updated, UsageEntry Entry)> Rows { get; } = [];

        public List<long> Cursors { get; } = [];

        protected override (IReadOnlyList<UsageEntry> Entries, long Cursor) ReadSince(long cursor)
        {
            Cursors.Add(cursor);
            var rows = Rows.Where(r => r.Updated > cursor).ToList();
            return (rows.Select(r => r.Entry).ToList(), rows.Count == 0 ? cursor : rows.Max(r => r.Updated));
        }
    }
}
