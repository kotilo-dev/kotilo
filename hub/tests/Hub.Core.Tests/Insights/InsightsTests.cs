using System.Globalization;
using System.Text;
using Hub.Core.Insights;
using Hub.Core.Notifications;
using Hub.Core.Sessions;
using Hub.Core.Usage;

namespace Hub.Core.Tests.Insights;

public sealed class WaitMetricsTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");

    /// <summary>2026-10-01 10:00 Istanbul.</summary>
    private static readonly DateTimeOffset T = new(2026, 10, 1, 10, 0, 0, TimeSpan.FromHours(3));

    private static StateTransition Tr(string id, SessionState to, DateTimeOffset at, string? detail = null) => new(id, to, at, detail);

    private static string Project(string id) => id.StartsWith('a') ? @"C:\src\alpha" : @"C:\src\beta";

    [Fact]
    public void Permission_wait_closes_on_the_next_state_and_counts_for_its_project()
    {
        var spans = WaitMetricsCalculator.Spans(
            [
                Tr("a1", SessionState.Working, T),
                Tr("a1", SessionState.WaitingPermission, T.AddMinutes(1), "Bash"),
                Tr("a1", SessionState.Working, T.AddMinutes(6)),
            ],
            Project, T.AddHours(1));

        var day = WaitMetricsCalculator.StartOfDay(new DateOnly(2026, 10, 1), Istanbul);
        var m = WaitMetricsCalculator.Calculate(spans, day, day.AddDays(1), Istanbul);

        m.Total.Should().Be(TimeSpan.FromMinutes(5));
        m.Count.Should().Be(1);
        m.PermissionTotal.Should().Be(TimeSpan.FromMinutes(5));
        m.TopPermissionTool.Should().Be("Bash");
        m.ByProject.Should().ContainSingle().Which.Should().Be(new KeyValuePair<string, TimeSpan>(@"C:\src\alpha", TimeSpan.FromMinutes(5)));
        m.ByHour[10].Should().Be(TimeSpan.FromMinutes(5));
    }

    [Fact]
    public void Ended_and_stale_close_a_wait_and_direct_switches_split_it()
    {
        var spans = WaitMetricsCalculator.Spans(
            [
                Tr("a1", SessionState.WaitingInput, T),
                Tr("a1", SessionState.WaitingPermission, T.AddMinutes(2), "Claude needs your permission to use Edit"),
                Tr("a1", SessionState.Ended, T.AddMinutes(5)),
                Tr("b1", SessionState.WaitingInput, T.AddMinutes(10)),
                Tr("b1", SessionState.Stale, T.AddMinutes(13)),
            ],
            Project, T.AddHours(2));

        spans.Should().HaveCount(3);
        spans.Should().Contain(s => s.Kind == WaitKind.Input && s.Duration == TimeSpan.FromMinutes(2));
        spans.Should().Contain(s => s.Kind == WaitKind.Permission && s.Tool == "Edit" && s.Duration == TimeSpan.FromMinutes(3));
        spans.Should().Contain(s => s.SessionId == "b1" && s.Duration == TimeSpan.FromMinutes(3));
        spans.Should().OnlyContain(s => !s.IsOpen);
    }

    [Fact]
    public void Still_waiting_is_counted_until_now()
    {
        var spans = WaitMetricsCalculator.Spans([Tr("a1", SessionState.WaitingInput, T)], Project, T.AddMinutes(7));
        spans.Should().ContainSingle().Which.Should().Match<WaitSpan>(s => s.IsOpen && s.Duration == TimeSpan.FromMinutes(7));
    }

    [Fact]
    public void Idle_prompt_counts_only_when_the_user_came_back()
    {
        const string idle = "Claude is waiting for your input";
        var spans = WaitMetricsCalculator.Spans(
            [
                Tr("a1", SessionState.WaitingInput, T, idle), Tr("a1", SessionState.Working, T.AddMinutes(4)),
                Tr("a2", SessionState.WaitingInput, T, idle), Tr("a2", SessionState.Ended, T.AddHours(6)),
                Tr("b1", SessionState.WaitingInput, T, idle),
                Tr("b2", SessionState.WaitingInput, T, "Claude has a question for you"), Tr("b2", SessionState.Ended, T.AddMinutes(9)),
            ],
            Project, T.AddHours(8));

        spans.Select(s => (s.SessionId, s.Duration)).Should().BeEquivalentTo(new[]
        {
            ("a1", TimeSpan.FromMinutes(4)),   // came back: counted
            ("b2", TimeSpan.FromMinutes(9)),   // a real question stays counted even if the session closed
        });
    }

    [Fact]
    public void Wait_across_midnight_is_split_between_days_in_local_time()
    {
        var evening = new DateTimeOffset(2026, 10, 1, 23, 50, 0, TimeSpan.FromHours(3));
        var spans = WaitMetricsCalculator.Spans(
            [Tr("a1", SessionState.WaitingInput, evening), Tr("a1", SessionState.Working, evening.AddMinutes(30))],
            Project, evening.AddHours(1));

        var oct1 = WaitMetricsCalculator.StartOfDay(new DateOnly(2026, 10, 1), Istanbul);
        var week = WaitMetricsCalculator.Calculate(spans, oct1, oct1.AddDays(2), Istanbul);

        week.ByDay.Should().HaveCount(2);
        week.ByDay[0].Total.Should().Be(TimeSpan.FromMinutes(10));
        week.ByDay[1].Total.Should().Be(TimeSpan.FromMinutes(20));
        week.ByHour[23].Should().Be(TimeSpan.FromMinutes(10));
        week.ByHour[0].Should().Be(TimeSpan.FromMinutes(20));

        var oct2 = WaitMetricsCalculator.Calculate(spans, oct1.AddDays(1), oct1.AddDays(2), Istanbul);
        oct2.Total.Should().Be(TimeSpan.FromMinutes(20));
        oct2.Count.Should().Be(0, "the wait started the day before");
    }

    [Fact]
    public void Median_longest_and_quiet_hours()
    {
        var spans = WaitMetricsCalculator.Spans(
            [
                Tr("a1", SessionState.WaitingInput, T), Tr("a1", SessionState.Working, T.AddMinutes(1)),
                Tr("a1", SessionState.WaitingInput, T.AddMinutes(2)), Tr("a1", SessionState.Working, T.AddMinutes(5)),
                Tr("b1", SessionState.WaitingPermission, T.AddMinutes(10), "Bash"), Tr("b1", SessionState.Working, T.AddMinutes(20)),
            ],
            Project, T.AddHours(1));

        var quiet = new QuietHours { Enabled = true, Start = new TimeOnly(10, 15), End = new TimeOnly(10, 18) };
        var day = WaitMetricsCalculator.StartOfDay(new DateOnly(2026, 10, 1), Istanbul);
        var m = WaitMetricsCalculator.Calculate(spans, day, day.AddDays(1), Istanbul, quiet);

        m.Median.Should().Be(TimeSpan.FromMinutes(3));
        m.Average.Should().Be(TimeSpan.FromMinutes(14.0 / 3));
        m.Longest!.ProjectRoot.Should().Be(@"C:\src\beta");
        m.DuringQuietHours.Should().Be(TimeSpan.FromMinutes(3));
    }
}

