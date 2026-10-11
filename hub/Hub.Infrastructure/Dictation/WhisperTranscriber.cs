using System.Text;
using Hub.Core.Dictation;
using Whisper.net;
using Whisper.net.LibraryLoader;

namespace Hub.Infrastructure.Dictation;

/// <summary>
/// Local speech-to-text with whisper.cpp through Whisper.net (spec §22.2). The model stays loaded between dictations and
/// is released by <see cref="Unload"/> after a quiet period, since the large model holds ~1.5 GB. Thread-safe: one
/// transcription at a time.
/// </summary>
public sealed class WhisperTranscriber : ISpeechTranscriber, IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private WhisperFactory? _factory;
    private string? _loadedPath;
    private bool _loadedGpu;

    static WhisperTranscriber()
    {
        // Vulkan when a GPU driver supports it (x64 only), otherwise CPU. Whisper.net falls back down the list.
        RuntimeOptions.RuntimeLibraryOrder = [RuntimeLibrary.Vulkan, RuntimeLibrary.Cpu, RuntimeLibrary.CpuNoAvx];
    }

    /// <summary>"Vulkan", "Cpu", … after the first load; null before.</summary>
    public static string? LoadedRuntime => RuntimeOptions.LoadedLibrary?.ToString();

    public bool IsLoaded => _factory is not null;

    /// <summary>CPU threads for decoding; tunable for measurements (AGENTHUB_WHISPER_THREADS).</summary>
    public static int Threads { get; set; } =
        int.TryParse(Environment.GetEnvironmentVariable("AGENTHUB_WHISPER_THREADS"), out var t) && t > 0 ? t : DefaultThreads();

    /// <summary>All logical cores but one: measured faster than physical cores only (8 threads 30 s vs 4 threads 35 s, D-085).</summary>
    private static int DefaultThreads() => Math.Clamp(Environment.ProcessorCount - 1, 1, 8);

    /// <summary>Loads (or switches) the model ahead of the first transcription, e.g. while the user is still speaking.</summary>
    public async Task PreloadAsync(string modelPath, bool useGpu, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureFactory(modelPath, useGpu);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <param name="samples">16 kHz mono float.</param>
    /// <param name="language">"tr", "en" or "auto".</param>
    /// <param name="prompt">Vocabulary hint, or null.</param>
    public async Task<string> TranscribeAsync(
        float[] samples, string modelPath, string language, string? prompt, bool useGpu, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var factory = EnsureFactory(modelPath, useGpu);
            var builder = factory.CreateBuilder()
                .WithLanguage(string.IsNullOrEmpty(language) ? "auto" : language)
                .WithThreads(Threads)
                .WithNoContext();
            if (!string.IsNullOrWhiteSpace(prompt))
            {
                builder = builder.WithPrompt(prompt);
            }

            await using var processor = builder.Build();
            var text = new StringBuilder();
            await foreach (var segment in processor.ProcessAsync(samples, ct))
            {
                text.Append(segment.Text);
            }

            return text.ToString().Trim();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Frees the model memory; the next dictation loads it again.</summary>
    public void Unload()
    {
        if (!_gate.Wait(0))
        {
            return;
        }

        try
        {
            _factory?.Dispose();
            _factory = null;
            _loadedPath = null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose()
    {
        _factory?.Dispose();
        _factory = null;
        _gate.Dispose();
    }

    private WhisperFactory EnsureFactory(string modelPath, bool useGpu)
    {
        if (_factory is not null && _loadedPath == modelPath && _loadedGpu == useGpu)
        {
            return _factory;
        }

        _factory?.Dispose();
        _factory = WhisperFactory.FromPath(modelPath, new WhisperFactoryOptions { UseGpu = useGpu });
        _loadedPath = modelPath;
        _loadedGpu = useGpu;
        return _factory;
    }
}
