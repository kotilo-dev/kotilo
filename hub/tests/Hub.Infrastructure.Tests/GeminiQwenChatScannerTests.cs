using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Gemini;
using Hub.Infrastructure.Qwen;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

/// <summary>Gemini CLI and Qwen Code usage sources on temp agent homes built from the adapters' chat fixtures.</summary>
public sealed class GeminiQwenChatScannerTests : IDisposable
{
    private const string GeminiSession = "7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10";
    private const string QwenSession = "1f6b3c2a-8e47-4d0b-b2a1-9c3e5d7f0a11";
    private readonly TempDir _dir = new();
    private readonly Database _db;
    private readonly UsageSourceContext _context;

    public GeminiQwenChatScannerTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate();
        _context = new UsageSourceContext(
            new TranscriptOffsetStore(_db), new UsageRepository(_db), () => PricingTable.Parse(PricingProvider.DefaultJson()), null);
    }

    public void Dispose() => _dir.Dispose();

    private string GeminiDir => Path.Combine(_dir.Path, ".gemini");

    private List<UsageEntry> Rows() => _context.Repository.Load(DateTimeOffset.MinValue.AddYears(2000)).OrderBy(e => e.Timestamp).ToList();

    private string GeminiChat(string slug, string projectRoot, string[] lines, bool marker = true)
    {
        var chats = Path.Combine(GeminiDir, "tmp", slug, "chats");
        Directory.CreateDirectory(chats);
        if (marker)
        {
            File.WriteAllText(Path.Combine(GeminiDir, "tmp", slug, ".project_root"), projectRoot);
        }

        var path = Path.Combine(chats, "session-2026-10-06T09-15-7b0c2f9e.jsonl");
        File.WriteAllLines(path, lines);
        return path;
    }

    private static string[] GeminiLines => File.ReadAllLines(GeminiQwenHooksTests.Fixture("gemini", "chat-session.jsonl"));

    [Fact]
    public void Gemini_scan_stores_each_message_once_with_the_marker_project()
    {
        var path = GeminiChat("shop-api", @"C:\work\shop-api", GeminiLines);
        var scanner = new GeminiChatScanner(GeminiDir, _context);

        scanner.Owns(path).Should().BeTrue();
        var result = scanner.ScanAll(DateTime.MinValue);

        result.Entries.Should().Be(3, "m-g2 is appended twice");
        var rows = Rows();
        rows.Should().HaveCount(2);
        rows.Should().OnlyContain(e => e.Agent == "gemini" && e.SessionId == GeminiSession && e.ProjectRoot == @"C:\work\shop-api");
        rows.Sum(e => e.Input).Should().Be(18234 - 12000 + (19102 - 18000 + 12));
        rows.Should().OnlyContain(e => e.CostUsd == null, "no Gemini prices are shipped");

        scanner.ScanAll(DateTime.MinValue).Should().Be(ScanResult.Empty, "nothing changed");
    }

    [Fact]
    public void Gemini_appended_lines_are_read_from_the_offset_with_the_header_replayed()
    {
        var lines = GeminiLines;
        var path = GeminiChat("shop-api", @"C:\work\shop-api", lines[..5]);
        var scanner = new GeminiChatScanner(GeminiDir, _context);
        scanner.ScanFile(path).Entries.Should().Be(1);

        File.AppendAllLines(path, lines[5..]);
        var second = scanner.ScanFile(path);

        second.Entries.Should().Be(2);
        Rows().Select(e => e.DedupKey).Should().Equal($"gemini:{GeminiSession}:m-g1", $"gemini:{GeminiSession}:m-g2");
    }

    [Fact]
    public void Gemini_project_falls_back_to_the_registry_and_legacy_files_are_read()
    {
        GeminiChat("shop-api-1", "unused", GeminiLines, marker: false);
        File.WriteAllText(Path.Combine(GeminiDir, "projects.json"), """{ "projects": { "c:\\work\\shop-api": "shop-api-1" } }""");
        var legacyChats = Path.Combine(GeminiDir, "tmp", "1111111111111111111111111111111111111111111111111111111111111111", "chats");
        Directory.CreateDirectory(legacyChats);
        File.Copy(GeminiQwenHooksTests.Fixture("gemini", "chat-legacy.json"), Path.Combine(legacyChats, "session-2025-06-01T10-00-5d1e7a20.json"));

        new GeminiChatScanner(GeminiDir, _context).ScanAll(DateTime.MinValue);

        var rows = Rows();
        rows.Should().HaveCount(3);
        rows.Where(e => e.SessionId == GeminiSession).Should().OnlyContain(e => e.ProjectRoot == @"c:\work\shop-api");
        rows.Single(e => e.SessionId != GeminiSession).ProjectRoot.Should().BeNull("a hash folder is never decoded");
    }

    [Fact]
    public void Gemini_ignores_other_files_and_the_hubs_own_ai_runs()
    {
        var scratch = Path.Combine(_dir.Path, "data", "buddy", "ai-scratch");
        GeminiChat("ai-scratch", scratch, GeminiLines);
        var logs = Path.Combine(GeminiDir, "tmp", "shop-api", "logs.json");
        Directory.CreateDirectory(Path.GetDirectoryName(logs)!);
        File.WriteAllText(logs, "[]");
        var scanner = new GeminiChatScanner(GeminiDir, _context, scratch);

        scanner.Owns(logs).Should().BeFalse();
        scanner.Owns(Path.Combine(GeminiDir, "antigravity", "x.jsonl")).Should().BeFalse();
        scanner.ScanAll(DateTime.MinValue);

        Rows().Should().BeEmpty();
    }

    [Fact]
    public void Qwen_scan_reads_assistant_usage_only_and_skips_ai_runs()
    {
        var projects = Path.Combine(_dir.Path, ".qwen", "projects");
        var chats = Path.Combine(projects, "c--work-shop-api", "chats");
        Directory.CreateDirectory(chats);
        var path = Path.Combine(chats, QwenSession + ".jsonl");
        File.Copy(GeminiQwenHooksTests.Fixture("qwen", "chat-session.jsonl"), path);
        var scratch = Path.Combine(_dir.Path, "data", "buddy", "ai-scratch");
        var aiChats = Path.Combine(projects, "c--data-ai-scratch", "chats");
        Directory.CreateDirectory(aiChats);
        File.WriteAllText(Path.Combine(aiChats, "ai.jsonl"),
            "{\"uuid\":\"a\",\"sessionId\":\"ai\",\"timestamp\":\"2026-10-06T10:00:00Z\",\"type\":\"assistant\",\"cwd\":" + System.Text.Json.JsonSerializer.Serialize(scratch)
            + ",\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":5}}\n");
        var scanner = new QwenChatScanner(Path.Combine(_dir.Path, ".qwen"), _context, scratch);

        scanner.Owns(path).Should().BeTrue();
        scanner.Owns(Path.Combine(_dir.Path, ".qwen", "tmp", "x", "chats", "a.jsonl")).Should().BeFalse();
        scanner.ScanAll(DateTime.MinValue);

        var rows = Rows();
        rows.Select(e => e.DedupKey).Should().Equal($"qwen:{QwenSession}:r2", $"qwen:{QwenSession}:r4");
        rows.Sum(e => e.Output).Should().Be(64 + 72 + 20, "ui_telemetry repeats the numbers and is not counted");
        rows.Should().OnlyContain(e => e.ProjectRoot == @"C:\work\shop-api" && e.Model == "qwen3-coder-plus");

        File.AppendAllText(path, File.ReadAllLines(GeminiQwenHooksTests.Fixture("qwen", "chat-session.jsonl"))[3].Replace("\"r4\"", "\"r6\"", StringComparison.Ordinal) + "\n");
        scanner.ScanFile(path).Entries.Should().Be(1, "only the appended line is read");
    }
}
