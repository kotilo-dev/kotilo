using Hub.Core.Adapters;
using Hub.Core.Ai;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.OpenCode;
using Hub.Infrastructure.Usage;
using Microsoft.Data.Sqlite;

namespace Hub.Infrastructure.Tests;

/// <summary>OpenCode v2 plugin install and <c>opencode.db</c> usage, on temp folders (never the real <c>~/.config/opencode</c>).</summary>
public sealed class OpenCodeIntegrationTests : IDisposable
{
    private const string HookExe = @"C:\Users\Dev\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private static readonly DateTimeOffset T0 = new(2026, 10, 6, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly AgentHomes _homes;
    private readonly Database _hubDb;
    private readonly UsageSourceContext _context;
    private readonly MutableTime _time = new(T0.AddHours(1));

    public OpenCodeIntegrationTests()
    {
        var env = new Dictionary<string, string> { ["XDG_CONFIG_HOME"] = Path.Combine(_dir.Path, "cfg"), ["XDG_DATA_HOME"] = Path.Combine(_dir.Path, "data") };
        _homes = new AgentHomes(_dir.Path, name => env.GetValueOrDefault(name));
        _hubDb = new Database(_dir.File("hub.db"));
        _hubDb.Migrate();
        var pricing = PricingTable.Parse(PricingProvider.DefaultJson());
        _context = new UsageSourceContext(new TranscriptOffsetStore(_hubDb), new UsageRepository(_hubDb), () => pricing, null);
    }

    public void Dispose() => _dir.Dispose();

    private string PluginsDir => Path.Combine(_homes.OpenCodeConfigDir, "plugins");

    private string PluginFile => Path.Combine(PluginsDir, OpenCodePluginInstaller.FileName);

    // -- plugin --------------------------------------------------------------------------------------------------

    [Fact]
    public void Install_writes_the_plugin_with_the_hook_path_as_a_js_string()
    {
        var installer = new OpenCodePluginInstaller(PluginsDir, HookExe);

        installer.ConfigPath.Should().Be(Path.Combine(_dir.Path, "cfg", "opencode", "plugins", "agenthub.js"));
        installer.GetStatus().State.Should().Be(HookInstallState.Missing);
        installer.Install().Should().BeNull();

        var text = File.ReadAllText(PluginFile);
        text.Should().Contain("""const HOOK = "C:\\Users\\Dev\\AppData\\Local\\agent-hub\\hub\\bin\\agenthub-hook.exe" """.TrimEnd());
        text.Should().NotContain(OpenCodePluginInstaller.ExePlaceholder);
        text.Should().Contain("export default {").And.Contain("id: \"agenthub\"").And.Contain("ctx.event.subscribe(");
        installer.GetStatus().State.Should().Be(HookInstallState.Installed);
        installer.Install().Should().BeNull("nothing changed");
        installer.ReferencedHookExes().Should().Equal(HookExe);
    }

    [Fact]
    public void The_plugin_forwards_exactly_the_events_the_adapter_maps()
    {
        var text = new OpenCodePluginInstaller(PluginsDir, HookExe).Render();

        foreach (var name in OpenCodeAdapter.Events)
        {
            text.Should().Contain($"case \"{name}\"", name);
        }

        text.Should().NotContain("fetch(", "the hook sidecar is the only transport")
            .And.NotContain("d.title", "session and form titles are content")
            .And.NotContain("metadata", "permission metadata holds file diffs");
    }

    [Fact]
    public void A_moved_hook_exe_reads_as_outdated_and_is_repaired_with_a_backup()
    {
        new OpenCodePluginInstaller(PluginsDir, @"C:\old\agenthub-hook.exe").Install();
        var installer = new OpenCodePluginInstaller(PluginsDir, HookExe);

        installer.GetStatus().State.Should().Be(HookInstallState.Outdated);
        installer.ReferencedHookExes().Should().Equal(@"C:\old\agenthub-hook.exe");
        var backup = installer.Install();

        backup.Should().NotBeNull();
        File.ReadAllText(backup!).Should().Contain(@"C:\\old\\agenthub-hook.exe");
        Path.GetFileName(backup).Should().NotEndWith(".js", "OpenCode would load a backup that ends in .js");
        installer.GetStatus().State.Should().Be(HookInstallState.Installed);
    }

