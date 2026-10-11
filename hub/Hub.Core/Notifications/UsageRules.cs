using Hub.Core.Usage;

namespace Hub.Core.Notifications;

/// <summary>Persisted "already fired" marks, so thresholds survive an app restart (spec §11.2, §13 notification_log).</summary>
public interface IRuleStateStore
{
    bool HasFired(string ruleId, string key);

    void MarkFired(string ruleId, string key, DateTimeOffset at);

    void Clear(string ruleId, string key);
}

public sealed class InMemoryRuleStateStore : IRuleStateStore
{
    private readonly HashSet<(string, string)> _fired = [];

    public bool HasFired(string ruleId, string key) => _fired.Contains((ruleId, key));

    public void MarkFired(string ruleId, string key, DateTimeOffset at) => _fired.Add((ruleId, key));

    public void Clear(string ruleId, string key) => _fired.Remove((ruleId, key));
}

public sealed record UsageRuleOptions
{
    public bool BlockThresholdEnabled { get; init; }

    /// <summary>Token thresholds for the active block, e.g. 70/85/95 % of the user's own limit.</summary>
    public IReadOnlyList<long> BlockTokenThresholds { get; init; } = [];

    /// <summary>A fired threshold re-arms only after dropping below threshold × (1 − margin).</summary>
    public double ResetMargin { get; init; } = 0.10;

    public bool DailyCostEnabled { get; init; }

    public decimal DailyCostThresholdUsd { get; init; }

    public bool BurnProjectionEnabled { get; init; }
}

/// <param name="TimeToThreshold">burn_projection: time until the threshold is crossed at the current rate.</param>
public sealed record UsageNotification(
    string RuleId,
    DateTimeOffset At,
    long? Tokens = null,
    long? ThresholdTokens = null,
    decimal? CostUsd = null,
    decimal? ThresholdUsd = null,
    TimeSpan? TimeToThreshold = null);

/// <summary>usage.block_threshold, usage.daily_cost and usage.burn_projection (spec §11.1, §11.2).</summary>
public sealed class UsageRuleEngine(UsageRuleOptions options, IRuleStateStore state)
{
    public const string BlockThreshold = "usage.block_threshold";
    public const string DailyCost = "usage.daily_cost";
    public const string BurnProjection = "usage.burn_projection";

    public UsageRuleOptions Options { get; set; } = options;

    public IReadOnlyList<UsageNotification> Evaluate(ActiveBlockStatus? block, UsageTotals today, DateOnly todayDate, DateTimeOffset now)
    {
        var result = new List<UsageNotification>();
        var thresholds = Options.BlockTokenThresholds.Where(t => t > 0).Order().ToList();

        if (block is not null && thresholds.Count > 0)
        {
            var tokens = block.Block.Totals.TotalTokens;

            if (Options.BlockThresholdEnabled)
            {
                long? highestNew = null;
                foreach (var t in thresholds)
                {
                    var key = Key(block, t);
                    if (tokens >= t)
                    {
                        if (!state.HasFired(BlockThreshold, key))
                        {
                            state.MarkFired(BlockThreshold, key, now);
                            highestNew = t;
                        }
                    }
                    else if (tokens < t * (1 - Options.ResetMargin) && state.HasFired(BlockThreshold, key))
                    {
                        state.Clear(BlockThreshold, key);
                    }
                }

                // Several thresholds crossed at once → one toast for the highest (spam protection).
                if (highestNew is { } crossed)
                {
                    result.Add(new UsageNotification(BlockThreshold, now, Tokens: tokens, ThresholdTokens: crossed));
                }
            }

            if (Options.BurnProjectionEnabled && block.TokensPerMinute > 0)
            {
                var next = thresholds.FirstOrDefault(t => t > tokens && block.ProjectedTokens >= t);
                if (next > 0 && !state.HasFired(BurnProjection, Key(block, next)))
                {
                    state.MarkFired(BurnProjection, Key(block, next), now);
                    var minutes = (next - tokens) / block.TokensPerMinute;
                    result.Add(new UsageNotification(
                        BurnProjection, now, Tokens: tokens, ThresholdTokens: next, TimeToThreshold: TimeSpan.FromMinutes(minutes)));
                }
            }
        }

        if (Options.DailyCostEnabled && Options.DailyCostThresholdUsd > 0 && today.CostUsd >= Options.DailyCostThresholdUsd)
        {
            var key = todayDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            if (!state.HasFired(DailyCost, key))
            {
                state.MarkFired(DailyCost, key, now);
                result.Add(new UsageNotification(DailyCost, now, CostUsd: today.CostUsd, ThresholdUsd: Options.DailyCostThresholdUsd));
            }
        }

        return result;
    }

    private static string Key(ActiveBlockStatus block, long threshold) =>
        $"{block.Block.Id}|{threshold.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
}
