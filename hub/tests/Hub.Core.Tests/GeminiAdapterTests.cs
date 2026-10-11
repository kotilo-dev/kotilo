using System.Text.Json.Nodes;
using Hub.Core.Adapters;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests;

/// <summary>Gemini CLI hook mapping on the synthetic payloads in <c>adapters/gemini/fixtures/hooks.jsonl</c>.</summary>
public class GeminiAdapterTests
{
    /// <summary>The fixture's payloads, each wrapped in an envelope as agenthub-hook sends it (from pane-1).</summary>
    internal static IReadOnlyList<HookEvent> FixtureEvents(string agent)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "adapters")))
        {
            dir = dir.Parent;
        }

        var lines = File.ReadAllLines(Path.Combine(dir!.FullName, "adapters", agent, "fixtures", "hooks.jsonl"));
        return lines.Where(l => l.Length > 0).Select(l => Parse(agent, JsonNode.Parse(l)!.AsObject())).ToList();
    }

    internal static HookEvent Parse(string agent, JsonObject payload)
    {
        // The sidecar's Qwen rule (crates/hook): a real submit is flagged, the text itself never arrives.
        if (agent == AgentIds.Qwen && payload.ContainsKey("submitted_prompt"))
        {
            payload["has_submitted_prompt"] = true;
        }

        var envelope = new JsonObject
        {
            ["v"] = 1,
            ["agent"] = agent,
            ["event"] = payload["hook_event_name"]!.GetValue<string>(),
            ["receivedAt"] = payload["timestamp"]!.GetValue<string>(),
            ["paneId"] = "pane-1",
            ["payload"] = payload,
        };
        var e = HookEventParser.Parse(System.Text.Encoding.UTF8.GetBytes(envelope.ToJsonString()), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }

    private static HookEvent Single(string eventName, int occurrence = 0) =>
        FixtureEvents(AgentIds.Gemini).Where(e => e.HookEventName == eventName).ElementAt(occurrence);

    [Fact]
    public void Fixture_events_map_to_normalized_kinds()
    {
        FixtureEvents(AgentIds.Gemini).Select(e => (e.HookEventName, e.Kind)).Should().Equal(
            ("SessionStart", HookEventKind.SessionStart),
            ("BeforeAgent", HookEventKind.UserPromptSubmit),
            ("BeforeTool", HookEventKind.PreToolUse),
            ("Notification", HookEventKind.PermissionRequest),
            ("AfterTool", HookEventKind.PostToolUse),
            ("BeforeTool", HookEventKind.PreToolUse),
            ("Notification", HookEventKind.PermissionRequest),
            ("BeforeAgent", HookEventKind.UserPromptSubmit),
            ("Notification", HookEventKind.PermissionRequest),
            ("AfterAgent", HookEventKind.Stop),
            ("SessionEnd", HookEventKind.SessionEnd));
        FixtureEvents(AgentIds.Gemini).Should().OnlyContain(e => e.Agent == AgentIds.Gemini && e.SessionId == "7b0c2f9e-3d4a-4c1e-9a55-2f1d8e6b4c10");
        FixtureEvents(AgentIds.Gemini).Should().OnlyContain(e => !e.ToString().Contains("SECRET"), "no mapped field holds content, even unscrubbed");
    }

    [Theory]
    [InlineData("BeforeModel")]
    [InlineData("AfterModel")]
    [InlineData("BeforeToolSelection")]
    [InlineData("PreCompress")]
    public void Unregistered_events_are_other(string name)
    {
        Parse(AgentIds.Gemini, new JsonObject { ["session_id"] = "s", ["hook_event_name"] = name, ["timestamp"] = "2026-10-06T09:00:00Z" })
            .Kind.Should().Be(HookEventKind.Other);
    }

    [Fact]
    public void Exec_permission_takes_the_command_from_details_and_the_tool_from_the_session()
    {
        var e = Single("Notification");

        e.ToolCommand.Should().Be("npm test");
        e.ToolPath.Should().BeNull();
        e.NotificationType.Should().Be(GeminiAdapter.ToolPermission);
        e.Message.Should().Be("Tool Shell requires execution");
        e.PaneId.Should().Be("pane-1");
    }

    [Fact]
    public void Edit_permission_takes_the_file_path_and_never_the_content()
    {
        var e = Single("Notification", 1);

        e.ToolPath.Should().Be(@"C:\work\shop-api\src\app.ts");
        e.ToolCommand.Should().BeNull();
        e.ToString().Should().NotContain("SECRET");
    }

    [Fact]
    public void Prompt_events_keep_only_the_prompt_length()
    {
        var e = Single("BeforeAgent");

        e.PromptLength.Should().Be("SECRET prompt: run the tests".Length);
        e.ToString().Should().NotContain("SECRET");
        Single("AfterAgent").ToString().Should().NotContain("SECRET");
    }

    [Fact]
    public void Other_notification_types_do_not_change_the_state()
    {
        Parse(AgentIds.Gemini, new JsonObject
        {
            ["session_id"] = "s", ["hook_event_name"] = "Notification", ["timestamp"] = "2026-10-06T09:00:00Z", ["notification_type"] = "Future",
        }).Kind.Should().Be(HookEventKind.Other);
    }

    [Fact]
    public void A_session_walks_through_permission_allowed_and_denied()
    {
        var states = new List<(string Event, SessionState State, string? Tool, string? Command, string? Path)>();
        SessionInfo? s = null;
        foreach (var e in FixtureEvents(AgentIds.Gemini))
        {
            (s, _) = SessionStateMachine.Apply(s, e);
            states.Add((e.HookEventName, s.State, s.PendingPermission?.Tool, s.PendingPermission?.Command, s.PendingPermission?.Path));
        }

        states.Should().Equal(
            ("SessionStart", SessionState.Idle, null, null, null),
            ("BeforeAgent", SessionState.Working, null, null, null),
            ("BeforeTool", SessionState.Working, null, null, null),
            ("Notification", SessionState.WaitingPermission, "run_shell_command", "npm test", null),
            ("AfterTool", SessionState.Working, null, null, null),
            ("BeforeTool", SessionState.Working, null, null, null),
            ("Notification", SessionState.WaitingPermission, "replace", null, @"C:\work\shop-api\src\app.ts"),
            // Denied: Gemini sends nothing, the user's next prompt ends the wait (stale-permission fallback).
            ("BeforeAgent", SessionState.Working, null, null, null),
            ("Notification", SessionState.WaitingPermission, null, null, null),
            ("AfterAgent", SessionState.Idle, null, null, null),
            ("SessionEnd", SessionState.Ended, null, null, null));
        s!.ProjectRoot.Should().Be(@"C:\work\shop-api");
    }

    [Theory]
    [InlineData("BeforeTool")]
    [InlineData("AfterTool")]
    [InlineData("AfterAgent")]
    [InlineData("BeforeAgent")]
    public void Any_later_turn_event_leaves_waiting_permission(string next)
    {
        var events = FixtureEvents(AgentIds.Gemini);
        SessionInfo? s = null;
        foreach (var e in events.Take(4))
        {
            (s, _) = SessionStateMachine.Apply(s, e);
        }

        s!.State.Should().Be(SessionState.WaitingPermission);
        var later = Parse(AgentIds.Gemini, new JsonObject
        {
            ["session_id"] = s.SessionId, ["hook_event_name"] = next, ["timestamp"] = "2026-10-06T09:20:00Z", ["tool_name"] = "read_file",
        });
        (s, _) = SessionStateMachine.Apply(s, later);

        s.State.Should().NotBe(SessionState.WaitingPermission);
        s.PendingPermission.Should().BeNull();
    }
}
