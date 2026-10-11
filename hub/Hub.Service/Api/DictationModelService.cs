using System.Collections.Concurrent;
using Hub.Infrastructure.Dictation;
using Serilog;

namespace Hub.Service.Api;

public sealed record DictationModelDto(
    string Id, string FileName, long Size, bool Installed, bool Selected, long PartialBytes, bool Downloading, double? Progress, string? Error);

/// <summary>Whisper model files for dictation: status and background downloads started from the UI (spec §22.2).</summary>
public sealed class DictationModelService(WhisperModelStore store) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, Download> _downloads = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> _errors = new(StringComparer.Ordinal);

    /// <summary>Raised when a download starts, progresses by a whole percent, finishes or fails.</summary>
    public event Action? Changed;

    public IReadOnlyList<DictationModelDto> Status(string selectedId) => WhisperModelStore.All
        .Select(m =>
        {
            _downloads.TryGetValue(m.Id, out var d);
            _errors.TryGetValue(m.Id, out var error);
            return new DictationModelDto(
                m.Id, m.FileName, m.Size, store.IsInstalled(m), m.Id == selectedId, store.PartialBytes(m), d is not null, d?.Progress, error);
        })
        .ToList();

    /// <returns>False for an unknown model id. A download already running is left alone.</returns>
    public bool Start(string id)
    {
        if (Find(id) is not { } model)
        {
            return false;
        }

        if (store.IsInstalled(model))
        {
            return true;
        }

        var download = new Download();
        if (!_downloads.TryAdd(id, download))
        {
            download.Cancel.Dispose();
            return true;
        }

        _errors.TryRemove(id, out _);
        var lastPercent = -1;
        var progress = new Progress<double>(p =>
        {
            download.Progress = p;
            var percent = (int)(p * 100);
            if (percent != lastPercent)
            {
                lastPercent = percent;
                Changed?.Invoke();
            }
        });
        download.Task = Task.Run(async () =>
        {
            try
            {
                await store.DownloadAsync(model, progress, download.Cancel.Token);
                Log.Information("Whisper model {Model} downloaded", model.Id);
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidDataException or UnauthorizedAccessException)
            {
                Log.Warning("Whisper model {Model} download failed: {Message}", model.Id, ex.Message);
                _errors[id] = ex.Message;
            }
            finally
            {
                _downloads.TryRemove(id, out _);
                download.Cancel.Dispose();
                Changed?.Invoke();
            }
        });
        Changed?.Invoke();
        return true;
    }

    /// <returns>False for an unknown model id; true (no-op) when nothing is downloading.</returns>
    public bool Cancel(string id)
    {
        if (Find(id) is null)
        {
            return false;
        }

        if (_downloads.TryGetValue(id, out var d))
        {
            try
            {
                d.Cancel.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        return true;
    }

    public bool Delete(string id)
    {
        if (Find(id) is not { } model)
        {
            return false;
        }

        Cancel(id);
        store.Delete(model);
        Changed?.Invoke();
        return true;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var (id, _) in _downloads)
        {
            Cancel(id);
        }

        await Task.WhenAll(_downloads.Values.Select(d => d.Task ?? Task.CompletedTask));
    }

    private static WhisperModel? Find(string id) => WhisperModelStore.All.FirstOrDefault(m => m.Id == id);

    private sealed class Download
    {
        public CancellationTokenSource Cancel { get; } = new();

        public double Progress { get; set; }

        public Task? Task { get; set; }
    }
}
