using System.Text.Json;
using Hub.Core.Sessions;

namespace Hub.Infrastructure.Usage;

/// <summary>
/// Loads <c>models.json</c> (model prefix → context window, spec §18.4) from the data folder, creating it from the
/// shipped default on first run. An invalid edit keeps the last good table.
/// </summary>
public sealed class ModelContextProvider(string path)
{
    private const string DefaultResource = "Hub.Infrastructure.Usage.models.default.json";

    public ModelContextTable Current { get; private set; } = ModelContextTable.Empty;

    public static string DefaultJson()
    {
        using var stream = typeof(ModelContextProvider).Assembly.GetManifestResourceStream(DefaultResource)
            ?? throw new InvalidOperationException("Default models resource missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    public bool Load()
    {
        try
        {
            if (!File.Exists(path))
            {
                File.WriteAllText(path, DefaultJson());
            }

            Current = ModelContextTable.Parse(File.ReadAllText(path));
            return true;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            if (Current.WindowFor("claude-") is null)
            {
                Current = ModelContextTable.Parse(DefaultJson());
            }

            return false;
        }
    }
}
