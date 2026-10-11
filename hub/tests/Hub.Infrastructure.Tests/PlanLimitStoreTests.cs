using Hub.Core.Usage;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

public sealed class PlanLimitStoreTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Limits_survive_a_restart_and_unchanged_reports_do_not_count_as_changes()
    {
        var path = _dir.File("plan-limits.json");
        var store = new PlanLimitStore(path);
        var report = new PlanLimits(Now) { FiveHour = new(23.5, Now.AddHours(2)), SevenDay = new(41, Now.AddDays(3)) };

        store.Apply(report).Should().BeTrue();
        store.Apply(report with { ReceivedAt = Now.AddMinutes(1) }).Should().BeFalse();

        var reloaded = new PlanLimitStore(path).Limits!;
        reloaded.FiveHour.Should().Be(report.FiveHour);
        reloaded.SevenDay.Should().Be(report.SevenDay);
    }

    [Fact]
    public void Corrupt_file_starts_empty()
    {
        var path = _dir.File("plan-limits.json");
        File.WriteAllText(path, "{ not json");

        new PlanLimitStore(path).Limits.Should().BeNull();
    }
}
