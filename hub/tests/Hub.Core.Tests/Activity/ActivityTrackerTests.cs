using System.Globalization;
using System.Text;
using Hub.Core.Activity;
using Hub.Core.Hooks;

namespace Hub.Core.Tests.Activity;

/// <summary>Payloads are what agenthub-hook forwards after scrubbing (tool arguments reduced to metadata, no output).</summary>
public class ActivityTrackerTests
{
    private const string Root = @"C:\src\alpha";

    private readonly ActivityTracker _tracker = new();

    private static HookEvent Ev(string agent, string name, string payload, double seconds = 0)
    {
        var at = TestData.T0.AddSeconds(seconds).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        var json = $$$"""{"v":1,"agent":"{{{agent}}}","event":"{{{name}}}","receivedAt":"{{{at}}}","payload":{{{payload}}}}""";
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None, json);
        return e!;
    }

    private bool Feed(string agent, string name, string payload, double seconds = 0) => _tracker.Observe(Ev(agent, name, payload, seconds), Root);

    private IReadOnlyList<ActivityEntry> Entries(string agent, string session = "s1") => _tracker.Get(agent, session)!.Entries;

    [Fact]
    public void Claude_pre_and_post_pair_by_tool_use_id_with_relative_paths_and_duration()
    {
        Feed("claude-code", "UserPromptSubmit", """{"session_id":"s1","cwd":"C:\\src\\alpha","prompt_length":12}""");
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t1","tool_input":{"file_path":"C:\\src\\alpha\\src\\a.ts"}}""", 1);
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t2","tool_input":{"file_path":"c:/SRC/alpha/b.ts"}}""", 1.5);
        Feed("claude-code", "PostToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t2","tool_input":{"file_path":"c:/SRC/alpha/b.ts"}}""", 2);
        Feed("claude-code", "PostToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t1","tool_input":{"file_path":"C:\\src\\alpha\\src\\a.ts"}}""", 4);

        var entries = Entries("claude-code");
        entries.Should().HaveCount(3);
        entries[0].Kind.Should().Be(ActivityKind.Turn);
        entries[0].At.Should().Be(TestData.T0);
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Read, Tool = "Read", Target = "src/a.ts", DurationMs = 3000L, Status = ActivityStatus.Ok });
        entries[2].Should().BeEquivalentTo(new { Target = "b.ts", DurationMs = 500L, Status = ActivityStatus.Ok });
        entries.Select(x => x.Id).Should().BeInAscendingOrder();
    }

    [Fact]
    public void Gemini_pairs_fifo_by_tool_name_without_ids()
    {
        Feed("gemini", "BeforeTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"npm test"}}""");
        Feed("gemini", "BeforeTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"npm run lint"}}""", 1);
        Feed("gemini", "AfterTool", """{"session_id":"s1","tool_name":"run_shell_command","tool_input":{"command":"npm test"}}""", 5);

        var entries = Entries("gemini");
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, Target = "npm test", Status = ActivityStatus.Ok, DurationMs = 5000L });
        entries[1].Status.Should().Be(ActivityStatus.Running);
    }

    [Fact]
    public void Copilot_post_only_events_create_completed_entries()
    {
        Feed("copilot", "postToolUse", """{"sessionId":"s1","cwd":"C:\\src\\alpha","toolName":"edit","toolArgs":"{\"path\":\"C:\\\\src\\\\alpha\\\\README.md\"}"}""");
        Feed("copilot", "postToolUseFailure", """{"sessionId":"s1","toolName":"bash","toolArgs":"{\"command\":\"npm test\"}"}""", 2);

        var entries = Entries("copilot");
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Edit, Target = "README.md", Status = ActivityStatus.Ok, At = TestData.T0 });
        entries[0].DurationMs.Should().BeNull();
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, Target = "npm test", Status = ActivityStatus.Failed });
    }

    [Fact]
    public void Copilot_permission_without_a_post_before_the_turn_ends_is_denied()
    {
        Feed("copilot", "permissionRequest", """{"sessionId":"s1","toolName":"powershell","toolInput":{"command":"rm -r build"}}""");
        Entries("copilot")[0].Status.Should().Be(ActivityStatus.Running);
        Feed("copilot", "agentStop", """{"sessionId":"s1"}""", 3);

        Entries("copilot")[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, Target = "rm -r build", Status = ActivityStatus.Denied });

        Feed("copilot", "permissionRequest", """{"sessionId":"s1","toolName":"powershell","toolInput":{"command":"npm ci"}}""", 4);
        Feed("copilot", "postToolUse", """{"sessionId":"s1","toolName":"powershell","toolArgs":"{\"command\":\"npm ci\"}"}""", 6);
        Entries("copilot").Should().HaveCount(2, "the approved call's post finishes the permission entry");
        Entries("copilot")[1].Should().BeEquivalentTo(new { Status = ActivityStatus.Ok, DurationMs = 2000L });
    }

    [Fact]
    public void Claude_permission_request_then_stop_is_denied_and_an_approved_one_is_ok()
    {
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"git push"}}""");
        Feed("claude-code", "PermissionRequest", """{"session_id":"s1","tool_name":"Bash","tool_input":{"command":"git push"}}""", 1);
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Edit","tool_use_id":"t2","tool_input":{"file_path":"C:\\src\\alpha\\a.ts"}}""", 2);
        Feed("claude-code", "Notification", """{"session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission to use Edit"}""", 3);
        Feed("claude-code", "PostToolUse", """{"session_id":"s1","tool_name":"Edit","tool_use_id":"t2","tool_input":{"file_path":"C:\\src\\alpha\\a.ts"}}""", 4);
        Feed("claude-code", "Stop", """{"session_id":"s1"}""", 5);

        var entries = Entries("claude-code");
        entries.Should().HaveCount(2, "the permission request joins its PreToolUse entry");
        entries[0].Status.Should().Be(ActivityStatus.Denied);
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Edit, Status = ActivityStatus.Ok });
    }

    [Fact]
    public void Codex_interrupt_fails_running_tools_and_apply_patch_lists_its_files()
    {
        Feed("codex", "PreToolUse", """{"session_id":"s1","tool_name":"apply_patch","tool_use_id":"c1","tool_input":{"paths":["src/a.rs","C:\\src\\alpha\\docs\\b.md","D:\\other\\c.rs"]}}""");
        Feed("codex", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"c2","tool_input":{"command":"cargo build"}}""", 1);
        Feed("codex", "PostToolUse", """{"session_id":"s1","tool_name":"apply_patch","tool_use_id":"c1","tool_input":{"paths":["src/a.rs"]}}""", 2);
        Feed("codex", "Interrupt", """{"session_id":"s1"}""", 3);

        var entries = Entries("codex");
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Edit, Target = "src/a.rs", Status = ActivityStatus.Ok });
        entries[0].Paths.Should().Equal("src/a.rs", "docs/b.md", @"D:\other\c.rs");
        entries[1].Status.Should().Be(ActivityStatus.Failed);
    }

    [Fact]
    public void Qwen_failure_absolute_path_and_continuation_prompts()
    {
        Feed("qwen", "UserPromptSubmit", """{"session_id":"s1","has_submitted_prompt":true,"prompt_length":5}""");
        Feed("qwen", "PreToolUse", """{"session_id":"s1","tool_name":"read_file","tool_use_id":"q1","tool_input":{"absolute_path":"C:\\src\\alpha\\pkg\\x.py"}}""", 1);
        Feed("qwen", "PostToolUseFailure", """{"session_id":"s1","tool_name":"read_file","tool_use_id":"q1","is_interrupt":false}""", 2);
        Feed("qwen", "UserPromptSubmit", """{"session_id":"s1","prompt_length":5}""", 3);
        Feed("qwen", "PostToolUse", """{"session_id":"s1","tool_name":"run_shell_command","tool_use_id":"q2","duration_ms":6800,"tool_input":{"command":"pytest"}}""", 10);

        var entries = Entries("qwen");
        entries.Count(x => x.Kind == ActivityKind.Turn).Should().Be(1, "a tool-result continuation is not a user prompt");
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Read, Target = "pkg/x.py", Status = ActivityStatus.Failed });
        entries[2].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, DurationMs = 6800L, Status = ActivityStatus.Ok });
        entries[2].At.Should().Be(TestData.T0.AddSeconds(10).AddMilliseconds(-6800));
    }

    [Fact]
    public void Cursor_observational_events_map_and_a_double_report_is_merged()
    {
        Feed("cursor", "postToolUse", """{"conversation_id":"s1","workspace_roots":["C:/src/alpha"],"tool_name":"Shell","tool_input":{"command":"npm test"},"tool_use_id":"tool_01","duration":5130}""");
        Feed("cursor", "afterShellExecution", """{"conversation_id":"s1","command":"npm test","duration":5120}""", 0.2);
        Feed("cursor", "afterFileEdit", """{"conversation_id":"s1","file_path":"C:/src/alpha/src/app.ts"}""", 3);

        var entries = Entries("cursor");
        entries.Should().HaveCount(2);
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, Target = "npm test", DurationMs = 5130L, Status = ActivityStatus.Ok });
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Edit, Tool = "Edit", Target = "src/app.ts" });
    }

    [Fact]
    public void Droid_permission_notification_marks_the_running_tool()
    {
        Feed("droid", "PreToolUse", """{"session_id":"s1","tool_name":"Execute","tool_input":{"command":"rm -rf dist","riskLevel":"high"}}""");
        Feed("droid", "Notification", """{"session_id":"s1","notification_type":"permission_prompt","message":"Droid needs your permission to use Execute"}""", 1);
        Feed("droid", "Notification", """{"session_id":"s1","notification_type":"idle_prompt","message":"waiting"}""", 2);
        Feed("droid", "UserPromptSubmit", """{"session_id":"s1","prompt_length":3}""", 3);

        var entries = Entries("droid");
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Bash, Target = "rm -rf dist", Status = ActivityStatus.Denied });
        entries[1].Kind.Should().Be(ActivityKind.Turn);
    }

    [Fact]
    public void OpenCode_tool_events_pair_by_tool_use_id()
    {
        Feed("opencode", "session.tool.called", """{"sessionId":"ses_1","toolUseId":"call_1","tool":"edit","path":"C:/src/alpha/app.ts","cwd":"C:/src/alpha"}""");
        Feed("opencode", "session.tool.called", """{"sessionId":"ses_1","toolUseId":"call_2","tool":"grep","pattern":"TODO"}""", 1);
        Feed("opencode", "session.tool.success", """{"sessionId":"ses_1","toolUseId":"call_1","tool":"edit"}""", 2);
        Feed("opencode", "session.tool.failed", """{"sessionId":"ses_1","toolUseId":"call_2","tool":"grep"}""", 3);

        var entries = Entries("opencode", "ses_1");
        entries[0].Should().BeEquivalentTo(new { Kind = ActivityKind.Edit, Target = "app.ts", Status = ActivityStatus.Ok, DurationMs = 2000L });
        entries[1].Should().BeEquivalentTo(new { Kind = ActivityKind.Search, Target = "TODO", Status = ActivityStatus.Failed });
    }

    [Fact]
    public void Todo_write_sets_the_plan_and_the_latest_wins()
    {
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"TodoWrite","tool_use_id":"t1","tool_input":{"todos":[{"content":"Write tests","status":"in_progress"},{"content":"Ship","status":"pending"}]}}""");
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"TodoWrite","tool_use_id":"t2","tool_input":{"todos":[{"content":"Write tests","status":"completed"},{"content":"Ship","status":"weird"}]}}""", 1);

        var plan = _tracker.Get("claude-code", "s1")!.Plan!;
        plan.Items.Should().Equal(new TodoItem("Write tests", "completed"), new TodoItem("Ship", "pending"));
    }

    [Fact]
    public void Paths_outside_the_project_stay_absolute_and_commands_are_clipped()
    {
        var command = new string('x', 300) + "\nsecond line";
        Feed("claude-code", "PreToolUse", $$$"""{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"{{{command.Replace("\n", "\\n", StringComparison.Ordinal)}}}"}}""");
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Read","tool_use_id":"t2","tool_input":{"file_path":"C:\\src\\alphabet\\a.ts"}}""", 1);
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Grep","tool_use_id":"t3","tool_input":{"pattern":"TODO","path":"src"}}""", 2);
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"mcp__github__create_issue","tool_use_id":"t4","tool_input":{}}""", 3);

        var entries = Entries("claude-code");
        entries[0].Target.Should().HaveLength(ActivityTracker.MaxTargetLength);
        entries[1].Target.Should().Be(@"C:\src\alphabet\a.ts", "a sibling folder with the same prefix is outside the project");
        entries[2].Should().BeEquivalentTo(new { Kind = ActivityKind.Search, Target = "src" });
        entries[3].Should().BeEquivalentTo(new { Kind = ActivityKind.Other, Target = (string?)null });
    }

    [Fact]
    public void The_ring_keeps_the_last_200_entries()
    {
        for (var i = 0; i < 250; i++)
        {
            Feed("copilot", "postToolUse", $$$"""{"sessionId":"s1","toolName":"view","toolArgs":"{\"path\":\"f{{{i}}}.txt\"}"}""", i * 10);
        }

        var entries = Entries("copilot");
        entries.Should().HaveCount(ActivityTracker.MaxEntries);
        entries[0].Target.Should().Be("f50.txt");
        entries[^1].Target.Should().Be("f249.txt");
    }

    [Fact]
    public void Drain_returns_new_and_changed_entries_once_per_session()
    {
        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"ls"}}""");
        var first = _tracker.DrainChanges();
        first.Should().ContainSingle().Which.Entries.Should().ContainSingle().Which.Status.Should().Be(ActivityStatus.Running);
        _tracker.DrainChanges().Should().BeEmpty();

        Feed("claude-code", "PostToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"ls"}}""", 1);
        Feed("codex", "UserPromptSubmit", """{"session_id":"s2"}""", 1);
        var second = _tracker.DrainChanges();
        second.Should().HaveCount(2);
        second.Single(d => d.Agent == "claude-code").Entries.Single().Status.Should().Be(ActivityStatus.Ok);
    }

    [Fact]
    public void Session_events_alone_start_no_timeline_and_rings_are_pruned_after_the_end()
    {
        Feed("claude-code", "SessionStart", """{"session_id":"s1","source":"startup"}""").Should().BeFalse();
        _tracker.Get("claude-code", "s1").Should().BeNull();

        Feed("claude-code", "PreToolUse", """{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"ls"}}""");
        Feed("claude-code", "SessionEnd", """{"session_id":"s1","reason":"exit"}""", 10);
        Entries("claude-code")[0].Status.Should().Be(ActivityStatus.Failed);

        _tracker.Prune(TestData.T0.AddMinutes(5), (_, _) => null).Should().Be(0);
        _tracker.Prune(TestData.T0.AddSeconds(10) + ActivityTracker.EndedRetention, (_, _) => null).Should().Be(1);
        _tracker.Get("claude-code", "s1").Should().BeNull();

        Feed("codex", "UserPromptSubmit", """{"session_id":"s2"}""");
        _tracker.Prune(TestData.T0.AddMinutes(1), (_, _) => TestData.T0.AddMinutes(-20)).Should().Be(1, "the session tracker saw it end");
    }

    [Theory]
    [InlineData("Read", ActivityKind.Read)]
    [InlineData("LS", ActivityKind.Read)]
    [InlineData("view", ActivityKind.Read)]
    [InlineData("Grep", ActivityKind.Search)]
    [InlineData("Glob", ActivityKind.Search)]
    [InlineData("search_file_content", ActivityKind.Search)]
    [InlineData("WebFetch", ActivityKind.Search)]
    [InlineData("Edit", ActivityKind.Edit)]
    [InlineData("MultiEdit", ActivityKind.Edit)]
    [InlineData("replace", ActivityKind.Edit)]
    [InlineData("ApplyPatch", ActivityKind.Edit)]
    [InlineData("Write", ActivityKind.Write)]
    [InlineData("Create", ActivityKind.Write)]
    [InlineData("write_file", ActivityKind.Write)]
    [InlineData("Bash", ActivityKind.Bash)]
    [InlineData("Execute", ActivityKind.Bash)]
    [InlineData("powershell", ActivityKind.Bash)]
    [InlineData("run_shell_command", ActivityKind.Bash)]
    [InlineData("Task", ActivityKind.Task)]
    [InlineData("TodoWrite", ActivityKind.Other)]
    [InlineData("mcp__x__read", ActivityKind.Other)]
    [InlineData(null, ActivityKind.Other)]
    public void Tool_names_map_to_kinds(string? tool, ActivityKind expected) => ActivityTracker.KindOf(tool).Should().Be(expected);

    [Theory]
    [InlineData(@"C:\src\alpha\a\b.ts", @"C:\src\alpha", "a/b.ts")]
    [InlineData("C:/src/alpha/a.ts", @"C:\src\alpha\", "a.ts")]
    [InlineData(@"c:\SRC\Alpha\a.ts", @"C:\src\alpha", "a.ts")]
    [InlineData(@"C:\src\alpha", @"C:\src\alpha", @"C:\src\alpha")]
    [InlineData(@"C:\src\alphabet\a.ts", @"C:\src\alpha", @"C:\src\alphabet\a.ts")]
    [InlineData("/home/u/app/src/a.ts", "/home/u/app", "src/a.ts")]
    [InlineData("/home/u/App/a.ts", "/home/u/app", "/home/u/App/a.ts")]
    [InlineData("src/a.ts", @"C:\src\alpha", "src/a.ts")]
    public void Relative_paths(string path, string root, string expected) => ActivityTracker.RelativeTo(path, root).Should().Be(expected);
}
