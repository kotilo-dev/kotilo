using System.Text.Json;
using Hub.Core.Usage;

namespace Hub.Infrastructure.Usage;

/// <summary>
/// Loads <c>pricing.json</c> from the data folder (spec §7.3, §13), creating it from the shipped default on
/// first run. The user's file always wins; an invalid edit keeps the last good table.
/// </summary>
public sealed class PricingProvider(string path)
{
    private const string DefaultResource = "Hub.Infrastructure.Usage.pricing.default.json";

    public PricingTable Current { get; private set; } = PricingTable.Empty;

    public string Path { get; } = path;

    /// <summary>Last load error, or null.</summary>
    public string? Error { get; private set; }

    public static string DefaultJson()
    {
        using var stream = typeof(PricingProvider).Assembly.GetManifestResourceStream(DefaultResource)
            ?? throw new InvalidOperationException("Default pricing resource missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    /// <returns>True when the table was (re)loaded.</returns>
    public bool Load()
    {
        try
        {
            if (!File.Exists(Path))
            {
                File.WriteAllText(Path, DefaultJson());
            }

            Current = PricingTable.Parse(File.ReadAllText(Path));
            Error = null;
            return true;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException or NotSupportedException)
        {
            Error = ex.Message;
            if (Current.Models.Count == 0)
            {
                Current = PricingTable.Parse(DefaultJson());
            }

            return false;
        }
    }
}