public sealed class CostReportTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");
    private const string Alpha = @"C:\src\alpha";
    private const string Beta = @"C:\src\beta";
    private const string Gamma = @"C:\src\gamma";
    private const string Buddy = @"C:\data\buddy";

    private static UsageEntry E(string root, string session, decimal cost, long tokens, string model = "claude-opus-4-7", int day = 10) =>
        new($"{root}{session}{cost}{day}{model}", new DateTimeOffset(2026, 9, day, 12, 0, 0, TimeSpan.FromHours(3)), tokens, 0, 0, 0, 0)
        {
            ProjectRoot = root,
            SessionId = session,
            CostUsd = cost,
            Model = model,
        };

    private static readonly UsageEntry[] Entries =
    [
        E(Alpha, "s1", 6m, 600), E(Alpha, "s2", 2m, 200, "claude-haiku-4-5"),
        E(Beta, "s3", 1m, 100),
        E(Gamma, "s4", 0.5m, 50),
        E(Buddy, "s5", 0.5m, 50),
        E(Alpha, "s6", 100m, 100, day: 30) with { Timestamp = new DateTimeOffset(2026, 10, 1, 0, 30, 0, TimeSpan.FromHours(3)) },
    ];

    private static CostReportBuilder Builder() => new(
        new Dictionary<string, Customer>(StringComparer.OrdinalIgnoreCase)
        {
            [Alpha] = new(1, "CTC", "#60CDFF"),
            [Beta] = new(1, "CTC", "#60CDFF"),
        },
        root => root == Buddy,
        root => Path.GetFileName(root));

    [Fact]
    public void Customer_grouping_has_unassigned_and_buddy_rows_and_matches_the_total()
    {
        var report = Builder().Build(Entries, new DateOnly(2026, 9, 1), CostGrouping.Customer, Istanbul);

        report.Rows.Select(r => (r.Kind, r.Name)).Should().Equal(
            (CostRowKind.Normal, "CTC"), (CostRowKind.Unassigned, ""), (CostRowKind.Buddy, "Buddy"));
        var ctc = report.Rows[0];
        ctc.Totals.CostUsd.Should().Be(9m);
        ctc.Sessions.Should().Be(3);
        ctc.Projects.Should().Equal("alpha", "beta");
        ctc.Share.Should().BeApproximately(0.9, 1e-9);

        report.Totals.CostUsd.Should().Be(10m, "the October entry (00:30 local on 1 Oct) is outside September");
        report.Rows.Sum(r => r.Totals.CostUsd).Should().Be(report.Totals.CostUsd);
        report.Rows.Sum(r => r.Share).Should().BeApproximately(1, 1e-9);
        report.Sessions.Should().Be(5);
    }

    [Fact]
    public void Model_grouping_includes_buddy_usage_by_model()
    {
        var report = Builder().Build(Entries, new DateOnly(2026, 9, 1), CostGrouping.Model, Istanbul);
        report.Rows.Select(r => r.Name).Should().Equal("claude-opus-4-7", "claude-haiku-4-5");
        report.Rows[0].Totals.CostUsd.Should().Be(8m);
    }

    [Fact]
    public void Daily_sheet_rows_sum_to_the_total()
    {
        var report = Builder().Build(Entries, new DateOnly(2026, 9, 1), CostGrouping.Project, Istanbul);
        report.Daily.Sum(d => d.Totals.CostUsd).Should().Be(report.Totals.CostUsd);
        report.Daily.Should().Contain(d => d.Project == "alpha" && d.Customer == "CTC" && d.Model == "claude-haiku-4-5");
        report.Daily.Should().Contain(d => d.Project == "Buddy" && d.Customer == "");
    }

    [Fact]
    public void Csv_is_utf8_bom_with_semicolons_and_turkish_decimals()
    {
        var report = Builder().Build(Entries, new DateOnly(2026, 9, 1), CostGrouping.Customer, Istanbul);
        var bytes = CostCsvExporter.Export(
            report, ["Müşteri", "Projeler", "Session", "Token", "Maliyet", "Pay"],
            r => r.Kind switch { CostRowKind.Unassigned => "Atanmamış", _ => r.Name },
            CultureInfo.GetCultureInfo("tr-TR"));

        bytes.Take(3).Should().Equal(0xEF, 0xBB, 0xBF);
        var lines = Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        lines[0].Should().Be("Müşteri;Projeler;Session;Token;Maliyet;Pay");
        lines[1].Should().Be("CTC;alpha, beta;3;900;9,00;90,0");
        lines[2].Should().StartWith("Atanmamış;gamma;1;50;0,50;");
    }
}

