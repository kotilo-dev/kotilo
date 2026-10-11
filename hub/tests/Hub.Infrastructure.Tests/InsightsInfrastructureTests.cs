using System.Diagnostics;
using Hub.Core.Insights;
using Hub.Core.Sessions;
using Hub.Core.Usage;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Projects;
using Hub.Infrastructure.Reports;
using Hub.Infrastructure.Usage;
using ClosedXML.Excel;

namespace Hub.Infrastructure.Tests;

public sealed class InsightsRepositoryTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();
    private readonly Database _db;

    public InsightsRepositoryTests()
    {
        _db = new Database(_dir.File("hub.db"));
        _db.Migrate().Should().Be(9);
    }

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Customers_label_projects_and_deleting_one_unassigns()
    {
        var repo = new CustomerRepository(_db);
        var ctc = repo.Add(" CTC ", "#60CDFF");
        var other = repo.Add("Müşteri A", "#6CCB5F");
        ctc.Name.Should().Be("CTC");

        repo.Assign(@"C:\src\alpha", ctc.Id, T0);
        repo.Assign(@"C:\src\beta", other.Id, T0);
        repo.Assignments().Should().BeEquivalentTo(new Dictionary<string, long> { [@"C:\src\alpha"] = ctc.Id, [@"C:\src\beta"] = other.Id });

        repo.Update(ctc with { Name = "CTCSolutionCloud", Archived = true });
        repo.LoadAll().Should().ContainSingle(c => c.Name == "CTCSolutionCloud" && c.Archived);

        repo.Delete(other.Id);
        repo.Assignments().Keys.Should().Equal(@"C:\src\alpha");
        repo.Assign(@"C:\src\alpha", null, T0);
        repo.Assignments().Should().BeEmpty();
    }

    [Fact]
    public void Git_status_round_trips()
    {
        var repo = new GitStatusRepository(_db);
        var status = new GitStatus("main", false, true, 2, 0, 12, T0.AddMinutes(-42), "Fix tests", T0);
        repo.Save(@"C:\src\alpha", status);
        repo.Save(@"C:\src\alpha", status with { Changed = 0, CheckedAt = T0.AddMinutes(1) });

        repo.LoadAll()[@"C:\SRC\ALPHA"].Should().Be(status with { Changed = 0, CheckedAt = T0.AddMinutes(1) });
    }

    [Fact]
    public void Todo_snapshots_store_only_changes_and_feed_the_daily_diff()
    {
        var repo = new TodoSnapshotRepository(_db);
        var a = TodoSnapshotRepository.ItemHash("Faz 2", "Sipariş onay");
        var b = TodoSnapshotRepository.ItemHash("Faz 2", "İptal akışı");

        repo.Record(@"C:\src\alpha", "tasks/todo.md", [(a, "Sipariş onay", false), (b, "İptal akışı", false)], T0.AddDays(-1)).Should().Be(2);
        repo.Record(@"C:\src\alpha", "tasks/todo.md", [(a, "Sipariş onay", false), (b, "İptal akışı", false)], T0).Should().Be(0);
        repo.Record(@"C:\src\alpha", "tasks/todo.md", [(a, "Sipariş onay", true), (b, "İptal akışı", false)], T0.AddHours(2)).Should().Be(1);

        var around = repo.Around(T0.AddHours(-1), T0.AddDays(1));
        around.Should().HaveCount(2, "the changed item with its earlier state");
        TodoDiff.CompletedBetween(around, T0.AddHours(-1), T0.AddDays(1)).Should().ContainSingle(c => c.Text == "Sipariş onay");

        repo.Prune(T0.AddDays(10)).Should().Be(1, "each item keeps its latest row");
    }

    [Fact]
    public void Daily_summary_round_trips()
    {
        var repo = new DailySummaryRepository(_db);
        var day = new DateOnly(2026, 9, 30);
        repo.Get(day).Should().BeNull();

        var record = new DailySummaryRecord(day, "## Öne çıkanlar\n- x\n", "haiku", T0, "abc");
        repo.Save(record);
        repo.Save(record with { Markdown = "## v2\n" });

        repo.Get(day).Should().Be(record with { Markdown = "## v2\n" });
    }

    [Fact]
    public void Session_error_and_context_reset_survive_a_restart()
    {
        var repo = new SessionRepository(_db);
        var s = new SessionInfo("s1", @"C:\a", "a", null, SessionState.Error, T0, T0, null, null, null, null, 0, null, null)
        {
            Error = new SessionError(SessionErrorKind.UsageLimit, T0.AddHours(3)),
            ContextResetAt = T0.AddMinutes(-5),
        };
        repo.Upsert(s);

        var loaded = repo.LoadRecent(T0, TimeSpan.FromMinutes(30)).Single();
        loaded.Error.Should().Be(s.Error);
        loaded.ContextResetAt.Should().Be(s.ContextResetAt);
        loaded.State.Should().Be(SessionState.Error);
    }

    [Fact]
    public void Transitions_around_include_the_state_before_the_range()
    {
        var repo = new SessionRepository(_db);
        var s = new SessionInfo("s1", @"C:\a", "a", null, SessionState.Idle, T0, T0, null, null, null, null, 0, null, null);
        repo.Upsert(s);

        void Tr(SessionState from, SessionState to, DateTimeOffset at) =>
            repo.AddTransition(new SessionStateChanged("s1", from, to, at, null, TransitionTrigger.HookEvent, s));

        Tr(SessionState.Idle, SessionState.Working, T0.AddHours(-3));
        Tr(SessionState.Working, SessionState.WaitingPermission, T0.AddHours(-1));
        Tr(SessionState.WaitingPermission, SessionState.Working, T0.AddHours(1));
        Tr(SessionState.Working, SessionState.Idle, T0.AddHours(30));

        repo.TransitionsAround(T0, T0.AddDays(1)).Select(t => t.To).Should().Equal(SessionState.WaitingPermission, SessionState.Working);
        repo.ProjectRoots(["s1", "nope"]).Should().ContainSingle().Which.Value.Should().Be(@"C:\a");
    }

    [Fact]
    public void Last_context_uses_the_newest_main_chain_entry()
    {
        new UsageRepository(_db).Upsert(
        [
            new UsageEntry("k1", T0, 10, 5, 1000, 0, 50_000) { SessionId = "s1", Model = "claude-opus-4-7" },
            new UsageEntry("k2", T0.AddMinutes(1), 20, 5, 2000, 0, 60_000) { SessionId = "s1", Model = "claude-opus-4-7" },
            new UsageEntry("k3", T0.AddMinutes(2), 1, 1, 0, 0, 999) { SessionId = "s1", Model = "claude-haiku-4-5", IsSidechain = true },
            new UsageEntry("k4", T0.AddMinutes(3), 0, 0, 0, 0, 0) { SessionId = "s1", Model = UsageEntry.SyntheticModel },
        ]);

        var last = new UsageRepository(_db).LastContext(["s1"])["s1"];
        last.Should().Be((62_020L, "claude-opus-4-7", T0.AddMinutes(1)));
    }
}

public sealed class TranscriptScannerInsightsTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Scanner_reports_api_errors_versions_and_line_counts()
    {
        var projects = Directory.CreateDirectory(_dir.File("projects")).FullName;
        var folder = Directory.CreateDirectory(Path.Combine(projects, "C--src-alpha")).FullName;
        File.WriteAllLines(Path.Combine(folder, "s1.jsonl"),
        [
            """{"type":"user","timestamp":"2026-10-01T12:00:00.000Z","sessionId":"s1","version":"2.1.286","message":{"role":"user","content":"rate limit?"}}""",
            """{"type":"assistant","timestamp":"2026-10-01T12:00:01.000Z","sessionId":"s1","version":"2.1.290","message":{"id":"m1","model":"claude-opus-4-7","usage":{"input_tokens":1,"output_tokens":2}}}""",
            """{"type":"assistant","timestamp":"2026-10-01T12:00:02.000Z","sessionId":"s1","version":"2.1.290","message":{"id":"m2","model":"claude-opus-4-7","content":[]}}""",
            """{"type":"assistant","timestamp":"2026-10-01T12:00:03.000Z","sessionId":"s1","version":"2.1.290","isApiErrorMessage":true,"message":{"id":"m3","model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 overloaded"}]}}""",
            "{not json",
        ]);
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        var scanner = new TranscriptScanner(projects, new TranscriptOffsetStore(db), new UsageRepository(db), () => PricingTable.Empty);

        var result = scanner.ScanAll(DateTime.MinValue);

        result.Lines.Should().Be(5);
        result.InvalidLines.Should().Be(1);
        result.AssistantLines.Should().Be(2, "the API error line is not counted as an assistant reply");
        result.MalformedUsageLines.Should().Be(1);
        result.ClaudeVersion.Should().Be("2.1.290");
        result.Errors.Should().ContainSingle().Which.Error.Kind.Should().Be(SessionErrorKind.Overloaded);
    }
}

