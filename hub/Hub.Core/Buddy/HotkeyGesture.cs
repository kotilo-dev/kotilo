namespace Hub.Core.Buddy;

/// <summary>RegisterHotKey modifier flags.</summary>
[Flags]
public enum HotkeyModifiers : uint
{
    None = 0,
    Alt = 0x1,
    Control = 0x2,
    Shift = 0x4,
    Windows = 0x8,
}

/// <summary>
/// A global shortcut such as "Ctrl+Alt+Space" (spec §17.4) as RegisterHotKey modifiers and a virtual-key code.
/// At least one of Ctrl / Alt / Win is required so plain typing is never captured.
/// </summary>
public sealed record HotkeyGesture(HotkeyModifiers Modifiers, uint VirtualKey, string Text)
{
    private static readonly Dictionary<string, uint> NamedKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Space"] = 0x20, ["Enter"] = 0x0D, ["Tab"] = 0x09, ["Esc"] = 0x1B, ["Escape"] = 0x1B,
        ["Insert"] = 0x2D, ["Delete"] = 0x2E, ["Home"] = 0x24, ["End"] = 0x23, ["PageUp"] = 0x21, ["PageDown"] = 0x22,
        ["Up"] = 0x26, ["Down"] = 0x28, ["Left"] = 0x25, ["Right"] = 0x27,
        ["`"] = 0xC0, ["-"] = 0xBD, ["="] = 0xBB, [","] = 0xBC, ["."] = 0xBE, ["/"] = 0xBF, [";"] = 0xBA,
    };

    public static HotkeyGesture? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var parts = text.Split('+', StringSplitOptions.TrimEntries);

        // "Ctrl++" style: the last part is the key itself.
        if (parts.Length >= 2 && parts[^1].Length == 0 && parts[^2].Length == 0)
        {
            return null;
        }

        var modifiers = HotkeyModifiers.None;
        foreach (var part in parts[..^1])
        {
            modifiers |= part.ToUpperInvariant() switch
            {
                "CTRL" or "CONTROL" => HotkeyModifiers.Control,
                "ALT" => HotkeyModifiers.Alt,
                "SHIFT" => HotkeyModifiers.Shift,
                "WIN" or "WINDOWS" => HotkeyModifiers.Windows,
                _ => (HotkeyModifiers)0x80000000,
            };
        }

        if (((uint)modifiers & 0x80000000) != 0 || (modifiers & (HotkeyModifiers.Control | HotkeyModifiers.Alt | HotkeyModifiers.Windows)) == 0)
        {
            return null;
        }

        var key = parts[^1];
        uint? vk = key.Length == 1 && char.IsAsciiLetterOrDigit(key[0]) ? char.ToUpperInvariant(key[0])
            : key.Length is 2 or 3 && (key[0] is 'F' or 'f') && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24 ? (uint)(0x70 + f - 1)
            : NamedKeys.TryGetValue(key, out var named) ? named
            : null;

        return vk is null ? null : new HotkeyGesture(modifiers, vk.Value, Format(modifiers, key));
    }

    private static string Format(HotkeyModifiers m, string key)
    {
        var parts = new List<string>();
        if (m.HasFlag(HotkeyModifiers.Control))
        {
            parts.Add("Ctrl");
        }

        if (m.HasFlag(HotkeyModifiers.Alt))
        {
            parts.Add("Alt");
        }

        if (m.HasFlag(HotkeyModifiers.Shift))
        {
            parts.Add("Shift");
        }

        if (m.HasFlag(HotkeyModifiers.Windows))
        {
            parts.Add("Win");
        }

        parts.Add(key.Length == 1 ? key.ToUpperInvariant() : char.ToUpperInvariant(key[0]) + key[1..]);
        return string.Join('+', parts);
    }
}
