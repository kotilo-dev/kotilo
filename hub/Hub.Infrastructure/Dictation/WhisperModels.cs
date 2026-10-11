using System.Security.Cryptography;

namespace Hub.Infrastructure.Dictation;

/// <summary>A downloadable whisper.cpp model (spec §22.2). Size and SHA-256 come from the Hugging Face LFS metadata.</summary>
public sealed record WhisperModel(string Id, string FileName, long Size, string Sha256)
{
    public Uri Url { get; } = new($"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{FileName}");
}

/// <summary>
/// The two offered models and their local files under <c>%LOCALAPPDATA%\kotilo\hub\models</c>. Downloads go to
/// a <c>.part</c> file, resume with an HTTP Range request and are verified against the SHA-256 before the final rename.
/// </summary>
public sealed class WhisperModelStore(string modelsDir, HttpClient http)
{
    /// <summary>Best Turkish accuracy; ~1.5 GB RAM.</summary>
    public static readonly WhisperModel Large = new(
        "large", "ggml-large-v3-turbo-q5_0.bin", 574_041_195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2");

    /// <summary>Faster and lighter; ~850 MB RAM, more mistakes in Turkish.</summary>
    public static readonly WhisperModel Small = new(
        "small", "ggml-small-q5_1.bin", 190_085_487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb");

    public static IReadOnlyList<WhisperModel> All { get; } = [Large, Small];

    public static WhisperModel ById(string? id) => All.FirstOrDefault(m => m.Id == id) ?? Large;

    public string ModelsDir => modelsDir;

    public string PathOf(WhisperModel model) => Path.Combine(modelsDir, model.FileName);

    /// <summary>Present with the expected size (the hash is checked once, when the download finishes).</summary>
    public bool IsInstalled(WhisperModel model)
    {
        var file = new FileInfo(PathOf(model));
        return file.Exists && file.Length == model.Size;
    }

    /// <summary>Bytes of an interrupted download that the next attempt resumes from.</summary>
    public long PartialBytes(WhisperModel model)
    {
        var part = new FileInfo(PathOf(model) + ".part");
        return part.Exists ? part.Length : 0;
    }

    /// <param name="progress">Receives 0..1.</param>
    /// <exception cref="InvalidDataException">The finished file does not match the expected SHA-256 (it is deleted).</exception>
    public async Task DownloadAsync(WhisperModel model, IProgress<double>? progress, CancellationToken ct)
    {
        Directory.CreateDirectory(modelsDir);
        var target = PathOf(model);
        var part = target + ".part";
        var existing = File.Exists(part) ? new FileInfo(part).Length : 0;
        if (existing > model.Size)
        {
            File.Delete(part);
            existing = 0;
        }

        if (existing < model.Size)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, model.Url);
            if (existing > 0)
            {
                request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(existing, null);
            }

            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            // A server that ignores Range sends the whole file again.
            var append = existing > 0 && response.StatusCode == System.Net.HttpStatusCode.PartialContent;
            if (!append)
            {
                existing = 0;
            }

            await using var source = await response.Content.ReadAsStreamAsync(ct);
            await using (var file = new FileStream(part, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true))
            {
                var buffer = new byte[1 << 16];
                var written = existing;
                int read;
                while ((read = await source.ReadAsync(buffer, ct)) > 0)
                {
                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                    written += read;
                    progress?.Report(Math.Min(1, (double)written / model.Size));
                }
            }
        }

        if (!await HashMatchesAsync(part, model.Sha256, ct))
        {
            File.Delete(part);
            throw new InvalidDataException($"{model.FileName}: SHA-256 mismatch; the download was discarded.");
        }

        File.Move(part, target, overwrite: true);
        progress?.Report(1);
    }

    public void Delete(WhisperModel model)
    {
        File.Delete(PathOf(model));
        File.Delete(PathOf(model) + ".part");
    }

    internal static async Task<bool> HashMatchesAsync(string path, string sha256, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, useAsync: true);
        var hash = await SHA256.HashDataAsync(stream, ct);
        return Convert.ToHexStringLower(hash) == sha256;
    }
}
