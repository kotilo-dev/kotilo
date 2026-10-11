using Hub.Core.Adapters;
using Hub.Infrastructure.Adapters;
using Hub.Infrastructure.Claude;

namespace Hub.Infrastructure.Tests;

/// <summary>Adapter definitions from a built-in and a user folder (temp dirs) joined with the code adapters.</summary>
public sealed class AdapterCatalogTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly string _builtIn;
    private readonly string _user;

    public AdapterCatalogTests()
    {
        _builtIn = Path.Combine(_dir.Path, "builtin");
        _user = Path.Combine(_dir.Path, "user");
        Write(_builtIn, "claude-code", Definition("claude-code", "Claude Code"));
        Write(_builtIn, "codex", Definition("codex", "Codex CLI"));
    }

    public void Dispose() => _dir.Dispose();

    private static string Definition(string id, string name, string extra = "") => $$"""
        { "v": 1, "id": "{{id}}", "displayName": "{{name}}", "avatar": { "letter": "A", "bg": "#101010", "ink": "#f0f0f0" },
          "detect": { "executables": ["{{id}}.exe"] }, "launch": { "command": "{{id}}" }{{extra}} }
        """;

    private static void Write(string root, string folder, string content)
    {
        Directory.CreateDirectory(Path.Combine(root, folder));
        File.WriteAllText(Path.Combine(root, folder, "adapter.json"), content);
    }

    private AdapterCatalog Catalog() => new(
        [
            new AgentIntegration(new ClaudeCodeAdapter(), new ClaudeSettingsMerger(_dir.File("claude-settings.json"), @"C:\x\agenthub-hook.exe")),
            new AgentIntegration(new CodexAdapter(), null),
        ],
        _builtIn,
        _user);

    [Fact]
    public void Built_in_definitions_join_their_code_adapters()
    {
        var catalog = Catalog();

        catalog.Entries.Select(e => (e.Id, e.Source, e.Error)).Should().Equal(
            ("claude-code", AdapterSource.BuiltIn, (string?)null), ("codex", AdapterSource.BuiltIn, (string?)null));
        catalog.Entries[0].Adapter.Should().BeOfType<ClaudeCodeAdapter>();
        catalog.Entries[0].Installer.Should().BeOfType<ClaudeSettingsMerger>();
        catalog.Entries[0].Definition!.DisplayName.Should().Be("Claude Code");
        catalog.Registry.All.Select(a => a.Id).Should().BeEquivalentTo(["claude-code", "codex"]);
    }

    [Fact]
    public void A_valid_user_definition_gets_a_generic_adapter_without_hooks()
    {
        Write(_user, "my-agent", Definition("my-agent", "My Agent", """, "usage": "protocol" """));

        var entry = Catalog().Find("my-agent");

        entry.Should().NotBeNull();
        entry!.Source.Should().Be(AdapterSource.User);
        entry.Adapter.Should().BeOfType<GenericAdapter>().Which.DisplayName.Should().Be("My Agent");
        entry.Installer.Should().BeNull();
        entry.Definition!.Usage.Should().Be(UsageMode.Protocol);
    }

    [Fact]
    public void Invalid_user_files_are_listed_with_their_error_and_never_registered()
    {
        Write(_user, "broken", "{ not json");
        Write(_user, "bad-schema", Definition("bad-schema", "Bad", """, "usage": "maybe" """));
        Write(_user, "renamed", Definition("other-id", "Renamed"));

        var catalog = Catalog();

        var users = catalog.Entries.Where(e => e.Source == AdapterSource.User).ToList();
        users.Select(e => e.Id).Should().Equal("bad-schema", "broken", "renamed");
        users.Should().OnlyContain(e => e.Error != null && e.Adapter == null);
        users[1].Error.Should().StartWith("Not valid JSON");
        users[0].Error.Should().Contain("$.usage");
        users[2].Error.Should().Contain("does not match its folder name");
        catalog.Registry.Find("broken").Should().BeNull();
    }

    [Fact]
    public void Built_in_ids_win_over_user_ids()
    {
        Write(_user, "codex", Definition("codex", "My Codex"));

        var catalog = Catalog();

        catalog.Find("codex")!.Source.Should().Be(AdapterSource.BuiltIn);
        catalog.Registry.Find("codex").Should().BeOfType<CodexAdapter>();
        var shadowed = catalog.Entries.Single(e => e.Source == AdapterSource.User);
        shadowed.Error.Should().Contain("built-in adapter 'codex' takes precedence");
        shadowed.Adapter.Should().BeNull();
    }

    [Fact]
    public void A_broken_built_in_file_keeps_its_code_adapter_working()
    {
        Write(_builtIn, "codex", "{");

        var codex = Catalog().Find("codex");

        codex!.Adapter.Should().BeOfType<CodexAdapter>();
        codex.Error.Should().NotBeNull();
        codex.Definition.Should().BeNull();
    }

    [Fact]
    public void Code_adapters_without_a_definition_folder_are_still_registered()
    {
        var catalog = new AdapterCatalog([new AgentIntegration(new CodexAdapter(), null)], builtInDir: null, userDir: Path.Combine(_dir.Path, "none"));

        catalog.Entries.Should().ContainSingle().Which.Should().Match<AdapterEntry>(e => e.Id == "codex" && e.Path == null && e.Error == null);
    }

    [Fact]
    public void Reload_picks_up_new_and_removed_user_files()
    {
        var catalog = Catalog();
        IReadOnlyList<AdapterEntry>? changed = null;
        catalog.Changed += entries => changed = entries;
        catalog.Find("my-agent").Should().BeNull();

        Write(_user, "my-agent", Definition("my-agent", "My Agent"));
        catalog.Reload();

        catalog.Registry.Find("my-agent").Should().BeOfType<GenericAdapter>();
        changed.Should().NotBeNull().And.Contain(e => e.Id == "my-agent");

        Directory.Delete(Path.Combine(_user, "my-agent"), recursive: true);
        catalog.Reload();
        catalog.Registry.Find("my-agent").Should().BeNull();
    }

    [Fact]
    public void A_built_in_folder_without_code_gets_the_protocol_adapter()
    {
        Write(_builtIn, "future-agent", Definition("future-agent", "Future"));

        var entry = Catalog().Find("future-agent");

        entry!.Source.Should().Be(AdapterSource.BuiltIn);
        entry.Adapter.Should().BeOfType<GenericAdapter>();
    }

    [Fact]
    public void The_bundled_adapters_folder_is_found_above_the_hub()
    {
        AppPaths.FindBuiltInAdapters(AppContext.BaseDirectory).Should().NotBeNull()
            .And.Subject.As<string>().Should().EndWith("adapters");
    }
}
