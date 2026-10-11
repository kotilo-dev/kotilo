using System.Text.Json;

namespace Hub.Core;

/// <summary>
/// Product identity from the repo's <c>brand.json</c> (the single source, M5 "Brand switch"), embedded into Hub.Core at
/// build time. Folder names, exe names, the hook marker, the mutex and the credential prefix derive from it; the
/// <c>Legacy*</c> lists name what a renamed build still recognises and migrates from.
/// </summary>
public sealed record Brand(
    string Name,
    string Slug,
    string Identifier,
    string Publisher,
    string ExePrefix,
    string Website,
    string SupportEmail,
    string UpdateEndpoint,
    IReadOnlyList<string> LegacySlugs,
    IReadOnlyList<string> LegacyHookMarkers,
    IReadOnlyList<string> LegacyCredentialPrefixes)
{
    private const string ResourceName = "brand.json";
    private const string HookSuffix = "-hook";

    /// <summary>The embedded brand of this build.</summary>
    public static Brand Current { get; } = LoadEmbedded();

    /// <summary>Marker that identifies our entries in any agent's config: the hook exe's name without extension.</summary>
    public string HookMarker => ExePrefix + HookSuffix;

    /// <summary>The current marker first, then the legacy ones: every entry containing one of them is ours.</summary>
    public IReadOnlyList<string> OwnedHookMarkers => [HookMarker, .. LegacyHookMarkers];

    /// <summary>Exe prefixes of earlier names, derived from the legacy hook markers (<c>&lt;prefix&gt;-hook</c>).</summary>
    public IReadOnlyList<string> LegacyExePrefixes =>
        [.. LegacyHookMarkers.Where(m => m.EndsWith(HookSuffix, StringComparison.OrdinalIgnoreCase)).Select(m => m[..^HookSuffix.Length])];

    /// <summary>Target prefix of AI provider keys in the OS credential vault.</summary>
    public string CredentialPrefix => Slug + "/ai/";

    public static Brand Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var legacy = root.TryGetProperty("legacy", out var l) && l.ValueKind == JsonValueKind.Object ? l : default;
        return new Brand(
            Required(root, "name"),
            Required(root, "slug"),
            Required(root, "identifier"),
            Required(root, "publisher"),
            Required(root, "exePrefix"),
            Optional(root, "website"),
            Optional(root, "supportEmail"),
            Optional(root, "updateEndpoint"),
            List(legacy, "slugs"),
            List(legacy, "hookMarkers"),
            List(legacy, "credentialPrefixes"));
    }

    private static Brand LoadEmbedded()
    {
        using var stream = typeof(Brand).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Missing embedded resource {ResourceName}.");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    }

    private static string Required(JsonElement root, string key) =>
        Optional(root, key) is { Length: > 0 } value ? value : throw new FormatException($"brand.json: \"{key}\" must be a non-empty string.");

    private static string Optional(JsonElement root, string key) =>
        root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static IReadOnlyList<string> List(JsonElement legacy, string key) =>
        legacy.ValueKind == JsonValueKind.Object && legacy.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Array
            ? [.. v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).Where(s => s.Length > 0)]
            : [];
}
