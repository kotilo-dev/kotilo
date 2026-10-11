using System.Runtime.InteropServices;
using Hub.Core.Ai;
using Hub.Core.Dictation;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Dictation;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>Outcome of <see cref="DictationService.TranscribeAsync"/>.</summary>
public enum DictationStatus
{
    Ok,
    NoSpeech,
    Cancelled,
    ModelMissing,
    Busy,
}

public sealed record DictationTranscription(DictationStatus Status, string RawText, double SpeechSeconds, string Model, string Language);

public sealed record DictationCleanup(string FinalText, bool Cleaned, string? Note);

/// <summary>What the desktop app delivered itself (focused field / clipboard) for one dictation.</summary>
public sealed record DictationDelivery(double DurationSeconds, string RawText, string FinalText, bool Cleaned, IReadOnlyList<string> Outputs);

public sealed record DictationSaved(long? Id, IReadOnlyList<string> Outputs, string? FileError);

/// <summary>Generates text with a system prompt through the dictation-cleanup AI provider; <see cref="BuddyService.GenerateAsync"/> in the app.</summary>
public delegate Task<AiResult> DictationGenerator(string message, string systemPrompt, TimeSpan timeout, CancellationToken ct);

/// <summary>
/// The hub half of live dictation (spec §22, decision D-020): the desktop app records and delivers, the hub transcribes,
/// cleans up, writes the file output and keeps the history. Ported from CCC's <c>DictationController</c> stop/cleanup/
/// deliver steps. Audio stays in memory and transcript text is never logged (AGENTS rule 5). One dictation at a time.
/// </summary>
public sealed class DictationService : IDisposable
{
    public static readonly TimeSpan MinimumSpeech = TimeSpan.FromSeconds(0.3);
    public static readonly TimeSpan WhisperMinimum = TimeSpan.FromSeconds(1.2);
    public static readonly TimeSpan UnloadAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan CleanupTimeout = TimeSpan.FromSeconds(60);

    /// <summary>Speech limit beyond <see cref="DictationSettings.MaxMinutes"/>, for the clip that ends the recording.</summary>
    public static readonly TimeSpan BodySlack = TimeSpan.FromSeconds(1);

    private readonly ISpeechTranscriber _transcriber;
    private readonly Func<WhisperModel, bool> _isInstalled;
    private readonly Func<WhisperModel, string> _pathOf;
    private readonly DictationRepository _history;
    private readonly DictationGenerator _generate;
    private readonly Func<DictationSettings> _settings;
    private readonly TimeProvider _time;
    private readonly Lock _lock = new();
    private CancellationTokenSource? _work;
    private ITimer? _unload;

    public DictationService(
        ISpeechTranscriber transcriber,
        Func<WhisperModel, bool> isInstalled,
        Func<WhisperModel, string> pathOf,
        DictationRepository history,
        DictationGenerator generate,
        Func<DictationSettings> settings,
        TimeProvider time)
    {
        _transcriber = transcriber;
        _isInstalled = isInstalled;
        _pathOf = pathOf;
        _history = history;
        _generate = generate;
        _settings = settings;
        _time = time;
    }

    /// <summary>Largest transcription body in bytes: <c>MaxMinutes</c> of 16 kHz f32 plus <see cref="BodySlack"/>.</summary>
    public long MaxBodyBytes => (long)((Math.Clamp(_settings().MaxMinutes, 1, 30) * 60) + BodySlack.TotalSeconds) * AudioSamples.WhisperRate * sizeof(float);

    public bool IsModelInstalled => _isInstalled(WhisperModelStore.ById(_settings().Model));