    [Fact]
    public void A_foreign_file_with_our_name_is_backed_up_and_left_alone()
    {
        Directory.CreateDirectory(PluginsDir);
        File.WriteAllText(PluginFile, "export default { id: 'someone-else', setup() {} }");
        var installer = new OpenCodePluginInstaller(PluginsDir, HookExe);

        installer.GetStatus().State.Should().Be(HookInstallState.InvalidConfig);
        installer.Invoking(i => i.Install()).Should().Throw<HookConfigException>().WithMessage("*not Kotilo's plugin*");
        File.ReadAllText(PluginFile).Should().Contain("someone-else");
        Directory.GetFiles(PluginsDir, $"agenthub.js.{Hub.Core.Brand.Current.ExePrefix}-backup-*").Should().ContainSingle();
        installer.Uninstall().Should().BeNull("only our own file is ever deleted");
        File.Exists(PluginFile).Should().BeTrue();
        installer.ReferencedHookExes().Should().BeEmpty();
    }

    [Fact]
    public void Uninstall_deletes_only_our_plugin()
    {
        Directory.CreateDirectory(PluginsDir);
        File.WriteAllText(Path.Combine(PluginsDir, "other.js"), "export default {}");
        var installer = new OpenCodePluginInstaller(PluginsDir, HookExe);
        installer.Install();

        installer.Uninstall().Should().NotBeNull();
        File.Exists(PluginFile).Should().BeFalse();
        File.Exists(Path.Combine(PluginsDir, "other.js")).Should().BeTrue();
        installer.GetStatus().State.Should().Be(HookInstallState.Missing);
        installer.Uninstall().Should().BeNull();
    }

    // -- usage ---------------------------------------------------------------------------------------------------

    /// <summary>The v2.0.22 columns agent-hub reads, plus a credential table the reader must never touch.</summary>
    private string CreateOpenCodeDb()
    {
        var path = _homes.OpenCodeDatabasePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        Exec(path, """
            CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, vcs text, name text, time_created integer NOT NULL, time_updated integer NOT NULL);
            CREATE TABLE session_v2 (
              id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, slug text NOT NULL, directory text NOT NULL,
              path text, title text, version text NOT NULL, metadata text,
              cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
              tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL,
              agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_idle integer, idle_outcome text, time_archived integer);
            CREATE TABLE control_account (id text PRIMARY KEY, access_token text, refresh_token text);
            INSERT INTO control_account VALUES ('a', 'SECRET', 'SECRET');
            INSERT INTO project VALUES ('prj_1', 'C:/src/delta', 'git', 'delta', 0, 0);
            INSERT INTO project VALUES ('global', '/', NULL, NULL, 0, 0);
            """);
        return path;
    }

    private static void Exec(string path, string sql, params (string Name, object Value)[] args)
    {
        using var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (name, value) in args)
        {
            cmd.Parameters.AddWithValue(name, value);
        }

