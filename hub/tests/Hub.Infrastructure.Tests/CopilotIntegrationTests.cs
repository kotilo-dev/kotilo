using System.Text;
using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Copilot;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

/// <summary>Copilot CLI hook file and session-state usage, on a temp COPILOT_HOME (never the real <c>~/.copilot</c>).</summary>
public sealed class CopilotIntegrationTests : IDisposable
{
    private const string SessionId = "6f1c2d3e-0000-4000-8000-00000000c001";
    private const string HookExe = @"C:\Users\Dev O'Neil\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe";
    private readonly TempDir _dir = new();
    private readonly AgentHomes _homes;
    private readonly Database _db;
    private readonly UsageSourceContext _context;

    public CopilotIntegrationTests()
    {
        var env = new Dictionary<string, string> { ["COPILOT_HOME"] = Path.Combine(_dir.Path, "copilot-home") };
        _homes = new AgentHomes(_dir.Path, name => env.GetValueOrDefault(name));
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate();
        var pricing = PricingTable.Parse(PricingProvider.DefaultJson());
        _context = new UsageSourceContext(new TranscriptOffsetStore(_db), new UsageRepository(_db), () => pricing, null);
    }

    public void Dispose() => _dir.Dispose();

    private string HooksFile => Path.Combine(_dir.Path, "copilot-home", "hooks", "agenthub.json");

    [Fact]
    public void Install_writes_our_own_file_with_powershell_commands_per_event()
    {
        var installer = CopilotHooks.Installer(_homes, HookExe);

        installer.ConfigPath.Should().Be(HooksFile);
        installer.GetStatus().State.Should().Be(HookInstallState.Missing);
        installer.Install().Should().BeNull("there was no file to back up");

        var root = JsonNode.Parse(File.ReadAllText(HooksFile))!.AsObject();
        root["version"]!.GetValue<int>().Should().Be(1);
        var hooks = root["hooks"]!.AsObject();
        hooks.Select(kv => kv.Key).Should().Equal(CopilotAdapter.Events);
        hooks.Select(kv => kv.Key).Should().NotContain("preToolUse", "a failing preToolUse hook blocks the tool");
        var entry = hooks["permissionRequest"]![0]!.AsObject();
        entry["type"]!.GetValue<string>().Should().Be("command");
        entry["powershell"]!.GetValue<string>().Should().Be(
            @"& 'C:\Users\Dev O''Neil\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe' --agent copilot --event permissionRequest");
        entry["bash"]!.GetValue<string>().Should().Contain("--agent copilot --event permissionRequest");
        entry["timeoutSec"]!.GetValue<int>().Should().Be(CopilotHooks.TimeoutSeconds);
        installer.GetStatus().State.Should().Be(HookInstallState.Installed);
        installer.ReferencedHookExes().Should().Equal(HookExe);
    }

    [Fact]
    public void A_moved_hook_exe_reads_as_outdated_and_uninstall_removes_the_file()
    {
        CopilotHooks.Installer(_homes, @"C:\old\agenthub-hook.exe").Install();
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(HooksFile)!, "mine.json"), """{"version":1,"hooks":{}}""");

        var installer = CopilotHooks.Installer(_homes, HookExe);
        installer.GetStatus().State.Should().Be(HookInstallState.Outdated);
        installer.Install().Should().NotBeNull("the old file is backed up first");
        installer.GetStatus().State.Should().Be(HookInstallState.Installed);

        installer.Uninstall().Should().NotBeNull();
        File.Exists(HooksFile).Should().BeFalse();
        File.Exists(Path.Combine(Path.GetDirectoryName(HooksFile)!, "mine.json")).Should().BeTrue("other hook files are the user's");
    }

    [Fact]
    public void Invalid_file_is_reported_and_never_rewritten()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(HooksFile)!);
        File.WriteAllText(HooksFile, "{ not json");
        var installer = CopilotHooks.Installer(_homes, HookExe);

        installer.GetStatus().State.Should().Be(HookInstallState.InvalidConfig);
        installer.Invoking(i => i.Install()).Should().Throw<HookConfigException>();
        File.ReadAllText(HooksFile).Should().Be("{ not json");
    }

    private string WriteSession(string id, IEnumerable<string> lines, string? cwd = null)
    {
        var dir = Path.Combine(_homes.CopilotSessionStateDir, id);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, CopilotSessionScanner.FileName);
        var text = string.Concat(lines.Select(l => (cwd is null ? l : l.Replace(@"C:\\src\\gamma", cwd.Replace(@"\", @"\\", StringComparison.Ordinal), StringComparison.Ordinal)) + "\n"));
        File.AppendAllText(path, text, new UTF8Encoding(false));
        return path;
    }

    private static string[] FixtureLines() =>
        File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "copilot", "events.jsonl")).Where(l => l.Length > 0).ToArray();

    [Fact]
    public void Scanner_stores_shutdown_totals_once_and_reads_only_new_bytes()
    {
        var scanner = new CopilotSessionScanner(_homes.CopilotSessionStateDir, _context);
        var lines = FixtureLines();
        var path = WriteSession(SessionId, lines.Take(3));

        scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(0, "no shutdown yet");
        WriteSession(SessionId, lines.Skip(3).Take(1));
        scanner.Owns(path).Should().BeTrue();
        scanner.ScanFile(path).Entries.Should().Be(2);
        scanner.ScanFile(path).Entries.Should().Be(0, "nothing new");

        WriteSession(SessionId, lines.Skip(4));
        scanner.ScanFile(path);

        var stored = _context.Repository.Load(DateTimeOffset.MinValue);
        stored.Should().HaveCount(3);
        stored.Should().OnlyContain(e => e.Agent == AgentIds.Copilot && e.SessionId == SessionId && e.ProjectRoot == @"C:\src\gamma" && e.CostUsd == null);
        stored.Sum(e => e.Output).Should().Be(1200);
        _context.Repository.Reprice(PricingTable.Parse(PricingProvider.DefaultJson()));
        _context.Repository.Load(DateTimeOffset.MinValue).Should().OnlyContain(e => e.CostUsd == null, "repricing never assigns API prices");
    }

    [Fact]
    public void Scanner_skips_the_hubs_own_ai_runs_and_foreign_files()
    {
        var scratch = Path.Combine(_dir.Path, "buddy", "ai-scratch");
        var scanner = new CopilotSessionScanner(_homes.CopilotSessionStateDir, _context, scratch);
        WriteSession("aaaaaaaa-0000-4000-8000-000000000001", FixtureLines().Take(4), cwd: scratch);

        scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(0);
        scanner.Owns(Path.Combine(_homes.CopilotSessionStateDir, "x", "workspace.yaml")).Should().BeFalse();
        _context.Repository.Load(DateTimeOffset.MinValue).Should().BeEmpty();
    }
}
