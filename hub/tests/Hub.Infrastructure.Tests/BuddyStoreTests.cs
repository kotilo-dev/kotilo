using Hub.Infrastructure.Buddy;
using Hub.Infrastructure.Data;

namespace Hub.Infrastructure.Tests;

public sealed class BuddyStoreTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 21, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Chat_list_keeps_first_title_orders_pinned_first_and_forgets()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        var repo = new BuddyChatRepository(db);

        repo.Touch("a", "  Rust string\nformat içinde   tarih?  ", "claude-haiku-4-5", T0);
        repo.Touch("b", "ikinci", null, T0.AddMinutes(1));
        repo.Touch("a", "bu ikinci mesaj başlığı değiştirmemeli", null, T0.AddMinutes(2));

        var list = repo.List(10);
        list.Select(c => c.SessionId).Should().Equal("a", "b");
        list[0].Title.Should().Be("Rust string");
        list[0].Model.Should().Be("claude-haiku-4-5", "a later null model keeps the known one");

        repo.SetPinned("b", true);
        repo.List(10)[0].SessionId.Should().Be("b");

        repo.Forget("b");
        repo.List(10).Should().ContainSingle();
    }

    [Fact]
    public void Long_titles_are_cut() =>
        BuddyChatRepository.Title(new string('x', 100)).Should().HaveLength(BuddyChatRepository.TitleLength).And.EndWith("…");

    [Fact]
    public void Transcript_reader_joins_assistant_blocks_and_skips_meta_tools_and_thinking()
    {
        var folder = Directory.CreateDirectory(Path.Combine(_dir.Path, "projects", "C--buddy")).FullName;
        File.WriteAllLines(Path.Combine(folder, "s1.jsonl"),
        [
            """{"type":"queue-operation","operation":"enqueue"}""",
            """{"type":"user","isMeta":true,"message":{"role":"user","content":"<command>meta</command>"}}""",
            """{"type":"user","message":{"role":"user","content":"2+2?"}}""",
            """{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}""",
            """{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Dört."}]}}""",
            """{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Başka?"}]}}""",
            "not json",
            """{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}""",
            """{"type":"user","message":{"role":"user","content":[{"type":"text","text":"teşekkürler"}]}}""",
        ]);

        var reader = new BuddyTranscriptReader(Path.Combine(_dir.Path, "projects"));
        reader.Read("s1").Should().Equal(
            new BuddyMessage(true, "2+2?"),
            new BuddyMessage(false, "Dört.\n\nBaşka?"),
            new BuddyMessage(true, "teşekkürler"));
        reader.Read("missing").Should().BeEmpty();
        reader.Read(@"..\x").Should().BeEmpty();
    }

    [Fact]
    public void Cli_locator_prefers_exe_on_path_then_local_bin()
    {
        var onPath = Directory.CreateDirectory(_dir.File("p")).FullName;
        var profile = Directory.CreateDirectory(_dir.File("home")).FullName;
        var localBin = Directory.CreateDirectory(Path.Combine(profile, ".local", "bin")).FullName;

        ClaudeCliLocator.Find(onPath, profile).Should().BeNull();

        File.WriteAllText(Path.Combine(localBin, "claude.exe"), "");
        ClaudeCliLocator.Find(onPath, profile).Should().Be(Path.Combine(localBin, "claude.exe"));

        File.WriteAllText(Path.Combine(onPath, "claude.cmd"), "");
        ClaudeCliLocator.Find(onPath, profile).Should().Be(Path.Combine(localBin, "claude.exe"), ".exe wins over .cmd");

        File.WriteAllText(Path.Combine(onPath, "claude.exe"), "");
        ClaudeCliLocator.Find($"\"{onPath}\";;", profile).Should().Be(Path.Combine(onPath, "claude.exe"));
    }
}
