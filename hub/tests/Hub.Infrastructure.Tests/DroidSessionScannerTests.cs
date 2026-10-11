using Hub.Core.Adapters;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Droid;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

/// <summary>Droid's running-total session files become per-turn deltas. Temp folder only, never the real <c>~/.factory</c>.</summary>
public sealed class DroidSessionScannerTests : IDisposable
{
    private const string SessionId = "7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    private static readonly DateTime T0 = new(2026, 10, 5, 9, 13, 25, DateTimeKind.Utc);
    private readonly TempDir _dir = new();
    private readonly UsageRepository _usage;
    private readonly DroidSessionScanner _scanner;
    private readonly string _sessions;
    private readonly string _project;
    private readonly string _file;

    public DroidSessionScannerTests()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        _usage = new UsageRepository(db);
        var pricing = PricingTable.Parse("""{ "models": {} }""");
        _sessions = Path.Combine(_dir.Path, ".factory", "sessions");
        _project = Path.Combine(_sessions, "-C-Users-dev-src-demo");
        Directory.CreateDirectory(_project);
        _file = Path.Combine(_project, SessionId + ".settings.json");
        _scanner = new DroidSessionScanner(_sessions, new UsageSourceContext(new TranscriptOffsetStore(db), _usage, () => pricing, null));
    }

    public void Dispose() => _dir.Dispose();

    private void WriteTotals(long input, long output, long cacheCreate, long cacheRead, long thinking, DateTime at, string model = "claude-sonnet-4-5-20250929")
    {
        File.WriteAllText(
            _file,
            $$$"""{"model":"{{{model}}}","autonomyMode":"normal","tokenUsage":{"inputTokens":{{{input}}},"outputTokens":{{{output}}},"cacheCreationTokens":{{{cacheCreate}}},"cacheReadTokens":{{{cacheRead}}},"thinkingTokens":{{{thinking}}}}}""");
        File.SetLastWriteTimeUtc(_file, at);
    }

    private void WriteTranscript() =>
        File.WriteAllText(
            Path.Combine(_project, SessionId + ".jsonl"),
            $$$"""
            {"type":"session_start","id":"{{{SessionId}}}","title":"Fix failing tests","cwd":"C:\\Users\\dev\\src\\demo"}
            {"type":"message","id":"m1","timestamp":"2026-10-05T09:12:44.000Z","message":{"role":"user","content":[{"type":"text","text":"<redacted>"}]}}

            """);

    [Fact]
    public void Says_which_files_are_its_own()
    {
        _scanner.Agent.Should().Be(AgentIds.Droid);
        ((IFileUsageSource)_scanner).FilePattern.Should().Be("*.settings.json");
        _scanner.ReportsActivity.Should().BeFalse();
        _scanner.Owns(_file).Should().BeTrue();
        _scanner.Owns(Path.Combine(_project, SessionId + ".jsonl")).Should().BeFalse();
        _scanner.Owns(Path.Combine(_dir.Path, ".factory", "settings.json")).Should().BeFalse("the user settings are not a session file");
    }

    [Fact]
    public void Each_rewrite_becomes_one_entry_with_the_growth_since_the_last_one()
    {
        WriteTranscript();
        WriteTotals(48210, 3120, 12000, 96400, 850, T0);

        _scanner.ScanAll(DateTime.MinValue).RowsWritten.Should().Be(1);
        _scanner.ScanAll(DateTime.MinValue).FilesRead.Should().Be(0, "an unchanged file is skipped");
        _scanner.ScanFile(_file).Entries.Should().Be(0, "the same totals add nothing");

        WriteTotals(50000, 3500, 12000, 120000, 900, T0.AddMinutes(2));
        _scanner.ScanFile(_file).RowsWritten.Should().Be(1);

        var rows = _usage.Load(DateTimeOffset.MinValue).OrderBy(e => e.Timestamp).ToList();
        rows.Should().HaveCount(2);
        rows.Should().OnlyContain(e => e.Agent == AgentIds.Droid && e.SessionId == SessionId && e.ProjectRoot == @"C:\Users\dev\src\demo");
        rows.Should().OnlyContain(e => e.Model == "claude-sonnet-4-5-20250929" && e.CostUsd == null);
        (rows[0].Input, rows[0].Output, rows[0].CacheCreate, rows[0].CacheRead).Should().Be((48210L, 3120L, 12000L, 96400L));
        (rows[1].Input, rows[1].Output, rows[1].CacheCreate, rows[1].CacheRead).Should().Be((1790L, 380L, 0L, 23600L));
        rows[1].Timestamp.Should().Be(new DateTimeOffset(T0.AddMinutes(2)));
        rows.Sum(e => e.Input).Should().Be(50000, "deltas add up to the running total");
    }

    [Fact]
    public void A_restarted_scanner_continues_from_the_stored_totals()
    {
        WriteTotals(1000, 100, 0, 0, 0, T0);
        _scanner.ScanAll(DateTime.MinValue);

        WriteTotals(1500, 180, 0, 0, 0, T0.AddMinutes(1));
        var db = new Database(_dir.File("hub.db"));
        var restarted = new DroidSessionScanner(_sessions, new UsageSourceContext(new TranscriptOffsetStore(db), _usage, () => PricingTable.Parse("""{ "models": {} }"""), null));
        restarted.ScanAll(DateTime.MinValue).RowsWritten.Should().Be(1);

        var last = _usage.Load(DateTimeOffset.MinValue).OrderBy(e => e.Timestamp).Last();
        (last.Input, last.Output).Should().Be((500L, 80L));
        last.ProjectRoot.Should().BeNull("there is no transcript to read the cwd from");
    }

    [Fact]
    public void Counters_that_went_down_start_a_new_count()
    {
        WriteTotals(1000, 100, 0, 0, 0, T0);
        _scanner.ScanFile(_file);
        WriteTotals(200, 20, 0, 0, 0, T0.AddMinutes(5));

        _scanner.ScanFile(_file).RowsWritten.Should().Be(1);

        _usage.Load(DateTimeOffset.MinValue).Sum(e => e.Input).Should().Be(1200);
    }

    [Fact]
    public void Old_files_and_files_without_token_usage_are_skipped()
    {
        WriteTotals(1000, 100, 0, 0, 0, T0);
        _scanner.ScanAll(T0.AddDays(1)).FilesRead.Should().Be(0);

        File.WriteAllText(_file, """{"model":"m"}""");
        _scanner.ScanFile(_file).Entries.Should().Be(0);
        File.WriteAllText(_file, "{ half written");
        _scanner.ScanFile(_file).Entries.Should().Be(0);
        _usage.Load(DateTimeOffset.MinValue).Should().BeEmpty();
    }

    [Fact]
    public void A_missing_sessions_folder_reads_nothing()
    {
        var scanner = new DroidSessionScanner(Path.Combine(_dir.Path, "nope"), new UsageSourceContext(new TranscriptOffsetStore(new Database(_dir.File("hub.db"))), _usage, () => PricingTable.Parse("""{ "models": {} }"""), null));

        scanner.ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty);
    }
}
