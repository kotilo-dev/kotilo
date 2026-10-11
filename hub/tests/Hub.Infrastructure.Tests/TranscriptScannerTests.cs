using System.Globalization;
using System.Text;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

public sealed class TranscriptScannerTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 30, 18, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly string _projects;
    private readonly string _file;
    private readonly UsageRepository _usage;
    private readonly TranscriptScanner _scanner;

    public TranscriptScannerTests()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        _usage = new UsageRepository(db);
        _projects = Path.Combine(_dir.Path, "projects");
        Directory.CreateDirectory(Path.Combine(_projects, "C--src-alpha"));
        _file = Path.Combine(_projects, "C--src-alpha", "sess-1.jsonl");
        var pricing = PricingTable.Parse(PricingProvider.DefaultJson());
        _scanner = new TranscriptScanner(_projects, new TranscriptOffsetStore(db), _usage, () => pricing);
    }

    public void Dispose() => _dir.Dispose();

    private static string Line(string messageId, int output, int minute = 0, string? requestId = "r")
    {
        var ts = T0.AddMinutes(minute).UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        var req = requestId is null ? "" : $",\"requestId\":\"{requestId}{messageId}\"";
        return "{\"type\":\"assistant\",\"timestamp\":\"" + ts + "\",\"sessionId\":\"sess-1\",\"cwd\":\"C:\\\\src\\\\alpha\"" + req
            + ",\"message\":{\"id\":\"" + messageId + "\",\"model\":\"claude-opus-5-5\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":"
            + output.ToString(CultureInfo.InvariantCulture) + ",\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}";
    }

    private void Append(string text) => File.AppendAllText(_file, text, new UTF8Encoding(false));

    private IReadOnlyList<UsageEntry> Stored() => _usage.Load(DateTimeOffset.MinValue);

    [Fact]
    public void Reads_new_lines_incrementally()
    {
        Append(Line("m1", 10) + "\n" + """{"type":"user","message":{"content":"x"}}""" + "\n");
        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(1);

        Append(Line("m2", 20, minute: 1) + "\n");
        var second = _scanner.ScanAll(DateTime.MinValue);

        second.Entries.Should().Be(1, "only the appended line is read");
        Stored().Select(e => e.Output).Should().Equal(10, 20);
    }

    [Fact]
    public void Unchanged_file_is_skipped()
    {
        Append(Line("m1", 10) + "\n");
        _scanner.ScanAll(DateTime.MinValue);

        _scanner.ScanAll(DateTime.MinValue).FilesRead.Should().Be(0);
    }

    [Fact]
    public void Half_written_last_line_is_read_on_the_next_pass()
    {
        var line = Line("m1", 10);
        Append(line[..40]);
        var first = _scanner.ScanAll(DateTime.MinValue);
        first.Entries.Should().Be(0);
        first.InvalidLines.Should().Be(0, "an unterminated tail is not counted as corrupt");

        Append(line[40..] + "\n");
        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(1);
        Stored().Should().ContainSingle();
    }

    [Fact]
    public void Duplicate_lines_count_once_with_larger_usage()
    {
        Append(Line("m1", 10) + "\n" + Line("m1", 10) + "\n" + Line("m1", 15) + "\n");
        _scanner.ScanAll(DateTime.MinValue);

        Stored().Should().ContainSingle().Which.Output.Should().Be(15);
    }

    [Fact]
    public void Shrunk_file_is_reread_without_double_counting()
    {
        Append(Line("m1", 10) + "\n" + Line("m2", 20, 1) + "\n");
        _scanner.ScanAll(DateTime.MinValue);

        File.WriteAllText(_file, Line("m1", 10) + "\n", new UTF8Encoding(false));
        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(1);

        Stored().Should().HaveCount(2, "rows are kept; dedup keys stop double counting");
        Stored().Sum(e => e.Output).Should().Be(30);
    }

    [Fact]
    public void Corrupt_middle_line_is_skipped_and_counted()
    {
        Append(Line("m1", 10) + "\n{not json\n" + Line("m2", 20, 1) + "\n");

        var result = _scanner.ScanAll(DateTime.MinValue);

        result.Entries.Should().Be(2);
        result.InvalidLines.Should().Be(1);
    }

    [Fact]
    public void Old_files_are_skipped_by_cutoff()
    {
        Append(Line("m1", 10) + "\n");
        File.SetLastWriteTimeUtc(_file, DateTime.UtcNow.AddDays(-40));

        _scanner.ScanAll(DateTime.UtcNow.AddDays(-35)).FilesRead.Should().Be(0);
    }

    [Fact]
    public void Costs_are_priced_at_ingest()
    {
        Append(Line("m1", 1_000_000) + "\n");
        _scanner.ScanAll(DateTime.MinValue);

        Stored()[0].CostUsd.Should().Be(20m + 0.000004m);
    }

    [Fact]
    public void Crlf_line_endings_are_handled()
    {
        Append(Line("m1", 10) + "\r\n" + Line("m2", 20, 1) + "\r\n");
        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(2);
    }

    [Fact]
    public void Lines_split_across_read_chunks_are_reassembled()
    {
        var big = new string('x', 100_000);
        var line = Line("m1", 10).Replace("\"content\":[]", $"\"content\":[{{\"type\":\"text\",\"text\":\"{big}\"}}]", StringComparison.Ordinal);
        Append(line + "\n" + Line("m2", 20, 1) + "\n");

        _scanner.ScanAll(DateTime.MinValue).Entries.Should().Be(2);
    }

    [Fact]
    public void Missing_projects_folder_is_fine()
    {
        var scanner = new TranscriptScanner(_dir.File("none"), null!, null!, () => PricingTable.Empty);
        scanner.ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty);
    }
}
