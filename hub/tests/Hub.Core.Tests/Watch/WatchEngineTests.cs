using System.Text;
using Hub.Core.Watch;

namespace Hub.Core.Tests.Watch;

public class WatchEngineTests
{
    private const string Root = @"C:\src\alpha";

    private static WatchInput Call(string? tool = null, string? command = null, string? path = null, string[]? paths = null) =>
        new(tool, command, path, paths, Root);

    private static WatchEngine With(params WatchRule[] rules)
    {
        var engine = new WatchEngine();
        engine.Configure(new WatchSettings { Rules = rules });
        return engine;
    }

    private static List<string> Ids(WatchEngine engine, WatchInput input, string? session = "s") =>
        engine.Evaluate(input, session).Select(h => h.Id).ToList();

    [Fact]
    public void Fields_of_a_rule_must_all_match_and_list_items_are_alternatives()
    {
        var engine = With(new WatchRule("user.prod", "Prod", Tools: ["bash", "PowerShell"], Command: @"kubectl\s+.*--context\s+prod"));

        Ids(engine, Call("Bash", "kubectl apply -f x.yml --context prod")).Should().Equal("user.prod");
        Ids(engine, Call("powershell", "kubectl delete pod a --context PROD")).Should().Equal("user.prod");
        Ids(engine, Call("Read", "kubectl apply --context prod")).Should().BeEmpty("the tool does not match");
        Ids(engine, Call("Bash", "kubectl apply --context dev")).Should().BeEmpty("the command does not match");
        Ids(engine, Call("Bash")).Should().BeEmpty("a command rule needs a command");
    }

    [Fact]
    public void Path_globs_match_the_project_relative_and_the_absolute_path()
    {
        var engine = With(
            new WatchRule("user.migrations", "Migrations", Paths: ["db/migrations/**"]),
            new WatchRule("user.abs", "Abs", Paths: ["C:/src/alpha/infra/*.tf"]),
            new WatchRule("user.any", "Any", Paths: ["**/secrets.json"]));

        Ids(engine, Call("Edit", path: @"C:\src\alpha\db\migrations\001.sql")).Should().Contain("user.migrations");
        Ids(engine, Call("Edit", path: @"C:\src\alpha\infra\main.tf")).Should().Contain("user.abs");
        Ids(engine, Call("Write", path: @"C:\src\alpha\a\b\secrets.json")).Should().Equal("user.any");
        Ids(engine, Call("apply_patch", paths: ["x.ts", "db/migrations/2.sql"])).Should().Contain("user.migrations");
        Ids(engine, Call("Edit", path: @"C:\src\alpha\src\a.ts")).Should().BeEmpty();
    }

    [Fact]
    public void The_master_switch_and_per_rule_switches_work()
    {
        var off = new WatchEngine();
        off.Configure(new WatchSettings { Enabled = false });
        Ids(off, Call("Bash", "git push --force")).Should().BeEmpty();

        var engine = new WatchEngine();
        engine.Configure(new WatchSettings
        {
            DisabledBuiltins = [WatchBuiltins.ForcePush],
            NotifyOffBuiltins = [WatchBuiltins.SecretFile],
            Rules = [new WatchRule("user.off", "Off", Enabled: false, Tools: ["Bash"])],
        });
        Ids(engine, Call("Bash", "git push --force")).Should().BeEmpty();
        var secret = engine.Evaluate(Call("Read", path: ".env"), "s").Single();
        secret.Id.Should().Be(WatchBuiltins.SecretFile);
        secret.Notify.Should().BeFalse();

        var overview = engine.Describe();
        overview.Builtins.Single(b => b.Id == WatchBuiltins.ForcePush).Enabled.Should().BeFalse();
        overview.Builtins.Single(b => b.Id == WatchBuiltins.SecretFile).Notify.Should().BeFalse();
        overview.Builtins.Single(b => b.Id == WatchBuiltins.GitDiscard).Notify.Should().BeFalse("label only by default");
        overview.Builtins.Should().HaveCount(6);
    }

