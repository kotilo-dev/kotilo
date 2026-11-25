using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hub.Service.Tests;

/// <summary>Claude Code statusLine install/uninstall over HTTP on a temp Claude folder (never the real <c>~/.claude</c>).</summary>
public sealed class StatusLineApiTests(HubFixture hub) : IClassFixture<HubFixture>
{
    private const string Route = "/v1/adapters/claude-code/statusline";

    private string Settings => hub.Host.Paths.ClaudeSettingsPath;

    private void Reset(string? settingsJson, bool helper = true)
    {
        Directory.CreateDirectory(hub.Host.Paths.ClaudeConfigDir);
        File.Delete(Settings);
        if (settingsJson is not null)
        {
            File.WriteAllText(Settings, settingsJson);
        }

        Directory.CreateDirectory(hub.Host.ToolsDir);
        if (helper)
        {
            File.WriteAllText(hub.Host.StatusLineExePath, "stub");
        }
        else
        {
            File.Delete(hub.Host.StatusLineExePath);
        }
    }

    private async Task<(HttpStatusCode Status, JsonElement Body)> SendAsync(HttpMethod method, string path)
    {
        using var request = new HttpRequestMessage(method, new Uri(path, UriKind.Relative)) { Content = new StringContent(string.Empty, Encoding.UTF8, "application/json") };
        using var response = await hub.Http.SendAsync(request);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return (response.StatusCode, doc.RootElement.Clone());
    }

    private JsonObject ReadSettings() => (JsonObject)JsonNode.Parse(File.ReadAllText(Settings))!;

    [Fact]
    public async Task Install_without_a_user_statusline_then_uninstall_removes_it()
    {
        Reset("""{ "model": "opus" }""");

        var (_, before) = await SendAsync(HttpMethod.Get, Route);
        before.GetProperty("state").GetString().Should().Be("missing");
        before.GetProperty("helperAvailable").GetBoolean().Should().BeTrue();

        var (status, installed) = await SendAsync(HttpMethod.Post, Route + "/install");
        status.Should().Be(HttpStatusCode.OK);
        installed.GetProperty("state").GetString().Should().Be("installed");
        installed.GetProperty("wrappedCommand").ValueKind.Should().Be(JsonValueKind.Null);
        installed.GetProperty("backupPath").GetString().Should().NotBeNull();
        ReadSettings()["statusLine"]!["command"]!.GetValue<string>().Should().Be($"\"{hub.Host.StatusLineExePath}\"");
        ReadSettings()["model"]!.GetValue<string>().Should().Be("opus");

        var (_, removed) = await SendAsync(HttpMethod.Post, Route + "/uninstall");
        removed.GetProperty("state").GetString().Should().Be("missing");
        ReadSettings().ContainsKey("statusLine").Should().BeFalse();
        ReadSettings()["model"]!.GetValue<string>().Should().Be("opus");
    }

    [Fact]
    public async Task Install_wraps_the_users_command_keeps_its_other_keys_and_uninstall_restores_it()
    {
        Reset("""{ "statusLine": { "type": "command", "command": "bash ~/sl.sh", "padding": 2, "refreshInterval": 5 } }""");

        var (_, installed) = await SendAsync(HttpMethod.Post, Route + "/install");
        installed.GetProperty("wrappedCommand").GetString().Should().Be("bash ~/sl.sh");
        var line = ReadSettings()["statusLine"]!;
        line["padding"]!.GetValue<int>().Should().Be(2);
        line["refreshInterval"]!.GetValue<int>().Should().Be(5);
        JsonNode.Parse(File.ReadAllText(hub.Host.Paths.StatusLineConfigPath))!["wrappedCommand"]!.GetValue<string>().Should().Be("bash ~/sl.sh");
        (await SendAsync(HttpMethod.Get, Route)).Body.GetProperty("wrappedCommand").GetString().Should().Be("bash ~/sl.sh");

        // Installing again keeps the wrapped command (idempotent).
        var (_, again) = await SendAsync(HttpMethod.Post, Route + "/install");
        again.GetProperty("state").GetString().Should().Be("installed");
        again.GetProperty("wrappedCommand").GetString().Should().Be("bash ~/sl.sh");

        await SendAsync(HttpMethod.Post, Route + "/uninstall");
        var restored = ReadSettings()["statusLine"]!;
        restored["command"]!.GetValue<string>().Should().Be("bash ~/sl.sh");
        restored["padding"]!.GetValue<int>().Should().Be(2);
        File.Exists(hub.Host.Paths.StatusLineConfigPath).Should().BeFalse();
    }

    [Fact]
    public async Task Invalid_settings_json_is_never_rewritten()
    {
        Reset("{ not json");

        (await SendAsync(HttpMethod.Get, Route)).Body.GetProperty("state").GetString().Should().Be("invalidConfig");
        var (status, body) = await SendAsync(HttpMethod.Post, Route + "/install");

        status.Should().Be(HttpStatusCode.UnprocessableEntity);
        body.GetProperty("error").GetString().Should().Be("invalidConfig");
        File.ReadAllText(Settings).Should().Be("{ not json");
        (await SendAsync(HttpMethod.Post, Route + "/uninstall")).Status.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Install_is_refused_without_the_helper_exe()
    {
        Reset("""{ "statusLine": { "type": "command", "command": "mine" } }""", helper: false);

        (await SendAsync(HttpMethod.Get, Route)).Body.GetProperty("helperAvailable").GetBoolean().Should().BeFalse();
        var (status, body) = await SendAsync(HttpMethod.Post, Route + "/install");

        status.Should().Be(HttpStatusCode.Conflict);
        body.GetProperty("error").GetString().Should().Be("helperMissing");
        ReadSettings()["statusLine"]!["command"]!.GetValue<string>().Should().Be("mine");
    }
}
