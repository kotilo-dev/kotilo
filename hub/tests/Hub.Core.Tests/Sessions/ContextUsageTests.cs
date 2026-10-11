using Hub.Core.Hooks;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using static Hub.Core.Tests.TestData;

namespace Hub.Core.Tests.Sessions;

public sealed class ContextUsageTests
{
    private static readonly ModelContextTable Table = ModelContextTable.Parse("""{ "models": { "claude-": 200000, "claude-sonnet-4-5": 200000 } }""");

    [Fact]
    public void Statusline_wins_over_transcript()
    {
        ContextUsageResolver.Resolve(new(42, T0), new(80, T0.AddSeconds(5)), null).Should().Be(42);
        ContextUsageResolver.Resolve(null, new(80, T0), null).Should().Be(80);
        ContextUsageResolver.Resolve(null, null, null).Should().BeNull();
    }

    [Fact]
    public void Readings_before_a_compact_are_ignored()
    {
        var reset = T0.AddMinutes(1);
        ContextUsageResolver.Resolve(new(90, T0), new(85, T0), reset).Should().BeNull();
        ContextUsageResolver.Resolve(new(90, T0), new(12, T0.AddMinutes(2)), reset).Should().Be(12);
    }

    [Fact]
    public void Transcript_tokens_over_the_model_window()
    {
        ContextUsageResolver.FromTokens(150_000, "claude-opus-4-7", Table).Should().Be(75);
        ContextUsageResolver.FromTokens(150_000, "gpt-x", Table).Should().BeNull("unknown model: no reading, no warning");
        ContextUsageResolver.FromTokens(500_000, "claude-sonnet-4-5", Table).Should().Be(50, "above 200k the session must be 1M");
    }

    [Fact]
    public void Context_rule_fires_once_and_rearms_after_compact()
    {
        var engine = new RuleEngine(new RuleOptions());
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0));

        void StatusLine(double pct, DateTimeOffset at) =>
            tracker.ApplyStatusLine(new StatusLineSnapshot("s1", at) { ContextUsedPercent = pct });

        StatusLine(79, T0.AddSeconds(1));
        engine.Poll(T0.AddSeconds(1), tracker.Snapshot).Should().BeEmpty();

        StatusLine(84, T0.AddSeconds(2));
        engine.Poll(T0.AddSeconds(2), tracker.Snapshot).Should().ContainSingle(r => r.RuleId == RuleIds.ContextHigh && r.ContextPercent == 84);

        StatusLine(90, T0.AddSeconds(3));
        engine.Poll(T0.AddSeconds(30), tracker.Snapshot).Should().BeEmpty("one warning per crossing");

        StatusLine(75, T0.AddSeconds(31));
        StatusLine(85, T0.AddSeconds(32));
        engine.Poll(T0.AddMinutes(1), tracker.Snapshot).Should().BeEmpty("hysteresis: must drop below 70 first");

        tracker.Apply(Hook(HookEventKind.SessionStart, T0.AddMinutes(2)) with { Source = "compact" });
        tracker.Get("s1")!.ContextUsedPercent.Should().BeNull("pre-compact readings no longer apply");
        engine.Poll(T0.AddMinutes(2), tracker.Snapshot).Should().BeEmpty();

        StatusLine(82, T0.AddMinutes(3));
        engine.Poll(T0.AddMinutes(3), tracker.Snapshot).Should().ContainSingle(r => r.RuleId == RuleIds.ContextHigh);
    }

    [Fact]
    public void Muting_the_session_silences_the_context_rule()
    {
        var engine = new RuleEngine(new RuleOptions());
        var tracker = new SessionTracker(new FakeEnvironment(), new SessionOptions());
        tracker.Apply(Hook(HookEventKind.UserPromptSubmit, T0));
        engine.MuteSessionRule("s1", RuleIds.ContextHigh);

        tracker.ApplyStatusLine(new StatusLineSnapshot("s1", T0) { ContextUsedPercent = 95 });
        engine.Poll(T0.AddSeconds(1), tracker.Snapshot).Should().BeEmpty();
    }
}
