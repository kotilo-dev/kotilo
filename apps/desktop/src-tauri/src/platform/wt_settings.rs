//! Windows Terminal's settings, read-only (D-055 fonts, D-057 colour schemes). Kotilo never
//! writes any of these files.
//!
//! Sources, in priority order (a scheme name seen earlier wins):
//! 1. the user's `settings.json` (Store, Preview, unpackaged),
//! 2. JSON fragments (`Fragments\<app>\*.json` under `%LOCALAPPDATA%` and `%PROGRAMDATA%`),
//! 3. the installed package's `defaults.json`, which holds the built-in schemes
//!    ("Campbell", "One Half Dark", …) – `settings.json` only lists the user's own.
//!
//! The files are JSON with comments and trailing commas ([`strip_jsonc`]).

use serde::Deserialize;

use crate::settings::{normalize_hex_color, normalize_scheme, TerminalScheme};

/// The text of every user `settings.json` found (fonts look only at these).
pub fn user_settings_texts() -> Vec<String> {
    read_all(&os::user_settings_paths())
}

/// Every Windows Terminal scheme Kotilo can import, deduped by name (first source wins).
pub fn schemes() -> Vec<TerminalScheme> {
    let mut texts = user_settings_texts();
    texts.extend(read_all(&os::fragment_paths()));
    texts.extend(read_all(&os::defaults_paths()));
    merge_schemes(texts.iter().map(String::as_str))
}

fn read_all(paths: &[std::path::PathBuf]) -> Vec<String> {
    paths.iter().filter_map(|p| std::fs::read_to_string(p).ok()).collect()
}

/// Removes `//` and `/* */` comments outside strings, then commas that only precede `}` or
/// `]`, so `serde_json` can read the result. A leading BOM is dropped too.
pub fn strip_jsonc(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for skipped in chars.by_ref() {
                    if skipped == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = '\0';
                for skipped in chars.by_ref() {
                    if prev == '*' && skipped == '/' {
                        break;
                    }
                    prev = skipped;
                }
                out.push(' ');
            }
            _ => out.push(c),
        }
    }
    drop_trailing_commas(&out)
}

fn drop_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.get(i + 1) {
                    out.push(next);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|ch| !ch.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                out.push(c);
            }
        } else {
            in_string = c == '"';
            out.push(c);
        }
        i += 1;
    }
    out
}

/// A scheme as Windows Terminal writes it (`purple` is xterm's magenta).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WtScheme {
    name: Option<String>,
    background: Option<String>,
    foreground: Option<String>,
    cursor_color: Option<String>,
    selection_background: Option<String>,
    black: Option<String>,
    red: Option<String>,
    green: Option<String>,
    yellow: Option<String>,
    blue: Option<String>,
    purple: Option<String>,
    cyan: Option<String>,
    white: Option<String>,
    bright_black: Option<String>,
    bright_red: Option<String>,
    bright_green: Option<String>,
    bright_yellow: Option<String>,
    bright_blue: Option<String>,
    bright_purple: Option<String>,
    bright_cyan: Option<String>,
    bright_white: Option<String>,
}

/// `#rgb` → `#rrggbb`; `#rrggbb` lowercased; anything else → `None`.
fn wt_color(value: &Option<String>) -> Option<String> {
    let value = value.as_deref()?.trim();
    match value.strip_prefix('#') {
        Some(short) if short.len() == 3 && short.bytes().all(|b| b.is_ascii_hexdigit()) => {
            normalize_hex_color(&format!("#{}", short.chars().flat_map(|c| [c, c]).collect::<String>()))
        }
        _ => normalize_hex_color(value),
    }
}

impl WtScheme {
    fn into_scheme(self) -> Option<TerminalScheme> {
        let c = wt_color;
        let foreground = c(&self.foreground)?;
        let bright_black = c(&self.bright_black)?;
        normalize_scheme(TerminalScheme {
            name: self.name.clone()?,
            background: c(&self.background)?,
            cursor: c(&self.cursor_color).unwrap_or_else(|| foreground.clone()),
            selection: c(&self.selection_background).unwrap_or_else(|| bright_black.clone()),
            foreground,
            black: c(&self.black)?,
            red: c(&self.red)?,
            green: c(&self.green)?,
            yellow: c(&self.yellow)?,
            blue: c(&self.blue)?,
            magenta: c(&self.purple)?,
            cyan: c(&self.cyan)?,
            white: c(&self.white)?,
            bright_black,
            bright_red: c(&self.bright_red)?,
            bright_green: c(&self.bright_green)?,
            bright_yellow: c(&self.bright_yellow)?,
            bright_blue: c(&self.bright_blue)?,
            bright_magenta: c(&self.bright_purple)?,
            bright_cyan: c(&self.bright_cyan)?,
            bright_white: c(&self.bright_white)?,
        })
    }
}

