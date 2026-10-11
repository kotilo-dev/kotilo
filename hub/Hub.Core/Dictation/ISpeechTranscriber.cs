namespace Hub.Core.Dictation;

/// <summary>Local speech-to-text (spec §22.2). Implemented by Whisper in the infrastructure; tests use a fake.</summary>
public interface ISpeechTranscriber
{
    /// <summary>Loads (or switches) the model ahead of the first transcription, e.g. while the user is still speaking.</summary>
    Task PreloadAsync(string modelPath, bool useGpu, CancellationToken ct);

    /// <param name="samples">16 kHz mono float.</param>
    /// <param name="language">"tr", "en" or "auto".</param>
    /// <param name="prompt">Vocabulary hint, or null.</param>
    Task<string> TranscribeAsync(float[] samples, string modelPath, string language, string? prompt, bool useGpu, CancellationToken ct);

    /// <summary>Frees the model memory; the next transcription loads it again.</summary>
    void Unload();
}
