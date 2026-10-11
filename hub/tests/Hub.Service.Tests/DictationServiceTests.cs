using Hub.Core.Ai;
using Hub.Core.Dictation;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Dictation;
using Hub.Service.Hosting;

namespace Hub.Service.Tests;

public sealed class DictationServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
    private readonly FakeTranscriber _transcriber = new();
    private readonly ManualTime _time = new();
    private readonly DictationRepository _history;
    private readonly List<(string Message, string System, TimeSpan Timeout)> _generated = [];
    private DictationSettings _settings;
    private bool _installed = true;
    private Func<CancellationToken, Task<AiResult>> _answer = _ => Task.FromResult(AiResult.Ok("Temiz."));

    public DictationServiceTests()
    {
        Directory.CreateDirectory(_dir);
        var db = new Database(Path.Combine(_dir, "hub.db"));
        db.Migrate();
        _history = new DictationRepository(db);
        _settings = new DictationSettings { FilePath = Path.Combine(_dir, "notes", "dictation.md"), Language = "tr" };
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private DictationService Service() => new(
        _transcriber,
        _ => _installed,
        m => Path.Combine(_dir, m.FileName),
        _history,
        (message, system, timeout, ct) =>
        {
            _generated.Add((message, system, timeout));
            return _answer(ct);
        },
        () => _settings,
        _time);

    private static byte[] Pcm(params float[] samples)
    {
        var bytes = new byte[samples.Length * sizeof(float)];
        Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
        return bytes;
    }

    private static byte[] Speech(double seconds) =>
        Pcm(Enumerable.Range(0, (int)(seconds * AudioSamples.WhisperRate)).Select(i => 0.1f * MathF.Sin(i * 0.2f)).ToArray());

    private static byte[] Silence(double seconds) => new byte[(int)(seconds * AudioSamples.WhisperRate) * sizeof(float)];

    [Fact]
    public async Task Silence_is_no_speech_without_touching_the_model()
    {
        _installed = false;
        using var service = Service();

        var result = await service.TranscribeAsync(Silence(2), CancellationToken.None);

        result.Status.Should().Be(DictationStatus.NoSpeech);
        _transcriber.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Speech_shorter_than_the_minimum_is_no_speech()
    {
        using var service = Service();
        var tooShort = Speech(0.01).Concat(Silence(1)).ToArray();

        (await service.TranscribeAsync(tooShort, CancellationToken.None)).Status.Should().Be(DictationStatus.NoSpeech);
    }

    [Fact]
    public async Task Speech_without_an_installed_model_is_model_missing()
    {
        _installed = false;
        using var service = Service();

        (await service.TranscribeAsync(Speech(1), CancellationToken.None)).Status.Should().Be(DictationStatus.ModelMissing);
        service.Preload().Should().BeFalse();
    }

    [Fact]
    public async Task Speech_is_trimmed_padded_and_transcribed_with_the_settings()
    {
        _settings = _settings with { Model = "small", Language = "en", Vocabulary = "Kubernetes, İzmir", UseGpu = false };
        _transcriber.Text = "  Merhaba dünya [Müzik]\nAltyazı M.K.";
        using var service = Service();
        var clip = Silence(2).Concat(Speech(0.5)).Concat(Silence(2)).ToArray();

        var result = await service.TranscribeAsync(clip, CancellationToken.None);

        result.Should().Be(new DictationTranscription(DictationStatus.Ok, "Merhaba dünya", result.SpeechSeconds, "small", "en"));
        result.SpeechSeconds.Should().BeInRange(0.5, 1.1, "trimmed to the speech plus 0.25 s padding each side");
        var call = _transcriber.Calls.Should().ContainSingle().Subject;
        call.Samples.Should().Be((int)(1.2 * AudioSamples.WhisperRate), "short speech is padded to 1.2 s");
        call.Path.Should().EndWith(WhisperModelStore.Small.FileName);
        call.Language.Should().Be("en");
        call.Prompt.Should().Be("Kubernetes, İzmir.");
        call.UseGpu.Should().BeFalse();
    }

    [Fact]
    public async Task A_transcript_of_only_hallucinations_is_no_speech()
    {
        _transcriber.Text = "Altyazı M.K.";
        using var service = Service();

        (await service.TranscribeAsync(Speech(1), CancellationToken.None)).Status.Should().Be(DictationStatus.NoSpeech);
    }

    [Fact]
    public async Task One_dictation_at_a_time_and_cancel_ends_the_running_one()
    {
        _transcriber.Block = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var service = Service();

        var first = service.TranscribeAsync(Speech(1), CancellationToken.None);
        await _transcriber.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        (await service.TranscribeAsync(Speech(1), CancellationToken.None)).Status.Should().Be(DictationStatus.Busy);
        (await service.CleanupAsync("x", CancellationToken.None)).Should().Be(new DictationCleanup("x", false, null), "cleanup is off by default");

        service.Cancel();

        (await first.WaitAsync(TimeSpan.FromSeconds(5))).Status.Should().Be(DictationStatus.Cancelled);
        _transcriber.Block = null;
        (await service.TranscribeAsync(Speech(1), CancellationToken.None)).Status.Should().Be(DictationStatus.Ok, "the slot is free again");
    }

    [Fact]
    public async Task Cleanup_is_skipped_when_off()
    {
        using var service = Service();

        (await service.CleanupAsync("ham metin", CancellationToken.None)).Should().Be(new DictationCleanup("ham metin", false, null));
        _generated.Should().BeEmpty();
    }

    [Fact]
    public async Task Cleanup_sends_the_transcript_as_data_and_strips_the_answer()
    {
        _settings = _settings with { AiCleanup = true, Mode = "Email", Vocabulary = "Kubernetes" };
        _answer = _ => Task.FromResult(AiResult.Ok("<dictation>\n\"Merhaba, Kubernetes raporu hazır.\"\n</dictation>"));
        using var service = Service();

        var result = await service.CleanupAsync("merhaba kubernetes raporu hazır", CancellationToken.None);

        result.Should().Be(new DictationCleanup("Merhaba, Kubernetes raporu hazır.", true, null));
        var (message, system, timeout) = _generated.Should().ContainSingle().Subject;
        message.Should().Be(DictationText.CleanupInput("merhaba kubernetes raporu hazır"));
        timeout.Should().Be(DictationService.CleanupTimeout);
        system.Should().Be(DictationText.CleanupPrompt(DictationMode.Email, "", ["Kubernetes"]));
    }

    [Fact]
    public async Task Cleanup_failure_keeps_the_raw_text_with_a_note()
    {
        _settings = _settings with { AiCleanup = true };
        _answer = _ => Task.FromResult(AiResult.Error(AiErrorKind.NotInstalled, "no claude"));
        using var service = Service();

        (await service.CleanupAsync("ham", CancellationToken.None)).Should().Be(new DictationCleanup("ham", false, "cleanupFailed"));
    }

    [Fact]
    public async Task Cancelling_the_cleanup_returns_the_raw_text_without_a_note()
    {
        _settings = _settings with { AiCleanup = true };
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _answer = async ct =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, ct);
            return AiResult.Ok("never");
        };
        using var service = Service();

        var cleanup = service.CleanupAsync("ham", CancellationToken.None);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        service.Cancel();

        (await cleanup.WaitAsync(TimeSpan.FromSeconds(5))).Should().Be(new DictationCleanup("ham", false, null));
    }

    [Fact]
    public async Task Save_appends_to_the_file_and_keeps_history()
    {
        _settings = _settings with { OutputFile = true, Mode = "Message" };
        using var service = Service();
        _time.Local = new DateTimeOffset(2026, 10, 4, 9, 5, 0, TimeSpan.FromHours(3));

        var saved = await service.SaveAsync(new DictationDelivery(7.5, "ham", "Temiz.", true, ["type", "clipboard"]));
        await File.AppendAllTextAsync(_settings.FilePath, "no trailing newline");
        await service.SaveAsync(new DictationDelivery(1, "iki", "İki.", false, []));

        saved.Outputs.Should().Equal("type", "clipboard", "file");
        saved.FileError.Should().BeNull();
        var file = await File.ReadAllTextAsync(_settings.FilePath);
        file.Should().Be(DictationText.FileEntry("Temiz.", _time.Local.DateTime) + "no trailing newline\n" + DictationText.FileEntry("İki.", _time.Local.DateTime));
        var latest = _history.List(2);
        latest[1].Should().BeEquivalentTo(new { Id = saved.Id!.Value, FinalText = "Temiz.", RawText = "ham", Cleaned = true, Mode = "Message", Model = "large", Language = "tr", Outputs = "type,clipboard,file" });
        latest[1].Duration.Should().Be(TimeSpan.FromSeconds(7.5));
        latest[0].Mode.Should().BeNull("mode only when the text was cleaned");
    }

    [Fact]
    public async Task Save_reports_a_file_error_and_skips_history_when_off()
    {
        var blocker = Path.Combine(_dir, "a-file");
        await File.WriteAllTextAsync(blocker, "x");
        _settings = _settings with { OutputFile = true, FilePath = Path.Combine(blocker, "sub", "d.md"), KeepHistory = false };
        using var service = Service();

        var saved = await service.SaveAsync(new DictationDelivery(1, "a", "A.", false, ["type"]));

        saved.Id.Should().BeNull();
        saved.Outputs.Should().Equal("type");
        saved.FileError.Should().NotBeNullOrEmpty();
        _history.List().Should().BeEmpty();
    }

    [Fact]
    public async Task The_model_is_unloaded_after_ten_idle_minutes()
    {
        using var service = Service();

        await service.TranscribeAsync(Speech(1), CancellationToken.None);

        var timer = _time.Timers.Should().ContainSingle().Subject;
        timer.DueTime.Should().Be(DictationService.UnloadAfter);
        _transcriber.Unloads.Should().Be(0);
        timer.Fire();
        _transcriber.Unloads.Should().Be(1);
    }

    [Fact]
    public async Task Preload_loads_the_selected_model_and_restarts_the_idle_timer()
    {
        using var service = Service();

        service.Preload().Should().BeTrue();

        await _transcriber.Preloaded.Task.WaitAsync(TimeSpan.FromSeconds(5));
        _transcriber.PreloadPath.Should().EndWith(WhisperModelStore.Large.FileName);
        await WaitUntil(() => _time.Timers.Count == 1);
    }

    [Fact]
    public void Body_limit_follows_max_minutes()
    {
        _settings = _settings with { MaxMinutes = 1 };
        using var service = Service();

        service.MaxBodyBytes.Should().Be(61L * 16_000 * 4);
    }

    [Fact]
    public void Broken_samples_become_silence()
    {
        DictationService.ToSamples(Pcm(0.5f, float.NaN, float.PositiveInfinity, -0.25f)).Should().Equal(0.5f, 0f, 0f, -0.25f);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++)
        {
            await Task.Delay(20);
        }

        condition().Should().BeTrue();
    }

    private sealed class FakeTranscriber : ISpeechTranscriber
    {
        public string Text { get; set; } = "Merhaba";

        public TaskCompletionSource<string>? Block { get; set; }

        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource Preloaded { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public List<(int Samples, string Path, string Language, string? Prompt, bool UseGpu)> Calls { get; } = [];

        public string? PreloadPath { get; private set; }

        public int Unloads { get; private set; }

        public Task PreloadAsync(string modelPath, bool useGpu, CancellationToken ct)
        {
            PreloadPath = modelPath;
            Preloaded.TrySetResult();
            return Task.CompletedTask;
        }

        public async Task<string> TranscribeAsync(float[] samples, string modelPath, string language, string? prompt, bool useGpu, CancellationToken ct)
        {
            Calls.Add((samples.Length, modelPath, language, prompt, useGpu));
            Started.TrySetResult();
            return Block is { } block ? await block.Task.WaitAsync(ct) : Text;
        }

        public void Unload() => Unloads++;
    }

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Local { get; set; } = new(2026, 10, 4, 12, 0, 0, TimeSpan.Zero);

        public List<ManualTimer> Timers { get; } = [];

        public override DateTimeOffset GetUtcNow() => Local.ToUniversalTime();

        public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.CreateCustomTimeZone("test", Local.Offset, "test", "test");

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new ManualTimer(this, () => callback(state), dueTime);
            lock (Timers)
            {
                Timers.Add(timer);
            }

            return timer;
        }

        public sealed class ManualTimer(ManualTime owner, Action fire, TimeSpan dueTime) : ITimer
        {
            public TimeSpan DueTime => dueTime;

            public void Fire() => fire();

            public bool Change(TimeSpan dueTime, TimeSpan period) => true;

            public void Dispose()
            {
                lock (owner.Timers)
                {
                    owner.Timers.Remove(this);
                }
            }

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }
}
