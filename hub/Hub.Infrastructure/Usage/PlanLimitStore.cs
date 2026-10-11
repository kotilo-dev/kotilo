using System.Text.Json;
using Hub.Core.Usage;

namespace Hub.Infrastructure.Usage;

/// <summary>
/// Keeps the merged plan limits (D-074) and persists them to a small JSON file. Thread-safe; the file is only
/// rewritten when the merged value actually changes, so frequent statusLine renders cost nothing.
/// </summary>
public sealed class PlanLimitStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly string _path;
    private readonly Lock _gate = new();
    private PlanLimits? _limits;

    /// <param name="agent">Whose limits the file holds; set on values loaded from disk.</param>
    public PlanLimitStore(string path, string agent = Hub.Core.Hooks.HookEnvelope.DefaultAgent)
    {
        _path = path;
        Agent = agent;
        _limits = Load(path, agent);
    }

    public string Agent { get; }

    /// <summary>The merged limits, including windows that may have expired since (use <see cref="PlanLimits.Current"/>).</summary>
    public PlanLimits? Limits
    {
        get
        {
            lock (_gate)
            {
                return _limits;
            }
        }
    }

    /// <summary>Merges a new report; returns true when the visible value changed.</summary>
    public bool Apply(PlanLimits incoming)
    {
        PlanLimits merged;
        lock (_gate)
        {
            merged = PlanLimits.Merge(_limits, incoming);
            var same = _limits is not null && merged.FiveHour == _limits.FiveHour && merged.SevenDay == _limits.SevenDay
                && merged.SpendLimit == _limits.SpendLimit;
            _limits = merged;
            if (same)
            {
                return false;
            }
        }

        Save(merged);
        return true;
    }

    private void Save(PlanLimits limits)
    {
        try
        {
            var dto = new Dto(limits.ReceivedAt, limits.FiveHour, limits.SevenDay, limits.SpendLimit);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(dto, Json));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Persistence is a convenience; the in-memory value still serves the UI.
        }
    }

    private static PlanLimits? Load(string path, string agent)
    {
        try
        {
            if (!File.Exists(path) || JsonSerializer.Deserialize<Dto>(File.ReadAllText(path), Json) is not { } dto)
            {
                return null;
            }

            var limits = new PlanLimits(dto.ReceivedAt) { Agent = agent, FiveHour = dto.FiveHour, SevenDay = dto.SevenDay, SpendLimit = dto.SpendLimit };
            return limits.IsEmpty ? null : limits;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private sealed record Dto(DateTimeOffset ReceivedAt, LimitWindow? FiveHour, LimitWindow? SevenDay, LimitWindow? SpendLimit);
}
