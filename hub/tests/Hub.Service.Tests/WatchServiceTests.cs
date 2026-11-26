using Hub.Core.Watch;
using Hub.Service.Api;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

/// <summary>Project files (<c>.kotilo/watch.json</c>), settings defaults and settings validation.</summary>
public sealed class WatchServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly string _root;

    public WatchServiceTests()
    {
        _root = Path.Combine(_dir, "proj");
        Directory.CreateDirectory(Path.Combine(_root, ".kotilo"));
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string FilePath => Path.Combine(_root, ".kotilo", "watch.json");

    private static string Rules(string name = "Deploy", string command = @"deploy\\.sh") =>
        $$"""{"rules":[{"id":"deploy","name":"{{name}}","tools":["Bash"],"command":"{{command}}"}]}""";

    private static List<string> Hits(WatchService service, string root, string command) =>
        service.Engine.Evaluate(new WatchInput("Bash", command, null, null, root), "s").Select(h => h.Id).ToList();

    [Fact]
    public void An_untrusted_project_is_listed_but_its_rules_do_not_apply()
    {
        File.WriteAllText(FilePath, Rules());
        var service = new WatchService();
        service.Configure(new WatchSettings());
        service.Refresh([_root]);

        Hits(service, _root, "./deploy.sh").Should().BeEmpty();
        var project = service.Engine.Describe().Projects.Should().ContainSingle().Subject;
        (project.Trusted, project.RuleCount).Should().Be((false, 1));
    }

    [Fact]
    public void A_trusted_project_applies_and_a_changed_file_is_picked_up_on_the_next_refresh()
    {
        File.WriteAllText(FilePath, Rules());
        var service = new WatchService();
        service.Configure(new WatchSettings { TrustedProjects = [_root] });
        service.Refresh([_root]);
        Hits(service, _root, "./deploy.sh").Should().Equal("project.deploy");

        File.WriteAllText(FilePath, Rules(command: @"release\\.sh"));
        service.Refresh([_root]);
        Hits(service, _root, "./deploy.sh").Should().BeEmpty();
        Hits(service, _root, "./release.sh").Should().Equal("project.deploy");

        File.Delete(FilePath);
        service.Refresh([_root]);
        Hits(service, _root, "./release.sh").Should().BeEmpty();
        service.Engine.Describe().Projects.Should().BeEmpty();
    }

    [Fact]
    public void A_trusted_project_without_a_session_is_still_read()
    {
        File.WriteAllText(FilePath, Rules());
        var service = new WatchService();
        service.Configure(new WatchSettings { TrustedProjects = [_root] });
        service.Refresh([]);

        Hits(service, _root, "./deploy.sh").Should().Equal("project.deploy");
    }

    [Fact]
    public void An_oversized_file_is_not_read_and_reported()
    {
        File.WriteAllText(FilePath, Rules() + new string(' ', WatchLimits.MaxFileBytes + 10));
        var service = new WatchService();
        service.Configure(new WatchSettings { TrustedProjects = [_root] });
        service.Refresh([_root]);

        Hits(service, _root, "./deploy.sh").Should().BeEmpty();
        service.Engine.Describe().Projects.Single().Problems.Should().ContainSingle().Which.Message.Should().Contain("64 KB");
    }

    [Fact]
    public void A_broken_file_reports_its_line_and_a_link_is_not_followed()
    {
        File.WriteAllText(FilePath, "{\n\"rules\": [\n{ oops }\n]}");
        var service = new WatchService();
        service.Configure(new WatchSettings());
        service.Refresh([_root]);
        service.Engine.Describe().Projects.Single().Problems.Single().Line.Should().Be(3);

        var target = Path.Combine(_dir, "real.json");
        File.WriteAllText(target, Rules());
        File.Delete(FilePath);
        try
        {
            File.CreateSymbolicLink(FilePath, target);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return; // creating a link needs a privilege this machine does not give
        }

        service.Configure(new WatchSettings { TrustedProjects = [_root] });
        service.Refresh([_root]);
        Hits(service, _root, "./deploy.sh").Should().BeEmpty("a link is not read");
        service.Engine.Describe().Projects.Single().Problems.Single().Message.Should().Contain("link");
    }

    [Fact]
    public void Old_settings_files_without_a_watch_section_load_the_defaults()
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, """{ "Version": 1, "Language": "en-US" }""");

        var watch = AppSettings.Load(path).Watch;

        watch.Enabled.Should().BeTrue();
        (watch.DisabledBuiltins, watch.NotifyOffBuiltins, watch.Rules, watch.TrustedProjects).Should().BeEquivalentTo(
            ((IReadOnlyList<string>)[], (IReadOnlyList<string>)[], (IReadOnlyList<WatchRule>)[], (IReadOnlyList<string>)[]));
    }

    [Fact]
    public void Watch_settings_survive_a_save_and_load()
    {
        var path = Path.Combine(_dir, "settings.json");
        var saved = new AppSettings
        {
            Watch = new WatchSettings
            {
                Enabled = false,
                DisabledBuiltins = [WatchBuiltins.DbDrop],
                Rules = [new WatchRule("user.x", "X", Notify: false, Tools: ["Bash"], Command: "x")],
                TrustedProjects = [_root],
            },
        };
        saved.Save(path);

        var loaded = AppSettings.Load(path).Watch;
        loaded.Enabled.Should().BeFalse();
        loaded.DisabledBuiltins.Should().Equal(WatchBuiltins.DbDrop);
        loaded.Rules.Should().BeEquivalentTo(saved.Watch.Rules);
        loaded.TrustedProjects.Should().Equal(_root);
    }

    private static Dictionary<string, string[]> Validate(WatchSettings watch)
    {
        var settings = HubSettingsDto.From(new AppSettings(), _ => false) with { Watch = watch };
        return SettingsEndpoints.Validate(settings);
    }

    [Fact]
    public void Settings_validation_accepts_good_rules_and_rejects_bad_ones_per_field()
    {
        Validate(new WatchSettings { Rules = [new WatchRule("user.ok", "OK", Tools: ["Bash"], Command: @"git\s+push", Paths: ["**/.env"])] }).Should().BeEmpty();

        var fields = Validate(new WatchSettings
        {
            DisabledBuiltins = ["builtin.nope"],
            Rules =
            [
                new WatchRule("user.regex", "Regex", Command: "(oops"),
                new WatchRule("user.empty", "Empty"),
                new WatchRule("builtin.force-push", "Takes a builtin id", Tools: ["Bash"]),
                new WatchRule("user.dup", "One", Tools: ["Bash"]),
                new WatchRule("user.dup", "Two", Tools: ["Bash"]),
                new WatchRule("user.long", new string('x', 61), Tools: ["Bash"]),
                new WatchRule("user.glob", "Glob", Paths: [""]),
            ],
            TrustedProjects = [" "],
        });

        fields.Keys.Should().Contain(
        [
            "watch.disabledBuiltins", "watch.rules[0].command", "watch.rules[1].match", "watch.rules[2].id", "watch.rules[4].id", "watch.rules[5].name",
            "watch.rules[6].paths", "watch.trustedProjects",
        ]);
    }

    [Theory]
    [InlineData("relative/project")]
    [InlineData("proj")]
    [InlineData("../../etc")]
    public void Trusted_projects_must_be_absolute_paths(string path) =>
        Validate(new WatchSettings { TrustedProjects = [path] }).Keys.Should().Contain("watch.trustedProjects");

    [Fact]
    public void Project_files_are_refreshed_by_the_services_own_timer_without_a_pipeline_tick()
    {
        File.WriteAllText(FilePath, Rules());
        using var service = new WatchService();
        service.Configure(new WatchSettings { TrustedProjects = [_root] });
        service.Start(() => [_root]);

        SpinWait.SpinUntil(() => Hits(service, _root, "./deploy.sh").Count == 1, TimeSpan.FromSeconds(10)).Should().BeTrue();
    }
}
