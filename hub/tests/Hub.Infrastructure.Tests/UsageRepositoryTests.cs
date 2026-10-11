using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

public sealed class UsageRepositoryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 30, 18, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly Database _db;
    private readonly UsageRepository _repo;

    public UsageRepositoryTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate();
        _repo = new UsageRepository(_db);
    }

    public void Dispose() => _dir.Dispose();

    private static UsageEntry E(string key, long output, bool sidechain = false, string session = "s1", decimal? cost = 1m, int minute = 0) =>
        new(key, T0.AddMinutes(minute), 1, output, 2, 3, 4)
        {
            SessionId = session,
            ProjectRoot = @"C:\src\a",
            Model = "claude-opus-5-5",
            IsSidechain = sidechain,
            CostUsd = cost,
        };

    [Fact]
    public void Roundtrips_all_fields()
    {
        _repo.Upsert([E("k", 10) with { IsFast = true }]);

        var e = _repo.Load(T0).Should().ContainSingle().Subject;
        e.Should().BeEquivalentTo(E("k", 10) with { IsFast = true });
    }

    [Fact]
    public void Larger_duplicate_replaces_smaller_but_not_vice_versa()
    {
        _repo.Upsert([E("k", 10)]);
        _repo.Upsert([E("k", 5)]).Should().Be(0);
        _repo.Upsert([E("k", 50)]).Should().Be(1);

        _repo.Load(T0).Single().Output.Should().Be(50);
    }

    [Fact]
    public void Main_chain_replaces_sidechain_copy()
    {
        _repo.Upsert([E("k", 500, sidechain: true)]);
        _repo.Upsert([E("k", 10)]);

        var e = _repo.Load(T0).Single();
        e.IsSidechain.Should().BeFalse();
        e.Output.Should().Be(10);
    }

    [Fact]
    public void Session_totals_sum_tokens_and_cost()
    {
        _repo.Upsert([E("a", 10, cost: 1.5m), E("b", 20, cost: 2m, minute: 1), E("c", 5, session: "s2", cost: null)]);

        var totals = _repo.SessionTotals(["s1", "s2", "none"]);

        totals.Should().HaveCount(2);
        totals["s1"].Tokens.Should().Be((1 + 10 + 2 + 3 + 4) + (1 + 20 + 2 + 3 + 4));
        totals["s1"].CostUsd.Should().Be(3.5m);
        totals["s1"].LastModel.Should().Be("claude-opus-5-5");
        totals["s2"].CostUsd.Should().BeNull("an unpriced entry makes the session cost unknown");
    }

    [Fact]
    public void Reprice_updates_costs()
    {
        _repo.Upsert([E("k", 1_000_000, cost: null) with { CacheCreate5m = 0, CacheCreate1h = 0, CacheRead = 0, Input = 0 }]);

        _repo.Reprice(PricingTable.Parse(PricingProvider.DefaultJson()));

        _repo.Load(T0).Single().CostUsd.Should().Be(20m);
    }

    [Fact]
    public void Prune_removes_old_rows()
    {
        _repo.Upsert([E("old", 1, minute: -60 * 24 * 100), E("new", 1)]);
        _repo.Prune(T0.AddDays(-90)).Should().Be(1);
        _repo.Load(DateTimeOffset.MinValue).Select(e => e.DedupKey).Should().Equal("new");
    }

    [Fact]
    public void Notification_log_store_tracks_marks()
    {
        var store = new NotificationLogStore(_db);
        store.HasFired("r", "k").Should().BeFalse();
        store.MarkFired("r", "k", T0);
        store.HasFired("r", "k").Should().BeTrue();
        store.Clear("r", "k");
        store.HasFired("r", "k").Should().BeFalse();
    }
}