/// The valid schemes in one settings/defaults/fragment file; an unreadable file gives none,
/// an invalid scheme is skipped on its own.
pub fn parse_schemes(text: &str) -> Vec<TerminalScheme> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&strip_jsonc(text)) else {
        return Vec::new();
    };
    let Some(list) = root.get("schemes").and_then(|s| s.as_array()) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|v| serde_json::from_value::<WtScheme>(v.clone()).ok())
        .filter_map(WtScheme::into_scheme)
        .collect()
}

/// Schemes from several files, deduped by name (the first file wins).
pub fn merge_schemes<'a>(texts: impl Iterator<Item = &'a str>) -> Vec<TerminalScheme> {
    let mut out: Vec<TerminalScheme> = Vec::new();
    for scheme in texts.flat_map(parse_schemes) {
        if !out.iter().any(|s| s.name == scheme.name) {
            out.push(scheme);
        }
    }
    out
}

#[cfg(windows)]
mod os {
    use std::path::PathBuf;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_SZ,
    };

    const PACKAGES: [&str; 2] = ["Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"];

    fn env_dir(name: &str) -> Option<PathBuf> {
        std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
    }

    pub fn user_settings_paths() -> Vec<PathBuf> {
        let Some(local) = env_dir("LOCALAPPDATA") else {
            return Vec::new();
        };
        let mut paths: Vec<PathBuf> =
            PACKAGES.iter().map(|p| local.join("Packages").join(p).join("LocalState").join("settings.json")).collect();
        paths.push(local.join("Microsoft").join("Windows Terminal").join("settings.json"));
        paths
    }

    /// `Fragments\<app>\*.json` (one level deep, as Windows Terminal reads them).
    pub fn fragment_paths() -> Vec<PathBuf> {
        let mut paths = Vec::new();
        for root in [env_dir("LOCALAPPDATA"), env_dir("PROGRAMDATA")].into_iter().flatten() {
            let Ok(apps) = std::fs::read_dir(root.join("Microsoft").join("Windows Terminal").join("Fragments")) else {
                continue;
            };
            for app in apps.flatten() {
                let Ok(files) = std::fs::read_dir(app.path()) else { continue };
                paths.extend(
                    files
                        .flatten()
                        .map(|f| f.path())
                        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"))),
                );
            }
        }
        paths
    }

    /// `defaults.json` of every installed Windows Terminal package (Store and Preview), found
    /// through the per-user AppModel package repository.
    pub fn defaults_paths() -> Vec<PathBuf> {
        const REPO: &str = "Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages";
        let mut paths = Vec::new();
        for name in subkeys(REPO) {
            let is_terminal = name.starts_with("Microsoft.WindowsTerminal_") || name.starts_with("Microsoft.WindowsTerminalPreview_");
            if !is_terminal || !name.ends_with("__8wekyb3d8bbwe") {
                continue;
            }
            if let Some(root) = string_value(&format!("{REPO}\\{name}"), "PackageRootFolder") {
                paths.push(PathBuf::from(root).join("defaults.json"));
            }
        }
        paths
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn subkeys(path: &str) -> Vec<String> {
        let path = wide(path);
        let mut key = HKEY::default();
        // SAFETY: `path` is NUL-terminated and alive for the call; `key` receives the handle.
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(path.as_ptr()), None, KEY_READ, &mut key) } != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut names = Vec::new();
        let mut index = 0u32;
        loop {
            let mut buf = [0u16; 256];
            let mut len = buf.len() as u32;
            // SAFETY: `buf`/`len` describe a writable buffer; class and time are not requested.
            let status =
                unsafe { RegEnumKeyExW(key, index, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
            index += 1;
        }
        // SAFETY: `key` was opened above.
        let _ = unsafe { RegCloseKey(key) };
        names
    }

    fn string_value(path: &str, value: &str) -> Option<String> {
        let (path, value) = (wide(path), wide(value));
        let mut buf = [0u16; 1024];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: NUL-terminated inputs; `buf`/`bytes` describe a writable buffer of that size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut bytes),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let len = (bytes as usize / 2).min(buf.len());
        let text = String::from_utf16_lossy(&buf[..len]);
        let text = text.trim_end_matches('\0').to_string();
        (!text.is_empty()).then_some(text)
    }
}

#[cfg(not(windows))]
mod os {
    use std::path::PathBuf;

