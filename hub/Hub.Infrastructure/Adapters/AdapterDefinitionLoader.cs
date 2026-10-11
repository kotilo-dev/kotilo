using System.Text.Json;
using Hub.Core.Adapters;

namespace Hub.Infrastructure.Adapters;

/// <summary>One <c>adapter.json</c> as found on disk: parsed, or the reason it could not be used.</summary>
/// <param name="Id">The definition's id, or its folder name when the file could not be parsed.</param>
public sealed record LoadedDefinition(string Id, AdapterSource Source, string Path)
{
    public AdapterDefinition? Definition { get; init; }

    /// <summary>Why the file is not used; null when <see cref="Definition"/> is set.</summary>
    public string? Error { get; init; }
}

/// <summary>
/// Reads adapter definitions (ARCHITECTURE §3a): built-in ones from the bundled <c>adapters</c> folder, user ones from
/// <c>%APPDATA%\kotilo\adapters\&lt;id&gt;\adapter.json</c>. Each file is validated against <c>schema/adapter.v1.json</c>
/// (embedded). A bad file is returned with its error, never thrown.
/// </summary>
public static class AdapterDefinitionLoader
{
    public const string FileName = "adapter.json";

    /// <summary>A definition is a small file; anything bigger is not one.</summary>
    private const long MaxFileBytes = 256 * 1024;

    private const int MaxErrors = 5;

    /// <summary>The adapter schema shipped inside the hub.</summary>
    public static JsonElement Schema { get; } = LoadSchema();

    /// <summary>Definitions in <c>&lt;dir&gt;/&lt;id&gt;/adapter.json</c>, ordered by folder name. A missing folder has none.</summary>
    public static IReadOnlyList<LoadedDefinition> LoadDirectory(string? dir, AdapterSource source)
    {
        if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
        {
            return [];
        }

        string[] folders;
        try
        {
            folders = Directory.GetDirectories(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }

        return folders
            .Order(StringComparer.Ordinal)
            .Select(folder => Path.Combine(folder, FileName))
            .Where(File.Exists)
            .Select(file => LoadFile(file, source))
            .ToList();
    }

    public static LoadedDefinition LoadFile(string path, AdapterSource source)
    {
        var folderId = Path.GetFileName(Path.GetDirectoryName(path)) ?? string.Empty;
        string text;
        try
        {
            if (new FileInfo(path).Length > MaxFileBytes)
            {
                return new LoadedDefinition(folderId, source, path) { Error = "The file is too large to be an adapter definition." };
            }

            text = File.ReadAllText(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new LoadedDefinition(folderId, source, path) { Error = "Could not read the file: " + ex.Message };
        }

        var definition = AdapterDefinition.Parse(text, Schema, out var errors);
        if (definition is null)
        {
            var shown = errors.Take(MaxErrors).ToList();
            var more = errors.Count > MaxErrors ? $" (+{errors.Count - MaxErrors} more)" : string.Empty;
            return new LoadedDefinition(folderId, source, path) { Error = string.Join("; ", shown) + more };
        }

        if (!string.Equals(definition.Id, folderId, StringComparison.Ordinal))
        {
            return new LoadedDefinition(folderId, source, path)
            {
                Error = $"The id '{definition.Id}' does not match its folder name '{folderId}'.",
            };
        }

        return new LoadedDefinition(definition.Id, source, path) { Definition = definition };
    }

    private static JsonElement LoadSchema()
    {
        using var stream = typeof(AdapterDefinitionLoader).Assembly.GetManifestResourceStream("Hub.Infrastructure.Adapters.adapter.v1.json")
            ?? throw new InvalidOperationException("Embedded adapter schema missing.");
        using var doc = JsonDocument.Parse(stream);
        return doc.RootElement.Clone();
    }
}
