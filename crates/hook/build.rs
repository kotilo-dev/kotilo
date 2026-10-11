//! Embeds a Windows version resource in the hook sidecar: ProductName/CompanyName from
//! `<repo>/brand.json`, ProductVersion/FileVersion from the app's `tauri.conf.json`. Code signing
//! (SignPath, D-051) enforces the same product name and version on every signed exe of a release.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> serde_json::Value {
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

fn string(value: &serde_json::Value, key: &str, file: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| panic!("{file}: \"{key}\" must be a string"))
        .to_string()
}

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"));
    let root = manifest_dir.join("..").join("..");
    let brand = read_json(&root.join("brand.json"));
    let tauri_conf = read_json(&root.join("apps").join("desktop").join("src-tauri").join("tauri.conf.json"));

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let name = string(&brand, "name", "brand.json");
    let publisher = string(&brand, "publisher", "brand.json");
    let version = string(&tauri_conf, "version", "tauri.conf.json");
    let description = format!("{name} hook");

    let mut res = tauri_winres::WindowsResource::new();
    res.set("ProductName", &name)
        .set("CompanyName", &publisher)
        .set("FileDescription", &description)
        .set("ProductVersion", &version)
        .set("FileVersion", &version);
    if let Err(e) = res.compile() {
        panic!("failed to embed the Windows version resource: {e}");
    }
}