    pub fn user_settings_paths() -> Vec<PathBuf> {
        Vec::new()
    }
    pub fn fragment_paths() -> Vec<PathBuf> {
        Vec::new()
    }
    pub fn defaults_paths() -> Vec<PathBuf> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTINGS: &str = r##"{
        // Windows Terminal settings with comments
        "$schema": "https://aka.ms/terminal-profiles-schema",
        "profiles": { "defaults": { "font": { "face": "MesloLGM Nerd Font" } }, "list": [] },
        /* a block
           comment */
        "schemes": [
            {
                "name": "One Half Dark", // trailing comment
                "background": "#282C34",
                "foreground": "#DCDFE4",
                "cursorColor": "#FFFFFF",
                "selectionBackground": "#FFFFFF",
                "black": "#282C34", "red": "#E06C75", "green": "#98C379", "yellow": "#E5C07B",
                "blue": "#61AFEF", "purple": "#C678DD", "cyan": "#56B6C2", "white": "#DCDFE4",
                "brightBlack": "#5A6374", "brightRed": "#E06C75", "brightGreen": "#98C379",
                "brightYellow": "#E5C07B", "brightBlue": "#61AFEF", "brightPurple": "#C678DD",
                "brightCyan": "#56B6C2", "brightWhite": "#DCDFE4",
            },
            {
                "name": "No cursor // not a comment",
                "background": "#000", "foreground": "#cccccc",
                "black": "#000000", "red": "#aa0000", "green": "#00aa00", "yellow": "#aaaa00",
                "blue": "#0000aa", "purple": "#aa00aa", "cyan": "#00aaaa", "white": "#aaaaaa",
                "brightBlack": "#555555", "brightRed": "#ff5555", "brightGreen": "#55ff55",
                "brightYellow": "#ffff55", "brightBlue": "#5555ff", "brightPurple": "#ff55ff",
                "brightCyan": "#55ffff", "brightWhite": "#ffffff"
            },
            { "name": "Bad colour", "background": "#12345", "foreground": "#ffffff" },
            { "name": "Missing purple", "background": "#000000", "foreground": "#ffffff",
              "black": "#000000", "red": "#aa0000", "green": "#00aa00", "yellow": "#aaaa00",
              "blue": "#0000aa", "cyan": "#00aaaa", "white": "#aaaaaa",
              "brightBlack": "#555555", "brightRed": "#ff5555", "brightGreen": "#55ff55",
              "brightYellow": "#ffff55", "brightBlue": "#5555ff", "brightPurple": "#ff55ff",
              "brightCyan": "#55ffff", "brightWhite": "#ffffff" },
            { "name": 42 },
        ],
    }"##;

    #[test]
    fn strips_comments_outside_strings_and_trailing_commas() {
        let text = "\u{feff}{ \"a\": \"http://x/*y*/\", // c\n \"b\": [1, 2, ], /* d */ \"c\": { \"e\": \"\\\"//\", }, }";
        let value: serde_json::Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(value["a"], "http://x/*y*/");
        assert_eq!(value["b"], serde_json::json!([1, 2]));
        assert_eq!(value["c"]["e"], "\"//");
    }

    #[test]
    fn parses_valid_schemes_and_maps_purple_to_magenta() {
        let schemes = parse_schemes(SETTINGS);
        let names: Vec<&str> = schemes.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["One Half Dark", "No cursor // not a comment"]);

        let one = &schemes[0];
        assert_eq!(one.background, "#282c34");
        assert_eq!(one.cursor, "#ffffff");
        assert_eq!(one.selection, "#ffffff");
        assert_eq!(one.magenta, "#c678dd");
        assert_eq!(one.bright_magenta, "#c678dd");
        assert_eq!(one.bright_black, "#5a6374");
    }

    #[test]
    fn missing_cursor_and_selection_fall_back_and_short_colours_expand() {
        let schemes = parse_schemes(SETTINGS);
        let plain = &schemes[1];
        assert_eq!(plain.background, "#000000");
        assert_eq!(plain.cursor, "#cccccc", "cursor falls back to foreground");
        assert_eq!(plain.selection, "#555555", "selection falls back to brightBlack");
    }

    #[test]
    fn unreadable_or_schemeless_files_give_nothing() {
        assert!(parse_schemes("{ not json").is_empty());
        assert!(parse_schemes("{ \"profiles\": {} }").is_empty());
        assert!(parse_schemes("{ \"schemes\": {} }").is_empty());
    }

    #[test]
    fn merge_dedupes_by_name_first_file_wins() {
        let user = r##"{ "schemes": [ { "name": "One Half Dark", "background": "#111111", "foreground": "#eeeeee",
            "black": "#000000", "red": "#aa0000", "green": "#00aa00", "yellow": "#aaaa00",
            "blue": "#0000aa", "purple": "#aa00aa", "cyan": "#00aaaa", "white": "#aaaaaa",
            "brightBlack": "#555555", "brightRed": "#ff5555", "brightGreen": "#55ff55",
            "brightYellow": "#ffff55", "brightBlue": "#5555ff", "brightPurple": "#ff55ff",
            "brightCyan": "#55ffff", "brightWhite": "#ffffff" } ] }"##;
        let merged = merge_schemes([user, SETTINGS].into_iter());
        let names: Vec<&str> = merged.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["One Half Dark", "No cursor // not a comment"]);
        assert_eq!(merged[0].background, "#111111");
    }
}