        cmd.ExecuteNonQuery();
    }

    private static void AddSession(string db, string id, string project, string directory, long updatedMs, string? parent = null, string? title = "Fix build")
    {
        Exec(db, """
            INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated)
            VALUES (@id, @project, @parent, 'slug', @dir, @title, '2.0.22', '{"id":"claude-sonnet-4-5","providerID":"anthropic"}', @t, @t)
            """,
            ("@id", id), ("@project", project), ("@parent", (object?)parent ?? DBNull.Value), ("@dir", directory), ("@title", (object?)title ?? DBNull.Value), ("@t", updatedMs));
    }

    private static void AddUsage(string db, string id, double cost, long input, long output, long reasoning, long cacheRead, long cacheWrite, long? idleMs = null) =>
        Exec(db, """
            UPDATE session_v2 SET cost = cost + @cost, tokens_input = tokens_input + @in, tokens_output = tokens_output + @out,
              tokens_reasoning = tokens_reasoning + @r, tokens_cache_read = tokens_cache_read + @cr, tokens_cache_write = tokens_cache_write + @cw,
              time_idle = coalesce(@idle, time_idle)
            WHERE id = @id
            """,
            ("@id", id), ("@cost", cost), ("@in", input), ("@out", output), ("@r", reasoning), ("@cr", cacheRead), ("@cw", cacheWrite), ("@idle", (object?)idleMs ?? DBNull.Value));

    private OpenCodeUsageSource Source() => new(_homes.OpenCodeDatabasePath, _context, _time);

    /// <summary>The base class skips a pass when the DB file time did not change; tests bump it.</summary>
    private static void Touch(string db, int minutes) => File.SetLastWriteTimeUtc(db, T0.AddMinutes(minutes).UtcDateTime);

    [Fact]
    public void Running_totals_become_deltas_with_the_reported_cost()
    {
        var db = CreateOpenCodeDb();
        var t = T0.ToUnixTimeMilliseconds();
        AddSession(db, "ses_a", "prj_1", "C:/src/delta/api", t);
        AddUsage(db, "ses_a", 0.0125, input: 1000, output: 200, reasoning: 50, cacheRead: 4000, cacheWrite: 300, idleMs: t + 60_000);
        Touch(db, 1);

        Source().ScanAll(DateTime.MinValue).Entries.Should().Be(1);

        var first = _context.Repository.Load(DateTimeOffset.MinValue).Single();
        first.Agent.Should().Be(AgentIds.OpenCode);
        first.SessionId.Should().Be("ses_a");
        first.ProjectRoot.Should().Be(@"C:\src\delta", "the project worktree, with backslashes");
        first.Model.Should().Be("claude-sonnet-4-5");
        (first.Input, first.Output, first.CacheRead, first.CacheCreate5m).Should().Be((1000, 250, 4000, 300));
        first.CostUsd.Should().Be(0.0125m);
        first.CostReported.Should().BeTrue();
        first.Timestamp.Should().Be(T0.AddMinutes(1), "a first reading is dated by the session's last activity");

        AddUsage(db, "ses_a", 0.0025, input: 100, output: 20, reasoning: 0, cacheRead: 500, cacheWrite: 0);
        Touch(db, 2);
        Source().ScanAll(DateTime.MinValue).Entries.Should().Be(1, "a new source instance continues from the stored totals");

        var rows = _context.Repository.Load(DateTimeOffset.MinValue).OrderBy(e => e.Timestamp).ToList();
        rows.Should().HaveCount(2);
        (rows[1].Input, rows[1].Output, rows[1].CacheRead).Should().Be((100, 20, 500));
        rows[1].CostUsd.Should().Be(0.0025m);
        rows[1].Timestamp.Should().Be(_time.GetUtcNow(), "growth seen while polling is dated now");
        rows.Sum(e => e.CostUsd).Should().Be(0.015m);

        Touch(db, 3);
        Source().ScanAll(DateTime.MinValue).Entries.Should().Be(0, "nothing grew");
    }

    [Fact]
    public void Sub_agents_count_toward_their_root_and_hub_runs_are_skipped()
    {
        var db = CreateOpenCodeDb();
        var t = T0.ToUnixTimeMilliseconds();
        AddSession(db, "ses_root", "global", "C:/scratch/notes", t);
        AddSession(db, "ses_child", "global", "C:/scratch/notes", t, parent: "ses_root");
        AddSession(db, "ses_hub", "global", "C:/hub/ai-scratch", t, title: CliAgentSpecs.RunTitle);
        AddUsage(db, "ses_root", 0.01, 100, 10, 0, 0, 0);
        AddUsage(db, "ses_child", 0.02, 200, 20, 0, 0, 0);
        AddUsage(db, "ses_hub", 0.5, 9000, 900, 0, 0, 0);
        Touch(db, 1);

        Source().ScanAll(DateTime.MinValue);

        var rows = _context.Repository.Load(DateTimeOffset.MinValue);
        rows.Should().HaveCount(2);
        rows.Should().OnlyContain(e => e.SessionId == "ses_root" && e.ProjectRoot == @"C:\scratch\notes");
        rows.Sum(e => e.Input).Should().Be(300);
    }

    [Fact]
    public void Sessions_outside_the_backfill_window_and_missing_dbs_are_ignored()
    {
        Source().ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty, "no opencode.db yet");

        var db = CreateOpenCodeDb();
        AddSession(db, "ses_old", "prj_1", "C:/src/delta", T0.AddDays(-60).ToUnixTimeMilliseconds());
        AddUsage(db, "ses_old", 1, 1000, 100, 0, 0, 0);
        Touch(db, 1);

        Source().ScanAll(T0.AddDays(-35).UtcDateTime).Entries.Should().Be(0);
    }

    [Fact]
    public void A_db_without_the_v2_tables_is_skipped_quietly()
    {
        var path = _homes.OpenCodeDatabasePath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        Exec(path, "CREATE TABLE session (id text PRIMARY KEY)");

        Source().ScanAll(DateTime.MinValue).Entries.Should().Be(0);
    }

    private sealed class MutableTime(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
