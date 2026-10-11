//! M3: key-sequence notation used by `adapter.json` (`gracefulClose[].keys`,
//! `permissionKeys.*`) and the `pane_send_keys` command, turned into the bytes a
//! terminal would send. Pure: ConPTY translates these bytes into console input itself.
//!
//! Notation:
//! - a named key: `Esc`, `Enter`, `Tab`, `Shift+Tab`, `Backspace`, `Space`, `Up`, `Down`,
//!   `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Delete` (case-insensitive);
//! - a control combination: `Ctrl+<letter>` (also `Ctrl+[`, `Ctrl+\`, `Ctrl+]`, `Ctrl+@`);
//! - several of those (or single characters) separated by spaces: `Down Enter`, `2 Enter`;
//! - anything else is literal text, sent as UTF-8 (`y`, `1`, `/exit\r`).

/// Bytes for one named key or control combination, `None` when `token` is neither.
fn named_key(token: &str) -> Option<Vec<u8>> {
    let lower = token.to_ascii_lowercase();
    let bytes: &[u8] = match lower.as_str() {
        "esc" | "escape" => b"\x1b",
        "enter" | "return" => b"\r",
        "tab" => b"\t",
        "shift+tab" => b"\x1b[Z",
        "backspace" => b"\x7f",
        "space" => b" ",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" => b"\x1b[5~",
        "pagedown" => b"\x1b[6~",
        "delete" | "del" => b"\x1b[3~",
        _ => {
            let rest = lower.strip_prefix("ctrl+")?;
            let mut chars = rest.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            return match c {
                'a'..='z' => Some(vec![(c as u8) & 0x1f]),
                '@' | ' ' => Some(vec![0x00]),
                '[' => Some(vec![0x1b]),
                '\\' => Some(vec![0x1c]),
                ']' => Some(vec![0x1d]),
                _ => None,
            };
        }
    };
    Some(bytes.to_vec())
}

/// Parses `keys` into the bytes to write. Errors only for an empty string.
pub fn parse_keys(keys: &str) -> Result<Vec<u8>, String> {
    if keys.is_empty() {
        return Err("empty key sequence".to_string());
    }
    if let Some(bytes) = named_key(keys.trim()) {
        return Ok(bytes);
    }
    let tokens: Vec<&str> = keys.split_whitespace().collect();
    if tokens.len() > 1
        && tokens.iter().any(|t| named_key(t).is_some())
        && tokens
            .iter()
            .all(|t| named_key(t).is_some() || t.chars().count() == 1)
    {
        let mut out = Vec::new();
        for t in tokens {
            match named_key(t) {
                Some(bytes) => out.extend(bytes),
                None => out.extend(t.as_bytes()),
            }
        }
        return Ok(out);
    }
    Ok(keys.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_combinations() {
        assert_eq!(parse_keys("Ctrl+C").unwrap(), vec![0x03]);
        assert_eq!(parse_keys("ctrl+d").unwrap(), vec![0x04]);
        assert_eq!(parse_keys("Ctrl+X").unwrap(), vec![0x18]);
        assert_eq!(parse_keys("Ctrl+[").unwrap(), vec![0x1b]);
    }

    #[test]
    fn named_keys() {
        assert_eq!(parse_keys("Esc").unwrap(), b"\x1b");
        assert_eq!(parse_keys("Enter").unwrap(), b"\r");
        assert_eq!(parse_keys("Right").unwrap(), b"\x1b[C");
        assert_eq!(parse_keys("Shift+Tab").unwrap(), b"\x1b[Z");
        assert_eq!(parse_keys("PageDown").unwrap(), b"\x1b[6~");
    }

    #[test]
    fn digits_letters_and_text_are_literal() {
        assert_eq!(parse_keys("1").unwrap(), b"1");
        assert_eq!(parse_keys("y").unwrap(), b"y");
        assert_eq!(parse_keys("/exit\r").unwrap(), b"/exit\r");
        assert_eq!(parse_keys("Ctrl+Cool").unwrap(), b"Ctrl+Cool");
        assert_eq!(parse_keys("hello world").unwrap(), b"hello world");
    }

    #[test]
    fn space_separated_sequences() {
        assert_eq!(parse_keys("Down Enter").unwrap(), b"\x1b[B\r");
        assert_eq!(parse_keys("2 Enter").unwrap(), b"2\r");
        assert_eq!(parse_keys("Esc Esc").unwrap(), b"\x1b\x1b");
    }

    #[test]
    fn empty_is_an_error() {
        assert!(parse_keys("").is_err());
    }
}