public sealed class GitStatusParserTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Branch_with_upstream_and_changes()
    {
        const string status = """
            # branch.oid 1234567890abcdef
            # branch.head feature/siparis-iptal
            # branch.upstream origin/feature/siparis-iptal
            # branch.ab +2 -1
            1 .M N... 100644 100644 100644 aaa bbb src/a.cs
            1 A. N... 000000 100644 100644 000 fff src/b.cs
            2 R. N... 100644 100644 100644 ddd eee R100 src/new.cs	src/old.cs
            u UU N... 100644 100644 100644 100644 f g h src/conflict.cs
            ? notes.txt
            """;
        var s = GitStatusParser.Parse(status, "1790856000\tFix order cancel flow\n", Now);

        s.Should().Be(new GitStatus("feature/siparis-iptal", false, true, 2, 1, 5,
            DateTimeOffset.FromUnixTimeSeconds(1790856000), "Fix order cancel flow", Now));
    }

    [Fact]
    public void Detached_head_without_upstream()
    {
        var s = GitStatusParser.Parse("# branch.oid abc\n# branch.head (detached)\n", null, Now);
        s.Branch.Should().BeNull();
        s.IsDetached.Should().BeTrue();
        s.HasUpstream.Should().BeFalse();
        s.Changed.Should().Be(0);
        s.LastCommitAt.Should().BeNull();
    }

    [Fact]
    public void Fresh_repo_with_only_untracked_files()
    {
        var s = GitStatusParser.Parse("# branch.oid (initial)\r\n# branch.head main\r\n? a.txt\r\n? b.txt\r\n", "", Now);
        s.Branch.Should().Be("main");
        s.Changed.Should().Be(2);
        s.Ahead.Should().Be(0);
    }
}

