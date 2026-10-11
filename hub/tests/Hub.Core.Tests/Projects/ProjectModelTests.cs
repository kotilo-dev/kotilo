using System.Text;
using Hub.Core.Projects;

namespace Hub.Core.Tests.Projects;

public class GlobPatternTests
{
    [Theory]
    [InlineData("tasks/todo.md", true)]
    [InlineData("tasks/sub/plan.md", true)]
    [InlineData("tasks/a/b/c.MD", true)]
    [InlineData(@"tasks\win\style.md", true)]
    [InlineData("tasks/todo.txt", false)]
    [InlineData("docs/todo.md", false)]
    [InlineData("tasksx/todo.md", false)]
    [InlineData("todo.md", false)]
    public void Default_pattern(string path, bool expected)
    {
        var glob = GlobPattern.Parse(null);
        glob.Pattern.Should().Be(GlobPattern.Default);
        glob.BaseDirectory.Should().Be("tasks");
        glob.IsMatch(path).Should().Be(expected);
    }

    [Fact]
    public void Single_star_stays_in_one_folder()
    {
        var glob = GlobPattern.Parse("docs/*.md");
        glob.IsMatch("docs/a.md").Should().BeTrue();
        glob.IsMatch("docs/x/a.md").Should().BeFalse();
    }

    [Fact]
    public void Plain_file_path_and_backslashes()
    {
        var glob = GlobPattern.Parse(@"\TODO.md");
        glob.BaseDirectory.Should().BeEmpty();
        glob.IsMatch("todo.md").Should().BeTrue();
        glob.IsMatch("sub/todo.md").Should().BeFalse();
    }

    [Fact]
    public void Leading_double_star_matches_any_depth()
    {
        var glob = GlobPattern.Parse("**/TODO?.md");
        glob.BaseDirectory.Should().BeEmpty();
        glob.IsMatch("TODO1.md").Should().BeTrue();
        glob.IsMatch("a/b/todo2.md").Should().BeTrue();
        glob.IsMatch("a/todo.md").Should().BeFalse();
    }

    [Fact]
    public void Regex_characters_are_literal() => GlobPattern.Parse("a+b/(x).md").IsMatch("a+b/(x).md").Should().BeTrue();
}

public class ProjectProgressTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);

    private static TodoFile File(string path, string md, int minutes = 0) => new(path, TodoParser.Parse(md), T0.AddMinutes(minutes));

    private static ProjectProgress Project(params TodoFile[] files) => new(@"C:\dev\p", "p", false, false, T0, files);

    [Fact]
    public void Totals_percent_next_and_last_change_span_files()
    {
        var p = Project(
            File("tasks/a.md", "- [x] 1\n- [x] 2", 5),
            File("tasks/b.md", "## B\n- [~] 3\n- [ ] 4", 1));

        p.Done.Should().Be(2);
        p.InProgress.Should().Be(1);
        p.Total.Should().Be(4);
        p.Percent.Should().Be(50);
        p.LastTodoChange.Should().Be(T0.AddMinutes(5));
        var next = p.Next!.Value;
        next.File.RelativePath.Should().Be("tasks/b.md");
        next.Item.Text.Should().Be("3");
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(1, 3, 33)]
    [InlineData(199, 200, 99)]
    [InlineData(5, 5, 100)]
    public void Percentage_rounds_down(int done, int total, int expected) =>
        ProjectProgress.Percentage(done, total).Should().Be(expected);

    [Fact]
    public void Project_without_files_has_no_todos()
    {
        var p = Project();
        p.HasTodos.Should().BeFalse();
        p.Next.Should().BeNull();
        p.LastTodoChange.Should().BeNull();
    }
}

public class TodoCompletionDetectorTests
{
    private static ProjectProgress Scan(string md, string path = "tasks/todo.md") =>
        new(@"C:\dev\p", "p", false, false, null, [new TodoFile(path, TodoParser.Parse(md), DateTimeOffset.UnixEpoch)]);

    [Fact]
    public void First_scan_is_a_baseline_even_when_complete()
    {
        new TodoCompletionDetector().Observe(Scan("- [x] a")).Should().BeEmpty();
    }

    [Fact]
    public void Fires_once_when_a_file_reaches_100_percent()
    {
        var detector = new TodoCompletionDetector();
        detector.Observe(Scan("- [x] a\n- [ ] b"));

        var fired = detector.Observe(Scan("- [x] a\n- [x] b")).Should().ContainSingle().Subject;
        fired.RelativePath.Should().Be("tasks/todo.md");
        fired.Total.Should().Be(2);

        detector.Observe(Scan("- [x] a\n- [x] b")).Should().BeEmpty();
    }

    [Fact]
    public void Reopening_and_completing_again_fires_again()
    {
        var detector = new TodoCompletionDetector();
        detector.Observe(Scan("- [ ] a"));
        detector.Observe(Scan("- [x] a")).Should().HaveCount(1);
        detector.Observe(Scan("- [x] a\n- [ ] new"));
        detector.Observe(Scan("- [x] a\n- [x] new")).Should().HaveCount(1);
    }

    [Fact]
    public void Empty_file_and_in_progress_items_are_not_complete()
    {
        var detector = new TodoCompletionDetector();
        detector.Observe(Scan("- [ ] a"));
        detector.Observe(Scan("- [~] a")).Should().BeEmpty();
        detector.Observe(Scan("no items")).Should().BeEmpty();
    }

    [Fact]
    public void New_file_appearing_complete_does_not_fire()
    {
        var detector = new TodoCompletionDetector();
        detector.Observe(Scan("- [ ] a"));
        detector.Observe(Scan("- [x] a", "tasks/other.md")).Should().BeEmpty();
    }
}

public class ClaudeTaskParserTests
{
    private static TaskListProgress? Parse(string json) => ClaudeTaskParser.Parse(Encoding.UTF8.GetBytes(json));

    [Fact]
    public void Single_task_file_format()
    {
        Parse("""{"id":"1","subject":"s","status":"in_progress","blocks":[]}""").Should().Be(new TaskListProgress(0, 1, 1));
        Parse("""{"id":"2","status":"completed"}""").Should().Be(new TaskListProgress(1, 0, 1));
        Parse("""{"id":"3","status":"deleted"}""").Should().Be(TaskListProgress.Empty);
    }

    [Fact]
    public void Todo_array_format()
    {
        Parse("""[{"content":"a","status":"completed"},{"content":"b","status":"pending"},{"content":"c","status":"in_progress"}]""")
            .Should().Be(new TaskListProgress(1, 1, 3));
        Parse("[]").Should().Be(TaskListProgress.Empty);
    }

    [Theory]
    [InlineData("""{"id":"1"}""")]
    [InlineData("""{"status":"blocked"}""")]
    [InlineData("""{"status":3}""")]
    [InlineData("""[{"status":"pending"},{"x":1}]""")]
    [InlineData("42")]
    [InlineData("{not json")]
    [InlineData("")]
    public void Unknown_formats_yield_null(string json) => Parse(json).Should().BeNull();
}
