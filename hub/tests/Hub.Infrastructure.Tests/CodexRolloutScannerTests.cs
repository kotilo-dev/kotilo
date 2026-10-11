using System.Text;
using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Codex;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

public sealed class CodexRolloutScannerTests : IDisposable
{
    private const string SessionId = "0199a1b2-0000-7000-8000-000000000001";
    private readonly TempDir _dir = new();
    private readonly UsageRepository _usage;
    private readonly CodexRolloutScanner _scanner;
    private readonly string _file;
    private readonly string[] _lines;

    public CodexRolloutScannerTests()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        _usage = new UsageRepository(db);
        var sessions = Path.Combine(_dir.Path, "sessions");
        var day = Path.Combine(sessions, "2026", "10", "04");
        Directory.CreateDirectory(day);
        _file = Path.Combine(day, $"rollout-2026-10-04T09-12-03-{SessionId}.jsonl");
        _lines = File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "codex", "rollout.jsonl"));
        var pricing = PricingTable.Parse(PricingProvider.DefaultJson());
        _scanner = new CodexRolloutScanner([sessions, Path.Combine(_dir.Path, "archived_sessions")], new TranscriptOffsetStore(db), _usage, () => pricing);
    }

    public void Dispose() => _dir.Dispose();

    private void Append(IEnumerable<string> lines) =>
        File.AppendAllText(_file, string.Concat(lines.Select(l => l + "\n")), new UTF8Encoding(false));

    [Fact]
    public void Stores_codex_usage_and_returns_the_latest_limits()
    {
        Append(_lines);

        var result = _scanner.ScanAll(DateTime.MinValue);

        var stored = _usage.Load(DateTimeOffset.MinValue);
        stored.Should().HaveCount(2, "the repeated token_count collapses onto one row");
        stored.Should().OnlyContain(e => e.Agent == AgentIds.Codex && e.SessionId == SessionId && e.CostUsd == null);
        stored.Sum(e => e.Output).Should().Be(500);
        result.Limits!.Agent.Should().Be(AgentIds.Codex);
        result.Limits.FiveHour!.UsedPercent.Should().Be(13.0);
    }

    [Fact]
    public void Incremental_scan_recovers_model_and_cwd_from_earlier_lines()
    {
        Append(_lines.Take(4));
        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(1);

        Append(_lines.Skip(5));
        var second = _scanner.ScanFile(_file);

        second.Entries.Should().Be(1, "only the appended token_count is read");
        var latest = _usage.Load(DateTimeOffset.MinValue).OrderBy(e => e.Timestamp).Last();
        latest.Model.Should().Be("gpt-test-codex");
        latest.ProjectRoot.Should().Be(@"C:\src\beta");
        latest.SessionId.Should().Be(SessionId);
    }

    [Theory]
    [InlineData(@"C:\x\rollout-2026-10-04T09-12-03-0199a1b2-0000-7000-8000-000000000001.jsonl", SessionId)]
    [InlineData(@"C:\x\rollout-2026-10-04T09-12-03-0199a1b2-0000-7000-8000-000000000001_0199a1b2-0000-7000-8000-000000000009.jsonl", SessionId)]
    [InlineData(@"C:\x\rollout-broken.jsonl", null)]
    public void Session_id_comes_from_the_file_name_when_needed(string path, string? expected) =>
        CodexRolloutScanner.SessionIdFromFileName(path).Should().Be(expected);
}