public sealed class HealthEvaluatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Transcripts_without_hooks_for_three_minutes_warn_and_recover()
    {
        var silent = new HealthInputs(Now) { LastTranscriptWriteAt = Now.AddMinutes(-1), LastHookAt = Now.AddMinutes(-4) };
        HealthEvaluator.Evaluate(silent).Should().ContainSingle(i => i.Check == HealthCheck.HooksSilent && i.Severity == HealthSeverity.Warning);

        HealthEvaluator.Evaluate(silent with { LastHookAt = Now.AddMinutes(-1) }).Should().BeEmpty();
        HealthEvaluator.Evaluate(silent with { LastTranscriptWriteAt = Now.AddSeconds(-5) }).Should().BeEmpty("the hook gets a grace period");
        HealthEvaluator.Evaluate(silent with { LastTranscriptWriteAt = Now.AddMinutes(-10) }).Should().BeEmpty("no recent activity");
    }

    [Fact]
    public void Broken_install_is_an_error_and_replaces_the_silence_check()
    {
        var i = new HealthInputs(Now)
        {
            HookInstall = HookSetup.Missing,
            LastTranscriptWriteAt = Now.AddMinutes(-1),
        };
        HealthEvaluator.Evaluate(i).Should().ContainSingle().Which.Should().Match<HealthIssue>(x => x.Check == HealthCheck.HooksBroken && x.Severity == HealthSeverity.Error);
    }

    [Fact]
    public void Parser_mismatch_needs_a_sample_and_merges_with_a_version_change()
    {
        var parser = new ParserStats(Lines: 100, InvalidLines: 4, AssistantLines: 60, MalformedUsageLines: 0);
        HealthEvaluator.Evaluate(new HealthInputs(Now) { Parser = parser })
            .Should().ContainSingle(i => i.Check == HealthCheck.ParserMismatch && i.Detail[0] == "4");

        HealthEvaluator.Evaluate(new HealthInputs(Now) { Parser = parser with { Lines = 40 } }).Should().BeEmpty("too few lines");

        var updated = new HealthInputs(Now)
        {
            Parser = parser,
            ClaudeVersion = "2.1.290",
            PreviousClaudeVersion = "2.1.286",
            VersionChangedAt = Now.AddHours(-1),
        };
        HealthEvaluator.Evaluate(updated).Should().ContainSingle()
            .Which.Detail.Should().Equal("4", "2.1.286", "2.1.290");
        HealthEvaluator.Evaluate(updated with { Parser = ParserStats.Empty })
            .Should().ContainSingle(i => i.Check == HealthCheck.ClaudeUpdated && i.Severity == HealthSeverity.Info);
        HealthEvaluator.Evaluate(updated with { Parser = ParserStats.Empty, VersionChangedAt = Now.AddHours(-25) }).Should().BeEmpty();
    }

    [Fact]
    public void Worst_issue_comes_first()
    {
        var i = new HealthInputs(Now)
        {
            PortOk = false,
            FailedHotkey = "Ctrl+Alt+Space",
            DatabaseOk = false,
            ClaudeVersion = "2", PreviousClaudeVersion = "1", VersionChangedAt = Now,
        };
        var issues = HealthEvaluator.Evaluate(i);
        issues[0].Severity.Should().Be(HealthSeverity.Error);
        issues[^1].Check.Should().Be(HealthCheck.ClaudeUpdated);
        issues.Should().Contain(x => x.Check == HealthCheck.HotkeyUnavailable && x.Detail[0] == "Ctrl+Alt+Space");
    }
}

