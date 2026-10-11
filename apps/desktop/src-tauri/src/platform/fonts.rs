//! D-055: a terminal font suggestion for prompts that draw Nerd Font icons (oh-my-posh,
//! starship…). Reads the installed font families from the registry and, read-only, the font
//! faces in Windows Terminal's `settings.json`, so Kotilo picks what the user already uses
//! there when it is an installed Nerd Font.

/// The Nerd Font family to put in front of the default terminal font, if any is installed.
pub fn nerd_font_suggestion() -> Option<String> {
    let installed = os::installed_font_names();
    let families = nerd_families(installed.iter().map(String::as_str));
    let faces: Vec<String> = os::windows_terminal_settings().iter().flat_map(|text| font_faces(text)).collect();
    pick(&families, &faces)
}

/// Family name from a registry font value name, e.g. `MesloLGM Nerd Font Bold Italic (TrueType)`
/// → `MesloLGM Nerd Font`.
pub fn family_of(value_name: &str) -> String {
    const STYLES: &[&str] = &[
        "Regular", "Bold", "Italic", "Oblique", "Light", "Medium", "SemiBold", "Semibold", "DemiBold", "ExtraBold",
        "ExtraLight", "UltraLight", "Thin", "Black", "Heavy", "Book", "Retina", "SemiLight", "Condensed",
    ];
    let mut name = value_name.trim();
    if let Some(open) = name.rfind(" (") {
        name = &name[..open];
    }
    let mut words: Vec<&str> = name.split_whitespace().collect();
    while words.len() > 1 && words.last().is_some_and(|w| STYLES.contains(w)) {
        words.pop();
    }
    words.join(" ")
}

fn is_nerd(family: &str) -> bool {
    (family.contains("Nerd Font") || family.ends_with(" NF") || family.contains(" NF ") || family.ends_with(" NFM"))
        && !family.contains("Propo")
        && !family.ends_with(" NFP")
}

/// Distinct installed Nerd Font families (proportional "Propo" variants left out), sorted.
pub fn nerd_families<'a>(value_names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut families: Vec<String> = value_names.map(family_of).filter(|f| is_nerd(f)).collect();
    families.sort();
    families.dedup();
    families
}

/// Windows Terminal's choice first (when installed), then a monospaced "Mono"/"NFM" variant,
/// then any Nerd Font.
pub fn pick(families: &[String], preferred_faces: &[String]) -> Option<String> {
    preferred_faces
        .iter()
        .find(|face| families.iter().any(|f| f.eq_ignore_ascii_case(face)))
        .cloned()
        .or_else(|| families.iter().find(|f| f.contains("Nerd Font Mono") || f.ends_with(" NFM")).cloned())
        .or_else(|| families.first().cloned())
}

/// Every `"face": "…"` value in a Windows Terminal settings file (JSON with comments).
pub fn font_faces(text: &str) -> Vec<String> {
    let mut faces = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("\"face\"") {
        rest = &rest[at + 6..];
        let Some(colon) = rest.find(':') else { break };
        let after = rest[colon + 1..].trim_start();
        if let Some(value) = after.strip_prefix('"') {
            if let Some(end) = value.find('"') {
                faces.push(value[..end].to_string());
            }
        }
    }
    faces
}

#[cfg(windows)]
mod os {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    pub fn installed_font_names() -> Vec<String> {
        let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts\0".encode_utf16().collect();
        let mut names = Vec::new();
        for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let mut key = HKEY::default();
            // SAFETY: `subkey` is NUL-terminated and alive for the call; `key` receives the handle.
            if unsafe { RegOpenKeyExW(root, PCWSTR(subkey.as_ptr()), None, KEY_READ, &mut key) } != ERROR_SUCCESS {
                continue;
            }
            let mut index = 0u32;
            loop {
                let mut buf = [0u16; 512];
                let mut len = buf.len() as u32;
                // SAFETY: `buf`/`len` describe a writable buffer; data and type are not requested.
                let status = unsafe {
                    RegEnumValueW(key, index, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None)
                };
                if status != ERROR_SUCCESS {
                    break;
                }
                names.push(String::from_utf16_lossy(&buf[..len as usize]));
                index += 1;
            }
            // SAFETY: `key` was opened above.
            let _ = unsafe { RegCloseKey(key) };
        }
        names
    }

    /// Windows Terminal's settings files (Store, Preview, unpackaged); read-only.
    pub fn windows_terminal_settings() -> Vec<String> {
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from) else {
            return Vec::new();
        };
        [
            local.join("Packages").join("Microsoft.WindowsTerminal_8wekyb3d8bbwe").join("LocalState").join("settings.json"),
            local.join("Packages").join("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe").join("LocalState").join("settings.json"),
            local.join("Microsoft").join("Windows Terminal").join("settings.json"),
        ]
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .collect()
    }
}

#[cfg(not(windows))]
mod os {
    pub fn installed_font_names() -> Vec<String> {
        Vec::new()
    }

    pub fn windows_terminal_settings() -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn family_strips_styles_and_format() {
        assert_eq!(family_of("MesloLGM Nerd Font Bold Italic (TrueType)"), "MesloLGM Nerd Font");
        assert_eq!(family_of("JetBrainsMono NF ExtraLight (TrueType)"), "JetBrainsMono NF");
        assert_eq!(family_of("MesloLGS Nerd Font Mono Regular (TrueType)"), "MesloLGS Nerd Font Mono");
        assert_eq!(family_of("Consolas (TrueType)"), "Consolas");
        assert_eq!(family_of("Bold"), "Bold");
    }

    #[test]
    fn nerd_families_skip_proportional_and_others() {
        let names = [
            "MesloLGM Nerd Font Regular (TrueType)",
            "MesloLGM Nerd Font Bold (TrueType)",
            "MesloLGMDZ Nerd Font Propo Bold (TrueType)",
            "JetBrainsMono NF Regular (TrueType)",
            "Consolas (TrueType)",
        ];
        assert_eq!(nerd_families(names.into_iter()), vec!["JetBrainsMono NF", "MesloLGM Nerd Font"]);
    }

    #[test]
    fn windows_terminal_face_wins_then_mono() {
        let families = vec!["JetBrainsMono NF".to_string(), "MesloLGM Nerd Font".into(), "MesloLGS Nerd Font Mono".into()];
        assert_eq!(pick(&families, &["MesloLGM Nerd Font".into()]).as_deref(), Some("MesloLGM Nerd Font"));
        assert_eq!(pick(&families, &["Not Installed".into()]).as_deref(), Some("MesloLGS Nerd Font Mono"));
        assert_eq!(pick(&["JetBrainsMono NF".to_string()], &[]).as_deref(), Some("JetBrainsMono NF"));
        assert_eq!(pick(&[], &["MesloLGM Nerd Font".into()]), None);
    }

    #[test]
    fn faces_from_settings_with_comments() {
        let text = r#"{
            // a comment
            "profiles": { "defaults": { "font": { "face": "MesloLGM Nerd Font", "size": 11 } },
              "list": [ { "font" : {"face":"Cascadia Code"} } ] }
        }"#;
        assert_eq!(font_faces(text), vec!["MesloLGM Nerd Font", "Cascadia Code"]);
    }
}
