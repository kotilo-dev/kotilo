//! Global shortcut strings such as `"Ctrl+Alt+D"` (hub setting `dictation.hotkey`), parsed
//! into RegisterHotKey-style modifier flags and a virtual-key code. Same format and rules
//! as the hub's `Hub.Core/Buddy/HotkeyGesture.cs`: at least one of Ctrl / Alt / Win, so
//! plain typing is never captured.

pub const MOD_ALT: u32 = 0x1;
pub const MOD_CONTROL: u32 = 0x2;
pub const MOD_SHIFT: u32 = 0x4;
pub const MOD_WIN: u32 = 0x8;

/// Virtual-key code of Esc (cancels a running dictation).
pub const VK_ESCAPE: u32 = 0x1B;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gesture {
    pub modifiers: u32,
    pub vk: u32,
    /// Normalised text: `Ctrl+Alt+Shift+Win+Key`.
    pub text: String,
}

const NAMED_KEYS: [(&str, u32); 23] = [
    ("Space", 0x20),
    ("Enter", 0x0D),
    ("Tab", 0x09),
    ("Esc", 0x1B),
    ("Escape", 0x1B),
    ("Insert", 0x2D),
    ("Delete", 0x2E),
    ("Home", 0x24),
    ("End", 0x23),
    ("PageUp", 0x21),
    ("PageDown", 0x22),
    ("Up", 0x26),
    ("Down", 0x28),
    ("Left", 0x25),
    ("Right", 0x27),
    ("`", 0xC0),
    ("-", 0xBD),
    ("=", 0xBB),
    (",", 0xBC),
    (".", 0xBE),
    ("/", 0xBF),
    (";", 0xBA),
    ("Spacebar", 0x20),
];

impl Gesture {
    pub fn parse(text: &str) -> Option<Gesture> {
        if text.trim().is_empty() {
            return None;
        }
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let (key, mods) = parts.split_last()?;
        let mut modifiers = 0;
        for part in mods {
            modifiers |= match part.to_ascii_uppercase().as_str() {
                "CTRL" | "CONTROL" => MOD_CONTROL,
                "ALT" => MOD_ALT,
                "SHIFT" => MOD_SHIFT,
                "WIN" | "WINDOWS" => MOD_WIN,
                _ => return None,
            };
        }
        if modifiers & (MOD_CONTROL | MOD_ALT | MOD_WIN) == 0 {
            return None;
        }
        let vk = key_code(key)?;
        Some(Gesture { modifiers, vk, text: format(modifiers, key) })
    }
}

fn key_code(key: &str) -> Option<u32> {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() == 1 && chars[0].is_ascii_alphanumeric() {
        return Some(chars[0].to_ascii_uppercase() as u32);
    }
    if (2..=3).contains(&chars.len()) && (chars[0] == 'F' || chars[0] == 'f') {
        if let Ok(n) = key[1..].parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + n - 1);
            }
        }
    }
    NAMED_KEYS.iter().find(|(name, _)| name.eq_ignore_ascii_case(key)).map(|(_, vk)| *vk)
}

fn format(modifiers: u32, key: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (flag, name) in [(MOD_CONTROL, "Ctrl"), (MOD_ALT, "Alt"), (MOD_SHIFT, "Shift"), (MOD_WIN, "Win")] {
        if modifiers & flag != 0 {
            parts.push(name.to_string());
        }
    }
    let mut chars = key.chars();
    let key = match chars.next() {
        Some(first) if key.chars().count() == 1 => first.to_uppercase().collect(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    };
    parts.push(key);
    parts.join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalises_the_defaults() {
        let g = Gesture::parse("Ctrl+Alt+D").unwrap();
        assert_eq!((g.modifiers, g.vk, g.text.as_str()), (MOD_CONTROL | MOD_ALT, 'D' as u32, "Ctrl+Alt+D"));
        let g = Gesture::parse("shift + alt + control + d").unwrap();
        assert_eq!(g.modifiers, MOD_CONTROL | MOD_ALT | MOD_SHIFT);
        assert_eq!(g.text, "Ctrl+Alt+Shift+D");
    }

    #[test]
    fn function_named_and_punctuation_keys() {
        assert_eq!(Gesture::parse("Win+F12").unwrap().vk, 0x7B);
        assert_eq!(Gesture::parse("Ctrl+F1").unwrap().vk, 0x70);
        assert_eq!(Gesture::parse("Alt+space").unwrap().text, "Alt+Space");
        assert_eq!(Gesture::parse("Ctrl+Alt+PageDown").unwrap().vk, 0x22);
        assert_eq!(Gesture::parse("Ctrl+.").unwrap().vk, 0xBE);
        assert_eq!(Gesture::parse("Ctrl+7").unwrap().vk, '7' as u32);
    }

    #[test]
    fn rejects_unsafe_or_malformed_gestures() {
        for bad in ["", "D", "Shift+D", "Ctrl+", "Ctrl++", "Hyper+D", "Ctrl+F25", "Ctrl+F0", "Ctrl+Ö", "Ctrl+Alt+DD"] {
            assert!(Gesture::parse(bad).is_none(), "{bad:?}");
        }
    }
}