    [Fact]
    public void Invalid_user_rules_are_skipped_and_reported_without_their_text()
    {
        var engine = With(
            new WatchRule("user.bad-regex", "Bad", Command: "(unclosed"),
            new WatchRule("user.lookahead", "Look", Command: "foo(?=bar)"),
            new WatchRule("user.empty", "Empty"),
            new WatchRule("user.empty-glob", "Glob", Paths: [" "]),
            new WatchRule("nope.prefix", "Prefix", Tools: ["Bash"]),
            new WatchRule("user.good", "Good", Tools: ["Bash"]));

        var problems = engine.Describe().Problems;
        problems.Select(p => p.RuleId).Should().BeEquivalentTo(["user.bad-regex", "user.lookahead", "user.empty", "user.empty-glob", "nope.prefix"]);
        problems.Should().NotContain(p => p.Message.Contains("unclosed", StringComparison.Ordinal));
        Ids(engine, Call("Bash", "x")).Should().Equal("user.good");
    }

    [Fact]
    public void Validation_enforces_limits()
    {
        WatchRuleCompiler.Compile(new WatchRule("user.a", new string('n', 61), Tools: ["Bash"]), "user.", WatchLimits.RegexTimeout, out _)
            .Should().ContainSingle(e => e.Field == "name");
        WatchRuleCompiler.Compile(new WatchRule("user.a", "A", Command: new string('a', 501)), "user.", WatchLimits.RegexTimeout, out _)
            .Should().ContainSingle(e => e.Field == "command");
        WatchRuleCompiler.Compile(new WatchRule("user.A B", "A", Tools: ["Bash"]), "user.", WatchLimits.RegexTimeout, out _)
            .Should().ContainSingle(e => e.Field == "id");
        WatchRuleCompiler.Compile(new WatchRule("user.a", "A", Tools: ["Bash"]), "user.", WatchLimits.RegexTimeout, out var ok).Should().BeEmpty();
        ok.Should().NotBeNull();
    }

    [Fact]
    public void A_rule_that_times_out_is_switched_off_for_that_session_and_reported_by_id_only()
    {
        const string Secret = "TOP-SECRET-COMMAND-TEXT";
        var calls = 0;
        var slow = new CompiledWatchRule("user.slow", "Slow", true, i =>
        {
            calls++;
            throw new System.Text.RegularExpressions.RegexMatchTimeoutException(i.Command ?? Secret, "pattern", TimeSpan.FromMilliseconds(50));
        });
        var engine = new WatchEngine(null, [slow]);
        var reported = new List<string>();
        engine.RuleTimedOut += reported.Add;

        engine.Evaluate(Call("Bash", Secret), "s1").Should().NotContain(h => h.Id == "user.slow");
        engine.Evaluate(Call("Bash", Secret), "s1");
        engine.Evaluate(Call("Bash", Secret), "s2");

        calls.Should().Be(2, "once per session, then it is off");
        reported.Should().Equal("user.slow", "user.slow");
        reported.Should().NotContain(r => r.Contains(Secret, StringComparison.Ordinal));
    }

    [Fact]
    public void Primary_prefers_a_hit_that_notifies()
    {
        WatchEngine.Primary([new WatchHit("a", "A") { Notify = false }, new WatchHit("b", "B")])!.Id.Should().Be("b");
        WatchEngine.Primary([new WatchHit("a", "A") { Notify = false }])!.Id.Should().Be("a");
        WatchEngine.Primary([]).Should().BeNull();
    }

    // ---- project files ----

    private static string File(params string[] rules) => $$"""{"rules":[{{string.Join(",", rules)}}]}""";

    [Fact]
    public void Project_rules_apply_only_when_the_project_is_trusted()
    {
        var parsed = WatchProjectFileParser.Parse(Root, File("""{"id":"deploy","name":"Deploy","tools":["Bash"],"command":"deploy\\.sh"}"""), WatchLimits.RegexTimeout);
        parsed.Problems.Should().BeEmpty();
        parsed.Rules.Single().Id.Should().Be("project.deploy");

        var engine = new WatchEngine();
        engine.SetProjectFiles([parsed]);
        engine.Configure(new WatchSettings());
        Ids(engine, Call("Bash", "./deploy.sh")).Should().BeEmpty("untrusted");
        var info = engine.Describe().Projects.Single();
        (info.Trusted, info.RuleCount).Should().Be((false, 1));

        engine.Configure(new WatchSettings { TrustedProjects = ["c:/SRC/alpha/"] });
        Ids(engine, Call("Bash", "./deploy.sh")).Should().Equal("project.deploy");
        engine.Describe().Projects.Single().Trusted.Should().BeTrue("paths compare normalized and case-insensitive on drive paths");

        Ids(engine, new WatchInput("Bash", "./deploy.sh", null, null, @"C:\src\beta")).Should().BeEmpty("another project");
    }

