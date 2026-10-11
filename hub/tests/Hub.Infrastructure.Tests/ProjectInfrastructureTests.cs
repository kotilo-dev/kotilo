using Hub.Core.Projects;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;

namespace Hub.Infrastructure.Tests;

public sealed class ProjectRepositoryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly Database _db;
    private readonly ProjectRepository _repo;

    public ProjectRepositoryTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate().Should().BeGreaterThanOrEqualTo(4);
        _repo = new ProjectRepository(_db);
    }

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Activity_merges_usage_and_sessions_and_respects_cutoff()
    {
        new UsageRepository(_db).Upsert(
        [
            new UsageEntry("k1", T0.AddHours(-1), 1, 1, 0, 0, 0) { SessionId = "s1", ProjectRoot = @"C:\a" },
            new UsageEntry("k2", T0.AddHours(-3), 1, 1, 0, 0, 0) { SessionId = "s1", ProjectRoot = @"C:\a" },
            new UsageEntry("k3", T0.AddDays(-70), 1, 1, 0, 0, 0) { SessionId = "s2", ProjectRoot = @"C:\old" },
        ]);
        new SessionRepository(_db).Upsert(
            new SessionInfo("s3", @"C:\b", "b", null, SessionState.Idle, T0, T0, null, null, null, null, 0, null, null));

        var activity = _repo.Activity(T0.AddDays(-60));

        activity.Keys.Should().BeEquivalentTo([@"C:\a", @"C:\b"]);
        activity[@"C:\a"].Should().Be(T0.AddHours(-1));
        activity[@"C:\b"].Should().Be(T0);
    }

    [Fact]
    public void Discovery_keeps_flags_and_manual_add_unhides()
    {
        _repo.EnsureDiscovered([@"C:\a", @"C:\b"], T0);
        _repo.SetHidden(@"C:\a", true, T0);
        _repo.EnsureDiscovered([@"C:\a"], T0.AddDays(1));

        var a = _repo.LoadAll().Single(p => p.Root == @"C:\a");
        a.Hidden.Should().BeTrue();
        a.Manual.Should().BeFalse();
        a.DiscoveredAt.Should().Be(T0);

        _repo.AddManual(@"C:\a", T0);
        _repo.AddManual(@"C:\new", T0);
        var all = _repo.LoadAll().ToDictionary(p => p.Root);
        all[@"C:\a"].Should().Match<ProjectRecord>(p => p.Manual && !p.Hidden);
        all[@"C:\new"].Manual.Should().BeTrue();

        _repo.SetAlias(@"C:\a", "  Sipariş  ", T0);
        _repo.LoadAll().Single(p => p.Root == @"C:\a").Alias.Should().Be("Sipariş");
        _repo.SetAlias(@"C:\a", " ", T0);
        _repo.LoadAll().Single(p => p.Root == @"C:\a").Alias.Should().BeNull();

        _repo.SetHidden(@"C:\unknown", true, T0);
        _repo.LoadAll().Should().Contain(p => p.Root == @"C:\unknown" && p.Hidden);
    }
}

public sealed class TodoScannerTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_dir.Path, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void Scans_glob_matches_with_depth_limit_and_skips_tool_folders()
    {
        Write("tasks/todo.md", "- [x] a\n- [ ] b");
        Write("tasks/x/backlog.md", "- [ ] c");
        Write("tasks/1/2/3/deep.md", "- [ ] depth 3");
        Write("tasks/1/2/3/4/deeper.md", "- [ ] depth 4");
        Write("tasks/node_modules/pkg.md", "- [ ] skip");
        Write("tasks/.hidden/h.md", "- [ ] skip");
        Write("tasks/notes.txt", "- [ ] not md");
        Write("docs/todo.md", "- [ ] outside");

        var files = TodoScanner.Scan(_dir.Path, GlobPattern.Parse(null));

        files.Select(f => f.RelativePath).Should().Equal("tasks/1/2/3/deep.md", "tasks/todo.md", "tasks/x/backlog.md");
        files.Single(f => f.RelativePath == "tasks/todo.md").Done.Should().Be(1);
    }

    [Fact]
    public void Missing_base_folder_yields_nothing()
    {
        TodoScanner.Scan(_dir.Path, GlobPattern.Parse(null)).Should().BeEmpty();
        TodoScanner.WatchDirectory(_dir.Path, GlobPattern.Parse(null)).Should().BeNull();
        TodoScanner.Scan(Path.Combine(_dir.Path, "missing"), GlobPattern.Parse("*.md")).Should().BeEmpty();
    }

    [Fact]
    public void Custom_glob_at_root()
    {
        Write("TODO.md", "- [x] a");
        var files = TodoScanner.Scan(_dir.Path, GlobPattern.Parse("*.md"));
        files.Should().ContainSingle().Which.IsComplete.Should().BeTrue();
    }

    [Fact]
    public void Reads_file_held_open_for_writing()
    {
        Write("tasks/todo.md", "- [x] a");
        using var held = new FileStream(Path.Combine(_dir.Path, "tasks", "todo.md"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
        TodoScanner.Scan(_dir.Path, GlobPattern.Parse(null)).Should().ContainSingle();
    }
}

public sealed class ClaudeTaskReaderTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly ClaudeTaskReader _reader;

    public ClaudeTaskReaderTests() => _reader = new ClaudeTaskReader(_dir.Path);

    public void Dispose() => _dir.Dispose();

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_dir.Path, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void Reads_task_folder_ignoring_lock_file()
    {
        Write("tasks/s1/.lock", "");
        Write("tasks/s1/1.json", """{"id":"1","subject":"secret","status":"completed"}""");
        Write("tasks/s1/2.json", """{"id":"2","status":"in_progress"}""");
        Write("tasks/s1/3.json", """{"id":"3","status":"pending"}""");

        _reader.Read("s1").Should().Be(new TaskListProgress(1, 1, 3));
    }

    [Fact]
    public void Reads_older_todos_format()
    {
        Write("todos/s2-agent-s2.json", """[{"content":"a","status":"completed"},{"content":"b","status":"pending"}]""");
        _reader.Read("s2").Should().Be(new TaskListProgress(1, 0, 2));
    }

    [Fact]
    public void Missing_empty_or_unknown_format_is_null()
    {
        _reader.Read("none").Should().BeNull();

        Write("todos/s3-agent-s3.json", "[]");
        _reader.Read("s3").Should().BeNull();

        Write("tasks/s4/1.json", """{"id":"1","status":"pending"}""");
        Write("tasks/s4/2.json", """{"id":"2","state":"weird"}""");
        _reader.Read("s4").Should().BeNull();

        _reader.Read(@"..\escape").Should().BeNull();
    }

    [Fact]
    public void Maps_changed_paths_to_sessions()
    {
        _reader.SessionIdFor(Path.Combine(_dir.Path, "tasks", "abc", "1.json")).Should().Be("abc");
        _reader.SessionIdFor(Path.Combine(_dir.Path, "tasks", "abc")).Should().Be("abc");
        _reader.SessionIdFor(Path.Combine(_dir.Path, "todos", "abc-agent-abc.json")).Should().Be("abc");
        _reader.SessionIdFor(Path.Combine(_dir.Path, "projects", "x.jsonl")).Should().BeNull();
    }
}