    /// <summary>Loads the selected model in the background. False when it is not installed.</summary>
    public bool Preload()
    {
        var settings = _settings();
        var model = WhisperModelStore.ById(settings.Model);
        if (!_isInstalled(model))
        {
            return false;
        }

        StopUnloadTimer();
        var path = _pathOf(model);
        _ = Task.Run(async () =>
        {
            try
            {
                await _transcriber.PreloadAsync(path, settings.UseGpu, CancellationToken.None);
            }
#pragma warning disable CA1031 // A failed preload is retried by the transcription itself, which reports the error.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                Log.Warning(ex, "Whisper model preload failed");
            }
            finally
            {
                ScheduleUnload();
            }
        });
        return true;
    }

    /// <summary>
    /// Trims silence, transcribes and cleans the transcript. <paramref name="pcm"/> is little-endian f32 mono at 16 kHz.
    /// Silence and too-short speech answer <see cref="DictationStatus.NoSpeech"/> without loading the model.
    /// </summary>
    public async Task<DictationTranscription> TranscribeAsync(ReadOnlyMemory<byte> pcm, CancellationToken aborted)
    {
        var settings = _settings();
        var model = WhisperModelStore.ById(settings.Model);
        var language = string.IsNullOrEmpty(settings.Language) ? "auto" : settings.Language;
        DictationTranscription Result(DictationStatus status, string text = "", double seconds = 0) => new(status, text, seconds, model.Id, language);

        var speech = AudioSamples.TrimSilence(ToSamples(pcm.Span));
        var speechSeconds = speech.Length / (double)AudioSamples.WhisperRate;
        if (speechSeconds < MinimumSpeech.TotalSeconds)
        {
            return Result(DictationStatus.NoSpeech);
        }

        if (!_isInstalled(model))
        {
            return Result(DictationStatus.ModelMissing);
        }

        if (Begin(aborted) is not { } work)
        {
            return Result(DictationStatus.Busy);
        }

        try
        {
            var vocabulary = DictationText.ParseVocabulary(settings.Vocabulary);
            var padded = AudioSamples.PadTo(speech, WhisperMinimum);
            var started = _time.GetTimestamp();
            var raw = await Task.Run(
                () => _transcriber.TranscribeAsync(padded, _pathOf(model), language, DictationText.WhisperPrompt(vocabulary), settings.UseGpu, work.Token),
                work.Token);
            work.Token.ThrowIfCancellationRequested();
            raw = DictationText.CleanTranscript(raw);
            Log.Information(
                "Dictation transcribed: {Seconds:0.0} s audio in {Elapsed:0.0} s ({Runtime})",
                speechSeconds,
                _time.GetElapsedTime(started).TotalSeconds,
                WhisperTranscriber.LoadedRuntime);
            return raw.Length == 0 ? Result(DictationStatus.NoSpeech, seconds: speechSeconds) : Result(DictationStatus.Ok, raw, speechSeconds);
        }
        catch (OperationCanceledException) when (work.IsCancellationRequested)
        {
            return Result(DictationStatus.Cancelled);
        }
        finally
        {
            End(work);
            ScheduleUnload();
        }
    }

    /// <summary>
    /// AI cleanup with the settings' mode, custom prompt and vocabulary through the dictation-cleanup provider (spec §22.3). The raw text comes back on
    /// failure or timeout, with the note <c>cleanupFailed</c>; also when cancelled or when another dictation step runs.
    /// </summary>
    public async Task<DictationCleanup> CleanupAsync(string text, CancellationToken aborted)
    {
        var settings = _settings();
        if (!settings.AiCleanup)
        {
            return new DictationCleanup(text, false, null);
        }

        if (Begin(aborted) is not { } work)
        {
            return new DictationCleanup(text, false, "cleanupFailed");
        }

        try
        {
            var mode = Enum.TryParse<DictationMode>(settings.Mode, out var m) ? m : DictationMode.Clean;
            var vocabulary = DictationText.ParseVocabulary(settings.Vocabulary);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(work.Token);
            timeout.CancelAfter(CleanupTimeout);
            var answer = await _generate(
                DictationText.CleanupInput(text), DictationText.CleanupPrompt(mode, settings.CustomPrompt, vocabulary), CleanupTimeout, timeout.Token);
            var cleaned = DictationText.CleanupOutput(answer.Text ?? "");
            if (answer.ErrorKind == AiErrorKind.None && cleaned.Length > 0)
            {
                return new DictationCleanup(cleaned, true, null);
            }

            if (work.IsCancellationRequested)
            {
                return new DictationCleanup(text, false, null);
            }

            Log.Warning("Dictation cleanup failed ({Kind})", answer.ErrorKind);
        }
        catch (OperationCanceledException) when (work.IsCancellationRequested)
        {
            return new DictationCleanup(text, false, null);
        }
        catch (OperationCanceledException)
        {
            Log.Warning("Dictation cleanup timed out");
        }
        finally
        {
            End(work);
        }

        return new DictationCleanup(text, false, "cleanupFailed");
    }

    /// <summary>Cancels the transcription or cleanup in flight, if any.</summary>
    public void Cancel()
    {
        lock (_lock)
        {
            _work?.Cancel();
        }
    }

    /// <summary>Appends to the dictation file when that output is on, then keeps the history when enabled.</summary>
    public async Task<DictationSaved> SaveAsync(DictationDelivery delivery)
    {
        var settings = _settings();
        var outputs = delivery.Outputs.Distinct(StringComparer.Ordinal).ToList();
        string? fileError = null;
        if (settings.OutputFile && !string.IsNullOrWhiteSpace(settings.FilePath))
        {
            fileError = await AppendToFileAsync(settings.FilePath, delivery.FinalText, _time.GetLocalNow().DateTime);
            if (fileError is null)
            {
                outputs.Add("file");
            }
        }

        long? id = null;
        if (settings.KeepHistory)
        {
            var record = _history.Add(new DictationRecord(
                0,
                _time.GetUtcNow(),
                TimeSpan.FromSeconds(delivery.DurationSeconds),
                delivery.RawText,
                delivery.FinalText,
                delivery.Cleaned,
                delivery.Cleaned ? settings.Mode : null,
                WhisperModelStore.ById(settings.Model).Id,
                settings.Language,
                string.Join(',', outputs)));
            id = record.Id;
        }

        return new DictationSaved(id, outputs, fileError);
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _work?.Cancel();
            _unload?.Dispose();
            _unload = null;
        }

        (_transcriber as IDisposable)?.Dispose();
    }

    /// <returns>Null when written; otherwise the error message.</returns>
    internal static async Task<string?> AppendToFileAsync(string filePath, string text, DateTime localNow)
    {
        try
        {
            var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(filePath.Trim()));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var prefix = File.Exists(path) && new FileInfo(path).Length > 0 && !EndsWithNewLine(path) ? "\n" : "";
            await File.AppendAllTextAsync(path, prefix + DictationText.FileEntry(text, localNow));
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Log.Warning("Dictation file could not be written: {Message}", ex.Message);
            return ex.Message;
        }
    }

    /// <summary>Little-endian f32 → floats; NaN/∞ (a broken capture) become silence.</summary>
    internal static float[] ToSamples(ReadOnlySpan<byte> pcm)
    {
        var samples = MemoryMarshal.Cast<byte, float>(pcm).ToArray();
        if (!BitConverter.IsLittleEndian)
        {
            var ints = MemoryMarshal.Cast<float, int>(samples.AsSpan());
            for (var i = 0; i < ints.Length; i++)
            {
                ints[i] = System.Buffers.Binary.BinaryPrimitives.ReverseEndianness(ints[i]);
            }
        }

        for (var i = 0; i < samples.Length; i++)
        {
            if (!float.IsFinite(samples[i]))
            {
                samples[i] = 0;
            }
        }

        return samples;
    }

    private static bool EndsWithNewLine(string path)
    {
        using var stream = File.OpenRead(path);
        stream.Seek(-1, SeekOrigin.End);
        return stream.ReadByte() == '\n';
    }

    private CancellationTokenSource? Begin(CancellationToken aborted)
    {
        lock (_lock)
        {
            if (_work is not null)
            {
                return null;
            }

            _unload?.Dispose();
            _unload = null;
            _work = CancellationTokenSource.CreateLinkedTokenSource(aborted);
            return _work;
        }
    }

    private void End(CancellationTokenSource work)
    {
        lock (_lock)
        {
            if (ReferenceEquals(_work, work))
            {
                _work = null;
            }
        }

        work.Dispose();
    }

    private void StopUnloadTimer()
    {
        lock (_lock)
        {
            _unload?.Dispose();
            _unload = null;
        }
    }

    /// <summary>The large model holds ~1.5 GB; release it after <see cref="UnloadAfter"/> without dictation.</summary>
    private void ScheduleUnload()
    {
        lock (_lock)
        {
            if (_work is not null)
            {
                return;
            }

            _unload?.Dispose();
            _unload = _time.CreateTimer(_ => UnloadIfIdle(), null, UnloadAfter, Timeout.InfiniteTimeSpan);
        }
    }

    private void UnloadIfIdle()
    {
        lock (_lock)
        {
            if (_work is not null)
            {
                return;
            }

            _unload?.Dispose();
            _unload = null;
        }

        _transcriber.Unload();
        Log.Information("Whisper model unloaded after {Minutes} min without dictation", UnloadAfter.TotalMinutes);
    }
}
