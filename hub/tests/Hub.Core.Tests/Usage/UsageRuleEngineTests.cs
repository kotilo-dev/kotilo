using Hub.Core.Notifications;
using Hub.Core.Usage;
using static Hub.Core.Tests.Usage.UsageTestData;

namespace Hub.Core.Tests.Usage;

public class UsageRuleEngineTests
{
    private static readonly DateTimeOffset H10 = new(2026, 9, 30, 10, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly Today = new(2026, 9, 30);
    private readonly InMemoryRuleStateStore _state = new();
    private readonly UsageRuleEngine _engine;

    public UsageRuleEngineTests() => _engine = new UsageRuleEngine(
        new UsageRuleOptions { BlockThresholdEnabled = true, BlockTokenThresholds = [1_000, 2_000, 3_000] },
        _state);

    private static ActiveBlockStatus Block(long tokens, DateTimeOffset? start = null, double perMinute = 0, long? projected = null)
    {
        var s = start ?? H10;
        var block = new UsageBlock(s, s.AddHours(5), s.AddMinutes(30), false, new UsageTotals(0, tokens, 0, 0, 0, false, 1));
        return new ActiveBlockStatus(block, TimeSpan.FromHours(4), perMinute, 0, projected ?? tokens, 0);
    }

    private IReadOnlyList<UsageNotification> Run(ActiveBlockStatus? block, decimal todayCost = 0) =>
        _engine.Evaluate(block, new UsageTotals(0, 0, 0, 0, todayCost, false, 1), Today, H10);

    [Fact]
    public void Threshold_fires_once_per_block()
    {
        Run(Block(500)).Should().BeEmpty();
        Run(Block(1_100)).Should().ContainSingle().Which.ThresholdTokens.Should().Be(1_000);
        Run(Block(1_500)).Should().BeEmpty();
        Run(Block(1_900)).Should().BeEmpty();
    }

    [Fact]
    public void Several_thresholds_crossed_at_once_produce_one_toast_for_the_highest()
    {
        Run(Block(2_500)).Should().ContainSingle().Which.ThresholdTokens.Should().Be(2_000);
        Run(Block(2_600)).Should().BeEmpty("1 000 was marked too");
    }

    [Fact]
    public void Hysteresis_requires_drop_below_reset_margin()
    {
        Run(Block(1_100)).Should().HaveCount(1);

        Run(Block(950)).Should().BeEmpty();          // within 10 % margin: still armed off
        Run(Block(1_050)).Should().BeEmpty();

        Run(Block(850)).Should().BeEmpty();          // below 900 → re-armed
        Run(Block(1_050)).Should().ContainSingle();
    }

    [Fact]
    public void New_block_resets_thresholds()
    {
        Run(Block(1_100)).Should().HaveCount(1);
        Run(Block(1_100, start: H10.AddHours(5))).Should().ContainSingle();
    }

    [Fact]
    public void Disabled_rule_does_not_fire()
    {
        _engine.Options = _engine.Options with { BlockThresholdEnabled = false };
        Run(Block(5_000)).Should().BeEmpty();
    }

    [Fact]
    public void Burn_projection_fires_for_next_threshold_with_eta()
    {
        _engine.Options = _engine.Options with { BlockThresholdEnabled = false, BurnProjectionEnabled = true };

        var fired = Run(Block(1_500, perMinute: 100, projected: 20_000));

        var n = fired.Should().ContainSingle().Subject;
        n.RuleId.Should().Be(UsageRuleEngine.BurnProjection);
        n.ThresholdTokens.Should().Be(2_000);
        n.TimeToThreshold.Should().Be(TimeSpan.FromMinutes(5));
        Run(Block(1_600, perMinute: 100, projected: 20_000)).Should().BeEmpty("same threshold, same block");
    }

    [Fact]
    public void Burn_projection_is_quiet_when_projection_stays_below()
    {
        _engine.Options = _engine.Options with { BurnProjectionEnabled = true };
        Run(Block(500, perMinute: 1, projected: 800)).Should().BeEmpty();
    }

    [Fact]
    public void Daily_cost_fires_once_per_day()
    {
        _engine.Options = new UsageRuleOptions { DailyCostEnabled = true, DailyCostThresholdUsd = 10m };

        Run(null, todayCost: 9m).Should().BeEmpty();
        Run(null, todayCost: 10.5m).Should().ContainSingle().Which.RuleId.Should().Be(UsageRuleEngine.DailyCost);
        Run(null, todayCost: 20m).Should().BeEmpty();
    }

    [Fact]
    public void Persisted_state_survives_a_new_engine()
    {
        Run(Block(1_100)).Should().HaveCount(1);

        var restarted = new UsageRuleEngine(_engine.Options, _state);
        restarted.Evaluate(Block(1_200), UsageTotals.Zero, Today, H10).Should().BeEmpty();
    }
}
