using System.Globalization;
using System.Text.Json;

namespace Hub.Core.Buddy;

/// <summary>A 16×16 sprite as straight (non-premultiplied) ARGB pixels, row-major; 0 is transparent.</summary>
public sealed class Sprite(int size, uint[] pixels)
{
    public int Size { get; } = size;

    public IReadOnlyList<uint> Pixels { get; } = pixels;

    public uint this[int x, int y] => pixels[(y * Size) + x];

    public bool IsOpaque(int x, int y) => x >= 0 && y >= 0 && x < Size && y < Size && (this[x, y] >> 24) != 0;

    public Sprite Mirrored()
    {
        var copy = new uint[pixels.Length];
        for (var y = 0; y < Size; y++)
        {
            for (var x = 0; x < Size; x++)
            {
                copy[(y * Size) + x] = pixels[(y * Size) + (Size - 1 - x)];
            }
        }

        return new Sprite(Size, copy);
    }
}

/// <summary>
/// Loads Bip from <c>docs/design/bip/sprites.json</c> (DESIGN.md "Bip"): one character per pixel, a shared palette, the
/// transparent character, and <c>L</c> = antenna light painted in each state's own color.
/// </summary>
public sealed class SpriteSheet
{
    private const char AntennaLight = 'L';

    private SpriteSheet(Dictionary<string, Sprite> sprites) => Sprites = sprites;

    public IReadOnlyDictionary<string, Sprite> Sprites { get; }

    public Sprite this[string state] => Sprites[state];

    public Sprite For(MascotState state) => Sprites[state.ToString().ToLowerInvariant()];

    /// <exception cref="FormatException">Malformed sheet (wrong row count / width, unknown palette key).</exception>
    public static SpriteSheet Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var size = root.GetProperty("size").GetInt32();
        var transparent = root.TryGetProperty("transparent", out var t) ? t.GetString()![0] : '.';
        var palette = root.GetProperty("palette").EnumerateObject()
            .ToDictionary(p => p.Name[0], p => ParseColor(p.Value.GetString()!));

        var sprites = new Dictionary<string, Sprite>(StringComparer.OrdinalIgnoreCase);
        foreach (var state in root.GetProperty("states").EnumerateObject())
        {
            var light = ParseColor(state.Value.GetProperty("antennaLight").GetString()!);
            var rows = state.Value.GetProperty("rows").EnumerateArray().Select(r => r.GetString()!).ToList();
            if (rows.Count != size || rows.Any(r => r.Length != size))
            {
                throw new FormatException($"Sprite '{state.Name}' is not {size}×{size}.");
            }

            var pixels = new uint[size * size];
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    var c = rows[y][x];
                    pixels[(y * size) + x] = c == transparent ? 0u
                        : c == AntennaLight ? light
                        : palette.TryGetValue(c, out var color) ? color
                        : throw new FormatException($"Sprite '{state.Name}' uses unknown palette key '{c}'.");
                }
            }

            sprites[state.Name] = new Sprite(size, pixels);
        }

        if (sprites.TryGetValue("input", out var input) && size == 16)
        {
            sprites["error"] = ErrorFrom(input, palette.GetValueOrDefault('q'));
        }

        return new SpriteSheet(sprites);
    }

    /// <summary>Design color for the error state (DESIGN.md "Faz 6 ekleri", Fluent critical on dark).</summary>
    public const uint ErrorColor = 0xFFFF99A4;

    /// <summary>
    /// The error look (spec §18.5): the input sprite with its yellow "?" replaced by a red "!" and a red antenna light.
    /// </summary>
    private static Sprite ErrorFrom(Sprite input, uint questionColor)
    {
        var pixels = input.Pixels.ToArray();
        var antenna = input[7, 1];
        for (var i = 0; i < pixels.Length; i++)
        {
            if (pixels[i] == questionColor || pixels[i] == antenna)
            {
                pixels[i] = pixels[i] == antenna && i / 16 is 1 && i % 16 is 7 or 8 ? ErrorColor : 0u;
            }
        }

        foreach (var (x, y) in new[] { (2, 0), (2, 1), (2, 2), (2, 4) })
        {
            pixels[(y * 16) + x] = ErrorColor;
        }

        return new Sprite(16, pixels);
    }

    /// <summary>"#RRGGBB" → opaque ARGB.</summary>
    private static uint ParseColor(string hex) =>
        0xFF000000u | uint.Parse(hex.TrimStart('#'), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
