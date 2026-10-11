using System.Text.Json;
using Hub.Core.Adapters;

namespace Hub.Core.Tests;

/// <summary>
/// <c>adapters/*/adapter.json</c> against <c>schema/adapter.v1.json</c> with the production validator
/// (<see cref="JsonSchemaLite"/>, no schema-validator dependency), ids matching the registered adapters, and
/// <see cref="AdapterDefinition.Parse"/> on hand-written definitions.
/// </summary>
public class AdapterDefinitionTests
{
    private static readonly string RepoRoot = FindRepoRoot();

    private static readonly JsonElement Schema = LoadSchema();

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "adapters")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new DirectoryNotFoundException("adapters/ not found above the test output folder");
    }

    private static JsonElement LoadSchema()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "schema", "adapter.v1.json")));
        return doc.RootElement.Clone();
    }

    public static TheoryData<string> AdapterFiles()
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.EnumerateFiles(Path.Combine(RepoRoot, "adapters"), "adapter.json", SearchOption.AllDirectories).Order(StringComparer.Ordinal))
        {
            data.Add(Path.GetRelativePath(RepoRoot, file));
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(AdapterFiles))]
    public void Adapter_file_matches_the_schema(string relativePath)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, relativePath)));

        var errors = JsonSchemaLite.Validate(doc.RootElement, Schema);

        errors.Should().BeEmpty();
        Path.GetFileName(Path.GetDirectoryName(relativePath)).Should().Be(doc.RootElement.GetProperty("id").GetString(), "the folder is named after the id");
    }

    [Fact]
    public void Every_registered_adapter_has_a_definition_and_vice_versa()
    {
        var defined = Directory.EnumerateDirectories(Path.Combine(RepoRoot, "adapters")).Select(Path.GetFileName);

        defined.Should().BeEquivalentTo(TestAdapters.BuiltIn.All.Select(a => a.Id));
    }

    [Fact]
    public void Built_in_definitions_parse_with_their_hook_shell_and_usage()
    {
        var claude = AdapterDefinition.Parse(File.ReadAllText(Path.Combine(RepoRoot, "adapters", "claude-code", "adapter.json")), Schema, out var errors);
        var codex = AdapterDefinition.Parse(File.ReadAllText(Path.Combine(RepoRoot, "adapters", "codex", "adapter.json")), Schema, out _);

        errors.Should().BeEmpty();
        claude!.Hooks!.Shell.Should().Be(HookShell.Cmd);
        claude.Usage.Should().Be(UsageMode.BuiltIn);
        codex!.Hooks!.Shell.Should().Be(HookShell.CmdUnquoted);
        codex.Hooks.Events.Should().Contain("Interrupt");
    }

    private const string Minimal = """
        { "v": 1, "id": "my-agent", "displayName": "My Agent", "avatar": { "letter": "M", "bg": "#101010", "ink": "#f0f0f0" },
          "detect": { "executables": ["my-agent.exe"] }, "launch": { "command": "my-agent" } %EXTRA% }
        """;

    private static AdapterDefinition? Parse(string extra, out IReadOnlyList<string> errors) =>
        AdapterDefinition.Parse(Minimal.Replace("%EXTRA%", extra, StringComparison.Ordinal), Schema, out errors);

    [Fact]
    public void A_user_definition_with_screen_rules_parses()
    {
        var d = Parse("""
            , "usage": "protocol",
              "screenRules": [
                { "id": "approve", "state": "waitingPermission", "pattern": "\\(y\\)es.*\\(n\\)o", "lines": 3, "clearOn": "input" },
                { "id": "ask", "state": "waitingInput", "pattern": "^\\? " } ]
            """, out var errors);

        errors.Should().BeEmpty();
        d!.Id.Should().Be("my-agent");
        d.Hooks.Should().BeNull("a protocol agent has no hooks");
        d.Usage.Should().Be(UsageMode.Protocol);
        d.ScreenRules.Should().Equal(
            new ScreenRule("approve", ScreenRuleState.WaitingPermission, @"\(y\)es.*\(n\)o", 3, "input"),
            new ScreenRule("ask", ScreenRuleState.WaitingInput, @"^\? ", ScreenRule.DefaultLines, null));
        d.Json.GetProperty("launch").GetProperty("command").GetString().Should().Be("my-agent");
    }

    [Theory]
    [InlineData(""", "usage": "sometimes" """, "$.usage")]
    [InlineData(""", "hooks": { "shell": "zsh", "events": [] } """, "$.hooks.shell")]
    [InlineData(""", "hooks": { "events": ["Stop"] } """, "missing 'shell'")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "busy", "pattern": "a" } ] """, "$.screenRules[0].state")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "done", "pattern": "a", "lines": 51 } ] """, "above 50")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "done", "pattern": "(?=y)" } ] """, "lookaround")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "done", "pattern": "(a)\\1" } ] """, "backreferences")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "done", "pattern": "[" } ] """, "invalid regex")]
    [InlineData(""", "screenRules": [ { "id": "x", "state": "done", "pattern": "a" }, { "id": "x", "state": "done", "pattern": "b" } ] """, "duplicate id")]
    [InlineData(""", "colour": "red" """, "unknown property 'colour'")]
    public void Invalid_definitions_are_rejected_with_a_reason(string extra, string expected)
    {
        Parse(extra, out var errors).Should().BeNull();

        errors.Should().Contain(e => e.Contains(expected, StringComparison.Ordinal));
    }

    [Fact]
    public void Text_that_is_not_json_is_an_error_not_an_exception()
    {
        AdapterDefinition.Parse("{ nope", Schema, out var errors).Should().BeNull();

        errors.Should().ContainSingle().Which.Should().StartWith("Not valid JSON");
    }
}