public sealed class DailySummaryTests
{
    private static readonly TimeZoneInfo Istanbul = TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul");
    private static readonly DateOnly Day = new(2026, 9, 30);
    private static readonly DateTimeOffset From = WaitMetricsCalculator.StartOfDay(Day, Istanbul);
    private const string Alpha = @"C:\src\alpha";
    private const string Beta = @"C:\src\beta";

    [Fact]
    public void Todo_diff_counts_only_items_that_were_open_before()
    {
        TodoSnapshot S(string hash, bool done, int hour) => new(Alpha, "tasks/todo.md", hash, "Item " + hash, done, From.AddHours(hour));

        var completed = TodoDiff.CompletedBetween(
            [
                S("a", false, -5), S("a", true, 10),          // open yesterday, done today → counted
                S("b", true, 9),                               // first seen already done → not counted
                S("c", false, 9), S("c", true, 11),            // added and finished today → counted
                S("d", false, -5), S("d", true, 10), S("d", false, 12), // reopened → not counted
                S("e", false, -5), S("e", true, 30),           // done tomorrow → not counted
            ],
            From, From.AddDays(1));

        completed.Select(c => c.Text).Should().BeEquivalentTo("Item a", "Item c");
    }

    [Fact]
    public void Active_time_is_working_time_clipped_to_the_day()
    {
        var activity = ActivityCalculator.ByProject(
            [
                new StateTransition("s1", SessionState.Working, From.AddHours(-1), null),
                new StateTransition("s1", SessionState.Idle, From.AddMinutes(30), null),
                new StateTransition("s1", SessionState.Working, From.AddHours(10), null),
                new StateTransition("s1", SessionState.WaitingPermission, From.AddHours(10).AddMinutes(20), null),
                new StateTransition("s1", SessionState.Working, From.AddHours(10).AddMinutes(25), null),
                new StateTransition("s1", SessionState.Idle, From.AddHours(10).AddMinutes(35), null),
            ],
            _ => Alpha, From, From.AddDays(1), From.AddDays(2));

        activity[Alpha].Should().Be((TimeSpan.FromMinutes(60), 1));
    }

