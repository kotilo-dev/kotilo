using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Hub.Infrastructure.Claude;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Dictation;

namespace Hub.Infrastructure.Tests;

public sealed class DictationInfrastructureTests : IDisposable
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 9, 0, 0, TimeSpan.Zero);
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void History_round_trips_newest_first_and_deletes()
    {
        var db = new Database(_dir.File("hub.db"));
        db.Migrate();
        var repo = new DictationRepository(db);

        repo.Add(new DictationRecord(0, T0, TimeSpan.FromSeconds(4.2), "eee merhaba", "Merhaba.", true, "Clean", "large", "tr", "type,file"));
        var second = repo.Add(new DictationRecord(0, T0.AddMinutes(1), TimeSpan.FromSeconds(2), "ikinci", "ikinci", false, null, "small", "tr", "clipboard"));

        var list = repo.List();
        list.Select(r => r.FinalText).Should().Equal("ikinci", "Merhaba.");
        list[1].Duration.Should().Be(TimeSpan.FromSeconds(4.2));
        list[1].Cleaned.Should().BeTrue();
        list[1].Outputs.Should().Be("type,file");
        repo.Latest()!.Id.Should().Be(second.Id);

        repo.Delete(second.Id);
        repo.Latest()!.FinalText.Should().Be("Merhaba.");
        repo.Clear();
        repo.List().Should().BeEmpty();
    }

    [Fact]
    public async Task Download_resumes_from_the_partial_file_and_verifies_the_hash()
    {
        var content = Enumerable.Range(0, 100_000).Select(i => (byte)(i * 7)).ToArray();
        var model = Model(content);
        var store = new WhisperModelStore(_dir.File("models"), new HttpClient(new RangeHandler(content)));
        Directory.CreateDirectory(store.ModelsDir);
        await File.WriteAllBytesAsync(store.PathOf(model) + ".part", content[..30_000]);

        double last = 0;
        await store.DownloadAsync(model, new Progress<double>(p => last = p), CancellationToken.None);

        store.IsInstalled(model).Should().BeTrue();
        (await File.ReadAllBytesAsync(store.PathOf(model))).Should().Equal(content);
        File.Exists(store.PathOf(model) + ".part").Should().BeFalse();
        RangeHandler.LastRangeStart.Should().Be(30_000);
    }

    [Fact]
    public async Task A_corrupt_download_is_discarded()
    {
        var content = new byte[5_000];
        var model = Model(content) with { Sha256 = new string('0', 64) };
        var store = new WhisperModelStore(_dir.File("models"), new HttpClient(new RangeHandler(content)));

        var act = () => store.DownloadAsync(model, null, CancellationToken.None);

        await act.Should().ThrowAsync<InvalidDataException>();
        store.IsInstalled(model).Should().BeFalse();
        store.PartialBytes(model).Should().Be(0);
    }

    [Fact]
    public void Voice_status_reads_claude_settings_and_language_is_set_with_a_backup()
    {
        var path = _dir.File("settings.json");
        File.WriteAllText(path, """{ "voice": { "enabled": true, "mode": "tap" }, "model": "opus" }""");
        var merger = new ClaudeSettingsMerger(path, @"C:\agent-hub\agenthub-hook.exe");

        var status = merger.GetVoiceStatus();
        status.Should().Be(new ClaudeVoiceStatus(true, "tap", null));
        status.IsTurkish.Should().BeFalse();

        merger.SetLanguage("tr").Should().NotBeNull("a backup is made before the change");
        merger.SetLanguage("tr").Should().BeNull("nothing to change");
        var root = (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;
        root["language"]!.GetValue<string>().Should().Be("tr");
        root["model"]!.GetValue<string>().Should().Be("opus", "other settings are kept");
        merger.GetVoiceStatus().IsTurkish.Should().BeTrue();
    }

    private static WhisperModel Model(byte[] content) =>
        new("test", "ggml-test.bin", content.Length, Convert.ToHexStringLower(SHA256.HashData(content)));

    /// <summary>Serves <paramref name="content"/>, honoring an open-ended Range header with 206.</summary>
    private sealed class RangeHandler(byte[] content) : HttpMessageHandler
    {
        public static long? LastRangeStart { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var from = request.Headers.Range?.Ranges.First().From;
            LastRangeStart = from;
            var start = (int)(from ?? 0);
            var response = new HttpResponseMessage(from is null ? HttpStatusCode.OK : HttpStatusCode.PartialContent)
            {
                Content = new ByteArrayContent(content[start..]),
            };
            return Task.FromResult(response);
        }
    }
}
