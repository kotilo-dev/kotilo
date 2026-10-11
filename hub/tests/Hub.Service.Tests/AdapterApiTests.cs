using System.Net;
using System.Text;
using System.Text.Json;

namespace Hub.Service.Tests;

/// <summary>A real hub with a user-defined agent: <c>/v1/adapters</c>, reload, and Agent Integration Protocol events end to end.</summary>
public sealed class AdapterApiTests(HubFixture hub) : IClassFixture<HubFixture>
{
    private const string UserAdapter = """
        { "v": 1, "id": "my-agent", "displayName": "My Agent", "avatar": { "letter": "M", "bg": "#101010", "ink": "#f0f0f0" },
          "detect": { "executables": ["my-agent.exe"] }, "launch": { "command": "my-agent" }, "usage": "protocol",
          "screenRules": [ { "id": "approve", "state": "waitingPermission", "pattern": "Allow\\?", "lines": 2 } ] }
        """;

    private async Task<JsonElement> GetAsync(string path)
    {
        using var response = await hub.Http.GetAsync(new Uri(path, UriKind.Relative));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return doc.RootElement.Clone();
    }

    private async Task<(HttpStatusCode Status, JsonElement Body)> PostAsync(string path, string? body = null)
    {
        using var content = new StringContent(body ?? string.Empty, Encoding.UTF8, "application/json");
        using var response = await hub.Http.PostAsync(new Uri(path, UriKind.Relative), content);
        var text = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(text.Length == 0 ? "null" : text);
        return (response.StatusCode, doc.RootElement.Clone());
    }

    private async Task<JsonElement> ReloadWithUserAdaptersAsync()
    {
        var dir = Path.Combine(hub.Host.Paths.UserAdaptersDir, "my-agent");
        Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(Path.Combine(dir, "adapter.json"), UserAdapter);
        var broken = Path.Combine(hub.Host.Paths.UserAdaptersDir, "broken");
        Directory.CreateDirectory(broken);
        await File.WriteAllTextAsync(Path.Combine(broken, "adapter.json"), "{ nope");

        var (status, body) = await PostAsync("/v1/adapters/reload");
        status.Should().Be(HttpStatusCode.OK);
        return body;
    }

    [Fact]
    public async Task Built_in_adapters_carry_their_definition_and_hook_status()
    {
        var items = (await GetAsync("/v1/adapters")).EnumerateArray().ToList();

        var claude = items.Single(i => i.GetProperty("id").GetString() == "claude-code");
        claude.GetProperty("source").GetString().Should().Be("builtIn");
        claude.GetProperty("displayName").GetString().Should().Be("Claude Code");
        claude.GetProperty("definition").GetProperty("permissionKeys").GetProperty("allowOnce").GetString().Should().Be("1");
        claude.GetProperty("hooks").GetProperty("state").GetString().Should().Be("missing");
        claude.GetProperty("error").ValueKind.Should().Be(JsonValueKind.Null);
        items.Select(i => i.GetProperty("id").GetString()).Should().StartWith(["claude-code", "codex"]);
    }

    [Fact]
    public async Task Reload_adds_user_adapters_without_hooks_and_lists_broken_ones()
    {
        var items = (await ReloadWithUserAdaptersAsync()).EnumerateArray().ToList();

        var mine = items.Single(i => i.GetProperty("id").GetString() == "my-agent");
        mine.GetProperty("source").GetString().Should().Be("user");
        mine.GetProperty("hooks").ValueKind.Should().Be(JsonValueKind.Null, "protocol adapters have no hooks");
        mine.GetProperty("definition").GetProperty("screenRules")[0].GetProperty("pattern").GetString().Should().Be(@"Allow\?");
        var broken = items.Single(i => i.GetProperty("id").GetString() == "broken");
        broken.GetProperty("error").GetString().Should().StartWith("Not valid JSON");
        broken.GetProperty("definition").ValueKind.Should().Be(JsonValueKind.Null);

        (await PostAsync("/v1/adapters/my-agent/hooks/install")).Status.Should().Be(HttpStatusCode.Conflict);
        (await PostAsync("/v1/adapters/broken/hooks/install")).Status.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Protocol_events_drive_a_session_and_usage_becomes_a_usage_row()
    {
        await ReloadWithUserAdaptersAsync();
        var session = "proto-" + Guid.NewGuid().ToString("N");

        async Task Send(string eventName, string payload, int offsetMs)
        {
            var at = DateTimeOffset.UtcNow.AddMilliseconds(offsetMs).UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture);
            var (status, _) = await PostAsync("/v1/events", $$"""{"v":1,"agent":"my-agent","event":"{{eventName}}","receivedAt":"{{at}}","paneId":"pane-7","payload":{{payload}}}""");
            status.Should().Be(HttpStatusCode.Accepted);
        }

        await Send("session-start", $$"""{"sessionId":"{{session}}","cwd":"C:\\src\\proto"}""", 0);
        await Send("waiting-permission", $$"""{"sessionId":"{{session}}","tool":"shell","command":"git push","risk":"network"}""", 10);
        await Send("usage", $$"""{"sessionId":"{{session}}","model":"local-7b","inputTokens":1500,"outputTokens":300,"costUsd":0.25}""", 20);

        JsonElement found = default;
        for (var i = 0; i < 60 && found.ValueKind == JsonValueKind.Undefined; i++)
        {
            await Task.Delay(50);
            found = (await GetAsync("/v1/sessions")).EnumerateArray()
                .FirstOrDefault(s => s.GetProperty("sessionId").GetString() == session && s.GetProperty("state").GetString() == "WaitingPermission");
        }

        found.ValueKind.Should().Be(JsonValueKind.Object, "the session reached WaitingPermission");
        found.GetProperty("agent").GetString().Should().Be("my-agent");
        found.GetProperty("paneId").GetString().Should().Be("pane-7");
        found.GetProperty("pendingPermission").GetProperty("risk").GetString().Should().Be("network", "the agent's own risk is kept");

        Hub.Core.Usage.UsageEntry? row = null;
        for (var i = 0; i < 100 && row is null; i++)
        {
            await Task.Delay(50);
            row = hub.Host.Usage.Repository.Load(DateTimeOffset.UtcNow.AddHours(-1)).FirstOrDefault(e => e.SessionId == session);
        }

        row.Should().NotBeNull("the usage event is stored by the usage worker");
        row!.Agent.Should().Be("my-agent");
        row.ProjectRoot.Should().Be(@"C:\src\proto", "the project comes from the session");
        (row.Input, row.Output, row.CostUsd).Should().Be((1500L, 300L, 0.25m));
    }

    [Fact]
    public async Task Limits_keep_their_shape()
    {
        (await GetAsync("/v1/limits")).ValueKind.Should().Be(JsonValueKind.Array);
    }
}