    [Theory]
    [InlineData("""{"id":"a","name":"A","command":5}""")]
    [InlineData("""{"id":"a","name":"A","command":null}""")]
    [InlineData("""{"id":5,"name":"A"}""")]
    [InlineData("""{"id":"a","name":["A"]}""")]
    [InlineData("""{"id":"a","name":"A","enabled":"no","tools":["Bash"]}""")]
    [InlineData("""{"id":"a","name":"A","notify":0,"tools":["Bash"]}""")]
    public void A_wrong_typed_field_rejects_the_rule_instead_of_broadening_it(string rule)
    {
        var parsed = WatchProjectFileParser.Parse(Root, File(rule), WatchLimits.RegexTimeout);

        parsed.Rules.Should().BeEmpty();
        parsed.Problems.Should().ContainSingle().Which.Message.Should().Contain("wrong type");
    }

    [Fact]
    public void Project_rules_cannot_take_builtin_or_user_ids()
    {
        var parsed = WatchProjectFileParser.Parse(
            Root,
            File(
                """{"id":"builtin.force-push","name":"Shadow","tools":["Bash"]}""",
                """{"id":"user.mine","name":"Shadow 2","tools":["Bash"]}"""),
            WatchLimits.RegexTimeout);

        parsed.Rules.Select(r => r.Id).Should().Equal("project.builtin.force-push", "project.user.mine");
        parsed.Rules.Should().NotContain(r => r.Id.StartsWith("builtin.", StringComparison.Ordinal) || r.Id.StartsWith("user.", StringComparison.Ordinal));
    }

    [Fact]
    public void Project_files_are_validated_with_caps_and_clean_names()
    {
        var many = Enumerable.Range(0, 60).Select(i => $$"""{"id":"r{{i}}","name":"R{{i}}","tools":["Bash"]}""").ToArray();
        var capped = WatchProjectFileParser.Parse(Root, File(many), WatchLimits.RegexTimeout);
        capped.Rules.Should().HaveCount(WatchLimits.MaxProjectRules);
        capped.Problems.Should().ContainSingle(p => p.Message.Contains("first 50", StringComparison.Ordinal));

        var parsed = WatchProjectFileParser.Parse(
            Root,
            File(
                $$"""{"id":"long","name":"x","command":"{{new string('a', 501)}}"}""",
                """{"id":"BAD ID","name":"x","tools":["Bash"]}""",
                """{"id":"no-match","name":"x"}""",
                """{"id":"dup","name":"One","tools":["Bash"]}""",
                """{"id":"dup","name":"Two","tools":["Bash"]}""",
                """{"id":"ctl","name":"Line\u0007\nbreak","tools":["Bash"]}""",
                """{"id":"wrong-type","name":"x","tools":"Bash"}""",
                """{"id":"lookahead","name":"x","command":"a(?=b)"}""",
                """42"""),
            WatchLimits.RegexTimeout);

        parsed.Rules.Select(r => (r.Id, r.Name)).Should().Equal(("project.dup", "One"), ("project.ctl", "Linebreak"));
        parsed.Problems.Should().HaveCount(7);
    }

    [Fact]
    public void A_broken_file_reports_the_line()
    {
        var parsed = WatchProjectFileParser.Parse(Root, "{\n  \"rules\": [\n    {\"id\": \"a\", ]\n}", WatchLimits.RegexTimeout);
        parsed.Rules.Should().BeEmpty();
        parsed.Problems.Should().ContainSingle().Which.Line.Should().Be(3);

        WatchProjectFileParser.Parse(Root, "[]", WatchLimits.RegexTimeout).Problems.Should().ContainSingle();
        WatchProjectFileParser.Parse(Root, Encoding.UTF8.GetString([]), WatchLimits.RegexTimeout).Problems.Should().ContainSingle();
    }

    [Fact]
    public void Settings_without_nulls_normalize()
    {
        var odd = new WatchSettings { DisabledBuiltins = null!, Rules = null!, TrustedProjects = null!, NotifyOffBuiltins = null! }.Normalized();
        odd.Rules.Should().BeEmpty();
        odd.DisabledBuiltins.Should().BeEmpty();
        new WatchEngine().Configure(odd);
    }
}
