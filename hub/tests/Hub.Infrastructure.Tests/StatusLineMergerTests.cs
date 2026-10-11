using System.Text.Json.Nodes;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Tests;

public sealed class StatusLineMergerTests : IDisposable
{
    private const string Exe = @"C:\agent-hub\agenthub-statusline.exe";
    private readonly TempDir _dir = new();
    private readonly ClaudeSettingsMerger _merger;
    private readonly string _settings;

    public StatusLineMergerTests()
    {
        _settings = _dir.File("settings.json");
        _merger = new ClaudeSettingsMerger(_settings, @"C:\agent-hub\agenthub-hook.exe");
    }

    public void Dispose() => _dir.Dispose();

    private JsonObject Read() => (JsonObject)JsonNode.Parse(File.ReadAllText(_settings))!;

    [Fact]
    public void Install_without_existing_statusline()
    {
        var (_, previous) = _merger.InstallStatusLine(Exe);

        previous.Should().BeNull();
        Read()["statusLine"]!["command"]!.GetValue<string>().Should().Be($"\"{Exe}\"");
        Read()["statusLine"]!["type"]!.GetValue<string>().Should().Be("command");
    }

    [Fact]
    public void Install_returns_existing_command_to_wrap_and_keeps_padding()
    {
        File.WriteAllText(_settings, """{ "statusLine": { "type": "command", "command": "bash ~/sl.sh", "padding": 2 } }""");

        var (backup, previous) = _merger.InstallStatusLine(Exe);

        previous.Should().Be("bash ~/sl.sh");
        backup.Should().NotBeNull();
        Read()["statusLine"]!["padding"]!.GetValue<int>().Should().Be(2);
        _merger.InstallStatusLine(Exe).Should().Be((null, null), "idempotent");
    }

    [Fact]
    public void Uninstall_restores_wrapped_command_or_removes()
    {
        File.WriteAllText(_settings, """{ "statusLine": { "type": "command", "command": "bash ~/sl.sh" } }""");
        _merger.InstallStatusLine(Exe);

        _merger.UninstallStatusLine("bash ~/sl.sh").Should().NotBeNull();
        Read()["statusLine"]!["command"]!.GetValue<string>().Should().Be("bash ~/sl.sh");

        _merger.InstallStatusLine(Exe);
        _merger.UninstallStatusLine(null);
        Read().ContainsKey("statusLine").Should().BeFalse();
    }

    [Fact]
    public void Uninstall_leaves_foreign_statusline_alone()
    {
        File.WriteAllText(_settings, """{ "statusLine": { "type": "command", "command": "other" } }""");
        _merger.UninstallStatusLine(null).Should().BeNull();
        Read()["statusLine"]!["command"]!.GetValue<string>().Should().Be("other");
    }

    [Fact]
    public void Pricing_provider_creates_default_and_survives_bad_edit()
    {
        var provider = new PricingProvider(_dir.File("pricing.json"));
        provider.Load().Should().BeTrue();
        File.Exists(provider.Path).Should().BeTrue();
        provider.Current.Find("claude-opus-5-5").Should().NotBeNull();

        File.WriteAllText(provider.Path, "{ broken");
        provider.Load().Should().BeFalse();
        provider.Error.Should().NotBeNull();
        provider.Current.Find("claude-opus-5-5").Should().NotBeNull("last good table is kept");
    }
}
