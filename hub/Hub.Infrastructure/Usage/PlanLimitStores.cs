using Hub.Core.Usage;

namespace Hub.Infrastructure.Usage;

/// <summary>
/// One <see cref="PlanLimitStore"/> per agent (Claude statusLine, Codex rollouts, later agents' readers), in a stable
/// order: the preloaded agents first, then agents in the order their first report arrived. Thread-safe.
/// </summary>
public sealed class PlanLimitStores
{
    private readonly Func<string, string> _pathFor;
    private readonly Lock _gate = new();
    private readonly List<PlanLimitStore> _stores = [];

    /// <param name="pathFor">Persistence file for an agent's limits.</param>
    /// <param name="preload">Agents whose last known limits are loaded at start (their files may exist from a previous run).</param>
    public PlanLimitStores(Func<string, string> pathFor, IEnumerable<string> preload)
    {
        _pathFor = pathFor;
        foreach (var agent in preload)
        {
            For(agent);
        }
    }

    /// <summary>Stores in display order.</summary>
    public IReadOnlyList<PlanLimitStore> All
    {
        get
        {
            lock (_gate)
            {
                return [.. _stores];
            }
        }
    }

    public PlanLimitStore For(string agent)
    {
        lock (_gate)
        {
            if (_stores.FirstOrDefault(s => s.Agent == agent) is { } existing)
            {
                return existing;
            }

            var store = new PlanLimitStore(_pathFor(agent), agent);
            _stores.Add(store);
            return store;
        }
    }

    /// <summary>Merges a report into its agent's store; true when the visible value changed.</summary>
    public bool Apply(PlanLimits limits) => For(limits.Agent).Apply(limits);
}
