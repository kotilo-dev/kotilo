//! `app_info` command (Faz 4 spec §4 item 21, extended by Faz 7 §9.7): exposes the
//! Windows build number so the frontend can pass ConPTY-specific reflow/cursor hints to
//! xterm.js (`windowsPty: { backend: "conpty", buildNumber }`), plus (§5/§9.7) the
//! version/git-sha/WebView2/OS fields the About section and the diagnostics zip's
//! `system.json` both need. `osBuild` is kept exactly as it was — existing callers are
//! untouched.

use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub os_build: u32,
    /// Spec §9.1/§9.7: single source of truth is `tauri.conf.json`'s `version`
    /// (`app.package_info().version`), never a separately-tracked constant.
    pub version: String,
    /// Spec §9.1: `AGENTHUB_GIT_SHA` baked in by `build.rs` (`+ "-dirty"` when the tree
    /// had uncommitted changes at build time); `"unknown"` when git wasn't available.
    pub git_sha: String,
    pub webview2: String,
    pub os: String,
    /// Faz 7 §11: `AGENTHUB_BUILD_DATE` baked in by `build.rs` — UTC `YYYY-MM-DD`.
    pub build_date: String,
    /// M5 About page: from `brand.json` (empty until the public repo/site exist).
    pub repository: String,
    pub website: String,
    pub support_email: String,
}

/// Spec §9.7 `app_info.os`: e.g. `"Windows 11 (10.0.26100)"` — pure so it's testable
/// without the registry. Windows 11 and Windows 10 share NT version `10.0`; builds
/// `>= 22000` are Windows 11 (Microsoft's own cutoff), everything else Windows 10.
pub fn os_description(build_number: Option<u32>) -> String {
    match build_number {
        Some(build) => {
            let name = if build >= 22000 { "Windows 11" } else { "Windows 10" };
            format!("{name} (10.0.{build})")
        }
        None => "Windows (unknown)".to_string(),
    }
}

/// Spec §9.1 start line / §9.7 `app_info.webview2`: the installed WebView2 runtime's
/// version, or `"unknown"` when it can't be determined (e.g. not installed).
pub fn webview2_version() -> String {
    tauri::webview_version().unwrap_or_else(|_| "unknown".to_string())
}

/// Parses the registry's `CurrentBuildNumber` value (a decimal string, e.g. `"26100"`)
/// into a `u32`. Pure and unit-tested separately from the registry read itself.
pub fn parse_build_number(raw: &str) -> Option<u32> {
    raw.trim().trim_end_matches('\0').parse().ok()
}

#[cfg(windows)]
fn read_current_build_number() -> Option<u32> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\0"
        .encode_utf16()
        .collect();
    let value_name: Vec<u16> = "CurrentBuildNumber\0".encode_utf16().collect();

    let mut buf = [0u16; 32];
    let mut size: u32 = (buf.len() * 2) as u32;

    // SAFETY: `subkey`/`value_name` are valid NUL-terminated UTF-16 strings alive for
    // the whole call; `buf`/`size` describe a correctly sized output buffer that
    // `RegGetValueW` never writes past (it fails with `ERROR_MORE_DATA` instead, which
    // `.is_err()` below catches).
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value_name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    };
    if result.is_err() {
        return None;
    }

    let chars = (size as usize / 2).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..chars]);
    parse_build_number(&text)
}

#[cfg(not(windows))]
fn read_current_build_number() -> Option<u32> {
    None
}

/// The fields that come from `brand.json`; the rest are left empty (`..brand_info()`).
pub fn brand_info() -> AppInfo {
    AppInfo {
        os_build: 0,
        version: String::new(),
        git_sha: String::new(),
        webview2: String::new(),
        os: String::new(),
        build_date: String::new(),
        repository: crate::brand::REPOSITORY.to_string(),
        website: crate::brand::WEBSITE.to_string(),
        support_email: crate::brand::SUPPORT_EMAIL.to_string(),
    }
}

#[tauri::command(async)]
pub fn app_info(app: tauri::AppHandle) -> AppResult<AppInfo> {
    let build = read_current_build_number();
    Ok(AppInfo {
        os_build: build.unwrap_or(0),
        version: app.package_info().version.to_string(),
        git_sha: env!("AGENTHUB_GIT_SHA").to_string(),
        webview2: webview2_version(),
        os: os_description(build),
        build_date: env!("AGENTHUB_BUILD_DATE").to_string(),
        ..brand_info()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_carries_the_brand_links_in_camel_case() {
        let json = serde_json::to_value(brand_info()).unwrap();
        assert_eq!(json["repository"], crate::brand::REPOSITORY);
        assert_eq!(json["website"], crate::brand::WEBSITE);
        assert_eq!(json["supportEmail"], crate::brand::SUPPORT_EMAIL);
        assert!(json.get("version").is_some() && json.get("buildDate").is_some());
    }

    #[test]
    fn parse_build_number_parses_plain_digits() {
        assert_eq!(parse_build_number("26100"), Some(26100));
    }

    #[test]
    fn parse_build_number_trims_whitespace_and_nul_terminator() {
        assert_eq!(parse_build_number("26100\0"), Some(26100));
        assert_eq!(parse_build_number("  26100  "), Some(26100));
    }

    #[test]
    fn parse_build_number_rejects_non_numeric() {
        assert_eq!(parse_build_number("not-a-number"), None);
        assert_eq!(parse_build_number(""), None);
    }

    #[test]
    fn os_description_labels_windows_11_builds() {
        assert_eq!(os_description(Some(26100)), "Windows 11 (10.0.26100)");
        assert_eq!(os_description(Some(22000)), "Windows 11 (10.0.22000)");
    }

    #[test]
    fn os_description_labels_windows_10_builds() {
        assert_eq!(os_description(Some(19045)), "Windows 10 (10.0.19045)");
        assert_eq!(os_description(Some(21999)), "Windows 10 (10.0.21999)");
    }

    #[test]
    fn os_description_handles_unknown_build() {
        assert_eq!(os_description(None), "Windows (unknown)");
    }

    /// Real end-to-end check on the actual machine running the test — every supported
    /// Windows build number fits comfortably under this bound, so a implausibly small
    /// or huge value would mean the registry read/parse is broken, not just "some other
    /// Windows version".
    #[cfg(windows)]
    #[test]
    fn read_current_build_number_returns_a_plausible_value_on_real_windows() {
        let build = read_current_build_number().expect("CurrentBuildNumber should be readable");
        assert!(build > 10000 && build < 100000, "implausible build number: {build}");
    }
}