public sealed class CostExcelExporterTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Workbook_has_a_sheet_per_grouping_and_totals_match()
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");
        UsageEntry E(string root, string sid, decimal cost, int day) =>
            new($"{root}{sid}{day}", new DateTimeOffset(2026, 9, day, 12, 0, 0, TimeSpan.FromHours(3)), 100, 10, 0, 0, 0)
            {
                ProjectRoot = root, SessionId = sid, CostUsd = cost, Model = "claude-opus-4-7",
            };
        UsageEntry[] entries = [E(@"C:\a", "s1", 1.25m, 1), E(@"C:\a", "s2", 2m, 2), E(@"C:\b", "s3", 0.75m, 2)];
        var builder = new CostReportBuilder(
            new Dictionary<string, Customer>(StringComparer.OrdinalIgnoreCase) { [@"C:\a"] = new(1, "CTC", "#60CDFF") },
            _ => false, r => Path.GetFileName(r));
        var month = new DateOnly(2026, 9, 1);
        var reports = Enum.GetValues<CostGrouping>().ToDictionary(g => g, g => builder.Build(entries, month, g, zone));

        var path = _dir.File("agent-hub-Maliyet-2026-09.xlsx");
        CostExcelExporter.Export(path, reports, r => r.Kind == CostRowKind.Unassigned ? "Atanmamış" : r.Name,
            new CostExcelLabels("Müşteri", "Proje", "Model", "Günlük", "Müşteri", "Proje", "Model", "Projeler", "Session",
                "Token", "Tahmini maliyet", "Pay", "Tarih", "Toplam", "Tahmini"));

        using var book = new XLWorkbook(path);
        book.Worksheets.Select(w => w.Name).Should().Equal("Müşteri", "Proje", "Model", "Agents", "Günlük");
        var customer = book.Worksheet("Müşteri");
        customer.Cell(2, 1).GetString().Should().Be("CTC");
        customer.Cell(3, 1).GetString().Should().Be("Atanmamış");
        customer.Cell(4, 1).GetString().Should().Be("Toplam");
        customer.Cell(4, 5).GetValue<decimal>().Should().Be(4m);
        (customer.Cell(2, 5).GetValue<decimal>() + customer.Cell(3, 5).GetValue<decimal>()).Should().Be(4m);

        var daily = book.Worksheet("Günlük");
        daily.Range("F2:F4").Cells().Sum(c => c.GetValue<decimal>()).Should().Be(4m);
    }
}

public sealed class GitRunnerTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly GitRunner _git = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task Status_of_a_real_repo_counts_changes_and_reads_the_last_commit()
    {
        if (!_git.IsAvailable)
        {
            return; // git is optional (spec §18.3)
        }

        var repo = Directory.CreateDirectory(_dir.File("repo")).FullName;
        Git(repo, "init", "-q", "-b", "main");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "a");
        Git(repo, "add", ".");
        Git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "İlk commit");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "changed");
        File.WriteAllText(Path.Combine(repo, "b.txt"), "new");

        var now = DateTimeOffset.UtcNow;
        var status = await _git.StatusAsync(repo, now);

        status!.Branch.Should().Be("main");
        status.Changed.Should().Be(2);
        status.HasUpstream.Should().BeFalse();
        status.LastCommitSubject.Should().Be("İlk commit");
        status.LastCommitAt.Should().BeCloseTo(now, TimeSpan.FromMinutes(1));

        (await _git.SubjectsSinceAsync(repo, now.AddHours(-1), now.AddHours(1), 20)).Should().Equal("İlk commit");

        File.WriteAllText(Path.Combine(repo, ".git", "index.lock"), "");
        (await _git.StatusAsync(repo, now)).Should().BeNull("a held index lock skips the round");
    }

    [Fact]
    public async Task Non_repo_folder_has_no_status() =>
        (await _git.StatusAsync(_dir.Path, DateTimeOffset.UtcNow)).Should().BeNull();

    private static void Git(string repo, params string[] args)
    {
        var psi = new ProcessStartInfo(FindGit()) { WorkingDirectory = repo, UseShellExecute = false, CreateNoWindow = true };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var p = Process.Start(psi)!;
        p.WaitForExit();
        p.ExitCode.Should().Be(0, string.Join(' ', args));
    }

    private static string FindGit()
    {
        var candidate = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd", "git.exe");
        return File.Exists(candidate) ? candidate : "git";
    }
}