    [Fact]
    public void Commit_list_is_capped_and_the_template_is_deterministic()
    {
        var commits = Enumerable.Range(1, 25).Select(i => $"commit {i}").ToList();
        var input = DailySummaryInputBuilder.Build(
            Day,
            new Dictionary<string, (TimeSpan, int)> { [Alpha] = (TimeSpan.FromMinutes(130), 2), [Beta] = (TimeSpan.FromMinutes(25), 1) },
            new Dictionary<string, (long, decimal?)> { [Alpha] = (1_200_000, 4.9m), [Beta] = (100_000, 0.8m) },
            new WaitMetrics
            {
                Total = TimeSpan.FromMinutes(47),
                Longest = new WaitSpan("s1", Beta, WaitKind.Permission, From.AddHours(15), From.AddHours(15).AddMinutes(14), "Bash", false),
                ByProject = [new(Beta, TimeSpan.FromMinutes(40)), new(Alpha, TimeSpan.FromMinutes(7))],
            },
            [new CompletedTodo(Alpha, "Sipariş onay action'ı"), new CompletedTodo(Alpha, "Testler")],
            new Dictionary<string, IReadOnlyList<string>> { [Alpha] = commits },
            new Dictionary<string, string> { [Alpha] = "API durum sorgusu", [Beta] = "Faz 2 planı" },
            new Dictionary<string, int> { [Alpha] = 12 },
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { Beta },
            root => Path.GetFileName(root),
            _ => true);

        input.Projects[0].Commits.Should().HaveCount(20);
        input.CompletedTodos.Should().Be(2);
        input.Commits.Should().Be(20);
        input.CostUsd.Should().Be(5.7m);
        input.HasActivity.Should().BeTrue();
        input.SourceHash("tr-TR").Should().Be(input.SourceHash("tr-TR")).And.HaveLength(32);
        input.SourceHash("en-US").Should().NotBe(input.SourceHash("tr-TR"));
        DailySummaryTemplate.SystemPromptFor("en-US").Should().Contain("## Highlights");
        DailySummaryTemplate.SystemPromptFor("tr-TR").Should().Contain("## Öne çıkanlar");
        input.ToJson().Should().Contain("\"date\": \"2026-09-30\"").And.Contain("API durum sorgusu");

        var labels = new SummaryLabels(
            "Öne çıkanlar", "Projeler", "Yarın için",
            m => m >= 60 ? $"{m / 60} sa {m % 60} dk" : $"{m} dk",
            c => "$" + c.ToString("0.00", CultureInfo.GetCultureInfo("tr-TR")),
            (text, n) => n > 0 ? $"{n} todo tamamlandı ({text})" : text,
            (todos, commitCount) => $"{todos} todo · {commitCount} commit",
            m => $"Session'lar bugün toplam {m} dk cevabını bekledi;",
            (p, m) => $"en uzun bekleme {p}'de ({m} dk).",
            n => $"{n} projede commit edilmemiş değişiklik var",
            p => $"{p}: bekleyen session var",
            "Plan yok");

        DailySummaryTemplate.Render(input, labels).Should().Be("""
            ## Öne çıkanlar
            - **alpha**: 2 todo tamamlandı (Sipariş onay action'ı, Testler)
            - Session'lar bugün toplam 47 dk cevabını bekledi; en uzun bekleme beta'de (14 dk).

            ## Projeler
            - **alpha** — 2 sa 10 dk · 2 todo · 20 commit · $4,90
            - **beta** — 25 dk · 0 todo · 0 commit · $0,80

            ## Yarın için
            - alpha: API durum sorgusu
            - beta: Faz 2 planı
            - beta: bekleyen session var
            - 1 projede commit edilmemiş değişiklik var

            """.Replace("\r\n", "\n"));
    }

    [Fact]
    public void A_day_without_sessions_todos_or_commits_has_no_activity()
    {
        var input = DailySummaryInputBuilder.Build(
            Day, new Dictionary<string, (TimeSpan, int)>(), new Dictionary<string, (long, decimal?)>(), new WaitMetrics(), [],
            new Dictionary<string, IReadOnlyList<string>>(), new Dictionary<string, string>(), new Dictionary<string, int>(),
            new HashSet<string>(), r => r, _ => true);
        input.HasActivity.Should().BeFalse();
    }
}
